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

Two layers merged at load, local edits winning:

| layer | scope |
|---|---|
| `data/peak-status.json` | committed baseline, shared across devices via git |
| `localStorage` | edits made in this browser |

Tagging a peak only writes to `localStorage`. To keep the change, hit **Export
JSON** and save the download over `data/peak-status.json`, then commit it — that
file becomes the new baseline. **Import** reads an export back in.

This is deliberately a static site; accounts and a real database are [issue #3](https://github.com/bpspricigo/my-mountaineering-jorney/issues/3).

### Regenerating the peak snapshot

```bash
node scripts/fetch-peaks.mjs
```

Queries the Overpass API for `natural=peak` nodes and writes `data/peaks.geojson`.
No dependencies — Node 18+ only. Defaults to the Bavarian Prealps / Karwendel /
Tirol box above 1000 m, named peaks only:

```bash
node scripts/fetch-peaks.mjs --bbox 46.0,10.0,48.0,13.0 --min-ele 1500
node scripts/fetch-peaks.mjs --help
```

Each peak is tagged with its country by asking Overpass which national boundary
contains it, so summits on the DE/AT border come back as `AT/DE` and match a
filter for either. Overpass is a free shared service and its instances are often
busy; the script falls back across three mirrors and retries before giving up.

Peak data © OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/).

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
