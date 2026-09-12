# Supabase setup (database pipeline)

This is the cloud store that connects the phone recorder to the web visualizer:

```
iPhone recorder  ──POST──►  Supabase (walks table)  ──SELECT──►  web app
```

`schema.sql` defines two tables — `nodes` and `walks` — plus hackathon RLS
policies that let the anonymous (`anon`) key read both tables and insert walks.
It matches `docs/contracts.md` exactly.

## 1. Create a Supabase project

1. Go to <https://supabase.com>, sign in, and click **New project**.
2. Pick an organization, give the project a name, set a database password
   (you won't need it for this app), choose a region, and click **Create**.
3. Wait ~1–2 minutes for provisioning to finish.

## 2. Run the schema

1. In the project dashboard, open the **SQL Editor** (left sidebar).
2. Click **+ New query**, paste the entire contents of
   [`schema.sql`](./schema.sql), and click **Run**.
3. You should see "Success. No rows returned." Verify under **Table Editor**
   that `nodes` and `walks` now exist.

## 3. Find your Project URL + anon key

In the dashboard:

- **Project URL** — Settings → **Data API** → *Project URL*
  (looks like `https://abcdefgh.supabase.co`).
- **anon / public key** — Settings → **API Keys** → the **`anon` `public`**
  key. This is safe to embed in the browser and the iOS app; the RLS policies
  in `schema.sql` restrict it to select-nodes / select-walks / insert-walks.

## 4. Configure the WEB app

```bash
cp web/config.example.js web/config.js
```

Edit `web/config.js` and paste your values:

```js
export const SUPABASE_URL = "https://abcdefgh.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGci...your-anon-key...";
```

- `web/config.js` is **gitignored** — never commit real keys.
- If `web/config.js` is missing, `web/data-loader.js` automatically falls back
  to the local JSON files in `web/data/` (nothing breaks offline).
- With config present, `loadWalks()` and `loadNodes()` read from Supabase REST.

## 5. Configure the iOS recorder (upload + node pull)

The app reads its Supabase creds from a small compiled-in file that is
**gitignored** (so the key never lands in the repo). Set it up once:

```bash
cp supabase/SupabaseConfig.example.swift Insid/Insid/SupabaseConfig.swift
```

Then edit `Insid/Insid/SupabaseConfig.swift` and fill in:

```swift
enum SupabaseConfig {
    static let url = "https://abcdefgh.supabase.co"   // BASE url, no /rest/v1
    static let anonKey = "eyJhbGci...your-anon-key..."
}
```

- `Insid/Insid/SupabaseConfig.swift` is **gitignored** — never commit real keys.
- Values are the same as `web/config.js`.
- (Fallback: the app also accepts `SUPABASE_URL` / `SUPABASE_ANON_KEY` Info.plist
  keys, but the compiled-in file is the recommended path — the target generates
  its Info.plist, which makes adding custom keys there awkward.)

Then build/run. The node-selection map pulls real nodes from the `nodes` table,
and the **Upload** button (cloud icon) POSTs the selected recording to `walks`.
If creds are missing/placeholder, the app falls back to bundled seed nodes and
Upload reports a config error instead of crashing.

## Data flow / column mapping

The recorder encodes a `Walk` (see `Insid/Insid/WalkModel.swift`) and maps it
onto the `walks` table (snake_case). The web loader maps those columns back to
the walk JSON's camelCase (`start_node_id` → `startNodeId`, etc.), so downstream
code (`web/main.js`, pipeline) is identical whether data is local or from
Supabase.

## Security note

These RLS policies are for a hackathon: anyone with the anon key can insert
walks and read all rows. Do not reuse this project for anything sensitive.
