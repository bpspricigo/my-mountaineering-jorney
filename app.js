if (typeof CONFIG === 'undefined') {
  console.error('[app] CONFIG not found — is config.js loaded?');
}

const apiKey = CONFIG?.MAPTILER_API_KEY;
console.log('[app] apiKey:', apiKey ? `${apiKey.slice(0, 6)}…` : 'MISSING');

const STYLE_HIKE   = `https://api.maptiler.com/maps/01977a50-3b45-714b-8988-53457dbba54f/style.json?key=${apiKey}`;
const STYLE_SUMMIT = `https://api.maptiler.com/maps/01977a3c-1420-7d86-8992-edcec1cbca8d/style.json?key=${apiKey}`;

const FLAG_URLS = {
  DE: 'https://flagcdn.com/w40/de.png',
  AT: 'https://flagcdn.com/w40/at.png',
  IT: 'https://flagcdn.com/w40/it.png',
  CH: 'https://flagcdn.com/w40/ch.png'
};

// ─── Tab switching ────────────────────────────────────────────────────────────

const initializedTabs = new Set();

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => activateTab(btn.dataset.tab));
});

function activateTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === name)
  );
  document.querySelectorAll('.tab-content').forEach(el => {
    el.hidden = el.id !== `tab-${name}`;
  });
  // The peak planner takes the whole window; the reading tabs stay a column.
  document.body.classList.toggle('tab-fullscreen', name === 'peaks');
  if (!initializedTabs.has(name)) {
    initializedTabs.add(name);
    initTab(name);
  } else if (name === 'peaks') {
    // The container had no size while the tab was hidden, so MapLibre needs
    // telling that it has one again — otherwise the map comes back stretched.
    resizePeaksMap();   // peaks.js
  }
}

async function initTab(name) {
  if (name === 'journal') await initJournal();
  else if (name === 'planner') await initPlanner();
  else if (name === 'peaks') await initPeaks();   // peaks.js
  else if (name === 'summits') await initSummits();
}

// ─── Hike index ───────────────────────────────────────────────────────────────

let hikeIndex = null;

// Kick off the default tab on load
console.log('[app] DOM ready, activating journal tab');
activateTab('journal');
async function getHikeIndex() {
  if (!hikeIndex) {
    console.log('[app] fetching data/hikes.json…');
    const res = await fetch('data/hikes.json');
    if (!res.ok) { console.error('[app] data/hikes.json not found:', res.status); throw new Error('hike index missing'); }
    hikeIndex = await res.json();
    console.log('[app] hike index loaded:', hikeIndex);
  }
  return hikeIndex;
}

// ─── Journal ─────────────────────────────────────────────────────────────────

async function initJournal() {
  console.log('[journal] init');
  const { completed } = await getHikeIndex().catch(e => { console.error('[journal] index error:', e); return { completed: [] }; });
  const entries = await loadInfos(completed);

  // Sort newest first
  entries.sort((a, b) => (b.data.date || '').localeCompare(a.data.date || ''));

  console.log('[journal] entries loaded:', entries.map(e => e.folder));
  const list = document.getElementById('journal-list');
  entries.forEach(({ folder, data }) => renderCard(list, folder, data, false));
}

// ─── Planner ─────────────────────────────────────────────────────────────────

async function initPlanner() {
  const { planned } = await getHikeIndex();
  const entries = await loadInfos(planned);
  const list = document.getElementById('planner-list');
  entries.forEach(({ folder, data }) => renderCard(list, folder, data, true));
}

// ─── Summits ─────────────────────────────────────────────────────────────────

async function initSummits() {
  const peaks = await fetch('summits/summits.json').then(r => r.json());
  renderSummitStats(peaks);
  renderSummitMap(peaks);
}

function renderSummitStats(peaks) {
  const highest = peaks.reduce((max, p) => {
    const m = parseInt(p.elevation);
    return m > max.m ? { m, name: p.name } : max;
  }, { m: 0, name: '' });

  const countryNames = {
    DE: 'Germany', '🇩🇪': 'Germany',
    AT: 'Austria',  '🇦🇹': 'Austria',
    IT: 'Italy',    '🇮🇹': 'Italy',
    CH: 'Switzerland', '🇨🇭': 'Switzerland'
  };
  const countries = [...new Set(peaks.map(p => countryNames[p.flag] || p.flag))];

  document.getElementById('summits-stats').innerHTML = `
    <div class="stats-dashboard">
      <div class="stat-card">
        <span class="stat-card-value">${peaks.length}</span>
        <span class="stat-card-label">Summits climbed</span>
      </div>
      <div class="stat-card">
        <span class="stat-card-value">${highest.m} m</span>
        <span class="stat-card-label">Highest · ${highest.name}</span>
      </div>
      <div class="stat-card">
        <span class="stat-card-value">${countries.length}</span>
        <span class="stat-card-label">Countries · ${countries.join(', ')}</span>
      </div>
    </div>
  `;
}

function renderSummitMap(peaks) {
  const mapDiv = document.createElement('div');
  mapDiv.id = 'map-summits';
  mapDiv.className = 'map map--summits';
  document.getElementById('summits-map-container').appendChild(mapDiv);

  const map = new maplibregl.Map({
    container: 'map-summits',
    style: STYLE_SUMMIT,
    center: [11.5, 47.5],
    zoom: 9
  });

  map.addControl(new maplibregl.NavigationControl(), 'top-right');

  peaks.forEach(peak => {
    const el = document.createElement('div');
    el.className = 'peak-marker';
    el.innerHTML = `
      <div class="peak-marker-label">
        <strong>${peak.name}</strong>
        <span>${peak.elevation}</span>
      </div>
      <div class="peak-marker-dot"></div>
    `;

    new maplibregl.Marker({ element: el, anchor: 'bottom' })
      .setLngLat([peak.lon, peak.lat])
      .setPopup(new maplibregl.Popup({ offset: 12 }).setHTML(`
        <div class="popup-content">
          <strong>${peak.name}</strong>
          <span>${peak.elevation}</span>
          <span>${formatDate(peak.date)}</span>
        </div>
      `))
      .addTo(map);
  });

  const bounds = new maplibregl.LngLatBounds();
  peaks.forEach(p => bounds.extend([p.lon, p.lat]));
  map.fitBounds(bounds, { padding: 60 });
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

async function loadInfos(folders) {
  const results = await Promise.all(
    folders.map(folder =>
      fetch(`gpx/${folder}/info.json`)
        .then(r => {
          if (!r.ok) { console.warn(`[loadInfos] ${folder}/info.json → ${r.status}`); return null; }
          return r.json();
        })
        .then(data => data ? { folder, data } : null)
        .catch(e => { console.error(`[loadInfos] ${folder}:`, e); return null; })
    )
  );
  return results.filter(Boolean);
}

function renderCard(container, folder, info, isPlanned) {
  const safeId = folder.replace(/[^a-zA-Z0-9]/g, '-');
  const mapId  = `map-${safeId}`;

  const flagHtml = FLAG_URLS[info.flag]
    ? `<img src="${FLAG_URLS[info.flag]}" alt="${info.flag}" class="flag-icon">`
    : (info.flag || '');

  const card = document.createElement('article');
  card.className = `hike-card${isPlanned ? ' hike-card--planned' : ''}`;
  card.innerHTML = `
    <div id="${mapId}" class="map"></div>
    <div class="card-body">
      <div class="card-header-row">
        <h2 class="card-title">${info.title || folder}</h2>
        ${isPlanned ? '<span class="badge">Planned</span>' : ''}
      </div>
      ${info.location ? `
        <div class="card-location">${flagHtml}<span>${info.location}</span></div>
      ` : ''}
      <div class="card-stats">
        ${info.difficulty  ? `<span class="stat-chip">⚠️ ${info.difficulty}</span>`  : ''}
        ${info.movingTime  ? `<span class="stat-chip">⏱ ${info.movingTime}</span>`   : ''}
        ${info.distance    ? `<span class="stat-chip">🚶 ${info.distance}</span>`    : ''}
        ${info.elevation   ? `<span class="stat-chip">⛰ ${info.elevation}</span>`   : ''}
      </div>
      ${info.description ? `<p class="card-description">${info.description}</p>` : ''}
      <div class="card-footer">
        ${formatDate(info.date) ? `<span class="card-date">📅 ${formatDate(info.date)}</span>` : ''}
        ${info.photos ? `<a class="card-photos" href="${info.photos}" target="_blank">📸 Photo Album</a>` : ''}
      </div>
    </div>
  `;

  container.appendChild(card);
  loadTrack(mapId, folder, safeId, info, isPlanned);
}

function loadTrack(mapId, folder, safeId, info, isPlanned) {
  console.log(`[track] loading gpx/${folder}/track.gpx`);
  fetch(`gpx/${folder}/track.gpx`)
    .then(r => r.ok ? r.text() : Promise.reject(`HTTP ${r.status}`))
    .then(gpxText => {
      console.log(`[track] gpx loaded for ${folder}, initialising map in #${mapId}`);
      const geojson = toGeoJSON.gpx(
        new DOMParser().parseFromString(gpxText, 'application/xml')
      );

      const map = new maplibregl.Map({
        container: mapId,
        style: STYLE_HIKE,
        center: [info.lon || 11.5, info.lat || 47.5],
        zoom: 9
      });

      map.addControl(new maplibregl.NavigationControl(), 'top-right');

      map.on('error', e => console.error(`[map] ${folder} error:`, e));
      map.on('load', () => {
        console.log(`[map] ${folder} loaded`);
        const sourceId = `track-${safeId}`;
        map.addSource(sourceId, { type: 'geojson', data: geojson });

        const lineColor = isPlanned ? '#4a7c59' : '#e85d04';

        try {
          map.addLayer({
            id: `line-${safeId}`,
            type: 'line',
            source: sourceId,
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
              'line-color': lineColor,
              'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.5, 12, 3.5],
              'line-opacity': 0.9
            }
          }, 'Peak labels');
        } catch (e) {
          map.addLayer({
            id: `line-${safeId}`,
            type: 'line',
            source: sourceId,
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': lineColor, 'line-width': 2.5, 'line-opacity': 0.9 }
          });
        }

        const bounds = new maplibregl.LngLatBounds();
        geojson.features.forEach(f => {
          if (f.geometry.type === 'LineString')
            f.geometry.coordinates.forEach(c => bounds.extend(c));
        });
        map.fitBounds(bounds, { padding: 40 });

        const line = geojson.features.find(f => f.geometry.type === 'LineString');
        if (line) {
          const coords = line.geometry.coordinates;
          addTrackMarker(map, coords[0], 'A');
          addTrackMarker(map, coords[coords.length - 1], 'B');
        }
      });
    })
    .catch(err => {
      console.error(`[track] failed for ${folder}:`, err);
      document.getElementById(mapId)?.remove();
    });
}

function addTrackMarker(map, coord, label) {
  const el = document.createElement('div');
  el.className = 'track-marker';
  el.textContent = label;
  new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(coord).addTo(map);
}

function formatDate(dateStr) {
  if (!dateStr || isNaN(new Date(dateStr))) return '';
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long', day: 'numeric', month: 'short', year: 'numeric'
  }).format(new Date(dateStr));
}
