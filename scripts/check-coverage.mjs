#!/usr/bin/env node
/**
 * Checks data/peaks.geojson against reference lists that should be in it.
 *
 * The snapshot is assembled from bounding boxes and elevation floors, and a
 * mistake there produces a plausible-looking file rather than an error: the
 * first version of this dataset covered "Bavaria and Tirol" and contained
 * neither Zugspitze nor Großglockner, and a later one had every peak in
 * Slovenia missing. This is the check that argues back.
 *
 *   node scripts/check-coverage.mjs [path/to/peaks.geojson]
 *
 * Exits non-zero if anything expected is absent.
 */

import { readFileSync } from 'node:fs';

const SNAPSHOT = process.argv[2] ?? 'data/peaks.geojson';
const peaks = JSON.parse(readFileSync(SNAPSHOT, 'utf8')).features
  .map(f => ({ ...f.properties, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }));

// ─── Reference lists ──────────────────────────────────────────────────────────

/** The 82 official UIAA four-thousanders, by their UIAA names. */
const UIAA = `Mont Blanc|4809
Mont Blanc de Courmayeur|4748
Dufourspitze|4634
Nordend|4608
Zumsteinspitze|4563
Signalkuppe|4554
Dom|4546
Lyskamm Eastern Summit|4532
Weisshorn|4505
Täschhorn|4491
Lyskamm Western Summit|4479
Matterhorn|4478
Picco Luigi Amedeo|4469
Mont Maudit|4465
Parrotspitze|4434
Dent Blanche|4357
Ludwigshöhe|4341
Nadelhorn|4327
Schwarzhorn|4321
Combin de Grafeneire|4309
Dôme du Goûter|4304
Lenzspitze|4293
Finsteraarhorn|4274
Mont Blanc du Tacul|4248
Grand Pilier d'Angle|4243
Stecknadelhorn|4240
Castor|4225
Zinalrothorn|4221
Hohberghorn|4218
Vincent Pyramid|4215
Grandes Jorasses Pointe Walker|4208
Alphubel|4206
Rimpfischhorn|4199
Aletschhorn|4194
Strahlhorn|4190
Combin de Valsorey|4184
Grandes Jorasses Pointe Whymper|4184
Dent d'Hérens|4173
Breithorn Western Summit|4160
Jungfrau|4158
Breithorn Central Summit|4154
Bishorn|4151
Eastern Breithorn|4138
Combin de la Tsessette|4132
Aiguille Verte|4122
Aiguilles du Diable L'Isolée|4114
Aiguille Blanche de Peuterey|4112
Mönch|4110
Grandes Jorasses Pointe Croz|4110
Aiguilles du Diable Pointe Carmen|4109
Breithorn Gendarm|4106
Grande Rocheuse|4102
Barre des Écrins|4102
Aiguilles du Diable Pointe Médiane|4097
Pollux|4089
Schreckhorn|4078
Breithorn Roccia Nera|4075
Aiguilles du Diable Pointe Chaubert|4074
Mont Brouillard|4069
Grandes Jorasses Pointe Marguerite|4065
Aiguilles du Diable Corne du Diable|4064
Ober Gabelhorn|4063
Gran Paradiso|4061
Aiguille de Bionnassay|4052
Gross Fiescherhorn|4049
Piz Bernina|4048
Punta Giordani|4046
Grandes Jorasses Pointe Elena|4045
Grünhorn|4043
Lauteraarhorn|4042
Aiguille du Jardin|4035
Dürrenhorn|4035
Allalinhorn|4027
Hinter Fiescherhorn|4025
Dôme de Rochefort|4015
Dôme de Neige des Écrins|4015
Weissmies|4013
Dent du Géant|4013
Punta Baretti|4013
Lagginhorn|4010
Aiguille de Rochefort|4001
Les Droites|4000`
  .split('\n')
  .map(line => {
    const [name, ele] = line.split('|');
    return { name: name.trim(), ele: Number(ele) };
  });

/** UIAA name → the name OSM actually uses for the same summit. */
const ALIASES = {
  'Mont Blanc de Courmayeur': 'Monte Bianco di Courmayeur',
  'Lyskamm Eastern Summit': 'Liskamm Ostgipfel',
  'Lyskamm Western Summit': 'Liskamm Westgipfel',
  'Vincent Pyramid': 'Piramide Vincent',
  'Breithorn Western Summit': 'Breithorn Occidentale',
  'Breithorn Central Summit': 'Breithorn Centrale',
  'Eastern Breithorn': 'Breithorn Orientale',
  'Breithorn Gendarm': 'Gemello del Breithorn',
  'Gross Fiescherhorn': 'Grosses Fiescherhorn',
  'Grandes Jorasses Pointe Elena': 'Punta Elena',
  'Dürrenhorn': 'Dirruhorn',
  'Punta Baretti': 'Pointe Baretti'
};

/**
 * Peaks that must be present for reasons other than height. Every one of these
 * is below some rule's floor, which is exactly why they need checking.
 */
const MUST_HAVE = [
  { name: 'Triglav', ele: 2864, why: 'highest in Slovenia' },
  { name: 'Zugspitze', ele: 2962, why: 'highest in Germany' },
  { name: 'Großglockner', ele: 3798, why: 'highest in Austria' },
  { name: 'Dufourspitze', ele: 4634, why: 'highest in Switzerland' },
  { name: 'Vorder Grauspitz', ele: 2599, why: 'highest in Liechtenstein' },
  { name: 'Watzmann', ele: 2713, why: 'named objective' },
  { name: 'Wildspitze', ele: 3768, why: 'highest in Tirol' },
  { name: 'Neureuth', ele: 1261, why: 'climbed, below the home floor' }
];

// ─── Matching ─────────────────────────────────────────────────────────────────

const norm = s => String(s ?? '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]/g, '');

/**
 * OSM writes "Mont Blanc / Monte Bianco" for bilingual names, and joins a
 * summit to its massif with a hyphen: the Watzmann's main top is
 * "Watzmann-Mittelspitze". Compare against every alternative, plus the hyphen
 * parts — but only long ones, so a short name like "Dom" cannot latch onto an
 * unrelated compound.
 */
const variants = name => {
  const text = String(name ?? '');
  const parts = text.split(/[/,]|\s+-\s+/).map(norm).filter(Boolean);
  const hyphenParts = text
    .split(/[/,]/)
    .flatMap(alt => alt.split('-'))
    .map(norm)
    .filter(v => v.length >= 5);
  return [...new Set([...parts, ...hyphenParts])];
};

const pickClosest = (candidates, target) =>
  [...candidates].sort((a, b) => Math.abs(a.ele - target.ele) - Math.abs(b.ele - target.ele))[0];

function findMatch(target) {
  const wanted = norm(ALIASES[target.name] ?? target.name);

  const exact = peaks.filter(p => variants(p.name).includes(wanted));
  if (exact.length) return pickClosest(exact, target);

  const loose = peaks.filter(p =>
    variants(p.name).some(v => (v.includes(wanted) || wanted.includes(v)) && v.length > 4) &&
    Math.abs(p.ele - target.ele) <= 40
  );
  return loose.length ? pickClosest(loose, target) : null;
}

// ─── Report ───────────────────────────────────────────────────────────────────

let failed = false;

console.log(`Snapshot: ${SNAPSHOT} — ${peaks.length} peaks\n`);

const found = [];
const missing = [];
for (const target of UIAA) {
  const peak = findMatch(target);
  if (peak) found.push({ target, peak });
  else missing.push(target);
}

console.log(`UIAA official four-thousanders: ${UIAA.length}`);
console.log(`  found:   ${found.length}`);
console.log(`  missing: ${missing.length}`);

if (missing.length) {
  failed = true;
  console.log('\nMissing four-thousanders — nearest peaks by elevation:');
  for (const target of missing) {
    const near = peaks
      .filter(p => Math.abs(p.ele - target.ele) <= 12)
      .sort((a, b) => Math.abs(a.ele - target.ele) - Math.abs(b.ele - target.ele))
      .slice(0, 3);
    console.log(`  ${target.name} (${target.ele} m)`);
    if (near.length) near.forEach(p => console.log(`      candidate: ${p.name} ${p.ele} m [${p.country}]`));
    else console.log('      nothing near that elevation — genuinely absent');
  }
}

const viaAlias = found.filter(f => ALIASES[f.target.name]).length;
if (viaAlias) console.log(`  (${viaAlias} matched through ALIASES — OSM names them locally)`);

console.log('\nPeaks that must be present regardless of height:');
for (const wanted of MUST_HAVE) {
  const hit = peaks.find(p =>
    variants(p.name).includes(norm(wanted.name)) && Math.abs(p.ele - wanted.ele) <= 30);
  if (hit) {
    console.log(`  ✓ ${wanted.name.padEnd(14)} ${String(hit.ele).padStart(4)} m  ${String(hit.country).padEnd(6)} z${hit.minZoom}  — ${wanted.why}`);
  } else {
    failed = true;
    console.log(`  ✗ ${wanted.name.padEnd(14)} ${String(wanted.ele).padStart(4)} m  MISSING — ${wanted.why}`);
  }
}

const byZoom = {};
for (const { peak } of found) byZoom[peak.minZoom] = (byZoom[peak.minZoom] ?? 0) + 1;
console.log('\nZoom tier of the four-thousanders:');
for (const z of Object.keys(byZoom).sort((a, b) => Number(a) - Number(b))) {
  console.log(`  z${String(z).padStart(2)}: ${byZoom[z]}`);
}

console.log(failed
  ? '\nFAILED — the snapshot is missing peaks it should contain.'
  : '\nAll expected peaks present.');
process.exit(failed ? 1 : 0);
