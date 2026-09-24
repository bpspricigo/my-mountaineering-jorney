// Copy to config.js (gitignored) and fill in.
const CONFIG = {
  // https://cloud.maptiler.com/account/keys — restrict it to your domain.
  MAPTILER_API_KEY: "your-maptiler-key",

  // Optional. Without these the planner keeps statuses in this browser only.
  // Both are public by design: row level security keeps each list private.
  SUPABASE_URL: "https://your-project-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_…",

  // Optional. The tileset id MapTiler gives you after uploading
  // data/world-peaks.geojson (built by scripts/build-world-peaks.mjs).
  // Without it the map shows data/peaks-core.geojson and nothing more.
  PEAKS_TILESET_ID: ""
};
