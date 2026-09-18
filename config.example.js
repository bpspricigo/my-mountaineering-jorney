// Copy to config.js (gitignored) and fill in.
const CONFIG = {
  // https://cloud.maptiler.com/account/keys — restrict it to your domain.
  MAPTILER_API_KEY: "your-maptiler-key",

  // Optional. Without these the planner keeps statuses in this browser only.
  // Both are public by design: row level security keeps each list private.
  SUPABASE_URL: "https://your-project-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_…"
};
