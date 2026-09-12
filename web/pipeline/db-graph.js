// Builds the routing graph directly from the database (via the existing
// loader), and offers a node-id-based routing API matching the product ask:
// "shortest indoor path from node A in building A to node B in building B".
// Owner: D (routing graph). See docs/contracts.md §Routing graph.
//
// This module only composes existing pieces (data-loader, floors, graph) --
// it doesn't talk to Supabase itself, so it stays correct however the DB is
// actually reached (Supabase REST today, anything else later).
//
// TODO(schema): neither the `nodes` nor `walks` table has a `building` column
// yet (see supabase/schema.sql) -- this repo doesn't have real crowdsourced
// data with buildings in it yet. Until that column exists, `building` is read
// opportunistically wherever a caller already attached one (walk.building,
// or a registry node's .building) and otherwise stays null throughout. None
// of the clustering/routing logic in graph.js depends on it -- it's carried
// through purely as display metadata (see buildGraph's building tagging) --
// so adding the column later is a one-line change here (attachBuildingToWalks)
// with no change to the graph algorithm itself.

import { loadWalks, loadNodes } from "../data-loader.js";
import { annotateFloors } from "./floors.js";
import { buildGraph, route, DEFAULT_MAX_EDGE_METERS } from "./graph.js";

// Best-effort building tag for a walk that doesn't already have one: fall
// back to the building of the registry node it started on, if that node
// happens to carry one. No-op today (registry nodes have no .building field
// either) -- see TODO(schema) above.
export function attachBuildingToWalks(walks, nodesById) {
  for (const w of walks) {
    if (w.building != null) continue;
    const startNode = nodesById[w.startNodeId];
    if (startNode && startNode.building != null) w.building = startNode.building;
  }
  return walks;
}

// The main entry point: pulls walks + the node registry from the database
// (Supabase, or its local-file/synthetic fallback -- see data-loader.js),
// annotates floors, and builds the multi-building-capable routing graph.
//
//   cellSize      grid-cell size for merging nearby points into one node (m)
//   maxEdgeMeters cap on any single edge's length (m); default 8ft, per spec
export async function loadGraphFromDatabase({ cellSize, maxEdgeMeters } = {}) {
  const [walks, nodes] = await Promise.all([loadWalks(), loadNodes()]);
  annotateFloors(walks);
  const nodesById = Object.fromEntries(nodes.map((n) => [n.id, n]));
  attachBuildingToWalks(walks, nodesById);
  const graph = buildGraph(walks, { cellSize, maxEdgeMeters });
  return { graph, nodes, nodesById };
}

// Route between two REGISTRY node ids (e.g. startNodeId="wean-lobby-door" in
// one building, endNodeId="hbh-cafe" in another) instead of raw positions.
// Cross-building routing isn't special-cased: it's the same Dijkstra over one
// unified graph as any other route, so it only succeeds if some recorded walk
// actually connects the two buildings (a real tunnel/skyway) -- see
// docs/contracts.md's coordinate-frame note on why that requires the
// buildings' walks to already share (or be projected into) one frame.
export function routeBetweenNodeIds(graph, nodesById, startNodeId, endNodeId) {
  const start = nodesById[startNodeId];
  const end = nodesById[endNodeId];
  if (!start || !end) return null;
  const result = route(graph, start, end);
  if (!result) return null;
  return {
    ...result,
    startNodeId,
    endNodeId,
    startBuilding: start.building ?? null,
    endBuilding: end.building ?? null,
  };
}

// Ordered building "legs" along a route's node path, e.g.
// [{building:"Building A",count:4},{building:"Tunnel",count:6},{building:"Building B",count:3}]
// -- lets a caller show "Building A -> Tunnel -> Building B" even though
// building is display metadata rather than something routing reasons about.
export function summarizeRouteBuildings(routeResult) {
  if (!routeResult) return [];
  const legs = [];
  for (const node of routeResult.nodes) {
    const building = node.building ?? null;
    const last = legs[legs.length - 1];
    if (last && last.building === building) last.count += 1;
    else legs.push({ building, count: 1 });
  }
  return legs;
}

// ---------------------------------------------------------------------------
// Self-test. Run: `node web/pipeline/db-graph.js`
//   1. loadGraphFromDatabase() end-to-end against whatever data-loader.js
//      falls back to with no Supabase config / no served files (synthetic
//      sample walks) -- proves the DB entry point doesn't need a real DB to
//      at least run.
//   2. routeBetweenNodeIds() / summarizeRouteBuildings() against a small
//      hand-built two-building-plus-tunnel graph, since the synthetic sample
//      data has no registry nodes or building tags to route between.
export async function runSelfTest() {
  const results = [];

  const { graph, nodes } = await loadGraphFromDatabase({});
  results.push({
    name: "loadGraphFromDatabase runs against the loader's fallback data",
    nodeCount: graph.nodes.size,
    edgeCount: graph.edges.size,
    registryNodeCount: nodes.length,
    pass: graph.nodes.size > 0 && graph.edges.size > 0,
  });

  const walkA = {
    id: "w-a", building: "Building A",
    points: [{ t: 0, x: 0, y: 0, z: 0, floor: 0 }, { t: 1, x: 2, y: 0, z: 0, floor: 0 }],
  };
  const tunnel = {
    id: "w-tunnel", building: "Tunnel",
    points: [{ t: 0, x: 2, y: 0, z: 0, floor: 0 }, { t: 1, x: 20, y: 0, z: 0, floor: 0 }],
  };
  const walkB = {
    id: "w-b", building: "Building B",
    points: [{ t: 0, x: 20, y: 0, z: 0, floor: 0 }, { t: 1, x: 22, y: 0, z: 0, floor: 0 }],
  };
  const g = buildGraph([walkA, tunnel, walkB], { cellSize: 0.5 });
  const nodesById = {
    "a-entrance": { id: "a-entrance", building: "Building A", x: 0, y: 0, z: 0 },
    "b-cafe": { id: "b-cafe", building: "Building B", x: 22, y: 0, z: 0 },
  };
  const r = routeBetweenNodeIds(g, nodesById, "a-entrance", "b-cafe");
  const legs = summarizeRouteBuildings(r);
  results.push({
    name: "routeBetweenNodeIds crosses buildings via a shared tunnel walk",
    found: !!r,
    startBuilding: r && r.startBuilding,
    endBuilding: r && r.endBuilding,
    legs,
    pass: !!r && r.startBuilding === "Building A" && r.endBuilding === "Building B" &&
      legs.length === 3 && legs[0].building === "Building A" &&
      legs[1].building === "Tunnel" && legs[2].building === "Building B",
  });

  results.push({
    name: "unknown node id returns null instead of throwing",
    pass: routeBetweenNodeIds(g, nodesById, "nope", "b-cafe") === null,
  });

  const pass = results.every((r) => r.pass);
  return { pass, results };
}

if (typeof process !== "undefined" && process.argv && process.argv[1]) {
  const invokedUrl = "file://" + process.argv[1].replace(/\\/g, "/");
  const meUrl = import.meta.url;
  if (invokedUrl === meUrl || meUrl.endsWith(process.argv[1].replace(/\\/g, "/"))) {
    const { pass, results } = await runSelfTest();
    console.log(JSON.stringify(results, null, 2));
    console.log(pass ? "SELF-TEST: PASS" : "SELF-TEST: FAIL");
    if (!pass) process.exitCode = 1;
  }
}
