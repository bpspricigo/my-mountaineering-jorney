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

import { writeFile } from 'node:fs/promises';

// Bavarian Prealps / Karwendel / Tirol — the area the journal already covers.
const DEFAULTS = {
  bbox: '47.2,11.0,47.9,12.3',   // south,west,north,east
  minEle: 1000,
  countries: ['DE', 'AT', 'IT', 'CH'],
  out: 'data/peaks.geojson',
  includeUnnamed: false
};

// The public instances are free and shared, so any of them can be busy at any
// moment. Try them in turn rather than failing the whole run on one 504.
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];
const ATTEMPTS_PER_ENDPOINT = 2;
const USER_AGENT = 'my-mountaineering-jorney/1.0 (peak snapshot importer; https://github.com/bpspricigo/my-mountaineering-jorney)';

// ─── Args ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--bbox') opts.bbox = argv[++i];
    else if (arg === '--min-ele') opts.minEle = Number(argv[++i]);
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--countries') opts.countries = argv[++i].split(',').map(c => c.trim()).filter(Boolean);
    else if (arg === '--include-unnamed') opts.includeUnnamed = true;
    else if (arg === '--help' || arg === '-h') { usage(); process.exit(0); }
    else { console.error(`Unknown argument: ${arg}`); usage(); process.exit(1); }
  }
  const parts = opts.bbox.split(',').map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) {
    console.error(`Invalid --bbox "${opts.bbox}" — expected south,west,north,east`);
    process.exit(1);
  }
  if (!Number.isFinite(opts.minEle)) {
    console.error('Invalid --min-ele — expected a number');
    process.exit(1);
  }
  return opts;
}

function usage() {
  console.log(`
Usage: node scripts/fetch-peaks.mjs [options]

  --bbox S,W,N,E      Bounding box to query      (default ${DEFAULTS.bbox})
  --min-ele METRES    Drop peaks below this      (default ${DEFAULTS.minEle})
  --countries A,B     ISO codes to tag peaks by  (default ${DEFAULTS.countries.join(',')})
  --include-unnamed   Keep peaks with no name    (default: named only)
  --out PATH          Output file                (default ${DEFAULTS.out})
`.trim());
}

// ─── Overpass ─────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function overpass(query, label) {
  const failures = [];

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
          console.log(`[overpass] ${host} busy (${detail})`);
          await sleep(5000);
          continue;
        }
        const json = await res.json();
        console.log(`[overpass] ${label} → ${json.elements?.length ?? 0} elements`);
        return json.elements ?? [];
      } catch (err) {
        if (err.message?.startsWith('Overpass rejected')) throw err;
        failures.push(`${host}: ${err.message}`);
        console.log(`[overpass] ${host} failed: ${err.message}`);
        await sleep(5000);
      }
    }
  }

  throw new Error(`All Overpass endpoints failed for "${label}":\n  ${failures.join('\n  ')}`);
}

/** Every peak node in the bbox that carries an elevation. */
function peaksQuery(bbox) {
  return `[out:json][timeout:120];
node["natural"="peak"]["ele"](${bbox});
out body;`;
}

/**
 * Ids of the peaks inside one country's boundary. Overpass resolves the country
 * relation to an area, so this is a real point-in-polygon test rather than a
 * guess from the coordinates — border ridges get the right side.
 */
function countryQuery(bbox, iso) {
  return `[out:json][timeout:180];
area["ISO3166-1"="${iso}"]["admin_level"="2"]->.country;
node(area.country)["natural"="peak"]["ele"](${bbox});
out ids;`;
}

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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`[peaks] bbox=${opts.bbox} minEle=${opts.minEle}m named-only=${!opts.includeUnnamed}`);

  const nodes = await overpass(peaksQuery(opts.bbox), 'peaks in bbox');

  const dropped = { noElevation: 0, tooLow: 0, unnamed: 0 };
  const peaks = new Map();

  for (const node of nodes) {
    const tags = node.tags ?? {};
    const ele = parseElevation(tags.ele);
    if (ele === null) { dropped.noElevation++; continue; }
    if (ele < opts.minEle) { dropped.tooLow++; continue; }
    const name = tags.name?.trim();
    if (!name && !opts.includeUnnamed) { dropped.unnamed++; continue; }

    peaks.set(node.id, {
      id: node.id,
      name: name || null,
      ele,
      lat: round5(node.lat),
      lon: round5(node.lon),
      countries: new Set(),
      prominence: parseElevation(tags.prominence),
      wikidata: tags.wikidata ?? null,
      wikipedia: tags.wikipedia ?? null
    });
  }

  console.log(`[peaks] kept ${peaks.size} — dropped ${dropped.noElevation} without elevation, ` +
              `${dropped.tooLow} below ${opts.minEle}m, ${dropped.unnamed} unnamed`);

  for (const iso of opts.countries) {
    await sleep(1500); // be a good citizen on a free, shared endpoint
    const inCountry = await overpass(countryQuery(opts.bbox, iso), `peaks in ${iso}`);
    let tagged = 0;
    for (const { id } of inCountry) {
      const peak = peaks.get(id);
      if (peak) { peak.countries.add(iso); tagged++; }
    }
    console.log(`[peaks] ${iso}: tagged ${tagged}`);
  }

  const stateless = [...peaks.values()].filter(p => p.countries.size === 0).length;
  if (stateless) console.log(`[peaks] ${stateless} peaks matched no country (outside ${opts.countries.join('/')} or exactly on a border)`);

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
        country: p.countries.size ? [...p.countries].sort().join('/') : null,
        ...(p.prominence !== null && { prominence: p.prominence }),
        ...(p.wikidata && { wikidata: p.wikidata }),
        ...(p.wikipedia && { wikipedia: p.wikipedia })
      }
    }));

  const collection = {
    type: 'FeatureCollection',
    generated: new Date().toISOString().slice(0, 10),
    query: { bbox: opts.bbox, minEle: opts.minEle, namedOnly: !opts.includeUnnamed, countries: opts.countries },
    attribution: '© OpenStreetMap contributors (ODbL)',
    features
  };

  // One feature per line: still valid JSON, but a re-run produces a diff you can
  // actually read instead of one giant changed line.
  const { features: _features, ...head } = collection;
  const headJson = JSON.stringify(head, null, 2).replace(/\n}$/, '');
  const body = features.map(f => '    ' + JSON.stringify(f)).join(',\n');
  await writeFile(opts.out, `${headJson},\n  "features": [\n${body}\n  ]\n}\n`, 'utf8');

  console.log(`[peaks] wrote ${features.length} peaks → ${opts.out}`);
  const highest = features[0];
  if (highest) console.log(`[peaks] highest: ${highest.properties.name} ${highest.properties.ele} m (${highest.properties.country ?? '—'})`);
}

main().catch(err => { console.error(err); process.exit(1); });
