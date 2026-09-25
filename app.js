/**
 * Start the planner.
 *
 * There was a tab switcher here once, with a journal and a planner listing the
 * folders under gpx/. Both became the map: a walk is an outing on the peak it
 * crosses, and a plan is a route drawn on the same map. So this file only
 * checks that the keys are present and hands over to peaks.js.
 */

if (typeof CONFIG === 'undefined') {
  console.error('[app] CONFIG not found — copy config.example.js to config.js');
} else if (!CONFIG.MAPTILER_API_KEY) {
  console.error('[app] no MAPTILER_API_KEY in config.js — the map cannot load');
}

console.log('[app] starting the peak planner');
initPeaks();   // peaks.js
