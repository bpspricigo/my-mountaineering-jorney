const apiKey = CONFIG.MAPTILER_API_KEY;

let hikeFolders = [];

if (window.location.pathname.includes('future')) {
  // Future hikes page
  hikeFolders = [
    'future/herzogstand',
    'future/baumgartenschneid',
    'future/brecherspitz',
    'Sample 1',
    'Sample 2',
    'Sample 3',
  ];
} else {
  // Main (completed) hikes page
  hikeFolders = [
    '20250531',
    '20250615',
    '20250629'
  ];
}

const countryFlags = {
  DE: "https://flagcdn.com/w40/de.png",
  AT: "https://flagcdn.com/w40/at.png",
  IT: "https://flagcdn.com/w40/it.png",
  CH: "https://flagcdn.com/w40/ch.png"
};

Promise.all(
  hikeFolders.map(folder =>
    fetch(`gpx/${folder}/info.json`)
      .then(res => {
        if (!res.ok) throw new Error(`info.json not found for ${folder}`);
        return res.json();
      })
      .then(data => ({ folder, data }))
      .catch(err => {
        console.warn(`Skipping ${folder}: ${err.message}`);
        return null;
      })
  )
).then(results => {
  results
    .forEach(entry => {
      if (entry) renderHike(entry.folder, entry.data); // preserves order
    });
});

function renderHike(folder, info) {
  // Use default values if keys are missing
  const title = info.title || `Untitled Hike (${folder})`;
  const date = info.date || 'Unknown date';
  const location = info.location || 'Unknown location';
  const flag = info.flag || '';
  const description = info.description || 'No description available.';
  const distance = info.distance || 'N/A';
  const elevation = info.elevation || 'N/A';
  const difficulty = info.difficulty || 'N/A';
  const movingTime = info.movingTime || 'N/A';
  const photos = info.photos || null;
  let formattedDate = "";
  if (date && !isNaN(new Date(date))) {
    formattedDate = new Intl.DateTimeFormat('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    }).format(new Date(date));
  } else {
    formattedDate = ""; // or leave empty, or use a placeholder
  }
  const lat = info.lat || 47.5;
  const lon = info.lon || 11.5;

  const container = document.createElement('section');
  container.innerHTML = `
    <div id="map-${folder}" class="map"></div>
    <h2>
      ${title}
    </h2>
    ${flag && location && countryFlags[flag] ? `
      <span class="hike-stat-item hike-location">
        <img src="${countryFlags[flag]}" alt="${flag}" class="flag-icon" />
        ${location}
      </span>` : ""}
    <div class="hike-stats">
      ${difficulty ? `<span class="hike-stat-item"><span class="stat-icon">⚠️</span>${difficulty}</span>` : ""}
      ${movingTime ? `<span class="hike-stat-item"><span class="stat-icon">⏱</span>${movingTime}</span>` : ""}
      ${distance ? `<span class="hike-stat-item"><span class="stat-icon">🚶</span>${distance}</span>` : ""}
      ${elevation ? `<span class="hike-stat-item"><span class="stat-icon">⛰</span>${elevation}</span>` : ""}
    </div>
    <p class="hike-description">${description}</p>
    <div class="hike-footer">
      <span class="hike-date">📅 ${formattedDate}</span>
      ${photos ? `<a class="hike-photos" href="${photos}" target="_blank">📸 Photo Album</a>` : ""}
    </div>
  `;

  document.getElementById('journal').appendChild(container);

  // Try to load the GPX file — skip if not found
  fetch(`gpx/${folder}/track.gpx`)
    .then(res => {
      if (!res.ok) throw new Error('track.gpx not found');
      return res.text();
    })
    .then(gpxText => {
      const parser = new DOMParser();
      const gpxDoc = parser.parseFromString(gpxText, 'application/xml');
      const geojson = toGeoJSON.gpx(gpxDoc);

      const map = new maplibregl.Map({
        container: `map-${folder}`,
        style: `https://api.maptiler.com/maps/01977a50-3b45-714b-8988-53457dbba54f/style.json?key=${apiKey}`,
        center: [lon, lat], // Default center, will be overridden by fitBounds
        zoom: 9
      });

      map.addControl(new maplibregl.NavigationControl(), 'top-right');

      map.on('load', () => {
        map.addSource(`track-${folder}`, {
          type: 'geojson',
          data: geojson
        });

        const beforeLayerId = 'Peak labels'; // or whichever label you want it under

        try {
          map.addLayer({
            id: `track-line-${folder}`,
            type: 'line',
            source: `track-${folder}`,
            layout: {
              'line-join': 'round',
              'line-cap': 'round'
            },
            paint: {
              'line-color': '#ff0000',
              'line-width': [
                'interpolate',
                ['linear'],
                ['zoom'],
                8, 1.5,
                12, 3
              ],
              'line-opacity': 1
            }
          }, beforeLayerId); // 👈 Insert *before* peak labels
        } catch (e) {
          console.error(`[${folder}] Failed to insert track layer:`, e);
        }

        // Fit bounds
        const bounds = new maplibregl.LngLatBounds();
        geojson.features.forEach(f => {
          if (f.geometry.type === "LineString") {
            f.geometry.coordinates.forEach(coord => bounds.extend(coord));
          }
        });
        map.fitBounds(bounds, { padding: 40 });

        /*// 🧠 Log current layer stack
        const style = map.getStyle();
        if (style && style.layers) {
          console.log(`[${folder}] Map layer stack (${style.layers.length} layers):`);
          style.layers.forEach((layer, index) => {
            console.log(`${index}: ${layer.id} [${layer.type}]`);
          });
        } else {
          console.warn(`[${folder}] No layers found in map style.`);
        }*/

        // Add start/end markers
        const line = geojson.features.find(f => f.geometry.type === "LineString");
        if (line) {
          const coords = line.geometry.coordinates;
          const start = coords[0];
          const end = coords[coords.length - 1];

          const makeMarker = (coord, label) => {
            const el = document.createElement('div');
            el.className = 'custom-marker';
            el.innerHTML = `<div class="marker-label">${label}</div>`;
            return new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(coord).addTo(map);
          };

          makeMarker(end, 'B');
          makeMarker(start, 'A');
        }
      });
    })
    .catch(err => {
      console.warn(`Map skipped for ${folder}: ${err.message}`);
      document.getElementById(`map-${folder}`).remove();
    });
}


function countryCodeToFlagEmoji(code) {
  return code
    .toUpperCase()
    .replace(/./g, char => 
      String.fromCodePoint(char.charCodeAt(0) + 127397)
    );
}