/**
 * Drawing a route on the map: click a point, click another, and the line
 * follows the trails between them.
 *
 * Routing is BRouter's public instance — the same engine gpx.studio uses. It
 * needs no key, allows cross-origin calls, understands mountain paths (its
 * hiking profiles read `sac_scale`, so it will not send you up a via ferrata by
 * accident) and returns an elevation with every point, which is what makes
 * distance and ascent honest without a second service.
 *
 * One request per leg, not per route: adding a tenth waypoint routes only from
 * the ninth, dragging one re-routes the two legs it touches, and undo pops a
 * leg rather than recomputing everything.
 *
 * The magnet is BRouter itself. It routes from the nearest routable way, so a
 * point dropped near a path comes back on it — and a dragged point is moved to
 * the routed line's own end, which is where the walk actually starts.
 *
 * BROUTER_URL is the only line that binds this to a server. Point it at your
 * own instance — docker run -v …:/segments4 abrensch/brouter — and nothing
 * else changes.
 */

const RouteDraw = (() => {
  const BROUTER_URL = 'https://brouter.de/brouter';

  const PROFILES = {
    'hiking-mountain': 'Mountain paths',
    trekking: 'Easier tracks',
    shortest: 'Most direct'
  };

  /** Hardest first, so a route's grade is the worst step on it. */
  const SAC_ORDER = [
    'difficult_alpine_hiking',
    'demanding_alpine_hiking',
    'alpine_hiking',
    'demanding_mountain_hiking',
    'mountain_hiking',
    'hiking'
  ];
  const SAC_LABELS = {
    hiking: 'T1 hiking',
    mountain_hiking: 'T2 mountain hiking',
    demanding_mountain_hiking: 'T3 demanding',
    alpine_hiking: 'T4 alpine',
    demanding_alpine_hiking: 'T5 demanding alpine',
    difficult_alpine_hiking: 'T6 difficult alpine'
  };

  let active = false;
  let profile = 'hiking-mountain';
  /** { point: [lon, lat], peak } per stop, in walking order. */
  let waypoints = [];
  /** One per gap between waypoints: legs[i] joins waypoints[i] to waypoints[i + 1]. */
  let legs = [];
  let busy = false;
  let dragging = null;   // { index } while a waypoint is under the cursor

  // ─── Routing ────────────────────────────────────────────────────────────────

  const hardestSac = messages => {
    const found = new Set();
    for (const row of messages?.slice(1) ?? []) {
      const match = /sac_scale=(\S+)/.exec(row[9] ?? '');
      if (match) found.add(match[1]);
    }
    return SAC_ORDER.find(scale => found.has(scale)) ?? null;
  };

  async function routeLeg(from, to) {
    const url = `${BROUTER_URL}?lonlats=${from[0]},${from[1]}|${to[0]},${to[1]}` +
      `&profile=${profile}&alternativeidx=0&format=geojson`;

    const response = await fetch(url);
    if (!response.ok) throw new Error(`BRouter said ${response.status}`);
    const feature = (await response.json()).features?.[0];
    if (!feature?.geometry?.coordinates?.length) throw new Error('no route found');

    const ascent = Number(feature.properties['filtered ascend']) || 0;
    // plain-ascend is the net gain, so what goes down is what does not stay up.
    const net = Number(feature.properties['plain-ascend']) || 0;
    return {
      coordinates: feature.geometry.coordinates,
      metres: Number(feature.properties['track-length']) || 0,
      ascent,
      descent: Math.max(0, ascent - net),
      seconds: Number(feature.properties['total-time']) || 0,
      sac: hardestSac(feature.properties.messages),
      straight: false
    };
  }

  /** When no path connects two points, join them and say so. */
  const straightLeg = (from, to) => ({
    coordinates: [from, to],
    metres: Math.round(RouteStore.metresBetween(from, to)),
    ascent: 0,
    descent: 0,
    seconds: 0,
    sac: null,
    straight: true
  });

  /**
   * Routes the legs on either side of a waypoint, then moves that waypoint onto
   * the line BRouter actually found — the magnet. Everything that changes a
   * point goes through here.
   */
  async function reroute(indexes) {
    const targets = [...new Set(indexes)].filter(i => i >= 0 && i < legs.length);
    if (!targets.length) return;

    busy = true;
    render();
    await Promise.all(targets.map(async i => {
      const from = waypoints[i].point, to = waypoints[i + 1].point;
      try {
        legs[i] = await routeLeg(from, to);
      } catch (err) {
        console.warn('[draw] routing failed, joining straight:', err.message);
        legs[i] = straightLeg(from, to);
      }
    }));
    busy = false;
    snapWaypoints();
    render();
  }

  /** Each stop sits where its routed leg begins or ends, not where it was dropped. */
  function snapWaypoints() {
    waypoints.forEach((stop, i) => {
      // A summit is where it is; the route bends to it, not the other way round.
      if (stop.peak) return;
      const before = legs[i - 1], after = legs[i];
      if (after && !after.straight) stop.point = after.coordinates[0].slice(0, 2);
      else if (before && !before.straight) stop.point = before.coordinates.at(-1).slice(0, 2);
    });
  }

  // ─── Points ─────────────────────────────────────────────────────────────────

  async function addPoint(lngLat, peak = null) {
    if (!active || busy) return;
    const point = [Number(lngLat[0].toFixed(6)), Number(lngLat[1].toFixed(6))];
    waypoints.push({ point, peak });

    if (waypoints.length === 1) { render(); return; }

    const index = waypoints.length - 2;
    legs.push(straightLeg(waypoints[index].point, point));
    await reroute([index]);
  }

  function removePoint(index) {
    if (index < 0 || index >= waypoints.length) return;
    waypoints.splice(index, 1);

    // Closing the gap: the legs either side become one.
    if (index === 0) legs.shift();
    else if (index === waypoints.length) legs.pop();
    else {
      legs.splice(index - 1, 2, straightLeg(waypoints[index - 1].point, waypoints[index].point));
      reroute([index - 1]);
      return;
    }
    render();
  }

  const undo = () => removePoint(waypoints.length - 1);

  function clear() {
    waypoints = [];
    legs = [];
    render();
  }

  /** Walk it the other way. Ascent and descent swap, so every leg is re-routed. */
  async function reverse() {
    if (waypoints.length < 2 || busy) return;
    waypoints.reverse();
    legs = waypoints.slice(1).map((stop, i) => straightLeg(waypoints[i].point, stop.point));
    await reroute(legs.map((_, i) => i));
  }

  /** The way back, retraced — how most days in the mountains actually go. */
  async function outAndBack() {
    if (waypoints.length < 2 || busy) return;
    const back = [...waypoints].reverse().slice(1);
    for (const stop of back) await addPoint(stop.point, stop.peak);
  }

  // ─── Dragging ───────────────────────────────────────────────────────────────

  function startDrag(map, index) {
    dragging = { index };
    map.getCanvas().style.cursor = 'grabbing';

    const onMove = event => {
      const point = [event.lngLat.lng, event.lngLat.lat];
      waypoints[index].point = point;
      // A dragged point is no longer pinned to its summit.
      waypoints[index].peak = null;
      // Straight lines to the neighbours while the mouse is down: routing every
      // frame would be a request per pixel.
      if (legs[index - 1]) legs[index - 1] = straightLeg(waypoints[index - 1].point, point);
      if (legs[index]) legs[index] = straightLeg(point, waypoints[index + 1].point);
      render();
    };

    const onUp = () => {
      map.off('mousemove', onMove);
      map.getCanvas().style.cursor = 'crosshair';
      dragging = null;
      reroute([index - 1, index]);
    };

    map.on('mousemove', onMove);
    map.once('mouseup', onUp);
  }

  function enableDragging(map) {
    map.on('mousedown', 'draw-points', event => {
      if (!active) return;
      event.preventDefault();   // the map must not pan under the point
      startDrag(map, Number(event.features[0].properties.index));
    });

    // Dragging the line itself inserts a stop there, the way a route planner
    // lets you pull a path onto the trail you meant.
    for (const layer of ['draw-line', 'draw-line-straight']) {
      map.on('mousedown', layer, event => {
        if (!active || dragging) return;
        event.preventDefault();
        const leg = Number(event.features[0].properties.index);
        const point = [event.lngLat.lng, event.lngLat.lat];
        waypoints.splice(leg + 1, 0, { point, peak: null });
        legs.splice(leg, 1,
          straightLeg(waypoints[leg].point, point),
          straightLeg(point, waypoints[leg + 2].point));
        startDrag(map, leg + 1);
      });
    }

    for (const layer of ['draw-points', 'draw-line', 'draw-line-straight']) {
      map.on('mouseenter', layer, () => {
        if (active && !dragging) map.getCanvas().style.cursor = 'grab';
      });
      map.on('mouseleave', layer, () => {
        if (active && !dragging) map.getCanvas().style.cursor = 'crosshair';
      });
    }
  }

  // ─── Totals ─────────────────────────────────────────────────────────────────

  function summary() {
    const total = key => legs.reduce((sum, leg) => sum + leg[key], 0);
    return {
      metres: total('metres'),
      ascent: total('ascent'),
      descent: total('descent'),
      seconds: total('seconds'),
      sac: SAC_ORDER.find(scale => legs.some(leg => leg.sac === scale)) ?? null,
      straight: legs.some(leg => leg.straight)
    };
  }

  /** Every leg end to end, without the duplicated point at each junction. */
  function coordinates() {
    const all = [];
    for (const leg of legs) all.push(...(all.length ? leg.coordinates.slice(1) : leg.coordinates));
    return all;
  }

  // ─── Map ────────────────────────────────────────────────────────────────────

  function render() {
    const map = state.map;
    if (!map?.getSource('draw-line')) return;

    map.getSource('draw-line').setData({
      type: 'FeatureCollection',
      features: legs.map((leg, index) => ({
        type: 'Feature',
        properties: { straight: leg.straight, index },
        geometry: { type: 'LineString', coordinates: leg.coordinates }
      }))
    });

    map.getSource('draw-points').setData({
      type: 'FeatureCollection',
      features: waypoints.map((stop, index) => ({
        type: 'Feature',
        properties: { index, label: String(index + 1), summit: stop.peak ? 1 : 0 },
        geometry: { type: 'Point', coordinates: stop.point }
      }))
    });

    renderPanel();
  }

  function addLayers(map) {
    map.addSource('draw-line', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource('draw-points', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

    // Two layers over one source rather than one with a data-driven dash:
    // line-dasharray takes no data expression, so the difference between a
    // routed leg and a straight guess has to be a filter.
    const lineWidth = ['interpolate', ['linear'], ['zoom'], 8, 3, 14, 5.5];

    map.addLayer({
      id: 'draw-line',
      type: 'line',
      source: 'draw-line',
      filter: ['!=', ['get', 'straight'], true],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#1d4ed8', 'line-width': lineWidth }
    });

    map.addLayer({
      id: 'draw-line-straight',
      type: 'line',
      source: 'draw-line',
      filter: ['==', ['get', 'straight'], true],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#1d4ed8', 'line-width': lineWidth, 'line-dasharray': [1.5, 1.5] }
    });

    map.addLayer({
      id: 'draw-points',
      type: 'circle',
      source: 'draw-points',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 6, 14, 9],
        'circle-color': '#ffffff',
        // A stop pinned to a summit is filled, so it reads as a destination.
        'circle-stroke-color': ['case', ['==', ['get', 'summit'], 1], '#2f7d32', '#1d4ed8'],
        'circle-stroke-width': 3
      }
    });

    map.addLayer({
      id: 'draw-points-label',
      type: 'symbol',
      source: 'draw-points',
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 10,
        'text-allow-overlap': true
      },
      paint: { 'text-color': '#1d4ed8' }
    });

    enableDragging(map);
  }

  // ─── Panel ──────────────────────────────────────────────────────────────────

  /** Elevation against distance, filled, with the climbing visible in it. */
  function profileSvg() {
    const points = coordinates().filter(point => point.length > 2);
    if (points.length < 3) return '';

    const width = 320, height = 96;
    let run = 0;
    const samples = points.map((point, i) => {
      if (i) run += RouteStore.metresBetween(points[i - 1], point);
      return [run, point[2]];
    });
    if (!run) return '';

    const highest = Math.max(...samples.map(s => s[1]));
    const lowest = Math.min(...samples.map(s => s[1]));
    const spread = Math.max(1, highest - lowest);
    const x = along => (along / run * width).toFixed(1);
    const y = ele => (height - 4 - (ele - lowest) / spread * (height - 14)).toFixed(1);
    const line = samples.map(([along, ele]) => `${x(along)},${y(ele)}`).join(' ');

    return `
      <div class="draw-profile-box">
        <svg class="draw-profile" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img"
             aria-label="Elevation profile, ${Math.round(lowest)} to ${Math.round(highest)} metres">
          <polygon points="0,${height} ${line} ${width},${height}" fill="#dbeafe" />
          <polyline points="${line}" fill="none" stroke="#1d4ed8" stroke-width="1.5" />
        </svg>
        <span class="draw-profile-high">${Math.round(highest)} m</span>
        <span class="draw-profile-low">${Math.round(lowest)} m</span>
      </div>
    `;
  }

  const clock = seconds =>
    `${Math.floor(seconds / 3600)}:${String(Math.round((seconds % 3600) / 60)).padStart(2, '0')} h`;

  function waypointList() {
    if (!waypoints.length) return '';
    return `
      <ol class="draw-stops">
        ${waypoints.map((stop, i) => `
          <li class="draw-stop${stop.peak ? ' is-summit' : ''}">
            <span class="draw-stop-number">${i + 1}</span>
            <span class="draw-stop-name">
              ${stop.peak
                ? `${escapeHtml(stop.peak.name ?? 'Summit')} <small>${stop.peak.ele ?? '?'} m</small>`
                : `<small>${stop.point[1].toFixed(4)}, ${stop.point[0].toFixed(4)}</small>`}
            </span>
            <button type="button" class="draw-stop-remove" data-index="${i}" aria-label="Remove stop ${i + 1}">×</button>
          </li>
        `).join('')}
      </ol>
    `;
  }

  function renderPanel() {
    const el = document.getElementById('peaks-draw');
    if (!el) return;
    el.hidden = !active;
    document.body.classList.toggle('is-drawing', active);
    if (!active) return;

    const { metres, ascent, descent, seconds, sac, straight } = summary();

    el.innerHTML = `
      <header class="draw-head">
        <h2>Planning a route</h2>
        <button type="button" id="draw-close" aria-label="Stop drawing">×</button>
      </header>

      <p class="draw-hint">
        ${waypoints.length === 0
          ? 'Click the map to drop the first stop. Clicking a peak pins its summit.'
          : busy ? 'Finding a path…'
          : 'Drag a stop to move it, drag the line to add one in between.'}
        ${straight ? '<br><strong>Dashed legs have no path</strong> — measured straight.' : ''}
      </p>

      <div class="draw-stats">
        <div class="draw-stat draw-stat--wide">
          <span class="draw-stat-value">${(metres / 1000).toFixed(1)}</span>
          <span class="draw-stat-label">km</span>
        </div>
        <div class="draw-stat">
          <span class="draw-stat-value">${ascent}</span>
          <span class="draw-stat-label">m up</span>
        </div>
        <div class="draw-stat">
          <span class="draw-stat-value">${descent}</span>
          <span class="draw-stat-label">m down</span>
        </div>
        <div class="draw-stat">
          <span class="draw-stat-value">${seconds ? clock(seconds) : '—'}</span>
          <span class="draw-stat-label">estimate</span>
        </div>
        <div class="draw-stat">
          <span class="draw-stat-value draw-stat-value--small">${sac ? SAC_LABELS[sac] : '—'}</span>
          <span class="draw-stat-label">hardest</span>
        </div>
      </div>

      ${profileSvg()}

      ${waypointList()}

      <label class="peaks-field">
        <span>Routing</span>
        <select id="draw-profile">
          ${Object.entries(PROFILES).map(([key, label]) =>
            `<option value="${key}"${key === profile ? ' selected' : ''}>${label}</option>`).join('')}
        </select>
      </label>

      <div class="peaks-buttons">
        <button type="button" id="draw-undo"${waypoints.length ? '' : ' disabled'}>Undo</button>
        <button type="button" id="draw-reverse"${legs.length ? '' : ' disabled'}>Reverse</button>
      </div>
      <div class="peaks-buttons">
        <button type="button" id="draw-back"${legs.length ? '' : ' disabled'}>Out &amp; back</button>
        <button type="button" id="draw-clear"${waypoints.length ? '' : ' disabled'}>Clear</button>
      </div>
      <div class="peaks-buttons">
        <button type="button" id="draw-save" class="draw-save"${legs.length ? '' : ' disabled'}>Save as outing</button>
      </div>
    `;

    el.querySelector('#draw-close').addEventListener('click', stop);
    el.querySelector('#draw-undo').addEventListener('click', undo);
    el.querySelector('#draw-reverse').addEventListener('click', reverse);
    el.querySelector('#draw-back').addEventListener('click', outAndBack);
    el.querySelector('#draw-clear').addEventListener('click', clear);
    el.querySelector('#draw-save').addEventListener('click', save);
    el.querySelector('#draw-profile').addEventListener('change', async event => {
      profile = event.target.value;
      await reroute(legs.map((_, i) => i));
    });
    el.querySelectorAll('.draw-stop-remove').forEach(button => {
      button.addEventListener('click', () => removePoint(Number(button.dataset.index)));
    });
    el.querySelectorAll('.draw-stop').forEach((row, i) => {
      row.addEventListener('click', event => {
        if (event.target.closest('.draw-stop-remove')) return;
        state.map.easeTo({ center: waypoints[i].point, zoom: Math.max(state.map.getZoom(), 13) });
      });
    });
  }

  // ─── Saving ─────────────────────────────────────────────────────────────────

  function save() {
    const points = coordinates();
    if (points.length < 2) return;

    const { metres, ascent, seconds, sac } = summary();
    const simplified = RouteStore.simplify(points, 5);
    const lons = points.map(p => p[0]), lats = points.map(p => p[1]);

    RouteForm.open({
      draft: {
        track: RouteStore.encode(simplified),
        track_points: simplified.length,
        bounds: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
        distance_m: Math.round(metres),
        ascent_m: Math.round(ascent),
        moving_seconds: seconds || null,
        difficulty: sac ? SAC_LABELS[sac] : null,
        fullPoints: points,
        // The summits pinned while drawing, which beat guessing from the line.
        title: waypoints.map(stop => stop.peak?.name).filter(Boolean).at(-1) ?? ''
      }
    });
  }

  // ─── Start and stop ─────────────────────────────────────────────────────────

  function start() {
    if (!state.map) return;
    active = true;
    state.popup?.remove();
    state.map.getCanvas().style.cursor = 'crosshair';
    render();
  }

  function stop() {
    active = false;
    clear();
    if (state.map) state.map.getCanvas().style.cursor = '';
    document.body.classList.remove('is-drawing');
    renderPanel();
  }

  return { start, stop, addPoint, addLayers, isActive: () => active, render };
})();
