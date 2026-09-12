// Synthetic multi-walk, multi-floor data conforming to docs/path-schema.md (v2).
// A tiny 2-floor "building" walked several ways. All walks share one physical
// start spot (startAnchorId "demo-lobby-x") so they live in ONE frame and can be
// stitched + merged into a graph. Lets the vis + pipeline develop before the
// ARKit recorder exists. Regenerate freely; deterministic so diffs stay clean.

const BARO_REF = 101.36; // kPa at the start spot

// ---- shared building layout (meters, y = up) ----
// Floor 0 (y=0)
const LOBBY = { x: 0, y: 0, z: 0 };
const C1 = { x: 0, y: 0, z: 10 }; // mid main corridor / room branch
const ROOM0 = { x: -6, y: 0, z: 10 };
const C2 = { x: 0, y: 0, z: 20 }; // main corridor meets cross corridor
const XW = { x: -8, y: 0, z: 20 }; // cross corridor, west end
const XE = { x: 8, y: 0, z: 20 }; // cross corridor, east end = stair base
// Stairs up to floor 1
const STAIR_TOP = { x: 8, y: 4, z: 24 };
// Floor 1 (y=4)
const F1_MID = { x: 0, y: 4, z: 24 };
const F1_W = { x: -8, y: 4, z: 24 };
const F1_BRANCH = { x: -8, y: 4, z: 14 };

// deterministic small PRNG so regenerated data is stable
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function makeWalk({ id, waypoints, seed }) {
  const rng = makeRng(seed);
  const jit = (amp) => (rng() - 0.5) * amp;
  const points = [];
  let t = 0;
  const dt = 0.2; // 5 Hz
  const speed = 1.3; // m/s
  const step = speed * dt; // ~0.26 m between samples

  const emit = (p) => {
    points.push({
      t: +t.toFixed(2),
      x: +(p.x + jit(0.06)).toFixed(3),
      y: +(p.y + jit(0.03)).toFixed(3),
      z: +(p.z + jit(0.06)).toFixed(3),
      pressure: +(BARO_REF - p.y * 0.012 + jit(0.004)).toFixed(3),
      relAltitude: +(p.y + jit(0.05)).toFixed(3),
      tracking: "normal",
    });
    t += dt;
  };

  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i];
    const b = waypoints[i + 1];
    const dist = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    const n = Math.max(2, Math.round(dist / step));
    // include start of first segment; skip each segment's first point after that
    // to avoid duplicating the shared waypoint
    for (let k = i === 0 ? 0 : 1; k <= n; k++) {
      const u = k / n;
      emit({
        x: a.x + (b.x - a.x) * u,
        y: a.y + (b.y - a.y) * u,
        z: a.z + (b.z - a.z) * u,
      });
    }
  }

  return {
    schemaVersion: 2,
    id,
    device: "synthetic",
    recordedAt: "2026-09-11T18:30:00Z",
    unit: "meters",
    up: "y",
    startAnchorId: "demo-lobby-x",
    startLatLon: { lat: 40.4433, lon: -79.9436, gpsAccuracy: 8.0 },
    startHeading: { trueHeading: 274.0, accuracy: 20.0 },
    baroReference: BARO_REF,
    points,
  };
}

export const walks = [
  // lobby -> main corridor -> east -> up stairs -> floor 1 west
  makeWalk({ id: "walk-001", seed: 1, waypoints: [LOBBY, C1, C2, XE, STAIR_TOP, F1_MID, F1_W] }),
  // lobby -> main corridor -> into a room (floor 0 only)
  makeWalk({ id: "walk-002", seed: 2, waypoints: [LOBBY, C1, ROOM0] }),
  // lobby -> main corridor -> west along cross corridor (floor 0 only)
  makeWalk({ id: "walk-003", seed: 3, waypoints: [LOBBY, C1, C2, XW] }),
  // like walk-001 but continues to a branch on floor 1
  makeWalk({ id: "walk-004", seed: 4, waypoints: [LOBBY, C1, C2, XE, STAIR_TOP, F1_MID, F1_W, F1_BRANCH] }),
];

// backward-compatible single-walk export (current main.js still imports this)
export const samplePath = walks[0];
