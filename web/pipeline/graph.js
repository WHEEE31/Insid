// Routing graph from many overlapping walks that share a frame.
//
// Approach (research §5, hackathon-simple):
//   1. grid-snap each point to a cell (per floor) -> merged nodes
//   2. edges between consecutive cells along each walk, visit-weighted
//   3. edges whose endpoints are on different floors are vertical connectors
//      (stairs/elevator) -- they only exist where someone actually changed floor
//   4. Dijkstra between the nearest nodes to a start/end position
//
// Expects points already annotated with `.floor` (see floors.annotateFloors).

const nodeKey = (floor, gx, gz) => `${floor}:${gx}:${gz}`;

export function buildGraph(walks, { cellSize = 1.5 } = {}) {
  const nodes = new Map(); // key -> { key, floor, sx, sy, sz, n }
  const edges = new Map(); // "a|b" (a<b) -> { a, b, weight, count, vertical }

  const snap = (v) => Math.round(v / cellSize);

  const touchNode = (p) => {
    const floor = p.floor || 0;
    const key = nodeKey(floor, snap(p.x), snap(p.z));
    let node = nodes.get(key);
    if (!node) {
      node = { key, floor, sx: 0, sy: 0, sz: 0, n: 0 };
      nodes.set(key, node);
    }
    node.sx += p.x;
    node.sy += p.y;
    node.sz += p.z;
    node.n += 1;
    return node;
  };

  const touchEdge = (aKey, bKey, aFloor, bFloor, dist) => {
    if (aKey === bKey) return;
    const [a, b] = aKey < bKey ? [aKey, bKey] : [bKey, aKey];
    const ek = `${a}|${b}`;
    let e = edges.get(ek);
    if (!e) {
      e = { a, b, weight: dist, count: 0, vertical: aFloor !== bFloor };
      edges.set(ek, e);
    }
    e.count += 1;
    e.weight = Math.min(e.weight, dist); // shortest observed span between the cells
    return e;
  };

  for (const w of walks) {
    let prev = null;
    for (const p of w.points) {
      const node = touchNode(p);
      if (prev && prev.key !== node.key) {
        const c1 = centroid(prev);
        const c2 = centroid(node);
        const dist = Math.hypot(c1.x - c2.x, c1.y - c2.y, c1.z - c2.z);
        touchEdge(prev.key, node.key, prev.floor, node.floor, dist);
      }
      prev = node;
    }
  }

  // finalize node centroids
  for (const node of nodes.values()) {
    const c = centroid(node);
    node.x = c.x;
    node.y = c.y;
    node.z = c.z;
  }

  return { nodes, edges };
}

function centroid(node) {
  return { x: node.sx / node.n, y: node.sy / node.n, z: node.sz / node.n };
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
