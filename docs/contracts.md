# System contracts (v1)

The interfaces the parallel workstreams share. **Do not change a signature here
without updating this file.** Everything is metric (meters), `y` = up.

## Coordinate frames (three levels, all 2-point registration between them)

1. **ARKit-local** — per-walk, origin at record start, arbitrary yaw. Raw recorder output.
2. **building-local map** — ONE shared frame for a building. Node registry lives here.
   A walk enters it via its start/orient nodes (see anchoring). Within a single
   continuous ARKit session walks are already in one frame (identity anchor).
3. **Earth (lat/lon)** — building-local georeferenced to the globe via 2 control points.

## Node registry — `web/data/nodes.json`  (owner: A)

```json
{
  "frame": "building-local", "unit": "meters", "up": "y",
  "nodes": [
    { "id": "lobby-door", "name": "Lobby Door", "floor": 0,
      "x": 0, "y": 0, "z": 0, "lat": null, "lon": null }
  ]
}
```
- `id` is a stable string key referenced by walks. `x,y,z` in building-local meters.
- `lat,lon` optional; filled once the building is georeferenced.

## Walk schema additions (v3) — `docs/path-schema.md`

Add optional top-level fields (recorder writes them; older walks omit them):
- `startNodeId`  — node the walk started on (translation anchor)
- `orientNodeId` — node walked toward / sighted (rotation anchor)
- `endNodeId`    — optional node at the end (drift correction)

## Loader interface — `web/data-loader.js`  (owner: B)

Source-agnostic (local files now, Supabase when configured). Everything imports these:
```js
loadWalks(): Promise<Walk[]>              // existing; B extends to Supabase
loadNodes(): Promise<Node[]>             // NEW: returns nodes.json .nodes[] or Supabase rows
```
`Node = { id, name, floor, x, y, z, lat?, lon? }`.

## Anchoring — `web/pipeline/node-anchor.js`  (owner: A)

```js
// least-squares rigid transform on the horizontal (x,z) plane, scale = 1
fitRigid2D(srcXZ: [{x,z}], dstXZ: [{x,z}]): { rot, tx, tz }

// transform a walk's ARKit-local points into building-local using its node refs.
// uses startNodeId (translation) + orientNodeId (rotation). y is unchanged.
// returns a NEW walk; sets .anchored=false (unchanged points) if refs/nodes missing.
anchorWalkToMap(walk: Walk, nodesById: Record<string,Node>): Walk

// optional: linear drift correction if endNodeId is present & resolvable
driftCorrect(walk: Walk, endNode: Node): Walk
```
Math: origin = P(startNode); yaw aligns local (P_orient_local − 0) to map (P_orient − P_start).

## Georeference — `web/pipeline/georef.js`  (owner: C)

```js
// controlPoints: >=2 pairs of building-local (x,z) <-> real (lat,lon)
fitGeoreference(controlPoints: [{x,z,lat,lon}]): Georef   // similarity: rot+scale+translation
localToLatLon(x: number, z: number, g: Georef): { lat, lon }
```

## Supabase schema — `supabase/schema.sql`  (owner: B)

- `nodes(id text pk, name text, floor int, x,y,z double precision, lat,lon double precision)`
- `walks(id text pk, recorded_at timestamptz, device text, start_node_id text,
   orient_node_id text, end_node_id text, baro_reference double precision,
   points jsonb, created_at timestamptz default now())`
- Hackathon RLS: anon insert on `walks`, anon select on both. Document in supabase/README.md.
- Web reads via anon key in `web/config.js` (gitignored); provide `web/config.example.js`.

## File ownership (NO cross-writes — prevents collisions)

| Stream | Owns (create/edit) | May IMPORT/READ only |
|---|---|---|
| **A** node anchoring | `web/pipeline/node-anchor.js`, `web/data/nodes.json` | contracts, path-schema |
| **B** database | `supabase/*`, `Insid/Insid/Uploader.swift`, `Insid/Insid/ContentView.swift`, `web/data-loader.js`, `web/config.example.js` | contracts, WalkModel.swift |
| **C** map overlay | `web/map.html`, `web/map.js`, `web/pipeline/georef.js` | `data-loader.js` (loadWalks/loadNodes), `node-anchor.js`, nodes.json |

Shared, read-only for all: `docs/contracts.md`, `docs/path-schema.md`.

## Current-data note

The existing `web/data/*.json` walks predate node refs. Within one continuous
session they already share a frame → treat as identity-anchored and georeference
the whole set with 2 control points. Node-anchoring is for FUTURE cross-session walks.
