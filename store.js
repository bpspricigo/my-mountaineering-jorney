/**
 * Where peak statuses live.
 *
 * Tagging a peak has to work three ways: on a fresh clone with no account, in
 * this browser between visits, and — once signed in — on every device at once.
 * Those are different storage backends, so the planner talks to this interface
 * instead of to any one of them:
 *
 *   await PeakStore.open()        load everything, return id → entry
 *   PeakStore.get(id)             one entry, or undefined
 *   await PeakStore.set(id, e)    write one
 *   PeakStore.pendingCount()      entries this backend holds that the
 *                                 committed baseline does not
 *   PeakStore.toExport()          the whole list, shaped as peak-status.json
 *   await PeakStore.importAll(o)  merge an exported file back in
 *
 * Two layers are always in play. `data/peak-status.json` is the committed
 * baseline: it ships with the repo, needs no account, and is what a fresh
 * clone sees. On top of it sits whatever the active backend holds, which wins.
 *
 * The local backend is `localStorage`, which is per-browser and invisible to
 * everyone else — hence `pendingCount()`, so the interface can admit when work
 * exists in one browser only. The Supabase backend replaces that layer with a
 * table once signed in (#3); the planner does not change either way.
 */

const PeakStore = (() => {
  const BASELINE_URL = 'data/peak-status.json';
  const STORAGE_KEY = 'mmj.peak-status.v1';

  /** id → entry, baseline merged with the backend's own edits. */
  let entries = new Map();
  /** What the committed file said, kept separately to spot unsaved work. */
  let baseline = {};
  let backend = null;

  // ─── Local backend ──────────────────────────────────────────────────────────

  const localBackend = {
    name: 'local',
    label: 'this browser',

    read() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
      } catch (err) {
        // Private browsing, disabled site data, or a corrupted value. None of
        // these should stop the planner loading the baseline.
        console.warn('[store] could not read local edits:', err);
        return {};
      }
    },

    write(all) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
        return true;
      } catch (err) {
        console.warn('[store] could not save locally:', err);
        return false;
      }
    }
  };

  // ─── Baseline ───────────────────────────────────────────────────────────────

  async function readBaseline() {
    try {
      const res = await fetch(BASELINE_URL);
      if (!res.ok) return {};
      const json = await res.json();
      return json.peaks ?? {};
    } catch {
      // A clone without the file is a legitimate starting state, not an error.
      return {};
    }
  }

  // ─── Interface ──────────────────────────────────────────────────────────────

  async function open() {
    backend = localBackend;
    baseline = await readBaseline();

    const own = backend.read();
    entries = new Map(
      Object.entries({ ...baseline, ...own }).map(([id, entry]) => [String(id), entry])
    );

    console.log(`[store] ${entries.size} entries (${Object.keys(baseline).length} from the baseline, backend: ${backend.name})`);
    return entries;
  }

  function persist() {
    const all = {};
    for (const [id, entry] of entries) all[id] = entry;
    return backend.write(all);
  }

  async function set(id, entry) {
    entries.set(String(id), entry);
    return persist();
  }

  const get = id => entries.get(String(id));
  const all = () => entries;

  /**
   * Entries whose status differs from the committed baseline — work that exists
   * only where the current backend can see it.
   */
  function pendingCount() {
    let changed = 0;
    const ids = new Set([...Object.keys(baseline), ...entries.keys()]);
    for (const id of ids) {
      const before = baseline[id]?.status ?? 'none';
      const after = entries.get(String(id))?.status ?? 'none';
      if (before !== after) changed++;
    }
    return changed;
  }

  /** Shaped exactly like data/peak-status.json, so an export can replace it. */
  function toExport() {
    const peaks = {};
    for (const [id, entry] of entries) {
      // Cleared peaks are tombstones locally; in a file they are simply absent.
      if (!entry || entry.status === 'none') continue;
      peaks[id] = entry;
    }
    return { version: 1, updated: new Date().toISOString().slice(0, 10), peaks };
  }

  async function importAll(payload, isKnownStatus) {
    const incoming = payload?.peaks ?? payload;
    if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) {
      throw new Error('not a peak-status export');
    }

    const applied = [];
    for (const [id, entry] of Object.entries(incoming)) {
      if (!entry?.status || !isKnownStatus(entry.status)) continue;
      entries.set(String(id), entry);
      applied.push(String(id));
    }
    persist();
    return applied;
  }

  /** True once statuses are stored somewhere other than this browser. */
  const isShared = () => Boolean(backend?.shared);
  const describe = () => backend?.label ?? 'nowhere yet';

  return { open, get, set, all, pendingCount, toExport, importAll, isShared, describe };
})();
