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
 * the ninth, so undo is instant and a long route costs nothing to extend.
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
  /** [lon, lat] per click, with the peak it snapped to when it did. */
  let waypoints = [];
  /** One per gap between waypoints, so undo just pops both. */
  let legs = [];
  let busy = false;

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

    return {
      coordinates: feature.geometry.coordinates,
      metres: Number(feature.properties['track-length']) || 0,
      ascent: Number(feature.properties['filtered ascend']) || 0,
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
    seconds: 0,
    sac: null,
    straight: true
  });

  // ─── Points ─────────────────────────────────────────────────────────────────

  async function addPoint(lngLat, peak = null) {
    if (!active || busy) return;
    const point = [Number(lngLat[0].toFixed(6)), Number(lngLat[1].toFixed(6))];
    const previous = waypoints.at(-1);
    waypoints.push({ point, peak });

    if (!previous) { render(); return; }

    busy = true;
    render();
    try {
      legs.push(await routeLeg(previous.point, point));
    } catch (err) {
      console.warn('[draw] routing failed, joining straight:', err.message);
      legs.push(straightLeg(previous.point, point));
      flash('No path there — joined in a straight line', true);
    }
    busy = false;
    render();
  }

  function undo() {
    if (!waypoints.length) return;
    waypoints.pop();
    legs.pop();
    render();
  }

  function clear() {
    waypoints = [];
    legs = [];
    render();
  }

  /** The way back, reversed — how most days in the mountains actually go. */
  async function outAndBack() {
    if (waypoints.length < 2 || busy) return;
    const back = [...waypoints].reverse().slice(1);
    for (const stop of back) await addPoint(stop.point, stop.peak);
  }

  // ─── Totals ─────────────────────────────────────────────────────────────────

  function summary() {
    const metres = legs.reduce((sum, leg) => sum + leg.metres, 0);
    const ascent = legs.reduce((sum, leg) => sum + leg.ascent, 0);
    const seconds = legs.reduce((sum, leg) => sum + leg.seconds, 0);
    const sac = SAC_ORDER.find(scale => legs.some(leg => leg.sac === scale)) ?? null;
    return { metres, ascent, seconds, sac, straight: legs.some(leg => leg.straight) };
  }

  /** Every leg end to end, without the duplicated point at each junction. */
  function coordinates() {
    const all = [];
    for (const leg of legs) {
      const points = all.length ? leg.coordinates.slice(1) : leg.coordinates;
      all.push(...points);
    }
    return all;
  }

  // ─── Map ────────────────────────────────────────────────────────────────────

  function render() {
    const map = state.map;
    if (!map?.getSource('draw-line')) return;

    map.getSource('draw-line').setData({
      type: 'FeatureCollection',
      features: legs.map((leg, i) => ({
        type: 'Feature',
        properties: { straight: leg.straight, index: i },
        geometry: { type: 'LineString', coordinates: leg.coordinates }
      }))
    });

    map.getSource('draw-points').setData({
      type: 'FeatureCollection',
      features: waypoints.map((stop, i) => ({
        type: 'Feature',
        properties: { label: String(i + 1), peak: stop.peak?.name ?? '' },
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
    const lineWidth = ['interpolate', ['linear'], ['zoom'], 8, 2.5, 14, 5];

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
      paint: {
        'line-color': '#1d4ed8',
        'line-width': lineWidth,
        'line-dasharray': [1.5, 1.5]
      }
    });

    map.addLayer({
      id: 'draw-points',
      type: 'circle',
      source: 'draw-points',
      paint: {
        'circle-radius': 7,
        'circle-color': '#ffffff',
        'circle-stroke-color': '#1d4ed8',
        'circle-stroke-width': 2.5
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
  }

  // ─── Panel ──────────────────────────────────────────────────────────────────

  /** Elevation against distance, as a line small enough to sit in the panel. */
  function profileSvg() {
    const points = coordinates().filter(point => point.length > 2);
    if (points.length < 3) return '';

    const width = 258, height = 46;
    let run = 0;
    const samples = points.map((point, i) => {
      if (i) run += RouteStore.metresBetween(points[i - 1], point);
      return [run, point[2]];
    });

    const highest = Math.max(...samples.map(s => s[1]));
    const lowest = Math.min(...samples.map(s => s[1]));
    const spread = Math.max(1, highest - lowest);
    const path = samples.map(([along, ele]) =>
      `${(along / run * width).toFixed(1)},${(height - (ele - lowest) / spread * (height - 6) - 3).toFixed(1)}`
    ).join(' ');

    return `
      <svg class="draw-profile" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
        <polyline points="${path}" fill="none" stroke="#1d4ed8" stroke-width="1.5" />
      </svg>
      <div class="draw-profile-scale"><span>${Math.round(lowest)} m</span><span>${Math.round(highest)} m</span></div>
    `;
  }

  function renderPanel() {
    const el = document.getElementById('peaks-draw');
    if (!el) return;
    el.hidden = !active;
    if (!active) return;

    const { metres, ascent, seconds, sac, straight } = summary();
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);

    el.innerHTML = `
      <div class="draw-head">
        <strong>Drawing a route</strong>
        <button type="button" id="draw-close" aria-label="Stop drawing">×</button>
      </div>

      <label class="peaks-field">
        <span>Routing</span>
        <select id="draw-profile">
          ${Object.entries(PROFILES).map(([key, label]) =>
            `<option value="${key}"${key === profile ? ' selected' : ''}>${label}</option>`).join('')}
        </select>
      </label>

      <p class="draw-hint">
        ${waypoints.length === 0
          ? 'Click the map to drop the first point. Clicking a peak snaps to its summit.'
          : busy ? 'Finding a path…'
          : `${waypoints.length} point${waypoints.length === 1 ? '' : 's'}${straight ? ' · dashed legs have no path' : ''}`}
      </p>

      <dl class="peaks-stats">
        <div class="peaks-stat"><dt>Distance</dt><dd>${(metres / 1000).toFixed(1)} km</dd></div>
        <div class="peaks-stat"><dt>Ascent</dt><dd>${ascent} m</dd></div>
        ${seconds ? `<div class="peaks-stat"><dt>Estimate</dt><dd>${hours}:${String(minutes).padStart(2, '0')} h</dd></div>` : ''}
        ${sac ? `<div class="peaks-stat"><dt>Hardest</dt><dd>${SAC_LABELS[sac] ?? sac}</dd></div>` : ''}
      </dl>

      ${profileSvg()}

      <div class="peaks-buttons">
        <button type="button" id="draw-undo"${waypoints.length ? '' : ' disabled'}>Undo</button>
        <button type="button" id="draw-back"${legs.length ? '' : ' disabled'}>Out &amp; back</button>
        <button type="button" id="draw-clear"${waypoints.length ? '' : ' disabled'}>Clear</button>
      </div>
      <div class="peaks-buttons">
        <button type="button" id="draw-save" class="draw-save"${legs.length ? '' : ' disabled'}>Save as outing</button>
      </div>
    `;

    el.querySelector('#draw-close').addEventListener('click', stop);
    el.querySelector('#draw-undo').addEventListener('click', undo);
    el.querySelector('#draw-back').addEventListener('click', outAndBack);
    el.querySelector('#draw-clear').addEventListener('click', clear);
    el.querySelector('#draw-save').addEventListener('click', save);
    el.querySelector('#draw-profile').addEventListener('change', async event => {
      profile = event.target.value;
      await reroute();
    });
  }

  /** Re-runs every leg, for when the profile changes under a drawn route. */
  async function reroute() {
    if (waypoints.length < 2) return;
    busy = true;
    render();
    const rebuilt = [];
    for (let i = 1; i < waypoints.length; i++) {
      try {
        rebuilt.push(await routeLeg(waypoints[i - 1].point, waypoints[i].point));
      } catch {
        rebuilt.push(straightLeg(waypoints[i - 1].point, waypoints[i].point));
      }
    }
    legs = rebuilt;
    busy = false;
    render();
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
        // The summits clicked while drawing, which beat guessing from the line.
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
    renderPanel();
  }

  return { start, stop, addPoint, addLayers, isActive: () => active, render };
})();
