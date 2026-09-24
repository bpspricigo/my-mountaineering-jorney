/**
 * Outings: the walks themselves, done or planned, and their tracks.
 *
 * A route is not a property of a peak. One walk can take in several summits —
 * "Brunnensteinspitze und Rotwandlspitze" is one day and two peaks — and a
 * peak collects walks over the years, so the two meet through route_peak.
 *
 *   await RouteStore.open()         load this account's routes
 *   RouteStore.forPeak(id)          the routes that take in a peak
 *   RouteStore.all()                every route, newest first
 *   await RouteStore.save(route, peakIds)
 *   await RouteStore.remove(id)
 *   RouteStore.available()          false when signed out — routes need an account
 *
 *   RouteStore.readGpx(text)        { track, points, bounds, distance_m, … }
 *   RouteStore.decode(polyline)     back to [[lon, lat], …] for the map
 *
 * Tracks are stored as encoded polylines rather than files. A 600 KB GPX
 * simplified to 5 m keeps every switchback and costs about 1 KB: small enough
 * to live in the row, so drawing a track needs no second request and no
 * storage bucket. Distance and ascent are measured from the full-resolution
 * points before simplifying, so the numbers never pay for the smaller line.
 */

const RouteStore = (() => {
  const EARTH_RADIUS_M = 6371000;
  /** Simplification tolerance. Below a GPS fix's own error, so nothing real is lost. */
  const TOLERANCE_M = 5;

  const rad = deg => deg * Math.PI / 180;

  /** id → route, with `peaks: [{ peak_id, name, ele }]` attached. */
  let routes = new Map();
  /** peak id (string) → routes taking it in. */
  let byPeak = new Map();

  const db = () => PeakStore.db();

  // ─── Geometry ───────────────────────────────────────────────────────────────

  function metresBetween(a, b) {
    const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
  }

  /**
   * Ramer–Douglas–Peucker, iterative so a 4,000 point track cannot blow the
   * stack, measuring in metres on a plane local to the track's first point —
   * at Alpine latitudes over a day's walk the distortion is centimetres.
   */
  function simplify(points, tolerance) {
    if (points.length < 3) return points.slice();

    const lat0 = rad(points[0][1]);
    const x = p => rad(p[0]) * Math.cos(lat0) * EARTH_RADIUS_M;
    const y = p => rad(p[1]) * EARTH_RADIUS_M;

    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];

    while (stack.length) {
      const [first, last] = stack.pop();
      const ax = x(points[first]), ay = y(points[first]);
      const dx = x(points[last]) - ax, dy = y(points[last]) - ay;
      const len2 = dx * dx + dy * dy;

      let index = -1, worst = 0;
      for (let i = first + 1; i < last; i++) {
        const px = x(points[i]), py = y(points[i]);
        const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
        const away = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
        if (away > worst) { worst = away; index = i; }
      }

      if (worst > tolerance && index > 0) {
        keep[index] = 1;
        stack.push([first, index], [index, last]);
      }
    }
    return points.filter((_, i) => keep[i]);
  }

  // ─── Encoded polyline (Google's algorithm, precision 5) ─────────────────────

  function encode(points) {
    let lastLat = 0, lastLon = 0, out = '';
    const chunk = value => {
      let v = value < 0 ? ~(value << 1) : value << 1;
      let s = '';
      while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
      return s + String.fromCharCode(v + 63);
    };
    for (const [lon, lat] of points) {
      const la = Math.round(lat * 1e5), lo = Math.round(lon * 1e5);
      out += chunk(la - lastLat) + chunk(lo - lastLon);
      lastLat = la; lastLon = lo;
    }
    return out;
  }

  function decode(polyline) {
    const points = [];
    let i = 0, lat = 0, lon = 0;
    while (i < polyline.length) {
      let result = 0, shift = 0, byte;
      do { byte = polyline.charCodeAt(i++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
      lat += (result & 1) ? ~(result >> 1) : result >> 1;

      result = 0; shift = 0;
      do { byte = polyline.charCodeAt(i++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
      lon += (result & 1) ? ~(result >> 1) : result >> 1;

      points.push([lon / 1e5, lat / 1e5]);
    }
    return points;
  }

  // ─── GPX ────────────────────────────────────────────────────────────────────

  /**
   * A GPX file to everything a route row needs. Handles a track (`trkpt`) or a
   * route/waypoint list (`rtept`), which is what route planners export.
   */
  function readGpx(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('that file is not valid GPX');

    const nodes = [...doc.querySelectorAll('trkpt, rtept')];
    if (!nodes.length) throw new Error('no track points in that file');

    const points = [];
    const elevations = [];
    const times = [];
    for (const node of nodes) {
      const lat = Number(node.getAttribute('lat'));
      const lon = Number(node.getAttribute('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      points.push([lon, lat]);
      const ele = Number(node.querySelector('ele')?.textContent);
      elevations.push(Number.isFinite(ele) ? ele : null);
      const time = node.querySelector('time')?.textContent;
      times.push(time ? Date.parse(time) : null);
    }
    if (points.length < 2) throw new Error('that track has fewer than two points');

    // Measured at full resolution, before the line is thinned.
    let distance = 0, ascent = 0, moving = 0;
    for (let i = 1; i < points.length; i++) {
      const step = metresBetween(points[i - 1], points[i]);
      distance += step;

      const climb = (elevations[i] ?? 0) - (elevations[i - 1] ?? 0);
      // 2 m of noise sits on every barometric fix; summing it raw inflates a
      // day's ascent by hundreds of metres.
      if (elevations[i] !== null && elevations[i - 1] !== null && climb > 2) ascent += climb;

      const gap = (times[i] ?? 0) - (times[i - 1] ?? 0);
      // Standing still, a long break, or a device that logs no time at all.
      if (gap > 0 && gap < 120000 && step > 1) moving += gap;
    }

    const simplified = simplify(points, TOLERANCE_M);
    const lons = points.map(p => p[0]), lats = points.map(p => p[1]);

    return {
      track: encode(simplified),
      track_points: simplified.length,
      bounds: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
      distance_m: Math.round(distance),
      ascent_m: Math.round(ascent),
      moving_seconds: moving ? Math.round(moving / 1000) : null,
      // Kept out of the row; the importer uses it to find which peaks a walk took in.
      fullPoints: points,
      date: times.find(Boolean) ? new Date(times.find(Boolean)).toISOString().slice(0, 10) : null
    };
  }

  // ─── Store ──────────────────────────────────────────────────────────────────

  const available = () => Boolean(db().client && db().user);

  function index() {
    byPeak = new Map();
    for (const route of routes.values()) {
      for (const { peak_id } of route.peaks ?? []) {
        const key = String(peak_id);
        if (!byPeak.has(key)) byPeak.set(key, []);
        byPeak.get(key).push(route);
      }
    }
  }

  async function open() {
    routes = new Map();
    byPeak = new Map();
    if (!available()) return routes;

    const { client } = db();
    const [{ data: rows, error }, { data: links, error: linkError }] = await Promise.all([
      client.from('route').select('*').order('date', { ascending: false }),
      client.from('route_peak').select('*')
    ]);
    if (error || linkError) {
      console.error('[routes] could not load:', error ?? linkError);
      return routes;
    }

    for (const row of rows) routes.set(row.id, { ...row, peaks: [] });
    for (const link of links) routes.get(link.route_id)?.peaks.push(link);
    index();

    console.log(`[routes] ${routes.size} routes, ${links.length} peak links`);
    return routes;
  }

  const all = () => [...routes.values()];
  const get = id => routes.get(id);
  const forPeak = peakId => byPeak.get(String(peakId)) ?? [];

  /**
   * Writes a route and the peaks it takes in. `peaks` is a list of
   * { peak_id, name, ele }; passing it replaces whatever was linked before.
   */
  async function save(route, peaks) {
    if (!available()) throw new Error('sign in to save a route');
    const { client, user } = db();

    const row = { ...route, user_id: user.id };
    delete row.peaks;

    const { data, error } = await client.from('route').upsert(row).select().single();
    if (error) throw error;

    if (peaks) {
      const { error: clearError } = await client.from('route_peak').delete().eq('route_id', data.id);
      if (clearError) throw clearError;

      if (peaks.length) {
        const { error: linkError } = await client.from('route_peak').insert(
          peaks.map(p => ({ route_id: data.id, user_id: user.id, peak_id: p.peak_id, name: p.name, ele: p.ele }))
        );
        if (linkError) throw linkError;
      }
    }

    const saved = { ...data, peaks: (peaks ?? get(data.id)?.peaks ?? []).map(p => ({ ...p, route_id: data.id })) };
    routes.set(saved.id, saved);
    index();
    return saved;
  }

  async function remove(id) {
    if (!available()) throw new Error('sign in to delete a route');
    // route_peak rows go with it: the foreign key cascades.
    const { error } = await db().client.from('route').delete().eq('id', id);
    if (error) throw error;
    routes.delete(id);
    index();
  }

  /** True when a route from this source folder is already in the account. */
  const hasSource = source => all().some(r => r.source === source);

  return {
    open, all, get, forPeak, save, remove, hasSource, available,
    readGpx, decode, encode, simplify, metresBetween
  };
})();
