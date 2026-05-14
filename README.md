# My Mountaineering Journey

A personal web app to track and visualize hikes and mountaineering adventures. Built with vanilla HTML/CSS/JS, MapLibre GL for maps, and GPX files for route data.

## Features

- **Journal** — completed hikes with route maps, stats, and descriptions
- **Planner** — upcoming routes on the radar
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
