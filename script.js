const hikeFolders = ['Sample 1', 'Sample 2', 'Sample 3', '20250531', '20250601']; // Just keep adding to this list

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
  const description = info.description || 'No description available.';
  const distance = info.distance || 'N/A';
  const elevation = info.elevation || 'N/A';
  const movingTime = info.movingTime || 'N/A';
  const photos = info.photos || null;

  const formattedDate = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  }).format(new Date(date));  

  const container = document.createElement('section');
  container.innerHTML = `
    <h2>${formattedDate}</h2>
    <h3>${title}</h3>
    <ul>
      <li><strong>Distance:</strong> ${distance}</li>
      <li><strong>Elevation gain:</strong> ${elevation}</li>
      ${movingTime !== 'N/A' ? `<li><strong>Moving time:</strong> ${movingTime}</li>` : ''}
      <li><strong>Notes:</strong> ${description}</p>
      ${photos ? `<li><strong>Photos:</strong> <a href="${photos}" target="_blank">📸 View Photo Album</a></p>` : ""}
    </ul>
    
    <div id="map-${folder}" class="map"></div>
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
          startIconUrl: 'https://leafletjs.com/examples/custom-icons/leaf-green.png',
          endIconUrl: 'https://leafletjs.com/examples/custom-icons/leaf-red.png',
          shadowUrl: 'https://leafletjs.com/examples/custom-icons/leaf-shadow.png'
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
