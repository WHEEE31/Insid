// TEMPLATE — do not put real keys here.
//
// Copy this file to `Insid/Insid/SupabaseConfig.swift` and fill in your values.
// That destination path is gitignored, so your anon key never gets committed.
// (This template lives in supabase/ so Xcode does NOT compile it into the app.)
//
// Values are the SAME as web/config.js:
//   url     = your base Supabase project URL, WITHOUT /rest/v1  (e.g. https://abc.supabase.co)
//   anonKey = your anon / public key
//
// The anon key is public-by-design; Row-Level Security guards the data.

enum SupabaseConfig {
    static let url = "https://YOUR-PROJECT.supabase.co"
    static let anonKey = "YOUR-ANON-KEY"
}
