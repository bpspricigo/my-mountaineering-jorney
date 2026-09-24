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
 *   await PeakStore.set(id, e)    write one; false if it did not stick
 *   PeakStore.pendingCount()      entries this backend holds that the
 *                                 committed baseline does not
 *   PeakStore.toExport()          the whole list, shaped as peak-status.json
 *   await PeakStore.importAll(o)  merge an exported file back in
 *
 *   PeakStore.account()           { available, email } for the sign-in UI
 *   await PeakStore.signIn(email) send a magic link
 *   await PeakStore.signOut()
 *   PeakStore.onChange(fn)        called after signing in or out reloads
 *                                 the entries from the other backend
 *
 * Signed out, two layers are in play. `data/peak-status.json` is the committed
 * baseline: it ships with the repo, needs no account, and is what a fresh
 * clone sees. On top of it sits `localStorage`, which wins, and which is
 * per-browser and invisible to everyone else — hence `pendingCount()`, so the
 * interface can admit when work exists in one browser only.
 *
 * Signed in, the `peak_status` table is the whole truth and the baseline is
 * only a seed: an account with no rows yet is filled from the baseline plus
 * this browser's edits, once. After that the file is never read again for that
 * account, so clearing a peak is a plain delete rather than a tombstone.
 *
 * Without SUPABASE_URL in config.js, or without the supabase-js script, the
 * account half simply does not exist and the planner works as before.
 */

const PeakStore = (() => {
  const BASELINE_URL = 'data/peak-status.json';
  const STORAGE_KEY = 'mmj.peak-status.v1';
  const TABLE = 'peak_status';

  /** id → entry, as the planner sees it. */
  let entries = new Map();
  /** What the committed file said, kept separately to spot unsaved work. */
  let baseline = {};
  let backend = null;

  const listeners = new Set();

  // ─── Supabase client ────────────────────────────────────────────────────────

  // Created as soon as this script runs, not when the Peaks tab opens: the
  // magic link lands on the page with the session in the URL fragment, and the
  // client has to read it before anything else touches the URL.
  const client = (() => {
    const url = typeof CONFIG !== 'undefined' ? CONFIG.SUPABASE_URL : null;
    const key = typeof CONFIG !== 'undefined' ? CONFIG.SUPABASE_PUBLISHABLE_KEY : null;
    if (!url || !key || !window.supabase?.createClient) return null;
    // Implicit flow, so a link opened in a different browser from the one
    // that asked for it still signs that browser in.
    return window.supabase.createClient(url, key, { auth: { flowType: 'implicit' } });
  })();

  let user = null;

  // ─── Local backend ──────────────────────────────────────────────────────────

  const localBackend = {
    name: 'local',
    label: 'this browser',
    shared: false,

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

    async load() {
      return { ...baseline, ...this.read() };
    },

    writeAll() {
      const all = {};
      for (const [id, entry] of entries) all[id] = entry;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
        return true;
      } catch (err) {
        console.warn('[store] could not save locally:', err);
        return false;
      }
    },

    async save(id, entry) {
      // Keep the tombstone: the baseline would otherwise put a cleared peak back.
      entries.set(id, entry);
      return this.writeAll();
    },

    async saveMany(batch) {
      for (const [id, entry] of Object.entries(batch)) entries.set(id, entry);
      return this.writeAll();
    }
  };

  // ─── Supabase backend ───────────────────────────────────────────────────────

  const toRow = (id, entry) => ({
    user_id: user.id,
    peak_id: Number(id),
    status: entry.status,
    name: entry.name ?? null,
    ele: entry.ele ?? null,
    country: entry.country ?? null,
    // Position and provenance, so a tagged peak can be drawn without the
    // snapshot — which is the only way to dream of something in the Andes.
    lat: entry.lat ?? null,
    lon: entry.lon ?? null,
    source: entry.source ?? null,
    climbed_on: entry.date ?? null,
    note: entry.note ?? null
  });

  const fromRow = row => {
    const entry = {
      status: row.status,
      name: row.name,
      ele: row.ele,
      country: row.country,
      updated: row.updated_at?.slice(0, 10)
    };
    if (row.lat != null && row.lon != null) { entry.lat = row.lat; entry.lon = row.lon; }
    if (row.source) entry.source = row.source;
    if (row.climbed_on) entry.date = row.climbed_on;
    if (row.note) entry.note = row.note;
    return entry;
  };

  const isTagged = entry => entry?.status && entry.status !== 'none';

  const supabaseBackend = {
    name: 'supabase',
    shared: true,
    get label() { return user?.email ?? 'your account'; },

    async load() {
      const { data, error } = await client.from(TABLE).select('*');
      if (error) throw error;

      if (data.length) {
        return Object.fromEntries(data.map(row => [String(row.peak_id), fromRow(row)]));
      }

      // First sign-in on this account: seed it with what this browser shows.
      const seed = Object.fromEntries(
        Object.entries({ ...baseline, ...localBackend.read() }).filter(([, e]) => isTagged(e))
      );
      const rows = Object.entries(seed).map(([id, e]) => toRow(id, e));
      if (rows.length) {
        const { error: seedError } = await client.from(TABLE).insert(rows);
        if (seedError) throw seedError;
        console.log(`[store] seeded the account with ${rows.length} statuses`);
      }
      return seed;
    },

    async save(id, entry) {
      const { error } = isTagged(entry)
        ? await client.from(TABLE).upsert(toRow(id, entry))
        : await client.from(TABLE).delete().eq('peak_id', Number(id));
      if (error) {
        console.error('[store] could not save to the account:', error);
        return false;
      }
      if (isTagged(entry)) entries.set(id, entry);
      else entries.delete(id);
      return true;
    },

    async saveMany(batch) {
      const rows = Object.entries(batch).filter(([, e]) => isTagged(e)).map(([id, e]) => toRow(id, e));
      const { error } = await client.from(TABLE).upsert(rows);
      if (error) {
        console.error('[store] could not import to the account:', error);
        return false;
      }
      for (const [id, entry] of Object.entries(batch)) entries.set(id, entry);
      return true;
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

  let opened = false;

  async function load() {
    backend = user ? supabaseBackend : localBackend;
    let loaded;
    try {
      loaded = await backend.load();
    } catch (err) {
      // Signed in but the database is unreachable: keep working in this
      // browser rather than showing an empty map.
      console.error('[store] could not load the account, falling back to this browser:', err);
      backend = localBackend;
      loaded = await backend.load();
    }
    entries = new Map(Object.entries(loaded).map(([id, entry]) => [String(id), entry]));
    console.log(`[store] ${entries.size} entries (backend: ${backend.name})`);
  }

  async function open() {
    baseline = await readBaseline();
    if (client) {
      const { data } = await client.auth.getSession();
      user = data.session?.user ?? null;
    }
    await load();
    opened = true;
    return entries;
  }

  if (client) {
    client.auth.onAuthStateChange((event, session) => {
      const next = session?.user ?? null;
      if ((next?.id ?? null) === (user?.id ?? null)) return;
      user = next;
      if (!opened) return;   // open() will pick the session up itself
      // supabase-js deadlocks if its own calls are awaited inside this
      // callback, so the reload runs on the next tick.
      setTimeout(async () => {
        await load();
        listeners.forEach(fn => fn(entries));
      }, 0);
    });
  }

  async function set(id, entry) {
    return backend.save(String(id), entry);
  }

  const get = id => entries.get(String(id));
  const all = () => entries;

  /**
   * Entries whose status differs from the committed baseline — work that exists
   * only where the current backend can see it. Nothing is pending in an account.
   */
  function pendingCount() {
    if (backend?.shared) return 0;
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
      if (!isTagged(entry)) continue;
      peaks[id] = entry;
    }
    return { version: 1, updated: new Date().toISOString().slice(0, 10), peaks };
  }

  async function importAll(payload, isKnownStatus) {
    const incoming = payload?.peaks ?? payload;
    if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) {
      throw new Error('not a peak-status export');
    }

    const batch = {};
    for (const [id, entry] of Object.entries(incoming)) {
      if (!entry?.status || !isKnownStatus(entry.status)) continue;
      batch[String(id)] = entry;
    }
    if (!(await backend.saveMany(batch))) throw new Error('could not save the import');
    return Object.keys(batch);
  }

  // ─── Account ────────────────────────────────────────────────────────────────

  const account = () => ({ available: Boolean(client), email: user?.email ?? null });

  async function signIn(email) {
    // Come back to the planner, not the journal the site opens on.
    const back = new URL(location.pathname, location.origin);
    back.searchParams.set('tab', 'peaks');
    const { error } = await client.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: back.href }
    });
    if (error) throw error;
  }

  async function signOut() {
    const { error } = await client.auth.signOut();
    if (error) throw error;
  }

  const onChange = fn => listeners.add(fn);

  /** True once statuses are stored somewhere other than this browser. */
  const isShared = () => Boolean(backend?.shared);
  const describe = () => backend?.label ?? 'nowhere yet';

  /**
   * The signed-in session, for the other stores. Statuses work signed out and
   * own this client; routes (routes.js) need an account and borrow it rather
   * than opening a second one, which would mean two sessions of one person.
   */
  const database = () => ({ client, user });

  return {
    open, get, set, all, pendingCount, toExport, importAll, isShared, describe,
    account, signIn, signOut, onChange, db: database
  };
})();
