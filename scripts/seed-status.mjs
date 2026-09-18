#!/usr/bin/env node
/**
 * One-off migration: turns summits/summits.json into data/peak-status.json,
 * so every peak already climbed shows up as `done` in the planner.
 *
 * Summits are matched to OSM peaks by proximity, not by name — OSM spells one
 * of them "Brunnsteinspitze" where summits.json says "Brunnensteinspitze", and
 * two distinct peaks in the snapshot share the name "Rotwandlspitze". The name
 * is only used to break ties between candidates at a similar distance.
 *
 *   node scripts/seed-status.mjs            # report only
 *   node scripts/seed-status.mjs --write    # write data/peak-status.json
 *
 * Existing entries in data/peak-status.json are preserved; this only fills in
 * summits that are not tracked yet.
 */

import { readFile, writeFile } from 'node:fs/promises';

const PEAKS = 'data/peaks.geojson';
const SUMMITS = 'summits/summits.json';
const OUT = 'data/peak-status.json';

const MATCH_RADIUS_M = 300;   // a summit further than this is not the same peak
const ELE_TOLERANCE_M = 60;   // recorded elevations drift a little from OSM

// ─── Geo ──────────────────────────────────────────────────────────────────────

function distanceMetres(a, b) {
  const R = 6371000;
  const rad = deg => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const parseEle = raw => {
  const match = String(raw ?? '').match(/-?\d+/);
  return match ? Number(match[0]) : null;
};

const normaliseName = name => String(name ?? '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip accents
  .replace(/[^a-z]/g, '');

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * "Brunnensteinspitze" and "Brunnsteinspitze" are the same mountain spelled two
 * ways, but "Rotwand" and "Rotwandkopf" are two mountains 250 m apart — so a
 * substring test is no good here. Allow a fifth of the name to differ.
 */
function nameSimilarity(a, b) {
  const x = normaliseName(a);
  const y = normaliseName(b);
  if (!x || !y) return { match: false, exact: false };
  if (x === y) return { match: true, exact: true };
  const ratio = editDistance(x, y) / Math.max(x.length, y.length);
  return { match: ratio <= 0.2, exact: false };
}

// ─── Flags ────────────────────────────────────────────────────────────────────

/** summits.json mixes "DE" with emoji flags; normalise to ISO codes. */
const FLAG_TO_ISO = {
  '🇩🇪': 'DE', '🇦🇹': 'AT', '🇮🇹': 'IT', '🇨🇭': 'CH',
  DE: 'DE', AT: 'AT', IT: 'IT', CH: 'CH'
};

// ─── Matching ─────────────────────────────────────────────────────────────────

function findPeak(summit, features) {
  const summitEle = parseEle(summit.elevation);

  const candidates = features
    .map(f => ({
      feature: f,
      metres: distanceMetres(summit, { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] })
    }))
    .filter(c => c.metres <= MATCH_RADIUS_M)
    .sort((a, b) => a.metres - b.metres);

  if (candidates.length === 0) return { match: null, reason: 'no peak within ' + MATCH_RADIUS_M + ' m' };

  // Prefer a candidate whose name and elevation both agree; fall back to nearest.
  const scored = candidates.map(c => {
    const props = c.feature.properties;
    const name = nameSimilarity(props.name, summit.name);
    const eleMatch = summitEle !== null && Math.abs(props.ele - summitEle) <= ELE_TOLERANCE_M;
    return { ...c, name, eleMatch, score: (name.exact ? 3 : name.match ? 2 : 0) + (eleMatch ? 1 : 0) };
  });
  scored.sort((a, b) => b.score - a.score || a.metres - b.metres);

  const best = scored[0];
  const warnings = [];
  if (!best.name.match) warnings.push(`name differs (OSM: "${best.feature.properties.name}")`);
  else if (!best.name.exact) warnings.push(`spelled "${best.feature.properties.name}" in OSM`);
  if (!best.eleMatch) warnings.push(`elevation differs (OSM: ${best.feature.properties.ele} m)`);
  if (scored.length > 1 && scored[1].score === best.score) {
    warnings.push(`ambiguous — "${scored[1].feature.properties.name}" scores the same, ${Math.round(scored[1].metres)} m away`);
  }

  return { match: best, warnings };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw new Error(`Could not read ${path}: ${err.message}`);
  }
}

async function main() {
  const write = process.argv.includes('--write');

  const peaks = await readJson(PEAKS);
  const summits = await readJson(SUMMITS);
  const existing = await readJson(OUT, { version: 1, peaks: {} });

  console.log(`[seed] ${summits.length} summits against ${peaks.features.length} peaks in the snapshot\n`);

  const statuses = { ...existing.peaks };
  let matched = 0;
  const unmatched = [];

  for (const summit of summits) {
    const { match, reason, warnings } = findPeak(summit, peaks.features);

    if (!match) {
      unmatched.push({ summit, reason });
      console.log(`  ✗ ${summit.name} (${summit.elevation}) — ${reason}`);
      continue;
    }

    const props = match.feature.properties;
    const id = String(props.id);
    matched++;

    const note = warnings?.length ? `  ⚠ ${warnings.join('; ')}` : '';
    console.log(`  ✓ ${summit.name} → ${props.name} ${props.ele} m (osm ${id}, ${Math.round(match.metres)} m away)${note}`);

    if (statuses[id]) {
      console.log(`      already tracked as "${statuses[id].status}" — left alone`);
      continue;
    }

    statuses[id] = {
      status: 'done',
      date: summit.date ?? null,
      // Denormalised so a diff of this file is readable; peaks.geojson stays
      // the source of truth for name, elevation and position.
      name: props.name,
      ele: props.ele,
      country: FLAG_TO_ISO[summit.flag] ?? props.country ?? null,
      source: 'summits.json'
    };
  }

  console.log(`\n[seed] matched ${matched}/${summits.length}` +
              (unmatched.length ? `, ${unmatched.length} unmatched` : ''));

  if (unmatched.length) {
    console.log('\n[seed] Unmatched summits are not in the snapshot — either outside its bbox,');
    console.log('       below --min-ele, unnamed in OSM, or genuinely absent. Widen the');
    console.log('       snapshot and re-run, or add them by hand in the app.');
  }

  if (!write) {
    console.log(`\n[seed] dry run — pass --write to update ${OUT}`);
    return;
  }

  const output = {
    version: 1,
    updated: new Date().toISOString().slice(0, 10),
    peaks: statuses
  };
  await writeFile(OUT, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.log(`\n[seed] wrote ${Object.keys(statuses).length} entries → ${OUT}`);
}

main().catch(err => { console.error(err); process.exit(1); });
