-- Indoor-mapping app — Supabase schema (v1)
-- Matches docs/contracts.md exactly. Run this whole file once in the
-- Supabase SQL editor (see supabase/README.md). Everything is metric (meters),
-- y = up. Snake_case columns here map to the walk JSON's camelCase downstream
-- (web/data-loader.js does the translation, e.g. start_node_id -> startNodeId).

-- =====================================================================
-- nodes — the building-local node registry (mirror of web/data/nodes.json)
--   id            stable string key referenced by walks (primary key)
--   name          human-readable label
--   floor         integer floor index (0 = ground)
--   x, y, z       building-local position in meters (y = up)
--   lat, lon      optional Earth coords, filled once georeferenced
-- =====================================================================
create table if not exists public.nodes (
  id    text primary key,                 -- stable string key (e.g. "lobby-door")
  name  text,                             -- display name
  floor int,                              -- floor index
  x     double precision,                 -- building-local X (meters)
  y     double precision,                 -- building-local Y / elevation (meters)
  z     double precision,                 -- building-local Z (meters)
  lat   double precision,                 -- optional latitude (null until georeferenced)
  lon   double precision                  -- optional longitude (null until georeferenced)
);

-- =====================================================================
-- walks — one recorded walk per row (see docs/path-schema.md)
--   id             unique walk id (== the recorder's walk.id / filename stem)
--   recorded_at    ISO-8601 timestamp when the walk was captured
--   device         capture source ("iphone-arkit", "synthetic", ...)
--   start_node_id  v3: registry node the walk started on (translation anchor)
--   orient_node_id v3: registry node walked toward (rotation anchor)
--   end_node_id    v3: optional registry node at the end (drift correction)
--   baro_reference pressure (kPa) at start; relAltitude is relative to it
--   points         the full ordered sample array, stored as JSON
--   created_at     server-side insert time (defaults to now())
-- =====================================================================
create table if not exists public.walks (
  id             text primary key,                    -- unique walk id
  recorded_at    timestamptz,                         -- when the walk was captured
  device         text,                                -- capture source
  start_node_id  text,                                -- translation anchor node id
  orient_node_id text,                                -- rotation anchor node id
  end_node_id    text,                                -- optional drift-correction node id
  baro_reference double precision,                    -- start pressure (kPa)
  points         jsonb,                               -- ordered samples ([{t,x,y,z,...}])
  created_at     timestamptz default now()            -- server insert time
);

-- =====================================================================
-- Row Level Security — HACKATHON policies only.
-- These intentionally allow anonymous (anon key) access so the phone can
-- upload and the web app can read without auth. NOT production-safe:
-- anyone with the anon key can insert walks and read all rows.
-- =====================================================================

-- Turn on RLS so the policies below actually govern access.
alter table public.nodes enable row level security;
alter table public.walks enable row level security;

-- NOTE: `create policy` has no `if not exists` form, so each one is preceded by
-- a `drop policy if exists`. Without that, re-running this file against a
-- project that already has the policies fails with
--   ERROR: 42710: policy "anon can select nodes" for table "nodes" already exists
-- and stops before reaching anything below it.

-- Allow the anon role to READ every node (web app renders the registry).
drop policy if exists "anon can select nodes" on public.nodes;
create policy "anon can select nodes"
  on public.nodes
  for select
  to anon
  using (true);

-- Allow the anon role to READ every walk (web app renders the walks).
drop policy if exists "anon can select walks" on public.walks;
create policy "anon can select walks"
  on public.walks
  for select
  to anon
  using (true);

-- Allow the anon role to INSERT walks (the iOS recorder uploads here).
-- with check (true) = no restriction on the inserted row.
drop policy if exists "anon can insert walks" on public.walks;
create policy "anon can insert walks"
  on public.walks
  for insert
  to anon
  with check (true);

-- =====================================================================
-- walks, v4 additions — the phone's GPS + compass, and north calibration.
--
-- These were being thrown away: the recorder captures startLatLon and
-- startHeading (see docs/path-schema.md) but there were no columns to put
-- them in, so every uploaded row lost them. Anything location-aware needs
-- them back — notably the location-scoped start-node picker, which uses a
-- rough fix to narrow 60+ registry nodes down to the ~5 you could be
-- standing on (web/pipeline/world-align.js).
--
-- Written as ALTERs rather than edits to the create above so this file stays
-- safe to re-run against a project that already has data.
-- =====================================================================
alter table public.walks
  add column if not exists start_lat        double precision,  -- one-shot GPS at start
  add column if not exists start_lon        double precision,
  add column if not exists gps_accuracy     double precision,  -- meters, horizontal
  add column if not exists start_heading    double precision,  -- compass, degrees true
  add column if not exists heading_accuracy double precision,  -- degrees
  -- v4 north calibration: the true bearing the recorded frame's -z axis points
  -- toward, captured when the collector confirms they're facing north. Null on
  -- walks recorded before the calibration step existed.
  add column if not exists north_offset_deg double precision,
  -- true only when the stored points were ALREADY rotated north-up by the
  -- recorder; normally false, with north_offset_deg carrying the rotation.
  add column if not exists north_aligned    boolean;

-- Allow the anon role to INSERT + UPDATE nodes (web edit-mode naming, the iOS
-- "+ new node" button, and the node registry seeding all upsert here).
-- Upsert = insert with Prefer: resolution=merge-duplicates, which needs both.
drop policy if exists "anon can insert nodes" on public.nodes;
create policy "anon can insert nodes"
  on public.nodes
  for insert
  to anon
  with check (true);

drop policy if exists "anon can update nodes" on public.nodes;
create policy "anon can update nodes"
  on public.nodes
  for update
  to anon
  using (true)
  with check (true);
