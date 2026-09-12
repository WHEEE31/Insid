// Routing graph from many overlapping walks that share a frame(s).
//
// Approach (research §5, hackathon-simple):
//   1. grid-snap each point to a cell (per floor) -> merged nodes
//   2. edges between consecutive cells along each walk, visit-weighted
//   3. edges whose endpoints are on different floors are vertical connectors
//      (stairs/elevator) -- they only exist where someone actually changed floor
//   4. long spans (e.g. a stairwell run) are subdivided with synthetic
//      in-between nodes so no single edge exceeds `maxEdgeMeters`
//   5. Dijkstra between the nearest nodes to a start/end position
//
// Multi-building note: this module has no idea what a "building" is -- it
// just clusters whatever points walks give it. If a walk physically crosses
// from one building into another (e.g. a connecting tunnel), the resulting
// nodes/edges span both buildings automatically -- no special-casing needed,
// as long as the walks involved already share ONE coordinate frame (see
// docs/contracts.md §Coordinate frames; db-graph.js handles projecting
// georeferenced buildings into a shared frame before calling buildGraph).
// `building` on a walk (optional, forward-compat with a future DB column) is
// carried through to nodes as display metadata only -- it never affects
// clustering or routing.
//
// Expects points already annotated with `.floor` (see floors.annotateFloors).

export const FEET_TO_METERS = 0.3048;
export const DEFAULT_MAX_EDGE_METERS = 8 * FEET_TO_METERS; // 8ft, per project spec

const nodeKey = (floor, gx, gz) => `${floor}:${gx}:${gz}`;

export function buildGraph(
  walks,
  { cellSize = 1.5, maxEdgeMeters = DEFAULT_MAX_EDGE_METERS } = {}
) {
  const nodes = new Map(); // key -> { key, floor, sx, sy, sz, n, buildingVotes }

  const snap = (v) => Math.round(v / cellSize);
  const keyFor = (p) => nodeKey(p.floor || 0, snap(p.x), snap(p.z));

  const touchNode = (p, building) => {
    const key = keyFor(p);
    let node = nodes.get(key);
    if (!node) {
      node = { key, floor: p.floor || 0, sx: 0, sy: 0, sz: 0, n: 0, buildingVotes: new Map() };
      nodes.set(key, node);
    }
    node.sx += p.x;
    node.sy += p.y;
    node.sz += p.z;
    node.n += 1;
    if (building != null) {
      node.buildingVotes.set(building, (node.buildingVotes.get(building) || 0) + 1);
    }
    return node;
  };

  // pass 1: cluster every point into its grid-cell node (position not final yet)
  for (const w of walks) {
    const building = w.building ?? null; // forward-compat: no DB column for this yet
    for (const p of w.points) touchNode(p, building);
  }

  // finalize node centroids + resolve a display building (majority vote)
  for (const node of nodes.values()) {
    const c = centroid(node);
    node.x = c.x;
    node.y = c.y;
    node.z = c.z;
    node.building = majorityVote(node.buildingVotes);
    delete node.buildingVotes;
  }

  const edges = new Map(); // "a|b" (a<b) -> { a, b, weight, count, vertical }
  let synthSeq = 0;

  const linkAdjacent = (aKey, bKey, aPos, bPos, vertical) => {
    if (aKey === bKey) return;
    const [a, b] = aKey < bKey ? [aKey, bKey] : [bKey, aKey];
    const ek = `${a}|${b}`;
    const dist = Math.hypot(aPos.x - bPos.x, aPos.y - bPos.y, aPos.z - bPos.z);
    let e = edges.get(ek);
    if (!e) {
      e = { a, b, weight: dist, count: 0, vertical };
      edges.set(ek, e);
    }
    e.count += 1;
    e.weight = Math.min(e.weight, dist); // shortest observed span between the cells
  };

  // Connect two (already-finalized) nodes, inserting synthetic intermediate
  // nodes along the straight line between them if the physical distance
  // exceeds maxEdgeMeters -- e.g. a stairwell run is a single floor-to-floor
  // hop in the raw walk data, but physically much longer than 8ft, so it gets
  // broken into several <=8ft hops here. All sub-edges inherit the ORIGINAL
  // pair's vertical flag (not each synthetic midpoint's own floor label), so a
  // subdivided stair connector still renders/traverses as one climb.
  const connect = (nodeA, nodeB) => {
    if (nodeA.key === nodeB.key) return;
    const dist = Math.hypot(nodeA.x - nodeB.x, nodeA.y - nodeB.y, nodeA.z - nodeB.z);
    const vertical = nodeA.floor !== nodeB.floor;
    if (!(maxEdgeMeters > 0) || dist <= maxEdgeMeters) {
      linkAdjacent(nodeA.key, nodeB.key, nodeA, nodeB, vertical);
      return;
    }

    const steps = Math.ceil(dist / maxEdgeMeters);
    let prevKey = nodeA.key;
    let prevPos = nodeA;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const key = `synth:${synthSeq++}`;
      const synth = {
        key,
        floor: t < 0.5 ? nodeA.floor : nodeB.floor, // label by nearer real endpoint
        x: nodeA.x + (nodeB.x - nodeA.x) * t,
        y: nodeA.y + (nodeB.y - nodeA.y) * t,
        z: nodeA.z + (nodeB.z - nodeA.z) * t,
        building: nodeA.building ?? nodeB.building ?? null,
        synthetic: true,
      };
      nodes.set(key, synth);
      linkAdjacent(prevKey, key, prevPos, synth, vertical);
      prevKey = key;
      prevPos = synth;
    }
    linkAdjacent(prevKey, nodeB.key, prevPos, nodeB, vertical);
  };

  // pass 2: walk each walk again, now that node centroids are final
  for (const w of walks) {
    let prev = null;
    for (const p of w.points) {
      const node = nodes.get(keyFor(p));
      if (prev) connect(prev, node);
      prev = node;
    }
  }

  return { nodes, edges };
}

function centroid(node) {
  return { x: node.sx / node.n, y: node.sy / node.n, z: node.sz / node.n };
}

// Pick the most-observed building for a node; null if no walk touching it
// carried a `building` tag (expected until the DB schema grows one).
function majorityVote(counts) {
  let best = null;
  let bestN = 0;
  for (const [building, n] of counts) {
    if (n > bestN) {
      bestN = n;
      best = building;
    }
  }
  return best;
}

export function nearestNode(graph, pos) {
  let best = null;
  let bestD = Infinity;
  for (const node of graph.nodes.values()) {
    const d = Math.hypot(node.x - pos.x, node.y - pos.y, node.z - pos.z);
    if (d < bestD) {
      bestD = d;
      best = node;
    }
  }
  return best;
}

// Dijkstra. Returns { nodes: [node...], edges: [edge...], length } or null.
export function route(graph, startPos, endPos) {
  const start = nearestNode(graph, startPos);
  const goal = nearestNode(graph, endPos);
  if (!start || !goal) return null;

  // adjacency
  const adj = new Map(); // key -> [{ to, weight, edge }]
  for (const node of graph.nodes.values()) adj.set(node.key, []);
  for (const e of graph.edges.values()) {
    adj.get(e.a).push({ to: e.b, weight: e.weight, edge: e });
    adj.get(e.b).push({ to: e.a, weight: e.weight, edge: e });
  }

  const dist = new Map();
  const prev = new Map(); // key -> { key, edge }
  for (const key of graph.nodes.keys()) dist.set(key, Infinity);
  dist.set(start.key, 0);

  // simple array-based priority queue (node counts are small for a POC)
  const pq = new Set(graph.nodes.keys());
  while (pq.size) {
    let u = null;
    let ud = Infinity;
    for (const k of pq) {
      const d = dist.get(k);
      if (d < ud) {
        ud = d;
        u = k;
      }
    }
    if (u === null) break;
    pq.delete(u);
    if (u === goal.key) break;
    for (const { to, weight, edge } of adj.get(u)) {
      if (!pq.has(to)) continue;
      const nd = ud + weight;
      if (nd < dist.get(to)) {
        dist.set(to, nd);
        prev.set(to, { key: u, edge });
      }
    }
  }

  if (dist.get(goal.key) === Infinity) return null;

  const nodePath = [];
  const edgePath = [];
  let cur = goal.key;
  while (cur !== start.key) {
    nodePath.push(graph.nodes.get(cur));
    const p = prev.get(cur);
    if (!p) break;
    edgePath.push(p.edge);
    cur = p.key;
  }
  nodePath.push(start);
  nodePath.reverse();
  edgePath.reverse();

  return { nodes: nodePath, edges: edgePath, length: dist.get(goal.key) };
}

// ---------------------------------------------------------------------------
// Self-test: prove the 8ft edge cap holds and routing still works after
// subdivision. Run: `node web/pipeline/graph.js`
export function runSelfTest() {
  const results = [];

  // A single long straight walk (floor 0, one point every 3m -- well over the
  // 8ft/2.4384m cap) should end up with every edge <= maxEdgeMeters.
  const longWalk = {
    id: "w-long",
    points: Array.from({ length: 6 }, (_, i) => ({ t: i, x: i * 3, y: 0, z: 0, floor: 0 })),
  };
  const g1 = buildGraph([longWalk], { cellSize: 0.5 });
  let maxEdge = 0;
  for (const e of g1.edges.values()) maxEdge = Math.max(maxEdge, e.weight);
  results.push({
    name: "8ft cap holds on a long straight walk",
    maxEdgeMeters: maxEdge,
    cap: DEFAULT_MAX_EDGE_METERS,
    pass: maxEdge <= DEFAULT_MAX_EDGE_METERS + 1e-9,
  });

  // Two "buildings" (tagged via walk.building, forward-compat metadata only)
  // joined by a bridging walk (a tunnel) should route end-to-end through it,
  // and nodes should carry the majority-vote building tag.
  const buildingA = {
    id: "w-a", building: "Building A",
    points: [{ t: 0, x: 0, y: 0, z: 0, floor: 0 }, { t: 1, x: 2, y: 0, z: 0, floor: 0 }],
  };
  const tunnel = {
    id: "w-tunnel", building: "Tunnel",
    points: [{ t: 0, x: 2, y: 0, z: 0, floor: 0 }, { t: 1, x: 20, y: 0, z: 0, floor: 0 }],
  };
  const buildingB = {
    id: "w-b", building: "Building B",
    points: [{ t: 0, x: 20, y: 0, z: 0, floor: 0 }, { t: 1, x: 22, y: 0, z: 0, floor: 0 }],
  };
  const g2 = buildGraph([buildingA, tunnel, buildingB], { cellSize: 0.5 });
  const r = route(g2, { x: 0, y: 0, z: 0 }, { x: 22, y: 0, z: 0 });
  const startNode = r && r.nodes[0];
  const endNode = r && r.nodes[r.nodes.length - 1];
  results.push({
    name: "cross-building route via a shared bridging walk",
    found: !!r,
    startBuilding: startNode && startNode.building,
    endBuilding: endNode && endNode.building,
    length: r && r.length,
    pass: !!r && startNode?.building === "Building A" && endNode?.building === "Building B",
  });

  const pass = results.every((r) => r.pass);
  return { pass, results };
}

if (typeof process !== "undefined" && process.argv && process.argv[1]) {
  const invokedUrl = "file://" + process.argv[1].replace(/\\/g, "/");
  const meUrl = import.meta.url;
  if (invokedUrl === meUrl || meUrl.endsWith(process.argv[1].replace(/\\/g, "/"))) {
    const { pass, results } = runSelfTest();
    console.log(JSON.stringify(results, null, 2));
    console.log(pass ? "SELF-TEST: PASS" : "SELF-TEST: FAIL");
    if (!pass) process.exitCode = 1;
  }
}
