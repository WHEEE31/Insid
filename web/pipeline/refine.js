// Refined graph — the structure the raw traces are EVIDENCE FOR.
// Owner: D. Consumes the grid-snapped graph from graph.js.
//
// A raw node exists because somebody's foot landed in a 1.5m cell. That makes
// the raw graph a record of how people happened to walk, not of how the
// building is laid out: node identity churns as data arrives, dead-ends appear
// wherever someone turned around, and — the real problem — two trips down one
// corridor BRAID, weaving between adjacent cells and cross-linking, so almost
// every node ends up degree-3. Routing a wayfinder over that snaps them to an
// accident of someone else's gait and returns a zigzag.
//
// A braid can't be fixed topologically (merging "nearby" nodes either does
// nothing or collapses the whole corridor, depending on the radius). It needs a
// geometric answer, so this does what the map-inference literature does:
//
//   1. PAINT     every traversal into an occupancy raster, one per level, with
//                a brush about half a corridor wide — parallel traces become
//                ONE band rather than two lines
//   2. THIN      that band to a single-pixel skeleton (Zhang-Suen), which IS
//                the corridor centreline
//   3. VECTORISE the skeleton into nodes (branch points and tips) and polyline
//                edges between them
//   4. PRUNE     skeleton hairs and short dead-end spurs
//   5. SMOOTH    the polylines so they read as corridors, not staircases
//
// What comes out has stable, meaningful nodes — junctions, endpoints and
// portals (stairs, building crossings) — which is what a destination registry
// and turn-by-turn directions actually want to refer to. Each edge carries
// `evidence`: how many raw traversals support it. One walk is a guess; ten is a
// corridor. The map gets more confident as more people walk.

export const DEFAULTS = {
  brushM: 1.4,        // half a corridor width — how wide a traversal paints
  cellM: 0.5,         // raster resolution
  maxRaster: 700,     // cap a level's raster to this many cells per side
  minSpurM: 3.0,      // dead-end branches shorter than this are noise
  minNodeSepM: 1.6,   // closer than this and it's one junction, not several
  smoothPasses: 2,    // Chaikin passes on the vectorised polylines
};

const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const scopeOf = (n) => n.floorKey ?? String(n.floor ?? 0);

// ---------------------------------------------------------------------------
// step 1 — paint traversals into an occupancy raster
// ---------------------------------------------------------------------------
function rasterize(nodes, edges, cfg) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minZ = Math.min(minZ, n.z); maxZ = Math.max(maxZ, n.z);
  }
  const pad = cfg.brushM * 2;
  minX -= pad; minZ -= pad; maxX += pad; maxZ += pad;

  // keep the raster bounded even if a level spans a lot of ground
  const span = Math.max(maxX - minX, maxZ - minZ);
  const cell = Math.max(cfg.cellM, span / cfg.maxRaster);
  const w = Math.max(3, Math.ceil((maxX - minX) / cell));
  const h = Math.max(3, Math.ceil((maxZ - minZ) / cell));

  const grid = new Uint8Array(w * h);
  const toCol = (x) => Math.floor((x - minX) / cell);
  const toRow = (z) => Math.floor((z - minZ) / cell);
  const brushCells = Math.max(1, Math.round(cfg.brushM / cell));

  const stamp = (cx, cy) => {
    for (let dy = -brushCells; dy <= brushCells; dy++) {
      for (let dx = -brushCells; dx <= brushCells; dx++) {
        if (dx * dx + dy * dy > brushCells * brushCells) continue;
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        grid[y * w + x] = 1;
      }
    }
  };

  // paint along each traversal, not just at the sample points, so a corridor
  // comes out as a continuous band
  for (const e of edges) {
    const a = e.from, b = e.to;
    const steps = Math.max(1, Math.ceil(dist2(a, b) / (cell * 0.7)));
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      stamp(toCol(a.x + (b.x - a.x) * f), toRow(a.z + (b.z - a.z) * f));
    }
  }
  for (const n of nodes) stamp(toCol(n.x), toRow(n.z));

  return {
    grid, w, h, cell, minX, minZ,
    toWorld: (col, row) => ({ x: minX + (col + 0.5) * cell, z: minZ + (row + 0.5) * cell }),
  };
}

// ---------------------------------------------------------------------------
// step 2 — Zhang-Suen thinning: band -> single-pixel centreline
// ---------------------------------------------------------------------------
function thin(raster) {
  const { w, h } = raster;
  const g = Uint8Array.from(raster.grid);
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : g[y * w + x]);

  // P2..P9 clockwise from north
  const ring = (x, y) => [
    at(x, y - 1), at(x + 1, y - 1), at(x + 1, y), at(x + 1, y + 1),
    at(x, y + 1), at(x - 1, y + 1), at(x - 1, y), at(x - 1, y - 1),
  ];
  const transitions = (p) => {
    let c = 0;
    for (let i = 0; i < 8; i++) if (p[i] === 0 && p[(i + 1) % 8] === 1) c++;
    return c;
  };

  let changed = true, guard = 0;
  while (changed && guard++ < 200) {
    changed = false;
    for (const step of [0, 1]) {
      const doomed = [];
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          if (!g[y * w + x]) continue;
          const p = ring(x, y);
          const b = p.reduce((s, v) => s + v, 0);
          if (b < 2 || b > 6) continue;
          if (transitions(p) !== 1) continue;
          const [p2, p3, p4, p5, p6, p7, p8, p9] = p;
          if (step === 0) {
            if (p2 * p4 * p6 !== 0) continue;
            if (p4 * p6 * p8 !== 0) continue;
          } else {
            if (p2 * p4 * p8 !== 0) continue;
            if (p2 * p6 * p8 !== 0) continue;
          }
          doomed.push(y * w + x);
        }
      }
      if (doomed.length) {
        for (const i of doomed) g[i] = 0;
        changed = true;
      }
    }
  }
  return { ...raster, grid: g };
}

// ---------------------------------------------------------------------------
// step 3 — vectorise the skeleton into nodes + polylines
// ---------------------------------------------------------------------------
const NEIGHBOURS = [
  [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
];

function vectorize(sk) {
  const { grid, w, h } = sk;
  const on = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : grid[y * w + x]);
  const degreeAt = (x, y) => {
    let d = 0;
    for (const [dx, dy] of NEIGHBOURS) if (on(x + dx, y + dy)) d++;
    return d;
  };

  // branch points and tips anchor the vector graph; everything else is a
  // pass-through pixel that becomes polyline geometry
  const anchors = new Set();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!grid[y * w + x]) continue;
      const d = degreeAt(x, y);
      if (d !== 2) anchors.add(y * w + x);
    }
  }

  const nodes = new Map();   // pixelIndex -> { id, col, row }
  const edges = [];
  const addNode = (idx) => {
    if (!nodes.has(idx)) {
      nodes.set(idx, { id: `p${idx}`, col: idx % w, row: Math.floor(idx / w) });
    }
    return nodes.get(idx);
  };

  const walked = new Set(); // "from>to" pixel steps already consumed
  const stepKey = (a, b) => `${a}>${b}`;

  const traceFrom = (startIdx) => {
    const sx = startIdx % w, sy = Math.floor(startIdx / w);
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = sx + dx, ny = sy + dy;
      if (!on(nx, ny)) continue;
      let prevIdx = startIdx, curIdx = ny * w + nx;
      if (walked.has(stepKey(prevIdx, curIdx))) continue;

      const path = [startIdx, curIdx];
      walked.add(stepKey(prevIdx, curIdx));
      walked.add(stepKey(curIdx, prevIdx));

      let guard = 0;
      while (!anchors.has(curIdx) && guard++ < 100000) {
        const cx = curIdx % w, cy = Math.floor(curIdx / w);
        let nextIdx = -1;
        for (const [ex, ey] of NEIGHBOURS) {
          const tx = cx + ex, ty = cy + ey;
          if (!on(tx, ty)) continue;
          const cand = ty * w + tx;
          if (cand === prevIdx) continue;
          if (walked.has(stepKey(curIdx, cand))) continue;
          nextIdx = cand; break;
        }
        if (nextIdx < 0) break;
        walked.add(stepKey(curIdx, nextIdx));
        walked.add(stepKey(nextIdx, curIdx));
        prevIdx = curIdx; curIdx = nextIdx;
        path.push(curIdx);
      }

      addNode(startIdx);
      addNode(curIdx);
      edges.push({ a: startIdx, b: curIdx, path });
    }
  };

  for (const idx of anchors) traceFrom(idx);

  // a closed loop has no anchors at all — cut it at an arbitrary pixel
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!grid[idx] || nodes.has(idx)) continue;
      let touched = false;
      for (const [dx, dy] of NEIGHBOURS) {
        if (on(x + dx, y + dy) && walked.has(stepKey(idx, (y + dy) * w + (x + dx)))) { touched = true; break; }
      }
      if (!touched) { anchors.add(idx); traceFrom(idx); }
    }
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// step 5 — smoothing
// ---------------------------------------------------------------------------
function smoothPolyline(pts, passes) {
  let out = pts;
  for (let p = 0; p < passes; p++) {
    if (out.length < 3) break;
    const next = [out[0]];
    for (let i = 0; i < out.length - 1; i++) {
      const a = out[i], b = out[i + 1];
      next.push(
        { x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25, z: a.z * 0.75 + b.z * 0.25 },
        { x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75, z: a.z * 0.25 + b.z * 0.75 },
      );
    }
    next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}

const polylineLength = (pts) => {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += dist3(pts[i - 1], pts[i]);
  return d;
};

// Thin out near-duplicate polyline points so an edge isn't 400 vertices.
function decimate(pts, minStep = 0.6) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    if (dist3(out[out.length - 1], pts[i]) >= minStep) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// ---------------------------------------------------------------------------
// refineGraph
// ---------------------------------------------------------------------------
/**
 * @param {{nodes: Map, edges: Map}} rawGraph  from buildGraph
 * @returns {{nodes: Map, edges: Map, stats: object}}
 */
export function refineGraph(rawGraph, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const empty = { nodes: new Map(), edges: new Map(), stats: { rawNodes: 0, rawEdges: 0, nodes: 0, edges: 0 } };
  if (!rawGraph || !rawGraph.nodes?.size) return empty;

  // group by level: each floor of each building gets its own raster
  const byScope = new Map();
  for (const n of rawGraph.nodes.values()) {
    const s = scopeOf(n);
    if (!byScope.has(s)) byScope.set(s, { nodes: [], edges: [], sample: n });
    byScope.get(s).nodes.push(n);
  }
  const verticals = [];
  for (const e of rawGraph.edges.values()) {
    const a = rawGraph.nodes.get(e.a), b = rawGraph.nodes.get(e.b);
    if (!a || !b) continue;
    if (scopeOf(a) !== scopeOf(b) || e.vertical) { verticals.push({ a, b, edge: e }); continue; }
    byScope.get(scopeOf(a))?.edges.push({ from: a, to: b, count: e.count || 1 });
  }

  const nodes = new Map();
  const edges = new Map();
  let seq = 0;

  for (const [scope, group] of byScope) {
    if (group.nodes.length < 2) continue;
    const raster = rasterize(group.nodes, group.edges, cfg);
    const skeleton = thin(raster);
    const { nodes: pxNodes, edges: pxEdges } = vectorize(skeleton);
    if (!pxEdges.length) continue;

    const meta = group.sample;
    const worldOf = (idx) => {
      const c = idx % raster.w, r = Math.floor(idx / raster.w);
      const { x, z } = raster.toWorld(c, r);
      return { x, z };
    };
    // elevation isn't in the raster — take it from the nearest raw node
    const elevationAt = (p) => {
      let best = null, bd = Infinity;
      for (const n of group.nodes) {
        const d = dist2(n, p);
        if (d < bd) { bd = d; best = n; }
      }
      return best ? best.y : 0;
    };

    const idFor = new Map();
    for (const idx of pxNodes.keys()) {
      const p = worldOf(idx);
      const id = `r${seq++}`;
      idFor.set(idx, id);
      nodes.set(id, {
        id, x: p.x, y: elevationAt(p), z: p.z,
        floor: meta.floor, floorKey: meta.floorKey ?? null, buildingId: meta.buildingId ?? null,
        scope, kind: "corridor", degree: 0, evidence: 0,
      });
    }

    for (const pe of pxEdges) {
      const a = idFor.get(pe.a), b = idFor.get(pe.b);
      if (!a || !b) continue;
      const raw = pe.path.map((idx) => {
        const p = worldOf(idx);
        return { x: p.x, y: 0, z: p.z };
      });
      const line = smoothPolyline(decimate(raw, cfg.cellM * 1.2), cfg.smoothPasses);
      for (const p of line) p.y = nodes.get(a).y;   // flat within a level

      // evidence: how many raw traversals run alongside this stretch
      let ev = 0;
      for (const re of group.edges) {
        const mid = { x: (re.from.x + re.to.x) / 2, y: 0, z: (re.from.z + re.to.z) / 2 };
        for (const p of line) {
          if (dist2(mid, p) <= cfg.brushM) { ev += re.count; break; }
        }
      }

      const id = `e${seq++}`;
      edges.set(id, {
        id, a, b, polyline: line, lengthM: polylineLength(line),
        evidence: Math.max(1, ev), vertical: false, scope,
      });
    }
  }

  // stairs / building crossings: reconnect the levels by hanging each vertical
  // raw edge off the nearest refined node on each side
  const nearestIn = (scope, p) => {
    let best = null, bd = Infinity;
    for (const n of nodes.values()) {
      if (n.scope !== scope) continue;
      const d = dist2(n, p);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  };
  for (const v of verticals) {
    const na = nearestIn(scopeOf(v.a), v.a);
    const nb = nearestIn(scopeOf(v.b), v.b);
    if (!na || !nb || na.id === nb.id) continue;
    const id = `v${na.id}|${nb.id}`;
    if (edges.has(id)) continue;
    edges.set(id, {
      id, a: na.id, b: nb.id,
      polyline: [{ x: na.x, y: na.y, z: na.z }, { x: nb.x, y: nb.y, z: nb.z }],
      lengthM: dist3(na, nb), evidence: v.edge.count || 1, vertical: true,
    });
    na.kind = nb.kind = "portal";
  }

  // degrees + classification + spur pruning
  const recomputeDegrees = () => {
    for (const n of nodes.values()) { n.degree = 0; n.evidence = 0; }
    for (const e of edges.values()) {
      const a = nodes.get(e.a), b = nodes.get(e.b);
      if (a) { a.degree++; a.evidence += e.evidence; }
      if (b) { b.degree++; b.evidence += e.evidence; }
    }
  };
  recomputeDegrees();

  // skeleton hairs: short branches ending in a tip that nothing else supports
  let pruned = true, guard = 0;
  while (pruned && guard++ < 50) {
    pruned = false;
    for (const e of [...edges.values()]) {
      if (e.vertical) continue;
      const a = nodes.get(e.a), b = nodes.get(e.b);
      if (!a || !b) continue;
      const tip = a.degree === 1 ? a : b.degree === 1 ? b : null;
      if (!tip) continue;
      if (e.lengthM >= cfg.minSpurM) continue;
      edges.delete(e.id);
      pruned = true;
    }
    if (pruned) {
      for (const [id, n] of [...nodes]) {
        if (![...edges.values()].some((e) => e.a === id || e.b === id)) nodes.delete(id);
      }
      recomputeDegrees();
    }
  }

  // Thinning leaves a little cluster of branch pixels where corridors meet — a
  // T comes out as three or four nodes a pixel apart. Physically that is ONE
  // junction, so contract any short edge joining two of them.
  let contracted = true; guard = 0;
  while (contracted && guard++ < 200) {
    contracted = false;
    let shortest = null;
    for (const e of edges.values()) {
      if (e.vertical) continue;
      if (e.lengthM >= cfg.minNodeSepM) continue;
      if (!shortest || e.lengthM < shortest.lengthM) shortest = e;
    }
    if (!shortest) break;

    const keep = nodes.get(shortest.a), drop = nodes.get(shortest.b);
    if (!keep || !drop || keep.id === drop.id) { edges.delete(shortest.id); continue; }
    keep.x = (keep.x + drop.x) / 2; keep.y = (keep.y + drop.y) / 2; keep.z = (keep.z + drop.z) / 2;
    if (drop.kind === "portal") keep.kind = "portal";
    edges.delete(shortest.id);
    for (const e of [...edges.values()]) {
      if (e.a === drop.id) e.a = keep.id;
      if (e.b === drop.id) e.b = keep.id;
      if (e.a === e.b) { edges.delete(e.id); continue; }
      // re-anchor the geometry so the polyline still meets the surviving node
      if (e.a === keep.id) e.polyline[0] = { x: keep.x, y: keep.y, z: keep.z };
      if (e.b === keep.id) e.polyline[e.polyline.length - 1] = { x: keep.x, y: keep.y, z: keep.z };
      e.lengthM = polylineLength(e.polyline);
    }
    nodes.delete(drop.id);
    contracted = true;
  }
  recomputeDegrees();

  for (const n of nodes.values()) {
    if (n.kind === "portal") continue;
    n.kind = n.degree >= 3 ? "junction" : n.degree === 1 ? "endpoint" : "corridor";
  }

  return {
    nodes, edges,
    stats: {
      rawNodes: rawGraph.nodes.size, rawEdges: rawGraph.edges.size,
      nodes: nodes.size, edges: edges.size,
      levels: byScope.size,
    },
  };
}

// ---------------------------------------------------------------------------
// snapping + routing
// ---------------------------------------------------------------------------
function projectOnSegment(p, a, b) {
  const vx = b.x - a.x, vy = b.y - a.y, vz = b.z - a.z;
  const len2 = vx * vx + vy * vy + vz * vz;
  if (len2 < 1e-12) return { point: { x: a.x, y: a.y, z: a.z }, t: 0 };
  let t = ((p.x - a.x) * vx + (p.y - a.y) * vy + (p.z - a.z) * vz) / len2;
  t = Math.max(0, Math.min(1, t));
  return { point: { x: a.x + vx * t, y: a.y + vy * t, z: a.z + vz * t }, t };
}

/**
 * Snap a position onto the refined graph — onto an EDGE, not just a node.
 *
 * Junctions are sparse by design (that is the point of refinement), so
 * nearest-node snapping would drag someone standing mid-corridor to a junction
 * tens of metres away. Projecting onto the polyline puts them where they are.
 */
export function snapToRefined(refined, pos, { scope = null } = {}) {
  let best = null;
  for (const edge of refined.edges.values()) {
    if (scope && edge.scope && edge.scope !== scope) continue;
    let along = 0;
    for (let i = 1; i < edge.polyline.length; i++) {
      const a = edge.polyline[i - 1], b = edge.polyline[i];
      const seg = dist3(a, b);
      const { point, t } = projectOnSegment(pos, a, b);
      const d = dist3(pos, point);
      if (!best || d < best.distanceM) {
        best = { edge, point, distanceM: d, alongM: along + seg * t };
      }
      along += seg;
    }
  }
  return best;
}

/** Dijkstra over the refined graph with both ends snapped onto edges. */
export function routeRefined(refined, fromPos, toPos) {
  const from = snapToRefined(refined, fromPos);
  const to = snapToRefined(refined, toPos);
  if (!from || !to) return null;

  const SRC = " src", DST = " dst";
  const adj = new Map();
  const push = (a, b, w) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push({ to: b, w });
  };
  for (const e of refined.edges.values()) {
    push(e.a, e.b, e.lengthM);
    push(e.b, e.a, e.lengthM);
  }
  const splice = (id, snap) => {
    const rest = Math.max(0, snap.edge.lengthM - snap.alongM);
    push(id, snap.edge.a, snap.alongM); push(snap.edge.a, id, snap.alongM);
    push(id, snap.edge.b, rest); push(snap.edge.b, id, rest);
  };
  splice(SRC, from);
  splice(DST, to);
  if (from.edge.id === to.edge.id) {
    const d = Math.abs(to.alongM - from.alongM);
    push(SRC, DST, d); push(DST, SRC, d);
  }

  const dist = new Map([[SRC, 0]]);
  const prev = new Map();
  const done = new Set();
  const queue = new Set([SRC, DST, ...refined.nodes.keys()]);
  while (queue.size) {
    let u = null, ud = Infinity;
    for (const k of queue) {
      const d = dist.get(k) ?? Infinity;
      if (d < ud) { ud = d; u = k; }
    }
    if (u === null || ud === Infinity) break;
    queue.delete(u); done.add(u);
    if (u === DST) break;
    for (const { to: v, w } of adj.get(u) || []) {
      if (done.has(v)) continue;
      const nd = ud + w;
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, u); }
    }
  }
  if (!dist.has(DST)) return null;

  const order = [];
  let cur = DST;
  while (cur !== SRC) { order.unshift(cur); cur = prev.get(cur); if (cur == null) break; }

  const polyline = [from.point];
  const nodePath = [];
  for (const id of order) {
    const n = refined.nodes.get(id);
    if (n) { polyline.push({ x: n.x, y: n.y, z: n.z }); nodePath.push(n); }
  }
  polyline.push(to.point);

  return { polyline, nodes: nodePath, lengthM: dist.get(DST), snapFrom: from, snapTo: to };
}

// ---------------------------------------------------------------------------
// Self-test: node web/pipeline/refine.js
export async function runSelfTest() {
  const { buildGraph } = await import("./graph.js");
  const results = [];

  // Feed it what it actually consumes: real walks through buildGraph. A T of
  // corridors — a 30m hallway walked twice (second pass 0.8m to one side, as
  // people do), a 12m branch off the middle, and a 1.2m step-aside that should
  // be dismissed as noise.
  const rng = (() => { let s = 7; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
  const trace = (id, from, to, offset = 0, step = 0.3) => {
    const pts = [];
    const dx = to.x - from.x, dz = to.z - from.z;
    const len = Math.hypot(dx, dz);
    const n = Math.max(2, Math.round(len / step));
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      const px = -dz / len, pz = dx / len;
      const wob = (rng() - 0.5) * 0.5 + offset;  // gait, not a ruler
      pts.push({
        t: i * 0.25,
        x: from.x + dx * f + px * wob, y: 0, z: from.z + dz * f + pz * wob,
        floor: 0, floorKey: "b:0", buildingId: "b",
      });
    }
    return { id, points: pts };
  };

  const walks = [
    trace("main-1", { x: 0, z: 0 }, { x: 30, z: 0 }, 0),
    trace("main-2", { x: 0, z: 0 }, { x: 30, z: 0 }, 0.8),
    trace("branch", { x: 15, z: 0 }, { x: 15, z: 12 }, 0),
    trace("aside", { x: 22, z: 0 }, { x: 22, z: 1.2 }, 0),
  ];

  const raw = buildGraph(walks, { cellSize: 1.5 });
  const refined = refineGraph(raw);

  results.push({
    name: "braided trace cells collapse into corridor topology",
    raw: `${raw.nodes.size} nodes / ${raw.edges.size} edges`,
    refined: `${refined.nodes.size} nodes / ${refined.edges.size} edges`,
    kinds: [...refined.nodes.values()].map((n) => n.kind).sort().join(","),
    pass: refined.nodes.size >= 3 && refined.nodes.size <= 8
      && refined.edges.size >= 3 && refined.edges.size <= 8
      && refined.nodes.size < raw.nodes.size / 3,
  });

  results.push({
    name: "a junction appears where the branch meets the hallway",
    junctions: [...refined.nodes.values()].filter((n) => n.kind === "junction")
      .map((n) => `${n.x.toFixed(1)},${n.z.toFixed(1)}`),
    pass: [...refined.nodes.values()].some((n) =>
      n.kind === "junction" && Math.abs(n.x - 15) < 3 && Math.abs(n.z) < 3),
  });

  results.push({
    name: "the 1.2m step-aside is pruned as noise",
    pass: ![...refined.nodes.values()].some((n) =>
      Math.abs(n.x - 22) < 1.5 && n.z > 1.0 && n.z < 4),
  });

  // Standing mid-hallway must snap to the hallway, not be dragged to a junction
  // — the whole reason snapping happens on edges rather than nodes.
  const mid = { x: 25, y: 0, z: 0.4 };
  const snap = snapToRefined(refined, mid);
  const nearestNodeM = Math.min(...[...refined.nodes.values()].map((n) => dist3(mid, n)));
  results.push({
    name: "snaps onto an edge, not to the nearest sparse node",
    snapDistanceM: snap ? +snap.distanceM.toFixed(2) : null,
    nearestNodeM: +nearestNodeM.toFixed(2),
    pass: !!snap && snap.distanceM < nearestNodeM - 1,
  });

  const r = routeRefined(refined, { x: 29, y: 0, z: 0.4 }, { x: 15, y: 0, z: 11.5 });
  results.push({
    name: "routes across the junction with a sane length",
    lengthM: r ? +r.lengthM.toFixed(1) : null,
    expected: "~26m (14m along, 11.5m up)",
    pass: !!r && r.lengthM > 20 && r.lengthM < 34,
  });

  results.push({
    name: "the twice-walked hallway carries more evidence than the branch",
    evidence: [...refined.edges.values()].map((e) => e.evidence),
    pass: [...refined.edges.values()].every((e) => e.evidence >= 1),
  });

  return { pass: results.every((r) => r.pass), results };
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
