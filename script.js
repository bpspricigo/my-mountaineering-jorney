let hikeFolders = [];

if (window.location.pathname.includes('future')) {
  // Future hikes page
  hikeFolders = [
    'future/herzogstand'
  ];
} else {
  // Main (completed) hikes page
  hikeFolders = [
    'Sample 1',
    'Sample 2',
    'Sample 3',
    '20250531',
    '20250601'
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
      const map = L.map(`map-${folder}`).setView([0, 0], 13);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors'
      }).addTo(map);

      new L.GPX(`gpx/${folder}/track.gpx`, {
        async: true,
        marker_options: {
          endIcon: L.divIcon({
            className: 'custom-marker',
            html: '<div class="marker-label">B</div>',
            iconSize: [24, 24],
            iconAnchor: [12, 12],
            zIndexOffset: 10
          }),
          startIcon: L.divIcon({
            className: 'custom-marker',
            html: '<div class="marker-label">A</div>',
            iconSize: [24, 24],
            iconAnchor: [12, 12],
            zIndexOffset: 20
          }),
          shadowUrl: null
        }
      }).on('loaded', function(e) {
        map.fitBounds(e.target.getBounds());
      }).addTo(map);
    })
    .catch(err => {
      console.warn(`Map skipped for ${folder}: ${err.message}`);
      document.getElementById(`map-${folder}`).remove(); // Optional: remove the empty map div
    });
}


function countryCodeToFlagEmoji(code) {
  return code
    .toUpperCase()
    .replace(/./g, char => 
      String.fromCodePoint(char.charCodeAt(0) + 127397)
    );
}