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
- **TODO(schema, owner B):** neither table has a `building` column yet. Once one
  exists (e.g. `walks.building text`, `nodes.building text`), plumb it through
  `rowToWalk`/`loadNodes` in `data-loader.js` so `graph.js`/`db-graph.js` (owner
  D, below) pick it up automatically — they already carry a `.building` field
  through if present and need no other change.
- **BUG(schema, owner B): the `walks` table drops the phone's GPS and compass.**
  `docs/path-schema.md` defines `startLatLon` and `startHeading`, the recorder
  captures both (they're present in `web/data/walk-*.json`), but `walks` has no
  columns for them — so every uploaded row loses them. Verified: all four rows
  in Supabase come back with `startLatLon: undefined`. This blocks anything
  location-aware, including the location-scoped start-node picker and
  `world-align.js`'s `estimateFrameGeoref`. Fix is additive:
  `alter table public.walks add column if not exists start_lat double precision,
  add column if not exists start_lon double precision,
  add column if not exists gps_accuracy double precision,
  add column if not exists start_heading double precision,
  add column if not exists heading_accuracy double precision,
  add column if not exists north_aligned boolean;`
  plus the matching fields in `Uploader.swift` and `rowToWalk` in `data-loader.js`.

## Routing graph — `web/pipeline/graph.js`, `web/pipeline/db-graph.js`  (owner: D)

Builds the graph a shortest-path query runs over, straight from whatever
`data-loader.js` returns (Supabase or its fallback) — no separate "database
schema" beyond `nodes`/`walks` above.

```js
// graph.js — pure, walks-in graph-out. cellSize = grid-cell size (m) for
// merging nearby points into one node. maxEdgeMeters = hard cap on any single
// edge's length (m); default DEFAULT_MAX_EDGE_METERS = 8ft. Longer spans (e.g.
// a stairwell run) are subdivided with synthetic in-between nodes rather than
// left as one long edge, so the 8ft constraint always holds on the output.
buildGraph(walks: Walk[], opts?: {cellSize?, maxEdgeMeters?}): Graph
nearestNode(graph: Graph, pos: {x,y,z}): Node
route(graph: Graph, startPos: {x,y,z}, endPos: {x,y,z}): {nodes, edges, length} | null

// db-graph.js — composes loadWalks/loadNodes + floors + graph, and adds
// registry-node-id routing (vs. raw positions) for cross-building queries.
loadGraphFromDatabase(opts?: {cellSize?, maxEdgeMeters?}): Promise<{graph, nodes, nodesById}>
routeBetweenNodeIds(graph, nodesById, startNodeId, endNodeId): RouteResult | null
summarizeRouteBuildings(routeResult): {building, count}[]
```

**Multi-building routing has no special case.** A `Graph` node/edge doesn't
know or care which building it's in — `building` is majority-vote display
metadata carried from whichever walks touched that grid cell (null until the
DB has a `building` column; see TODO above). Building A connects to building B
in the graph *only if* some recorded walk's points physically span both (e.g.
a tunnel/skyway) — same Dijkstra as any other route, not a separate algorithm.
This mirrors the "record raw, align later" principle in `docs/path-schema.md`:
if two buildings' walks were recorded as separate ARKit sessions with no
shared frame, they won't connect here until something (future anchoring/
georeferencing work) puts their points in one frame — that's out of scope for
this module, which only clusters whatever frame the input walks are already in.

## World alignment — `web/pipeline/world-align.js`  (owner: D)

Relates the local (ARKit/graph) frame to the real world: which way is north,
and where on Earth the frame's origin sits. Needed so a collector can be shown
"the 5 nodes near you" instead of all 60+, and so walks from different sessions
can be overlaid without a per-walk rotation fit.

```js
// -z = north and +x = east after alignment. northOffsetDeg is the true bearing
// the RAW frame's -z axis points toward.
alignWalkToNorth(walk, opts?: {northOffsetDeg}): Walk   // sets northAligned
estimateFrameNorth(walks): {northOffsetDeg, n, spreadDeg} | null
estimateFrameGeoref(walks, opts?): Georef | null        // from walks' startLatLon
localToLatLon(x, z, g) / latLonToLocal(lat, lon, g)
nodesWithLatLon(nodes, g): Node[]                       // tags derived ones geoDerived
nearestNodesToLatLon(nodes, lat, lon, {k, floor}): Node[]  // + distanceM, nearest first
```

Two ways a frame's north offset is known, and the difference is the point of
the calibration flow:
- **Calibrated** — the collector physically faces north before walking, so the
  frame is north-aligned by construction (`northAligned: true`, nothing to fit).
- **Estimated (legacy)** — compare the recorded compass heading at start against
  the bearing of the walk's first few meters, assuming the collector walked
  roughly the way they faced. On the current five recorded walks this estimate
  disagrees with itself by **±53°**, which is the guesswork calibration removes.

## File ownership (NO cross-writes — prevents collisions)

| Stream | Owns (create/edit) | May IMPORT/READ only |
|---|---|---|
| **A** node anchoring | `web/pipeline/node-anchor.js`, `web/data/nodes.json` | contracts, path-schema |
| **B** database | `supabase/*`, `Insid/Insid/Uploader.swift`, `Insid/Insid/ContentView.swift`, `web/data-loader.js`, `web/config.example.js` | contracts, WalkModel.swift |
| **C** map overlay | `web/map.html`, `web/map.js`, `web/pipeline/georef.js` | `data-loader.js` (loadWalks/loadNodes), `node-anchor.js`, nodes.json |
| **D** routing graph | `web/pipeline/graph.js`, `web/pipeline/db-graph.js`, `web/pipeline/world-align.js`, `web/graph-view.*`, `web/prototype.*` | contracts, path-schema, `data-loader.js` (loadWalks/loadNodes), `floors.js` |

Shared, read-only for all: `docs/contracts.md`, `docs/path-schema.md`.

Note: `web/main.js` imports `buildGraph`/`route` from `graph.js` (unchanged
call signatures — `maxEdgeMeters` defaults to 8ft rather than unlimited, which
only changes behavior when an edge was already longer than that, e.g. a
stairwell run gets subdivided into multiple connector segments instead of one).

## Current-data note

The existing `web/data/*.json` walks predate node refs. Within one continuous
session they already share a frame → treat as identity-anchored and georeference
the whole set with 2 control points. Node-anchoring is for FUTURE cross-session walks.
