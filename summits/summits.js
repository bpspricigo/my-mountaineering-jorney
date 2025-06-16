const apiKey = CONFIG.MAPTILER_API_KEY;

const container = document.createElement('section');
container.classList.add('section-summits');
container.innerHTML = `
  <div id="map-summits" class="map-summit"></div>
  <h2>
      Summits
  </h2>
`;

document.getElementById('journal').appendChild(container);

fetch('summits/summits.json')
  .then(res => res.json())
  .then(peaks => {
    const map = new maplibregl.Map({
      container: 'map-summits',
      style: `https://api.maptiler.com/maps/019777b2-7e93-7846-880d-ec28927d8a99/style.json?key=${apiKey}`,
      center: [11.5, 47.5],
      zoom: 9
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    peaks.forEach(peak => {
      // Create a new div for each marker
      const markerDiv = document.createElement('div');
      markerDiv.style.fontSize = '12px';
      markerDiv.style.textAlign = 'center';
      markerDiv.style.lineHeight = '1.2';
      markerDiv.style.whiteSpace = 'nowrap';
      markerDiv.style.color = 'black';

      markerDiv.innerHTML = `
        <div>${peak.name}</div>
        <div>${peak.elevation}</div>
        <div style="font-size: 16px; line-height: 1;">🗻</div>
      `;
      
      new maplibregl.Marker({ element : markerDiv, anchor: 'bottom' })
        .setLngLat([peak.lon, peak.lat])
        .setPopup(new maplibregl.Popup().setHTML(`
          <strong>${peak.name}</strong><br>
          ${peak.elevation}<br>
          ${peak.flag} ${peak.date}
        `))
        .addTo(map);
    });

    // Fit map to bounds
    const bounds = new maplibregl.LngLatBounds();
    peaks.forEach(p => bounds.extend([p.lon, p.lat]));
    map.fitBounds(bounds, { padding: 50 });
  });
