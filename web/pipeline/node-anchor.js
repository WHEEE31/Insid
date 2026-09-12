// NODE ANCHORING (owner: A) — maps a walk's ARKit-local points into the ONE
// shared building-local map frame using registry-node references, instead of
// GPS+compass (see anchor.js for that experiment).
//
// Frames (see docs/contracts.md):
//   ARKit-local     — per-walk, origin at record start, arbitrary yaw.
//   building-local  — one shared frame per building; the node registry lives here.
//
// All math is metric. `y` = up and is passed through UNCHANGED — anchoring only
// resolves the horizontal (x,z) plane (a rigid rotation + translation, scale = 1).
// Floors/elevation come from the barometer downstream, not from this transform.

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// Build an { id -> node } lookup from a nodes[] array (nodes.json .nodes, or
// loadNodes() rows). Callers pass the result straight into anchorWalkToMap.
export function nodesById(nodes) {
  const byId = {};
  for (const n of nodes || []) byId[n.id] = n;
  return byId;
}

// Apply a { rot, tx, tz } rigid transform to a horizontal point.
//   x' = cos(rot)*x - sin(rot)*z + tx
//   z' = sin(rot)*x + cos(rot)*z + tz
function applyRigid2D(x, z, { rot, tx, tz }) {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  return { x: c * x - s * z + tx, z: s * x + c * z + tz };
}

// ---------------------------------------------------------------------------
// fitRigid2D — least-squares rigid transform on the (x,z) plane, scale = 1.
// ---------------------------------------------------------------------------
// Finds { rot, tx, tz } minimizing Σ | dst_i - R(rot)*src_i - t |² over all i,
// i.e. the best rotation + translation (NO scaling) mapping src -> dst.
//
// Method: 2D Kabsch/Umeyama-without-scale.
//   1. subtract centroids of src and dst,
//   2. rot = atan2( Σ (sx·dz - sz·dx),  Σ (sx·dx + sz·dz) )   over centered pts,
//   3. t   = centroid(dst) - R(rot)·centroid(src).
// For the 2-point case this is exact when src/dst are related by a true rigid
// motion (equal inter-point distances); with N>2 or noise it is least-squares.
//
// srcXZ, dstXZ: equal-length arrays of { x, z } (any object with x,z works).
export function fitRigid2D(srcXZ, dstXZ) {
  const n = Math.min(srcXZ.length, dstXZ.length);
  if (n === 0) throw new Error("fitRigid2D: need at least one point pair");

  // centroids
  let scx = 0, scz = 0, dcx = 0, dcz = 0;
  for (let i = 0; i < n; i++) {
    scx += srcXZ[i].x; scz += srcXZ[i].z;
    dcx += dstXZ[i].x; dcz += dstXZ[i].z;
  }
  scx /= n; scz /= n; dcx /= n; dcz /= n;

  // cross/dot accumulators over centered vectors
  let a = 0; // Σ (sx·dx + sz·dz)   -> cos component
  let b = 0; // Σ (sx·dz - sz·dx)   -> sin component
  for (let i = 0; i < n; i++) {
    const sx = srcXZ[i].x - scx, sz = srcXZ[i].z - scz;
    const dx = dstXZ[i].x - dcx, dz = dstXZ[i].z - dcz;
    a += sx * dx + sz * dz;
    b += sx * dz - sz * dx;
  }

  const rot = Math.atan2(b, a); // 0 when both are 0 (single point / no spread)
  const c = Math.cos(rot), s = Math.sin(rot);
  const tx = dcx - (c * scx - s * scz);
  const tz = dcz - (s * scx + c * scz);
  return { rot, tx, tz };
}

// ---------------------------------------------------------------------------
// anchorWalkToMap — ARKit-local walk -> building-local, via its node refs.
// ---------------------------------------------------------------------------
// Uses two correspondences:
//   startNodeId  -> the walk's FIRST point (points[0])  ... translation anchor
//   orientNodeId -> the walk's LAST  point (points[N-1]) ... rotation anchor
//
// The recorder convention (see report / docs): begin the walk standing on the
// start node and finish on the orient node. The transform pins the start point
// EXACTLY onto P(startNode) and rotates about it so the local start->orient
// direction lines up with the map start->orient direction. This matches the
// contract math: origin = P(startNode); yaw aligns local (orient - start) to
// map (P_orient - P_start). (When points[0] is the ARKit origin, "start" is 0.)
//
// Returns a NEW walk. On success .anchored=true and .points[].x/.z are in
// building-local meters (y unchanged). If refs or nodes are missing/degenerate,
// returns the walk unchanged with .anchored=false and an .anchor.reason.
export function anchorWalkToMap(walk, nodesById) {
  const pts = walk && walk.points;
  const startNode = nodesById && walk ? nodesById[walk.startNodeId] : undefined;
  const orientNode = nodesById && walk ? nodesById[walk.orientNodeId] : undefined;

  let reason = null;
  if (!walk || !Array.isArray(pts) || pts.length < 2) reason = "no points";
  else if (!walk.startNodeId) reason = "no startNodeId";
  else if (!walk.orientNodeId) reason = "no orientNodeId";
  else if (!startNode) reason = `unknown startNodeId '${walk.startNodeId}'`;
  else if (!orientNode) reason = `unknown orientNodeId '${walk.orientNodeId}'`;

  if (reason) return { ...walk, anchored: false, anchor: { reason } };

  // ARKit-local anchor positions (horizontal only).
  const startLocal = pts[0];
  const orientLocal = pts[pts.length - 1];

  // Local start->orient vector and its map counterpart.
  const lvx = orientLocal.x - startLocal.x;
  const lvz = orientLocal.z - startLocal.z;
  const mvx = orientNode.x - startNode.x;
  const mvz = orientNode.z - startNode.z;

  // Degenerate if either vector has ~no length (can't resolve yaw).
  const lLen = Math.hypot(lvx, lvz);
  const mLen = Math.hypot(mvx, mvz);
  if (lLen < 1e-9 || mLen < 1e-9) {
    return { ...walk, anchored: false, anchor: { reason: "degenerate orient vector" } };
  }

  // Yaw = bearing(map vector) - bearing(local vector).
  const rot = Math.atan2(mvz, mvx) - Math.atan2(lvz, lvx);
  const c = Math.cos(rot), s = Math.sin(rot);

  // Translation pins startLocal exactly onto P(startNode):
  //   P_start = R * startLocal + t   ->   t = P_start - R*startLocal
  const tx = startNode.x - (c * startLocal.x - s * startLocal.z);
  const tz = startNode.z - (s * startLocal.x + c * startLocal.z);
  const T = { rot, tx, tz };

  const points = pts.map((p) => {
    const { x, z } = applyRigid2D(p.x, p.z, T);
    return { ...p, x, z }; // y unchanged
  });

  return {
    ...walk,
    points,
    anchored: true,
    anchor: {
      via: "nodes",
      startNodeId: walk.startNodeId,
      orientNodeId: walk.orientNodeId,
      rot,
      tx,
      tz,
      lengthResidual: mLen - lLen, // map vs ARKit distance start->orient (m)
    },
  };
}

// ---------------------------------------------------------------------------
// driftCorrect — linear rubber-sheet of the residual across the walk.
// ---------------------------------------------------------------------------
// After anchoring, the walk's LAST point should sit on endNode but usually
// won't, because ARKit tracking drifts over the walk. Distribute that residual
// linearly in t (0 at the first point, full residual at the last) so the start
// stays pinned and the end lands exactly on endNode. Horizontal (x,z) only;
// y unchanged. Expects an already-anchored (building-local) walk.
//
// Returns a NEW walk; unchanged (with .drift.reason) if it can't be applied.
export function driftCorrect(walk, endNode) {
  const pts = walk && walk.points;
  if (!Array.isArray(pts) || pts.length < 2) {
    return { ...walk, drift: { reason: "no points" } };
  }
  if (!endNode) return { ...walk, drift: { reason: "no endNode" } };

  const first = pts[0];
  const last = pts[pts.length - 1];
  const t0 = first.t ?? 0;
  const t1 = last.t ?? pts.length - 1;
  const span = t1 - t0;
  if (Math.abs(span) < 1e-9) return { ...walk, drift: { reason: "zero time span" } };

  // residual at the end, in building-local meters
  const rx = endNode.x - last.x;
  const rz = endNode.z - last.z;

  const points = pts.map((p) => {
    const frac = ((p.t ?? t0) - t0) / span; // 0..1 along the walk
    return { ...p, x: p.x + rx * frac, z: p.z + rz * frac }; // y unchanged
  });

  return {
    ...walk,
    points,
    drift: { endNodeId: endNode.id, residual: { x: rx, z: rz }, magnitude: Math.hypot(rx, rz) },
  };
}
