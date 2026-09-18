#!/usr/bin/env node
/**
 * Pushes the local snapshot into Supabase:
 *
 *   data/peaks.geojson      -> public.peaks        (shared reference data)
 *   data/peak-status.json   -> public.peak_status  (one person's list)
 *
 * No dependencies — PostgREST is just HTTP. Upserts, so re-running after a
 * fresh fetch-peaks.mjs updates rows rather than duplicating them.
 *
 *   SUPABASE_URL=https://<ref>.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   node scripts/push-to-supabase.mjs --user <uuid>
 *
 * The service role key bypasses RLS, which is the only way to write `peaks`.
 * It must never reach the browser: read it from the environment, never commit
 * it, and use the publishable key in the app.
 *
 *   --user <uuid>   who the statuses belong to (from auth.users)
 *   --peaks-only    skip the statuses
 *   --dry-run       show what would be sent, send nothing
 */

import { readFile } from 'node:fs/promises';

const BATCH = 500;

function parseArgs(argv) {
  const opts = { user: null, peaksOnly: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--user') opts.user = argv[++i];
    else if (arg === '--peaks-only') opts.peaksOnly = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--help' || arg === '-h') { console.log(usage()); process.exit(0); }
    else { console.error(`Unknown argument: ${arg}`); console.log(usage()); process.exit(1); }
  }
  return opts;
}

const usage = () => `
Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/push-to-supabase.mjs [options]

  --user <uuid>   Owner of the statuses (required unless --peaks-only)
  --peaks-only    Push only the peak reference data
  --dry-run       Report what would be sent without sending it
`.trim();

// ─── PostgREST ───────────────────────────────────────────────────────────────

const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function upsert(table, rows, onConflict) {
  const endpoint = `${url}/rest/v1/${table}?on_conflict=${onConflict}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      // merge-duplicates makes this an upsert; minimal keeps the rows from
      // being echoed back, which matters at 9,479 of them.
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(rows)
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${table}: HTTP ${res.status} ${res.statusText}\n${body.slice(0, 600)}`);
  }
}

async function pushInBatches(table, rows, onConflict, dryRun) {
  console.log(`[push] ${table}: ${rows.length} rows`);
  if (dryRun) {
    console.log(`[push]   dry run — first row: ${JSON.stringify(rows[0])}`);
    return;
  }
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    await upsert(table, slice, onConflict);
    console.log(`[push]   ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!url || !key) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.\n');
    console.log(usage());
    process.exit(1);
  }
  if (!opts.peaksOnly && !opts.user) {
    console.error('--user <uuid> is required (or pass --peaks-only).\n');
    console.log(usage());
    process.exit(1);
  }

  const snapshot = JSON.parse(await readFile('data/peaks.geojson', 'utf8'));
  const peaks = snapshot.features.map(f => ({
    id: f.properties.id,
    name: f.properties.name,
    ele: f.properties.ele,
    lat: f.geometry.coordinates[1],
    lon: f.geometry.coordinates[0],
    country: f.properties.country,
    isolation: f.properties.isolation,
    min_zoom: f.properties.minZoom ?? 0,
    prominence: f.properties.prominence ?? null,
    wikidata: f.properties.wikidata ?? null,
    wikipedia: f.properties.wikipedia ?? null
  }));

  await pushInBatches('peaks', peaks, 'id', opts.dryRun);

  if (opts.peaksOnly) {
    console.log('[push] done (peaks only)');
    return;
  }

  const status = JSON.parse(await readFile('data/peak-status.json', 'utf8'));
  const known = new Set(peaks.map(p => p.id));

  const rows = [];
  const orphans = [];
  for (const [id, entry] of Object.entries(status.peaks ?? {})) {
    // 'none' is a local tombstone; in the database, untagged means no row.
    if (!entry?.status || entry.status === 'none') continue;
    if (!known.has(Number(id))) { orphans.push(`${entry.name ?? id} (${id})`); continue; }
    rows.push({
      user_id: opts.user,
      peak_id: Number(id),
      status: entry.status,
      climbed_on: entry.date ?? null,
      note: entry.note ?? null
    });
  }

  if (orphans.length) {
    // A status pointing at a peak the snapshot lacks would violate the foreign
    // key, and silently dropping someone's tagged peak is worse than saying so.
    console.warn(`[push] ⚠ ${orphans.length} statuses reference peaks missing from the snapshot:`);
    for (const o of orphans) console.warn(`[push]     ${o}`);
    console.warn('[push]   Re-run scripts/fetch-peaks.mjs so they are included, or they stay local only.');
  }

  await pushInBatches('peak_status', rows, 'user_id,peak_id', opts.dryRun);
  console.log(`[push] done — ${peaks.length} peaks, ${rows.length} statuses`);
}

main().catch(err => { console.error(err.message ?? err); process.exit(1); });
