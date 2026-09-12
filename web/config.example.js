// Supabase config TEMPLATE for the web app.
//
// SETUP: copy this file to `web/config.js` and paste in your project's values.
//   cp web/config.example.js web/config.js
// `web/config.js` is gitignored (never commit real keys). If web/config.js is
// absent, web/data-loader.js falls back to local files under web/data/.
//
// Find these in the Supabase dashboard: Project Settings -> Data API (URL) and
// Project Settings -> API Keys -> anon / public key. See supabase/README.md.
//
// The anon key is safe to ship in a browser: RLS (see supabase/schema.sql)
// limits it to selecting nodes/walks and inserting walks.

export const SUPABASE_URL = "https://YOUR-PROJECT-REF.supabase.co";
export const SUPABASE_ANON_KEY = "YOUR-ANON-PUBLIC-KEY";
