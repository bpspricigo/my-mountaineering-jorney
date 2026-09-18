#!/usr/bin/env node
/**
 * Fetches peaks from OpenStreetMap via the Overpass API and writes a snapshot
 * to data/peaks.geojson.
 *
 * The app reads that snapshot directly — it never talks to Overpass at runtime,
 * which keeps the Peaks tab instant and works offline. Re-run this by hand when
 * the area of interest grows.
 *
 *   node scripts/fetch-peaks.mjs
 *   node scripts/fetch-peaks.mjs --bbox 46.0,10.0,48.0,13.0 --min-ele 1500
 *   node scripts/fetch-peaks.mjs --include-unnamed --out data/peaks-wide.geojson
 *
 * Data © OpenStreetMap contributors, ODbL.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/**
 * Two regions with different elevation floors, because "what can I do on a
 * Saturday" and "what is worth a week's planning" are different questions.
 *
 * Home keeps the local 1200 m hills that make up most of the journal; the wider
 * Eastern Alps only contributes serious objectives, which is what stops the
 * snapshot ballooning to thousands of nondescript ridge bumps.
 */
const REGIONS = [
  { name: 'home',         bbox: '47.15,10.75,47.95,12.45', minEle: 1500 },
  // West edge at 9.45°E, not 9.8°E: the old line ran through the Rätikon and
  // left Liechtenstein under the 3000 m rule, with no peaks at all.
  { name: 'eastern-alps', bbox: '46.4,9.45,48.0,13.6',     minEle: 2500 },

  // The Dolomites deserve a lower floor than the rest of the east. Much of the
  // walking there — Col di Lana, Monte Serva above Belluno — is 2000–2500 m,
  // and eastern-alps stops at 46.4°N, which cuts through the range: the Pala
  // group, Agnèr and the Belluno Dolomites fell below it with nothing to catch
  // them under 3000 m. Also takes in Brenta, Lagorai and the Sarntal Alps.
  { name: 'dolomites',    bbox: '46.0,10.7,46.8,12.8',     minEle: 2000 },

  // The whole Alpine arc, 3000 m and up. Split into strips because the arc as a
  // single box took 133 s of a 300 s budget — close enough to the ceiling that
  // a busy day would push it over.
  { name: 'alps-3000-west',   bbox: '43.3,5.0,47.0,8.0',   minEle: 3000 },
  { name: 'alps-3000-central', bbox: '44.0,8.0,47.5,11.0', minEle: 3000 },
  { name: 'alps-3000-east',   bbox: '45.5,11.0,48.5,16.5', minEle: 3000 },

  // Height alone misses mountains that matter. Triglav is Slovenia's highest
  // summit and one of the best-known objectives in the Alps, but at 2864 m it
  // fell between every rule above: 2.4 km outside the eastern-alps box, and
  // 136 m under the 3000 m floor of the box it does sit in. Slovenia ended up
  // with no peaks at all while 1500 m wooded hills near Munich were included.
  //
  // Prominence — how far you must descend before climbing something higher —
  // is what marks a range high point. Triglav's is 2048 m. Requiring 300 m adds
  // only ~370 peaks across the whole arc, so this stays a rule about
  // significance rather than an excuse to bulk the file out.
  { name: 'notable', bbox: '43.3,5.0,48.5,16.5', minEle: 1500, minProminence: 300 }
];

const DEFAULTS = {
  regions: REGIONS,
  countries: ['DE', 'AT', 'IT', 'CH', 'FR', 'SI', 'LI'],
  out: 'data/peaks.geojson',
  statusFile: 'data/peak-status.json',
  includeUnnamed: false
};

// The public instances are free and shared, so any of them can be busy at any
// moment. Try them in turn rather than failing the whole run on one 504.
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];
// The main instance is the only one that reliably answers the country-area
// queries; the mirrors time out on them. So give it several patient attempts
// before falling back, rather than treating all three as equals.
const ATTEMPTS_PER_ENDPOINT = 3;
const RATE_LIMIT_WAIT_MS = 45000;
const BUSY_WAIT_MS = 8000;
const USER_AGENT = 'my-mountaineering-jorney/1.0 (peak snapshot importer; https://github.com/bpspricigo/my-mountaineering-jorney)';

// ─── Args ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  let bbox = null;
  let minEle = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--bbox') bbox = argv[++i];
    else if (arg === '--min-ele') minEle = Number(argv[++i]);
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--countries') opts.countries = argv[++i].split(',').map(c => c.trim()).filter(Boolean);
    else if (arg === '--include-unnamed') opts.includeUnnamed = true;
    else if (arg === '--no-keep-tagged') opts.statusFile = null;
    else if (arg === '--no-cache') cacheEnabled = false;
    else if (arg === '--help' || arg === '-h') { usage(); process.exit(0); }
    else { console.error(`Unknown argument: ${arg}`); usage(); process.exit(1); }
  }

  // A --bbox or --min-ele on the command line replaces the configured regions
  // with the single ad-hoc one being asked for.
  if (bbox !== null || minEle !== null) {
    opts.regions = [{
      name: 'custom',
      bbox: bbox ?? REGIONS[0].bbox,
      minEle: minEle ?? 0
    }];
  }

  for (const region of opts.regions) {
    const parts = region.bbox.split(',').map(Number);
    if (parts.length !== 4 || parts.some(Number.isNaN)) {
      console.error(`Invalid bbox "${region.bbox}" for region "${region.name}" — expected south,west,north,east`);
      process.exit(1);
    }
    if (!Number.isFinite(region.minEle)) {
      console.error(`Invalid minEle for region "${region.name}" — expected a number`);
      process.exit(1);
    }
  }
  return opts;
}

function usage() {
  const regions = DEFAULTS.regions
    .map(r => `                        ${r.name}: ${r.bbox} above ${r.minEle} m` +
              (r.minProminence ? ` and prominence >= ${r.minProminence} m` : ''))
    .join('\n');
  console.log(`
Usage: node scripts/fetch-peaks.mjs [options]

Without arguments, fetches the regions configured in this file:
${regions}

  --bbox S,W,N,E      Query this box instead of the configured regions
  --min-ele METRES    Elevation floor for --bbox
  --countries A,B     ISO codes to tag peaks by  (default ${DEFAULTS.countries.join(',')})
  --include-unnamed   Keep peaks with no name    (default: named only)
  --no-keep-tagged    Do not force-include peaks already tagged in
                      ${DEFAULTS.statusFile}
  --no-cache          Ignore cached Overpass responses in ${CACHE_DIR}
  --out PATH          Output file                (default ${DEFAULTS.out})
`.trim());
}

// ─── Overpass ─────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * A full run is a dozen slow queries against a free service that is often busy,
 * and failing on the last one used to mean refetching all of them. Responses
 * are cached on disk by query, so a re-run only pays for what did not succeed.
 */
const CACHE_DIR = '.cache/overpass';
let cacheEnabled = true;

const cachePath = query =>
  `${CACHE_DIR}/${createHash('sha1').update(query).digest('hex').slice(0, 16)}.json`;

async function readCache(query) {
  if (!cacheEnabled) return null;
  try {
    return JSON.parse(await readFile(cachePath(query), 'utf8'));
  } catch {
    return null;
  }
}

async function writeCache(query, elements) {
  if (!cacheEnabled) return;
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cachePath(query), JSON.stringify({ query, elements }), 'utf8');
  } catch (err) {
    console.warn(`[cache] could not write: ${err.message}`);
  }
}

/**
 * `expectNonEmpty` guards the country lookups. A mirror can answer a country
 * query with an empty set and no remark — a Swiss lookup came back with zero
 * peaks while Piz Morteratsch sat in the results with no country at all. An
 * empty answer is only believed when every endpoint agrees on it.
 */
async function overpass(query, label, { expectNonEmpty = false } = {}) {
  const hit = await readCache(query);
  if (hit) {
    console.log(`[overpass] ${label} → ${hit.elements.length} elements (cached)`);
    return hit.elements;
  }

  const failures = [];
  let emptyAnswers = 0;

  for (const endpoint of ENDPOINTS) {
    for (let attempt = 1; attempt <= ATTEMPTS_PER_ENDPOINT; attempt++) {
      const host = new URL(endpoint).host;
      console.log(`[overpass] ${label} via ${host}${attempt > 1 ? ` (retry ${attempt - 1})` : ''}…`);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
          body: new URLSearchParams({ data: query })
        });
        if (!res.ok) {
          // 429 (rate limit) and 504 (server busy) are worth another go; the
          // rest — a bad query, mostly — will fail identically every time.
          const retryable = res.status === 429 || res.status === 504;
          const detail = `HTTP ${res.status} ${res.statusText}`;
          if (!retryable) {
            const body = await res.text().catch(() => '');
            throw new Error(`Overpass rejected "${label}": ${detail}\n${body.slice(0, 500)}`);
          }
          failures.push(`${host}: ${detail}`);
          // 429 means this client has used up its slots — a few seconds is not
          // enough, and moving to a weaker mirror only trades it for a timeout.
          const wait = res.status === 429 ? RATE_LIMIT_WAIT_MS : BUSY_WAIT_MS;
          console.log(`[overpass] ${host} busy (${detail}) — waiting ${wait / 1000}s`);
          await sleep(wait);
          continue;
        }
        const json = await res.json();

        // A server-side timeout comes back as HTTP 200 with an empty element
        // list and a `remark`. Without this check the run "succeeds" having
        // silently dropped everything the query was supposed to return.
        if (json.remark) {
          failures.push(`${host}: ${json.remark}`);
          console.log(`[overpass] ${host} returned a remark: ${json.remark}`);
          await sleep(5000);
          continue;
        }

        const elements = json.elements ?? [];

        if (expectNonEmpty && elements.length === 0) {
          emptyAnswers++;
          failures.push(`${host}: empty result`);
          console.log(`[overpass] ${host} returned nothing for "${label}" — trying elsewhere`);
          await sleep(3000);
          continue;
        }

        console.log(`[overpass] ${label} → ${elements.length} elements`);
        await writeCache(query, elements);
        return elements;
      } catch (err) {
        if (err.message?.startsWith('Overpass rejected')) throw err;
        failures.push(`${host}: ${err.message}`);
        console.log(`[overpass] ${host} failed: ${err.message}`);
        await sleep(5000);
      }
    }
  }

  // Every endpoint that answered at all said "nothing here", so believe them:
  // the country genuinely does not reach into this bbox.
  if (expectNonEmpty && emptyAnswers === failures.length) {
    console.log(`[overpass] ${label} → 0 elements (every endpoint agrees)`);
    await writeCache(query, []);
    return [];
  }

  throw new Error(`All Overpass endpoints failed for "${label}":\n  ${failures.join('\n  ')}`);
}

/**
 * Every named peak in the bbox above the floor.
 *
 * The floor is applied server-side so the Alpine arc returns ~4k nodes instead
 * of well over a hundred thousand. `number()` reads "3.798" — a German
 * thousands separator — as 3.798, so anything that parses below 10 m is pulled
 * in too and re-parsed properly on this side. (No such tag exists in the
 * regions checked so far: 18404 cached tags, none in that format.)
 */
function peaksQuery(bbox, minEle, includeUnnamed, minProminence = null) {
  const named = includeUnnamed ? '' : '["name"]';

  if (minProminence !== null) {
    // A significance rule rather than a height one: only peaks OSM records as
    // rising well clear of their surroundings.
    return `[out:json][timeout:300];
node["natural"="peak"]["ele"]${named}["prominence"](if:number(t["prominence"]) >= ${minProminence} && number(t["ele"]) >= ${minEle})(${bbox});
out body;`;
  }

  const floor = `(if:number(t["ele"]) >= ${minEle} || number(t["ele"]) < 10)`;
  return `[out:json][timeout:300];
node["natural"="peak"]["ele"]${named}${floor}(${bbox});
out body;`;
}

/** Specific nodes by id, wherever they are and however low they are. */
function idsQuery(ids) {
  return `[out:json][timeout:120];
node(id:${ids.join(',')});
out body;`;
}

/**
 * The boundary relation behind each ISO code, with its bounding box so that
 * country/region pairs that cannot overlap are never queried.
 */
function countryRelationsQuery(isoCodes) {
  return `[out:json][timeout:60];
rel["ISO3166-1"~"^(${isoCodes.join('|')})$"]["admin_level"="2"]["boundary"="administrative"];
out ids tags bb;`;
}

/**
 * Ids of the peaks inside one country's boundary. Overpass resolves the country
 * relation to an area, so this is a real point-in-polygon test rather than a
 * guess from the coordinates — border ridges get the right side.
 *
 * The area is addressed by id rather than by ISO tag: resolving the tag made
 * Germany time out on every endpoint, while the id form answers in ~20 s.
 */
function countryQuery(bbox, areaId, minEle) {
  const floor = `(if:number(t["ele"]) >= ${minEle} || number(t["ele"]) < 10)`;
  return `[out:json][timeout:300];
area(${areaId})->.country;
node(area.country)["natural"="peak"]["ele"]${floor}(${bbox});
out ids;`;
}

/** Overpass turns relation N into area 3600000000 + N. */
const AREA_ID_OFFSET = 3600000000;

// ─── Tag parsing ──────────────────────────────────────────────────────────────

/**
 * OSM `ele` is free text: "1261", "1261 m", "2.061" (German thousands dot),
 * "1,261", even "ca. 1800". Pull out the first plausible number and reject
 * anything that cannot be a summit elevation.
 */
function parseElevation(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  let text = String(raw).trim().replace(/\s*(m|meter|metres|meters)\b\.?/i, '');
  // A dot or comma used as a thousands separator: 2.061 / 2,061 → 2061.
  text = text.replace(/^(\d{1,2})[.,](\d{3})$/, '$1$2');
  text = text.replace(',', '.');
  const match = text.match(/-?\d+(\.\d+)?/);
  if (!match) return null;
  const value = Math.round(Number(match[0]));
  if (!Number.isFinite(value) || value < 0 || value > 9000) return null;
  return value;
}

const round5 = n => Math.round(n * 1e5) / 1e5;

// ─── Isolation and display rank ───────────────────────────────────────────────

function distanceMetres(a, b) {
  const R = 6371000;
  const rad = d => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Isolation: how far you must travel from a summit to reach higher ground.
 *
 * It is what separates a mountain from a bump on the side of one. Kleinglockner
 * is 3770 m — only 28 m below Großglockner — but its isolation is 70 m, while
 * Großglockner's is 175 km. Elevation cannot tell those two apart; this can.
 *
 * Peaks are walked from the top down, each one added to a coarse grid after it
 * is processed, so the grid always holds exactly the peaks higher than the one
 * being measured and the nearest can be found by widening a ring of cells.
 */
function computeIsolation(peaks) {
  const sorted = [...peaks].sort((a, b) => b.ele - a.ele);
  const CELL = 0.05;                    // degrees; ~5.5 km of latitude
  const CELL_METRES = CELL * 78000;     // worst-case cell span in this latitude band
  const grid = new Map();
  const key = (x, y) => `${x}:${y}`;

  for (const peak of sorted) {
    const cx = Math.floor(peak.lon / CELL);
    const cy = Math.floor(peak.lat / CELL);
    let best = Infinity;

    for (let ring = 0; ring < 400; ring++) {
      // Stop one ring after a hit: nothing in a further ring can be closer.
      if (best < Infinity && ring > Math.ceil(best / CELL_METRES) + 1) break;

      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const bucket = grid.get(key(cx + dx, cy + dy));
          if (!bucket) continue;
          for (const other of bucket) {
            const d = distanceMetres(peak, other);
            if (d < best) best = d;
          }
        }
      }
    }

    // The highest peak in the set has nothing above it anywhere.
    peak.isolation = best === Infinity ? null : Math.round(best);

    const k = key(cx, cy);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(peak);
  }
}

/**
 * The zoom at which a peak starts being drawn, from isolation alone.
 *
 * Elevation deliberately gets no say. An earlier version let anything above
 * 3500 m show early, which put twelve summits on screen around Großglockner at
 * z9 — the Glockner massif's towers are all ~3700 m and 50 m apart, exactly the
 * clutter this is meant to remove.
 */
const ZOOM_LADDER = [
  [40000, 6],
  [15000, 8],
  [7000, 9],
  [3500, 10],
  [1750, 11],
  [900, 12],
  [450, 13]
];
const MAX_ZOOM_TIER = 14;

function minZoomFor(isolation) {
  if (isolation === null) return ZOOM_LADDER[0][1];   // nothing higher exists
  for (const [metres, zoom] of ZOOM_LADDER) {
    if (isolation >= metres) return zoom;
  }
  return MAX_ZOOM_TIER;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function toPeak(node, tags) {
  return {
    id: node.id,
    name: tags.name?.trim() || null,
    ele: parseElevation(tags.ele),
    lat: round5(node.lat),
    lon: round5(node.lon),
    countries: new Set(),
    prominence: parseElevation(tags.prominence),
    wikidata: tags.wikidata ?? null,
    wikipedia: tags.wikipedia ?? null
  };
}

/** The smallest box containing every region, for the country lookups. */
function unionBbox(regions) {
  const boxes = regions.map(r => r.bbox.split(',').map(Number));
  return [
    Math.min(...boxes.map(b => b[0])),
    Math.min(...boxes.map(b => b[1])),
    Math.max(...boxes.map(b => b[2])),
    Math.max(...boxes.map(b => b[3]))
  ].join(',');
}

/**
 * Peaks already marked dream/planned/done must survive whatever the elevation
 * floor is, or raising it would orphan them: the status file would point at
 * peaks the map no longer knows about.
 */
async function keepTagged(peaks, statusFile, includeUnnamed) {
  let status;
  try {
    status = JSON.parse(await readFile(statusFile, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[peaks] could not read ${statusFile}: ${err.message}`);
    return;
  }

  const tagged = Object.entries(status.peaks ?? {})
    .filter(([, entry]) => entry?.status && entry.status !== 'none')
    .map(([id]) => id);
  const missing = tagged.filter(id => !peaks.has(Number(id)));

  if (!missing.length) {
    console.log(`[peaks] all ${tagged.length} tagged peaks are already in range`);
    return;
  }

  console.log(`[peaks] ${missing.length} tagged peaks fell outside the regions — fetching them by id`);
  await sleep(1500);
  const nodes = await overpass(idsQuery(missing), 'tagged peaks by id');

  for (const node of nodes) {
    const tags = node.tags ?? {};
    const peak = toPeak(node, tags);
    if (peak.ele === null) {
      console.warn(`[peaks]   node ${node.id} has no usable elevation — skipped`);
      continue;
    }
    if (!peak.name && !includeUnnamed) peak.name = `Peak ${node.id}`;
    peak.keptBecauseTagged = true;

    // The country lookups only cover peaks above the lowest region floor, and
    // this one is below it by definition. Its status entry already knows where
    // it is, which beats lowering the floor and doubling every country query.
    const recorded = status.peaks?.[String(node.id)]?.country;
    if (recorded) {
      for (const iso of String(recorded).split('/')) peak.countries.add(iso);
    }

    peaks.set(node.id, peak);
    console.log(`[peaks]   kept ${peak.name} ${peak.ele} m${recorded ? ` (${recorded}, from its status entry)` : ''}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log('[peaks] regions:');
  for (const r of opts.regions) {
    const rule = r.minProminence ? ` and prominence >= ${r.minProminence} m` : '';
    console.log(`          ${r.name}: ${r.bbox} above ${r.minEle} m${rule}`);
  }
  console.log(`[peaks] named-only=${!opts.includeUnnamed}
`);

  const peaks = new Map();
  const dropped = { noElevation: 0, tooLow: 0, unnamed: 0 };

  for (const [index, region] of opts.regions.entries()) {
    if (index > 0) await sleep(1500);
    const nodes = await overpass(
      peaksQuery(region.bbox, region.minEle, opts.includeUnnamed, region.minProminence ?? null),
      `peaks in ${region.name}`
    );
    let kept = 0;

    for (const node of nodes) {
      const tags = node.tags ?? {};
      const peak = toPeak(node, tags);
      if (peak.ele === null) { dropped.noElevation++; continue; }
      if (peak.ele < region.minEle) { dropped.tooLow++; continue; }
      if (!peak.name && !opts.includeUnnamed) { dropped.unnamed++; continue; }
      // Overlapping regions: the first (lower floor) wins, which is what keeps
      // the local hills inside the wider high-altitude box.
      if (!peaks.has(node.id)) { peaks.set(node.id, peak); kept++; }
    }

    console.log(`[peaks] ${region.name}: kept ${kept} (running total ${peaks.size})
`);
  }

  console.log(`[peaks] dropped ${dropped.noElevation} without elevation, ` +
              `${dropped.tooLow} below their region floor, ${dropped.unnamed} unnamed`);

  if (opts.statusFile) await keepTagged(peaks, opts.statusFile, opts.includeUnnamed);

  const bbox = unionBbox(opts.regions);
  const unresolved = [];

  // One cheap lookup turns the ISO codes into boundary relation ids, so the
  // expensive per-country queries can address the area directly.
  const areaIds = new Map();
  const countryBounds = new Map();
  try {
    const relations = await overpass(countryRelationsQuery(opts.countries), 'country boundaries', { expectNonEmpty: true });
    for (const rel of relations) {
      const iso = rel.tags?.['ISO3166-1'];
      if (!iso) continue;
      areaIds.set(iso, AREA_ID_OFFSET + rel.id);
      if (rel.bounds) countryBounds.set(iso, rel.bounds);
    }
    console.log(`[peaks] resolved boundaries: ${[...areaIds].map(([iso, id]) => `${iso}=${id}`).join(' ')}`);
  } catch (err) {
    console.warn(`[peaks] ⚠ could not resolve country boundaries: ${err.message.split('\n')[0]}`);
  }

  const [south, west, north, east] = bbox.split(',').map(Number);
  const lowestFloor = Math.min(...opts.regions.map(r => r.minEle));

  for (const iso of opts.countries) {
    const areaId = areaIds.get(iso);
    if (!areaId) {
      console.warn(`[peaks] ⚠ no boundary relation for ${iso} — skipping`);
      unresolved.push(iso);
      continue;
    }

    // Liechtenstein does not reach the western Alps, and France does not reach
    // the eastern ones. Skipping the pairs that cannot overlap saves several
    // minutes of queries that could only ever return nothing.
    const bounds = countryBounds.get(iso);
    // France's relation covers its overseas territories, so Overpass reports a
    // longitude range that wraps the antimeridian (minlon 0.0002, maxlon
    // -0.0013). Read naively that says "entirely west of the Alps", which
    // silently left every French summit without a country. A wrapped or
    // malformed box means "could be anywhere" — always query it.
    const wrapsAntimeridian = bounds && bounds.maxlon < bounds.minlon;
    const clearlyElsewhere = bounds && !wrapsAntimeridian &&
      (bounds.maxlat < south || bounds.minlat > north ||
       bounds.maxlon < west || bounds.minlon > east);

    if (clearlyElsewhere) {
      console.log(`[peaks] ${iso}: outside the queried area — skipped`);
      continue;
    }

    await sleep(1500); // be a good citizen on a free, shared endpoint
    let inCountry;
    try {
      inCountry = await overpass(countryQuery(bbox, areaId, lowestFloor), `peaks in ${iso}`, { expectNonEmpty: true });
    } catch (err) {
      // Losing one country's labels is worth far less than throwing away every
      // peak fetched so far, so carry on — but say so loudly, and record it in
      // the file so a degraded snapshot cannot be mistaken for a complete one.
      console.warn(`[peaks] ⚠ could not resolve ${iso}: ${err.message.split('\n')[0]}`);
      unresolved.push(iso);
      continue;
    }
    let tagged = 0;
    for (const { id } of inCountry) {
      const peak = peaks.get(id);
      if (peak) { peak.countries.add(iso); tagged++; }
    }
    console.log(`[peaks] ${iso}: tagged ${tagged}`);
  }

  const stateless = [...peaks.values()].filter(p => p.countries.size === 0).length;
  if (stateless) console.log(`[peaks] ${stateless} peaks matched no country (outside ${opts.countries.join('/')} or exactly on a border)`);

  const t0 = Date.now();
  computeIsolation([...peaks.values()]);
  console.log(`[peaks] isolation computed for ${peaks.size} peaks in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const features = [...peaks.values()]
    .sort((a, b) => b.ele - a.ele || (a.name ?? '').localeCompare(b.name ?? ''))
    .map(p => ({
      type: 'Feature',
      id: p.id,
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      properties: {
        id: p.id,
        name: p.name,
        ele: p.ele,
        // Distance to the nearest higher peak, and the zoom it earns from it.
        isolation: p.isolation,
        minZoom: minZoomFor(p.isolation),
        country: p.countries.size ? [...p.countries].sort().join('/') : null,
        ...(p.prominence !== null && { prominence: p.prominence }),
        ...(p.wikidata && { wikidata: p.wikidata }),
        ...(p.wikipedia && { wikipedia: p.wikipedia }),
        ...(p.keptBecauseTagged && { keptBecauseTagged: true })
      }
    }));

  const collection = {
    type: 'FeatureCollection',
    generated: new Date().toISOString().slice(0, 10),
    query: {
      regions: opts.regions.map(({ name, bbox: box, minEle }) => ({ name, bbox: box, minEle })),
      namedOnly: !opts.includeUnnamed,
      countries: opts.countries,
      ...(unresolved.length && { unresolvedCountries: unresolved })
    },
    attribution: '© OpenStreetMap contributors (ODbL)',
    features
  };

  const { features: _features, ...head } = collection;
  const headJson = JSON.stringify(head, null, 2).replace(/\n}$/, '');
  // One feature per line: still valid JSON, but a re-run produces a diff you can
  // actually read instead of one giant changed line.
  const body = features.map(f => '    ' + JSON.stringify(f)).join(',\n');
  await writeFile(opts.out, `${headJson},\n  "features": [\n${body}\n  ]\n}\n`, 'utf8');

  console.log(`\n[peaks] wrote ${features.length} peaks → ${opts.out}`);
  summarise(features);

  if (unresolved.length) {
    console.warn(`\n[peaks] ⚠ THIS SNAPSHOT IS INCOMPLETE — no country resolved for ${unresolved.join(', ')}.`);
    console.warn('[peaks]   Those peaks carry a null country and match no country filter.');
    console.warn('[peaks]   Re-run to fix it; cached responses make the retry cheap.');
    process.exitCode = 2;
  }
}

/**
 * The first run of this script produced a snapshot of "Bavaria and Tirol" whose
 * highest peak was 2884 m — no Zugspitze, no Grossglockner, because the bbox was
 * drawn around the existing journal entries. Printing the highest peak per
 * country makes that class of mistake obvious instead of invisible.
 */
function summarise(features) {
  const byCountry = new Map();
  for (const f of features) {
    for (const iso of (f.properties.country ?? '??').split('/')) {
      const best = byCountry.get(iso);
      if (!best || f.properties.ele > best.properties.ele) byCountry.set(iso, f);
    }
  }
  console.log('[peaks] highest per country:');
  for (const [iso, f] of [...byCountry].sort((a, b) => b[1].properties.ele - a[1].properties.ele)) {
    console.log(`          ${iso}: ${f.properties.name} ${f.properties.ele} m`);
  }
  console.log('[peaks] sanity-check those against the real highest summits of each country.');

  console.log('[peaks] peaks drawn at each zoom:');
  for (let z = ZOOM_LADDER[0][1]; z <= MAX_ZOOM_TIER; z++) {
    const n = features.filter(f => f.properties.minZoom <= z).length;
    if (n) console.log(`          z${String(z).padStart(2)}: ${n}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
