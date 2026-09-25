# My Mountaineering Journey

A personal web app to track and visualize hikes and mountaineering adventures. Built with vanilla HTML/CSS/JS, MapLibre GL for maps, and GPX files for route data.

## Features

- **Journal** — completed hikes with route maps, stats, and descriptions
- **Planner** — upcoming routes on the radar
- **Peaks** — every peak in the region on one map, tagged dream / planned / attempted / done, with what your done list adds up to

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

### Outings

A walk is a `route` row, done or planned, joined to the summits it takes in
through `route_peak` — one outing can cover several peaks, and a peak collects
outings over the years. Click a peak and its walks appear under the tag
buttons, with stats, Strava and photo links, notes, and the track drawn on the
map. Tracks stay until **Clear**, so a planned line can be held against one
already walked.

**Tracks are polylines, not files.** A 600 KB GPX simplified to 5 m keeps every
switchback and costs about 1 KB, so the whole history is ~12 KB and lives in
the rows — no storage bucket, no second request to draw a line. Distance and
ascent are measured from the full-resolution points *before* simplifying, so
the numbers never pay for the smaller line.

**Draw one on the map** with *Draw a route*, or *Draw from here* in a peak's
popup. Click to drop points — clicking a peak snaps to its summit — and the
line follows the trails between them, with distance, ascent, a time estimate,
the hardest SAC grade on the way and an elevation profile updating as you go.
Drag a stop to move it, or drag the line itself to add one in between — both
re-route only the legs they touch. *Reverse* walks it the other way, re-routing
so ascent and descent swap rather than simply flipping the list. *Out & back*
retraces the way home. *Save as outing* hands the drawn track to the form
below, stats and summits already filled in.

The magnet is BRouter itself: it routes from the nearest routable way, so a
stop dropped near a path comes back on it, and the marker is then moved onto
the routed line's own end. A stop pinned to a summit stays put — the route
bends to the summit, not the other way round.

Routing is [BRouter](https://brouter.de)'s public instance, the engine
gpx.studio uses: no key, open CORS, hiking profiles that read `sac_scale`, and
an elevation on every point, which is what keeps ascent honest without a second
service. One request per leg, so adding a point never re-routes the rest, and a
leg with no path between its ends is drawn dashed and measured straight.
`BROUTER_URL` in `route-draw.js` is the only line tying this to a server —
point it at `docker run -v …:/segments4 abrensch/brouter` and nothing else
changes.

**Add or edit one by hand** with *Add outing* — in the panel, or in a peak's
popup, where it starts linked to that peak. Only the title is required. Drop a
GPX in and it measures the walk, fills whatever stats are still blank (a number
you typed wins, since it came from your watch) and adds every summit the line
crosses. Other links go in one per line as `label | url`; gear and conditions
go in notes. A checkbox tags the linked summits with the outing's own status,
so recording a walk marks its peaks done in one go.

**Import the repo's own hikes** with *Backup & sharing → Import old hikes*,
signed in. Each folder under `gpx/` becomes a route, its stats taken from
`info.json` where present and measured off the track where not, linked to every
peak within 80 m of the line — which is how one August day comes back as both
Brunnsteinspitze and Rotwandlspitze. A route remembers its folder, so importing
twice imports nothing twice.

### Where the peaks come from

Three sources, each covering what the others cannot:

| source | what it holds | when |
|---|---|---|
| `data/peaks-core.geojson` | the few thousand most isolated peaks on earth | always, offline |
| a MapTiler tileset | every peak we know, with our own fields | online, when `PEAKS_TILESET_ID` is set |
| the basemap's `mountain_peak` | whatever neither of those has heard of | behind the *More peaks, worldwide* switch |

Plus your own list, which carries each peak's position and so draws at any zoom
anywhere, with or without a network.

```bash
node scripts/build-world-peaks.mjs                 # every country
node scripts/build-world-peaks.mjs --countries AR,CL,PE
```

Writes `data/world-peaks.geojson` — upload that as a **tileset** (not a
dataset: those are the editable kind, capped at 10 MB) at
[MapTiler Cloud](https://cloud.maptiler.com/), which tiles it automatically,
and put the tileset id in `config.js` as `PEAKS_TILESET_ID`. The free plan
takes vector uploads up to 1 GB, far more than every named peak on earth needs.
It also writes `data/peaks-core.geojson`, which ships in the repo.

**MapTiler strips a property called `minZoom`** — the name is reserved for a
tileset's own metadata — so the same number is written twice, as `tier` as
well. Where a tileset predates that, the map falls back to thresholds on
`isolation`, calibrated against the built file to keep 60–80 peaks on screen at
any zoom anywhere: at zoom 6, 50 over the Andes, 72 over the Alps, 63 over
Kilimanjaro. Uploaded points are **not** thinned by MapTiler — a zoom 3 view
arrives with 177,688 of them — so that filtering is what keeps the map fast.

**Two sources, each where it is better.** OSM (`data/peaks.geojson`, the Alps
snapshot) has node ids matching what you have already tagged, countries
resolved against real boundaries, and prominence where mappers recorded it.
GeoNames covers everywhere else, carrying a country, a state and an elevation —
and every mountain feature in it is named, so no "Unnamed peak" can come out.
Where the two overlap, OSM wins: a GeoNames peak within 150 m of an OSM one is
the same summit under another name.

**Nothing decides what is "important enough".** Every named peak goes in, and
the zoom it appears at comes from filling tiles rather than from a threshold:
peaks are walked from the most isolated down, and each takes the first zoom
whose tile still has room for it. So the screen holds about the same number of
peaks wherever you are, and they are the ones that dominate there. A 4000 m
bump outside El Alto has higher ground a few kilometres away and waits for a
close zoom; Pico da Bandeira at 2890 m has none for 2,300 km and appears at
zoom 2, next to Everest and Aconcagua. No elevation cut-offs, no per-region
rules, nothing to tune when you take an interest in a new continent.

### Peaks beyond the snapshot

**More peaks, worldwide** in the panel draws the basemap's own `mountain_peak`
layer — every peak MapTiler knows, from zoom 7, anywhere on earth. Those tiles
are already downloaded to draw the map, so it costs no request and no quota,
and it is what puts Aconcagua on the map without shipping a snapshot of the
Andes. They carry a name, an elevation and a rank of 1–5 (the detail slider
decides how deep into the ranks to go), but no country, so a country filter
hides them.

Tagging one keeps it. `peak_status` carries `lat`/`lon`, so a tagged peak is
drawn from your own list at any zoom whether or not any snapshot has heard of
it, and the country is asked of MapTiler's geocoder at that moment — one
request, and it puts Everest in Nepal where a boundary file said China. Peaks
from the tiles have no OSM node id, so they get a deterministic one derived
from their position, offset above 1e15 where no real OSM id can reach.

Clicking a tile peak within 120 m of one already in the snapshot opens *that*
peak instead, so the two sources cannot put the same summit on your list twice.

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
| `eastern-alps` | `46.4,9.45,48.0,13.6` | 2500 m | Rätikon and Liechtenstein, Hohe Tauern, Ötztal, Zillertal, northern Dolomites |
| `dolomites` | `46.0,10.7,46.8,12.8` | 2000 m | all of the Dolomites incl. Pala, Belluno, Brenta; Lagorai, Sarntal Alps |
| `alps-3000-*` | the Alpine arc, in three strips | 3000 m | Mont Blanc, Monte Rosa, Bernina, Gran Paradiso |
| `notable` | the Alpine arc | 1500 m **and prominence ≥ 300 m** | range high points below the 3000 m rule |

That currently yields **11,661 named peaks** from 1261 m to 4807 m (Mont Blanc),
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
filter for either. A node lying exactly on the boundary line belongs to no
country's area, so any peak left over is asked about individually with `is_in`,
which does place it — that is how Plattenspitz and seven others got their
country. Whatever is still unclaimed is genuinely outside the seven countries,
the Dinaric Alps being what the `notable` box reaches, and is dropped, unless
it is already on your list. So the country filter never shows an "Unknown" row. Overpass is a free shared service and its instances are often
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

Peaks you have tagged ignore that ladder. They are drawn at every zoom and
compete for screen space by status instead — **done**, then **planned**,
**dream**, **attempted**. Where two would overlap, the higher status keeps its
place, so zooming out never swaps a done peak for a planned one; lower statuses
fill whatever room is left, and unticking a status in the filter hands its room
to the rest. Within a status the higher summit wins — elevation here, not the
isolation that ranks untagged peaks, because on a list of your own a 1261 m
foothill outranking an 1884 m summit only reads as arbitrary.

The **Detail** slider in the panel shifts the ladder for untagged peaks if you
want to see everything in an area regardless.

