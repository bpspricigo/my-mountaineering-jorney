# My Mountaineering Journey

A personal web app to track and visualize hikes and mountaineering adventures. Built with vanilla HTML/CSS/JS, MapLibre GL for maps, and GPX files for route data.

## Features

- **Journal** — completed hikes with route maps, stats, and descriptions
- **Planner** — upcoming routes on the radar
- **Peaks** — every peak in the region on one map, tagged dream / planned / attempted / done
- **Summits** — an overview map of all peaks reached

## Running locally

The app loads local JSON and GPX files via `fetch`, so you need a local HTTP server — opening `index.html` directly in the browser won't work.

**VS Code Live Server** (easiest)

Install the [Live Server](https://marketplace.visualstudio.com/items?itemName=ritwickdey.LiveServer) extension, then right-click `index.html` and choose **Open with Live Server**.

**Python**

```bash
python -m http.server 8080
```

**Node.js**

```bash
npx serve .
```

Then open `http://localhost:8080` in your browser.

## Adding a hike

1. Create a folder under `gpx/` named by date (e.g. `gpx/20251120/`)
2. Add a `track.gpx` file with the recorded route
3. Add an `info.json` with the hike metadata:

```json
{
  "title": "Hike Name",
  "date": "2025-11-20",
  "location": "Location, Country",
  "flag": "DE",
  "description": "A short description.",
  "distance": "10 km",
  "elevation": "800 m",
  "difficulty": "Moderate",
  "movingTime": "3:30 h",
  "photos": "",
  "lat": 47.0,
  "lon": 11.0
}
```

For planned routes, add the folder under `gpx/future/` with the same structure.

## The peak planner

The Peaks tab loads `data/peaks.geojson`, a snapshot of OpenStreetMap peaks. Click
any peak to mark it **dream**, **planned**, **attempted** or **done**; filter by
elevation, country, status or name.

### Where the statuses live

**Signed out**, two layers are merged at load, local edits winning:

| layer | scope |
|---|---|
| `data/peak-status.json` | committed baseline, shared across devices via git |
| `localStorage` | edits made in this browser |

Tagging a peak only writes to `localStorage`. To keep the change, hit **Export
JSON** and save the download over `data/peak-status.json`, then commit it — that
file becomes the new baseline. **Import** reads an export back in.

**Signed in** (email magic link, in the panel under *Your list*), the
`peak_status` table in Supabase is the whole truth and every tag writes straight
to it. The first sign-in on an empty account seeds it from what the browser
shows at that moment — the baseline plus any local edits. After that the file is
not read for that account; export still works as a backup.

Supabase is optional. Copy `config.example.js` to `config.js`; leave the
`SUPABASE_*` keys out and the sign-in form never appears. The schema is in
`supabase/migrations/`. In the Supabase dashboard, under *Authentication → URL
Configuration*, add every origin you serve from (e.g. `http://127.0.0.1:5501/**`)
to the redirect URLs, or the link in the email falls back to the Site URL.

### Regenerating the peak snapshot

```bash
node scripts/fetch-peaks.mjs
```

Queries the Overpass API for `natural=peak` nodes and writes `data/peaks.geojson`.
No dependencies — Node 18+ only.

The snapshot is built from **regions with their own elevation floors**, configured
at the top of the script, because "what can I do on a Saturday" and "what is worth
a week of planning" are different questions:

| region | box | floor | covers |
|---|---|---|---|
| `home` | `47.15,10.75,47.95,12.45` | 1500 m | local hills, Karwendel, Zugspitze |
| `eastern-alps` | `46.4,9.8,48.0,13.6` | 2500 m | Hohe Tauern, Ötztal, Zillertal, northern Dolomites |
| `dolomites` | `46.0,10.7,46.8,12.8` | 2000 m | all of the Dolomites incl. Pala, Belluno, Brenta; Lagorai, Sarntal Alps |
| `alps-3000-*` | the Alpine arc, in three strips | 3000 m | Mont Blanc, Monte Rosa, Bernina, Gran Paradiso |
| `notable` | the Alpine arc | 1500 m **and prominence ≥ 300 m** | range high points below the 3000 m rule |

That currently yields **11,462 named peaks** from 1261 m to 4807 m (Mont Blanc),
across 7 countries — a 2.7 MB file, including all 82 official UIAA
four-thousanders. The arc is split into strips because querying it as one box
used 133 s of a 300 s timeout.

The `notable` rule exists because height alone misses mountains that matter.
Triglav is Slovenia's highest summit and a famous objective, but at 2864 m it
fell through every box-and-floor rule and Slovenia ended up with **no peaks at
all**, while 1500 m wooded hills near Munich were included. Prominence — how far
you must descend before you can climb higher — is what marks a range high point;
Triglav's is 2048 m. Requiring 300 m adds only ~280 peaks across the whole arc.

### Checking coverage

```bash
node scripts/check-coverage.mjs
```

Verifies the snapshot contains all 82 official UIAA four-thousanders and a list
of peaks that must be present regardless of height — country high points that sit
below some rule's floor, and anything already climbed. Exits non-zero if any are
missing.

This exists because every coverage mistake in this project produced a
plausible-looking file rather than an error: a snapshot of "Bavaria and Tirol"
with no Zugspitze, a French Alps with no country, a Slovenia with no peaks. None
of them raised anything. Run it after changing the regions.

Overlapping regions keep the lower floor, so local 1200 m hills survive inside the
high-altitude box. Edit `REGIONS` to change the coverage, or query an ad-hoc box:

```bash
node scripts/fetch-peaks.mjs --bbox 46.0,10.0,48.0,13.0 --min-ele 1500
node scripts/fetch-peaks.mjs --help
```

**Raising a floor cannot orphan a peak you have tagged.** Before writing, the
script re-reads `data/peak-status.json` and force-fetches by OSM id any tagged
peak the floors would have excluded, marking it `keptBecauseTagged`. Disable with
`--no-keep-tagged`.

Each peak is tagged with its country by asking Overpass which national boundary
contains it, so summits on the DE/AT border come back as `AT/DE` and match a
filter for either. Overpass is a free shared service and its instances are often
busy; the script falls back across three mirrors and retries before giving up.

The run ends by printing the **highest peak per country**. Check it. The first
snapshot of this project covered "Bavaria and Tirol" and topped out at 2884 m —
no Zugspitze, no Großglockner — because the box had been drawn around the hikes
already in the journal rather than around where it was worth going next.

Peak data © OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/).

### Which peaks appear at which zoom

A snapshot this size cannot be drawn all at once — 11,000 dots is not a map, it is
a texture. Which peaks appear is decided by **isolation**: the distance from a
summit to the nearest higher ground.

Isolation is what separates a mountain from a bump on the side of one. It is
computed at build time by walking peaks from the highest down, so the answer for
Großglockner and its neighbour is unambiguous:

| peak | elevation | isolation | drawn from |
|---|---|---|---|
| Großglockner | 3798 m | 174.88 km | z6 |
| Kleinglockner | 3770 m | **0.07 km** | z14 |
| Zugspitze | 2962 m | 25.76 km | z8 |
| Schneefernerkopf | 2874 m | 1.78 km | z11 |

28 m of elevation separates the first two; isolation separates them by a factor
of 2,500. So zoomed out near Großglockner you see one mountain, and Kleinglockner
appears when you are close enough to be planning the summit itself.

Elevation deliberately has no say in this. An earlier version let anything above
3500 m appear early, which put twelve summits on screen around Großglockner — the
massif's towers are all ~3700 m and 50 m apart, exactly the clutter this removes.

Peaks you have tagged appear two zoom levels earlier than they otherwise would,
so your own list stays findable without stacking two dots on one massif. The
**Detail** slider in the panel shifts the whole ladder if you want to see
everything in an area regardless.

### Seeding from summits.json

One-off migration that marks everything in `summits/summits.json` as `done`:

```bash
node scripts/seed-status.mjs           # dry run — prints what it would match
node scripts/seed-status.mjs --write   # writes data/peak-status.json
```

Summits are matched to OSM peaks by **position**, not name: OSM spells one of
them `Brunnsteinspitze` where `summits.json` says `Brunnensteinspitze`, and two
different peaks in the snapshot are both called `Rotwandlspitze`. The name only
breaks ties, and any fuzzy match is reported so it can be eyeballed. Entries
already present are left alone.
