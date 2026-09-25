#!/usr/bin/env node
/**
 * Builds one worldwide peak file, for upload to MapTiler as a vector tileset.
 *
 *   node scripts/build-world-peaks.mjs                 # every country
 *   node scripts/build-world-peaks.mjs --countries AR,CL,PE
 *   node scripts/build-world-peaks.mjs --core 4000     # how many go in the offline file
 *
 * Two sources, each where it is better:
 *
 *   OSM      data/peaks.geojson, the Alps snapshot. Node ids that match what is
 *            already tagged, countries resolved against real boundaries, and
 *            prominence where the mappers recorded it.
 *   GeoNames everywhere else. One download per country, already carrying a
 *            country code, an admin1 (state) code and an elevation, and — the
 *            part that matters — every mountain feature in it has a name. No
 *            "Unnamed peak" can come out of this.
 *
 * Where the two overlap, OSM wins: a GeoNames peak within 150 m of an OSM one
 * is the same summit under another name, and dropping it keeps one identity
 * per mountain.
 *
 * Nothing here decides what is "important enough". Every named peak goes in,
 * and each one gets an isolation — the distance to the nearest higher ground —
 * which is what the map ranks by. A 4000 m bump outside El Alto has higher
 * ground a few kilometres away and ranks near nothing; Pico da Bandeira at
 * 2890 m has none for hundreds of kilometres and ranks like the mountain it is.
 * No thresholds, no per-region rules.
 *
 * Writes:
 *   data/world-peaks.geojson   everything, for the MapTiler upload
 *   data/peaks-core.geojson    the most isolated few thousand, shipped in the
 *                              repo so the map has peaks before any tile loads
 *                              and while offline
 *
 * No dependencies — Node 18+ only. GeoNames data is CC BY 4.0, so the map
 * credits say so.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

const GEONAMES = 'https://download.geonames.org/export/dump';
const CACHE_DIR = '.cache/geonames';
const OSM_FILE = 'data/peaks.geojson';
const OUT_FILE = 'data/world-peaks.geojson';
const CORE_FILE = 'data/peaks-core.geojson';

/** GeoNames feature codes worth having: summits, not ridges or slopes. */
const PEAK_CODES = new Set(['PK', 'PKS', 'MT', 'MTS', 'VLC']);

/** A GeoNames peak this close to an OSM one is the same mountain. */
const SAME_PEAK_M = 150;

const USER_AGENT = 'my-mountaineering-jorney/1.0 (peak dataset builder; https://github.com/bpspricigo/my-mountaineering-jorney)';

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const opts = { countries: null, core: 4000 };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--countries') opts.countries = args[++i].split(',').map(c => c.trim().toUpperCase());
  else if (args[i] === '--core') opts.core = Number(args[++i]);
  else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`Usage: node scripts/build-world-peaks.mjs [--countries AR,CL] [--core 4000]`);
    process.exit(0);
  } else {
    console.error(`Unknown argument: ${args[i]}`);
    process.exit(1);
  }
}

// ─── Downloads ────────────────────────────────────────────────────────────────

async function cached(name, url) {
  const path = `${CACHE_DIR}/${name}`;
  try {
    const info = await stat(path);
    if (info.size > 0) return readFile(path);
  } catch { /* not cached yet */ }

  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(path, body);
  return body;
}

/**
 * The one file we need out of a GeoNames country zip.
 *
 * A dependency-free reader: walk the central directory at the end of the
 * archive, find the entry, then inflate it. GeoNames uses deflate (method 8)
 * or no compression at all, which is the whole of what this handles.
 */
function unzipEntry(buffer, wantedName) {
  const signature = 0x06054b50;
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== signature) end--;
  if (end < 0) throw new Error('not a zip file');

  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);

  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    if (name === wantedName) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const raw = buffer.subarray(start, start + compressedSize);
      return method === 0 ? raw : inflateRawSync(raw);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`${wantedName} not found in the archive`);
}

// ─── Sources ──────────────────────────────────────────────────────────────────

const toRadians = degrees => degrees * Math.PI / 180;

function metresBetween(a, b) {
  const dLat = toRadians(b.lat - a.lat), dLon = toRadians(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

/**
 * The same id the app derives when it meets a peak with no OSM node — position
 * to five decimals, offset above every real OSM id. One mountain, one id,
 * whichever source found it.
 */
const idFromPosition = (lon, lat) =>
  1e15 + Math.round((lat + 90) * 1e5) * 36000001 + Math.round((lon + 180) * 1e5);

async function readOsmPeaks() {
  try {
    const json = JSON.parse(await readFile(OSM_FILE, 'utf8'));
    const peaks = json.features
      .filter(f => f.properties.name)
      .map(f => ({
        id: f.properties.id,
        name: f.properties.name,
        lon: f.geometry.coordinates[0],
        lat: f.geometry.coordinates[1],
        ele: f.properties.ele,
        country: f.properties.country ?? null,
        prominence: f.properties.prominence ?? null,
        source: 'osm'
      }));
    console.log(`[world] ${peaks.length} named peaks from ${OSM_FILE}`);
    return peaks;
  } catch (err) {
    console.warn(`[world] no OSM snapshot (${err.message}) — GeoNames only`);
    return [];
  }
}

async function countryCodes() {
  const text = (await cached('countryInfo.txt', `${GEONAMES}/countryInfo.txt`)).toString('utf8');
  return text.split('\n')
    .filter(line => line && !line.startsWith('#'))
    .map(line => line.split('\t')[0])
    .filter(code => /^[A-Z]{2}$/.test(code));
}

async function readGeoNames(code) {
  const zip = await cached(`${code}.zip`, `${GEONAMES}/${code}.zip`);
  const text = unzipEntry(zip, `${code}.txt`).toString('utf8');

  const peaks = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const c = line.split('\t');
    if (c[6] !== 'T' || !PEAK_CODES.has(c[7])) continue;

    const name = c[1]?.trim();
    if (!name) continue;                       // never a nameless peak

    const lat = Number(c[4]), lon = Number(c[5]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    // The stated elevation where GeoNames has one, otherwise its SRTM reading.
    // Both columns use -9999 for "not known", and the SRTM one does so for most
    // of Antarctica; taken literally it puts mountains below the sea.
    const stated = Number(c[15]), srtm = Number(c[16]);
    const ele = [stated, srtm].find(v => Number.isFinite(v) && v > -500 && v !== 0) ?? null;
    if (ele === null) continue;                // a peak with no height cannot be ranked

    peaks.push({
      id: idFromPosition(lon, lat),
      name,
      lon, lat, ele,
      country: c[8] || null,
      state: c[10] || null,
      source: 'geonames'
    });
  }
  return peaks;
}

// ─── Merging ──────────────────────────────────────────────────────────────────

/** A grid of peaks, so "is there one within 150 m" does not scan the world. */
function grid(peaks, cellDegrees) {
  const cells = new Map();
  const key = (x, y) => `${x}:${y}`;
  for (const peak of peaks) {
    const k = key(Math.floor(peak.lon / cellDegrees), Math.floor(peak.lat / cellDegrees));
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(peak);
  }
  return {
    near(peak, metres) {
      const cx = Math.floor(peak.lon / cellDegrees), cy = Math.floor(peak.lat / cellDegrees);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const other of cells.get(key(cx + dx, cy + dy)) ?? []) {
            if (metresBetween(peak, other) <= metres) return other;
          }
        }
      }
      return null;
    }
  };
}

/**
 * Distance to the nearest higher ground, which is what a peak is ranked by.
 * Walking from the highest down and inserting as we go means every comparison
 * is against something already known to be higher.
 */
function computeIsolation(peaks) {
  const sorted = [...peaks].sort((a, b) => b.ele - a.ele);
  const CELL = 0.05;                   // degrees, ~5.5 km of latitude
  const CELL_METRES = CELL * 78000;    // worst-case span of a cell
  const cells = new Map();
  const higher = [];                   // everything already placed, all of it taller
  const key = (x, y) => `${x}:${y}`;

  for (const peak of sorted) {
    const cx = Math.floor(peak.lon / CELL), cy = Math.floor(peak.lat / CELL);
    let best = Infinity;

    for (let ring = 0; ring < 400; ring++) {
      // One ring past a hit is enough: nothing further out can be closer.
      if (best < Infinity && ring > Math.ceil(best / CELL_METRES) + 1) break;
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          for (const other of cells.get(key(cx + dx, cy + dy)) ?? []) {
            const away = metresBetween(peak, other);
            if (away < best) best = away;
          }
        }
      }
    }

    // The rings reach ~20°, which is not far enough for a mountain whose
    // nearest higher ground is on another continent: Mont Blanc's is in the
    // Caucasus. Falling back to a full scan of what is already placed keeps
    // those honest, and only the genuine outliers ever pay for it.
    if (best === Infinity && higher.length) {
      for (const other of higher) {
        const away = metresBetween(peak, other);
        if (away < best) best = away;
      }
    }

    peak.isolation = best === Infinity ? null : Math.round(best);
    const k = key(cx, cy);
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(peak);
    higher.push(peak);
  }
}

/**
 * The zoom each peak appears at, by filling tiles rather than by thresholds.
 *
 * An elevation or isolation cut-off always means something different in the
 * Andes than in the Alps — 2000 m is nothing in the Himalaya and everything in
 * Brazil. So no cut-off: walk the peaks from the most isolated down and give
 * each the first zoom whose tile still has room. Every tile ends up with at
 * most PER_TILE peaks, which means the screen holds about the same number
 * wherever you are, and the ones it holds are the ones that dominate there.
 *
 * A mountain with nothing higher anywhere — Everest — lands at the first zoom
 * it is offered, because it is first in the queue.
 */
const PER_TILE = 8;
const MIN_ZOOM = 2;
const MAX_ZOOM = 14;

function assignZooms(peaks) {
  const ranked = [...peaks].sort((a, b) =>
    (b.isolation ?? Infinity) - (a.isolation ?? Infinity) || b.ele - a.ele);
  const counts = new Map();

  for (const peak of ranked) {
    const latRad = peak.lat * Math.PI / 180;
    for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) {
      const n = 2 ** z;
      const x = Math.floor((peak.lon + 180) / 360 * n);
      const y = Math.floor(
        (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
      const k = `${z}/${x}/${y}`;
      const used = counts.get(k) ?? 0;
      if (used >= PER_TILE && z < MAX_ZOOM) continue;
      counts.set(k, used + 1);
      peak.minZoom = z;
      break;
    }
  }
}

// ─── Output ───────────────────────────────────────────────────────────────────

const asFeature = peak => ({
  type: 'Feature',
  id: peak.id,
  geometry: { type: 'Point', coordinates: [Number(peak.lon.toFixed(5)), Number(peak.lat.toFixed(5))] },
  properties: {
    id: peak.id,
    name: peak.name,
    ele: Math.round(peak.ele),
    isolation: peak.isolation,
    // "tier", not "minZoom": MapTiler strips minzoom from an uploaded tileset,
    // the name being reserved for the tileset's own metadata.
    tier: peak.minZoom,
    minZoom: peak.minZoom,
    source: peak.source,
    ...(peak.country && { country: peak.country }),
    ...(peak.state && { state: peak.state }),
    ...(peak.prominence && { prominence: peak.prominence })
  }
});

/** Streamed: the whole collection does not fit comfortably in one string. */
async function writeCollection(path, peaks, extra) {
  const out = createWriteStream(path);
  const write = chunk => new Promise((resolve, reject) =>
    out.write(chunk, err => (err ? reject(err) : resolve())));

  await write('{\n  "type": "FeatureCollection",\n');
  await write(`  "generated": ${JSON.stringify(new Date().toISOString().slice(0, 10))},\n`);
  await write(`  "attribution": ${JSON.stringify(extra.attribution)},\n`);
  await write(`  "count": ${peaks.length},\n`);
  await write('  "features": [\n');
  for (let i = 0; i < peaks.length; i++) {
    await write(`    ${JSON.stringify(asFeature(peaks[i]))}${i === peaks.length - 1 ? '' : ','}\n`);
  }
  await write('  ]\n}\n');
  await new Promise(resolve => out.end(resolve));
}

// ─── Run ──────────────────────────────────────────────────────────────────────

const started = Date.now();
const osm = await readOsmPeaks();
const codes = opts.countries ?? await countryCodes();
console.log(`[world] ${codes.length} countries from GeoNames`);

const osmGrid = grid(osm, 0.05);
const all = [...osm];
const seen = grid(all, 0.05);
let fromGeoNames = 0, sameAsOsm = 0, duplicates = 0, failed = 0;

for (const [i, code] of codes.entries()) {
  let peaks;
  try {
    peaks = await readGeoNames(code);
  } catch (err) {
    console.warn(`[world] ${code}: ${err.message}`);
    failed++;
    continue;
  }

  let kept = 0;
  for (const peak of peaks) {
    if (osmGrid.near(peak, SAME_PEAK_M)) { sameAsOsm++; continue; }
    const twin = seen.near(peak, 60);
    if (twin && twin.name === peak.name) { duplicates++; continue; }
    all.push(peak);
    kept++;
  }
  fromGeoNames += kept;
  if (kept) console.log(`[world] ${code}: +${kept}${peaks.length - kept ? ` (${peaks.length - kept} already known)` : ''}  [${i + 1}/${codes.length}]`);
}

console.log(`[world] ${all.length} peaks: ${osm.length} from OSM, ${fromGeoNames} from GeoNames` +
  ` (${sameAsOsm} were the same summit, ${duplicates} duplicates, ${failed} countries failed)`);

const t0 = Date.now();
computeIsolation(all);
assignZooms(all);
console.log(`[world] isolation and zooms computed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const attribution = 'Peak data © OpenStreetMap contributors (ODbL) and GeoNames (CC BY 4.0)';
await writeCollection(OUT_FILE, all, { attribution });

const core = [...all].sort((a, b) => (b.isolation ?? Infinity) - (a.isolation ?? Infinity)).slice(0, opts.core);
await writeCollection(CORE_FILE, core, { attribution });

const size = async path => `${((await stat(path)).size / 1024 / 1024).toFixed(1)} MB`;
console.log(`[world] wrote ${OUT_FILE} (${await size(OUT_FILE)}) and ${CORE_FILE} (${await size(CORE_FILE)})`);
console.log(`[world] highest per source: ` +
  ['osm', 'geonames'].map(s => {
    const top = all.filter(p => p.source === s).sort((a, b) => b.ele - a.ele)[0];
    return top ? `${s} ${top.name} ${top.ele} m` : `${s} none`;
  }).join(' | '));
console.log(`[world] done in ${((Date.now() - started) / 1000).toFixed(0)}s`);
