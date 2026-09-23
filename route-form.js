/**
 * Adding and editing an outing by hand.
 *
 * A modal rather than another panel section: an outing has a dozen fields and
 * a file to drop, which is more than fits beside a map without pushing the map
 * off the screen.
 *
 * Everything here is optional except the title. A planned walk often starts as
 * a name and a GPX exported from a route planner; the stats, the links and the
 * notes arrive later, and a walk already done may have no track at all.
 *
 * Opened from a peak, the form starts linked to that peak. Drop a GPX in and
 * it measures the track, fills whatever stats are still blank, and adds every
 * summit the line passes over — so "Rotwand + Taubenstein" links both without
 * anyone typing a peak id.
 */

const RouteForm = (() => {
  let dialog = null;
  let editing = null;          // the route being edited, or null for a new one
  let peaks = new Map();       // peak id → { peak_id, name, ele }
  let parsed = null;           // the last GPX read, if one was dropped

  // ─── Units ──────────────────────────────────────────────────────────────────

  /** "6:30" or "6.5" → seconds. Empty stays empty. */
  function toSeconds(text) {
    const value = String(text ?? '').trim();
    if (!value) return null;
    const clock = value.match(/^(\d+):([0-5]?\d)$/);
    if (clock) return Number(clock[1]) * 3600 + Number(clock[2]) * 60;
    const hours = parseFloat(value.replace(',', '.'));
    return Number.isFinite(hours) ? Math.round(hours * 3600) : null;
  }

  const toClock = seconds => seconds
    ? `${Math.floor(seconds / 3600)}:${String(Math.round((seconds % 3600) / 60)).padStart(2, '0')}`
    : '';

  const toNumber = text => {
    const value = parseFloat(String(text ?? '').replace(',', '.'));
    return Number.isFinite(value) ? value : null;
  };

  /**
   * "Komoot | https://…" per line, which beats a row of paired inputs for
   * something that is usually two lines long and occasionally five.
   */
  function parseLinks(text) {
    return String(text ?? '').split('\n').map(line => {
      const [label, ...rest] = line.split('|');
      const url = rest.join('|').trim();
      return url ? { label: label.trim() || url, url } : null;
    }).filter(Boolean);
  }

  const printLinks = links =>
    (links ?? []).map(link => `${link.label} | ${link.url}`).join('\n');

  // ─── The dialog ─────────────────────────────────────────────────────────────

  function build() {
    if (dialog) return dialog;

    dialog = document.createElement('dialog');
    dialog.className = 'route-dialog';
    dialog.innerHTML = `
      <form method="dialog" class="route-form">
        <header class="route-form-head">
          <h2 id="route-form-title">Add an outing</h2>
          <button type="button" class="route-form-close" value="cancel" aria-label="Close">×</button>
        </header>

        <div class="route-form-body">
          <div class="route-form-row">
            <label class="route-field route-field--grow">
              <span>Title</span>
              <input name="title" required placeholder="Rotwand and Taubenstein">
            </label>
            <label class="route-field">
              <span>Status</span>
              <select name="kind">
                <option value="planned">Planned</option>
                <option value="done">Done</option>
              </select>
            </label>
          </div>

          <div class="route-form-row">
            <label class="route-field">
              <span>Date</span>
              <input type="date" name="date">
            </label>
            <label class="route-field route-field--grow">
              <span>Location</span>
              <input name="location" placeholder="Spitzingsee, Germany">
            </label>
          </div>

          <label class="route-field">
            <span>Track — a GPX from a watch or a route planner</span>
            <input type="file" name="gpx" accept=".gpx,application/gpx+xml,application/xml,text/xml">
            <small class="route-form-hint" id="route-gpx-note">
              Optional. Dropping one measures the walk and finds the summits it crosses.
            </small>
          </label>

          <div class="route-form-row">
            <label class="route-field">
              <span>Distance (km)</span>
              <input name="distance" inputmode="decimal" placeholder="15.0">
            </label>
            <label class="route-field">
              <span>Ascent (m)</span>
              <input name="ascent" inputmode="numeric" placeholder="869">
            </label>
            <label class="route-field">
              <span>Moving time</span>
              <input name="moving" placeholder="3:45">
            </label>
            <label class="route-field">
              <span>Difficulty</span>
              <input name="difficulty" placeholder="Hard">
            </label>
          </div>

          <fieldset class="route-field">
            <legend>Summits</legend>
            <div class="route-peaks" id="route-peaks"></div>
            <small class="route-form-hint">Click a peak on the map to start an outing there, or drop a GPX to pick them up from the track.</small>
          </fieldset>

          <div class="route-form-row">
            <label class="route-field route-field--grow">
              <span>Strava</span>
              <input name="strava_url" type="url" placeholder="https://www.strava.com/activities/…">
            </label>
            <label class="route-field route-field--grow">
              <span>Photos</span>
              <input name="photos_url" type="url" placeholder="https://photos.app.goo.gl/…">
            </label>
          </div>

          <label class="route-field">
            <span>Other links — one per line, <code>label | url</code></span>
            <textarea name="links" rows="2" placeholder="Komoot | https://www.komoot.com/tour/…"></textarea>
          </label>

          <label class="route-field">
            <span>Description</span>
            <textarea name="description" rows="2" placeholder="Ridge traverse, scramble at the top."></textarea>
          </label>

          <label class="route-field">
            <span>Notes — gear, conditions, huts</span>
            <textarea name="notes" rows="3" placeholder="Crampons and axe until June.&#10;Hut booked for the Friday."></textarea>
          </label>

          <label class="route-check">
            <input type="checkbox" name="tagPeaks" checked>
            <span id="route-tag-label">Tag these summits as planned</span>
          </label>
        </div>

        <footer class="route-form-foot">
          <button type="button" class="route-form-delete" id="route-delete" hidden>Delete</button>
          <span class="route-form-status" id="route-form-status"></span>
          <button type="button" class="route-form-cancel">Cancel</button>
          <button type="submit" class="route-form-save">Save outing</button>
        </footer>
      </form>
    `;
    document.body.appendChild(dialog);

    const form = dialog.querySelector('form');

    form.gpx.addEventListener('change', readDroppedGpx);
    form.kind.addEventListener('change', () => {
      dialog.querySelector('#route-tag-label').textContent =
        `Tag these summits as ${form.kind.value}`;
    });

    // Both close without saving; the dialog's own form would otherwise submit.
    for (const selector of ['.route-form-close', '.route-form-cancel']) {
      dialog.querySelector(selector).addEventListener('click', () => dialog.close());
    }
    dialog.querySelector('#route-delete').addEventListener('click', destroy);
    form.addEventListener('submit', submit);

    return dialog;
  }

  // ─── Opening ────────────────────────────────────────────────────────────────

  /**
   * `route` edits an existing outing; `peak` is the feature the form was opened
   * from, which seeds the summit list and the title of a new one.
   */
  function open({ route = null, peak = null, draft = null } = {}) {
    if (!RouteStore.available()) {
      flash('Sign in first — outings live in your account', true);
      return;
    }

    build();
    const form = dialog.querySelector('form');
    form.reset();
    editing = route;
    parsed = null;
    peaks = new Map();
    setStatusLine('');

    dialog.querySelector('#route-form-title').textContent = route ? 'Edit outing' : 'Add an outing';
    dialog.querySelector('#route-delete').hidden = !route;
    dialog.querySelector('#route-gpx-note').textContent = route?.track
      ? `${route.track_points} points stored. Dropping a new file replaces the track.`
      : 'Optional. Dropping one measures the walk and finds the summits it crosses.';

    if (route) {
      form.title.value = route.title ?? '';
      form.kind.value = route.kind ?? 'planned';
      form.date.value = route.date ?? '';
      form.location.value = route.location ?? '';
      form.distance.value = route.distance_m ? (route.distance_m / 1000).toFixed(1) : '';
      form.ascent.value = route.ascent_m ?? '';
      form.moving.value = toClock(route.moving_seconds);
      form.difficulty.value = route.difficulty ?? '';
      form.strava_url.value = route.strava_url ?? '';
      form.photos_url.value = route.photos_url ?? '';
      form.links.value = printLinks(route.links);
      form.description.value = route.description ?? '';
      form.notes.value = route.notes ?? '';
      form.tagPeaks.checked = false;   // an edit should not silently retag
      for (const link of route.peaks ?? []) {
        peaks.set(String(link.peak_id), { peak_id: link.peak_id, name: link.name, ele: link.ele });
      }
    } else if (peak) {
      form.title.value = peak.properties.name ?? '';
      addPeak(peak.properties);
    }

    // A route just drawn on the map arrives as a draft: the same shape a
    // dropped GPX produces, so it fills the form the same way.
    if (draft) {
      parsed = draft;
      form.title.value = draft.title || form.title.value;
      form.distance.value = (draft.distance_m / 1000).toFixed(1);
      form.ascent.value = draft.ascent_m;
      if (draft.moving_seconds) form.moving.value = toClock(draft.moving_seconds);
      if (draft.difficulty) form.difficulty.value = draft.difficulty;
      for (const found of peaksAlong(draft.fullPoints)) peaks.set(String(found.peak_id), found);
      dialog.querySelector('#route-gpx-note').textContent =
        `Drawn on the map — ${draft.track_points} points kept. Dropping a file replaces it.`;
    }

    dialog.querySelector('#route-tag-label').textContent = `Tag these summits as ${form.kind.value}`;
    renderPeaks();
    dialog.showModal();
    form.title.focus();
  }

  const addPeak = properties => peaks.set(String(properties.id), {
    peak_id: properties.id, name: properties.name, ele: properties.ele
  });

  function renderPeaks() {
    const el = dialog.querySelector('#route-peaks');
    if (!peaks.size) {
      el.innerHTML = '<span class="route-peaks-empty">No summit linked — the outing still saves.</span>';
      return;
    }
    el.innerHTML = [...peaks.values()].map(peak => `
      <span class="route-peak-chip">
        ${escapeHtml(peak.name ?? String(peak.peak_id))}
        ${peak.ele ? `<small>${peak.ele} m</small>` : ''}
        <button type="button" data-id="${peak.peak_id}" aria-label="Remove ${escapeHtml(peak.name ?? '')}">×</button>
      </span>
    `).join('');

    el.querySelectorAll('button').forEach(button => {
      button.addEventListener('click', () => {
        peaks.delete(String(button.dataset.id));
        renderPeaks();
      });
    });
  }

  // ─── GPX ────────────────────────────────────────────────────────────────────

  async function readDroppedGpx(event) {
    const file = event.target.files?.[0];
    const note = dialog.querySelector('#route-gpx-note');
    if (!file) return;

    try {
      parsed = RouteStore.readGpx(await file.text());
    } catch (err) {
      parsed = null;
      note.textContent = err.message;
      note.classList.add('is-error');
      return;
    }

    note.classList.remove('is-error');
    const form = dialog.querySelector('form');

    // Only fill what is still blank: a number you typed came from your watch
    // and beats one measured off a track that may have been trimmed.
    if (!form.distance.value) form.distance.value = (parsed.distance_m / 1000).toFixed(1);
    if (!form.ascent.value) form.ascent.value = parsed.ascent_m;
    if (!form.moving.value && parsed.moving_seconds) form.moving.value = toClock(parsed.moving_seconds);
    if (!form.date.value && parsed.date) form.date.value = parsed.date;

    const crossed = peaksAlong(parsed.fullPoints);
    for (const peak of crossed) peaks.set(String(peak.peak_id), peak);
    renderPeaks();

    note.textContent = `${(parsed.distance_m / 1000).toFixed(1)} km · ${parsed.ascent_m} m up · ` +
      `${parsed.track_points} points kept · ${crossed.length} summit${crossed.length === 1 ? '' : 's'} on the line`;
  }

  // ─── Saving ─────────────────────────────────────────────────────────────────

  const setStatusLine = (text, isError = false) => {
    const el = dialog.querySelector('#route-form-status');
    el.textContent = text;
    el.classList.toggle('is-error', isError);
  };

  async function submit(event) {
    event.preventDefault();
    const form = dialog.querySelector('form');
    if (!form.reportValidity()) return;

    const distance = toNumber(form.distance.value);
    const row = {
      ...(editing ? { id: editing.id, source: editing.source } : {}),
      kind: form.kind.value,
      title: form.title.value.trim(),
      date: form.date.value || null,
      location: form.location.value.trim() || null,
      difficulty: form.difficulty.value.trim() || null,
      distance_m: distance === null ? null : Math.round(distance * 1000),
      ascent_m: toNumber(form.ascent.value),
      moving_seconds: toSeconds(form.moving.value),
      strava_url: form.strava_url.value.trim() || null,
      photos_url: form.photos_url.value.trim() || null,
      links: parseLinks(form.links.value),
      description: form.description.value.trim() || null,
      notes: form.notes.value.trim() || null,
      // Keep the stored track when no new file was dropped.
      track: parsed ? parsed.track : editing?.track ?? null,
      track_points: parsed ? parsed.track_points : editing?.track_points ?? null,
      bounds: parsed ? parsed.bounds : editing?.bounds ?? null
    };

    setStatusLine('Saving…');
    let saved;
    try {
      saved = await RouteStore.save(row, [...peaks.values()]);
    } catch (err) {
      console.error('[route-form] save failed:', err);
      setStatusLine(err.message ?? 'Could not save', true);
      return;
    }

    if (form.tagPeaks.checked) {
      for (const peak of peaks.values()) await setStatus(peak.peak_id, form.kind.value);
    }

    dialog.close();
    RouteDraw.stop();
    afterChange(saved);
    flash(`Saved ${saved.title}`);
  }

  async function destroy() {
    if (!editing) return;
    if (!confirm(`Delete "${editing.title}"? The peaks keep their status.`)) return;

    try {
      await RouteStore.remove(editing.id);
    } catch (err) {
      console.error('[route-form] delete failed:', err);
      setStatusLine(err.message ?? 'Could not delete', true);
      return;
    }

    const gone = editing;
    dialog.close();
    afterChange(null, gone.id);
    flash(`Deleted ${gone.title}`);
  }

  /** Put the map and the panel back in step with what just changed. */
  function afterChange(saved, removedId = null) {
    if (removedId) undrawTrack(removedId);
    renderTaggedList();
    if (state.popup?.isOpen()) {
      const el = document.querySelector('#peak-routes');
      if (el?.dataset.peakId) renderPeakRoutes(el, el.dataset.peakId);
    }
    if (saved?.track) {
      drawTrack(saved);
      fitTracks([saved]);
    }
  }

  return { open };
})();
