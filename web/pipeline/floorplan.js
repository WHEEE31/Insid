// Building footprints — which real building a path is inside, and where that
// building's outline sits in the local (ARKit/vis) frame.
//
// This is the piece that makes "overlay the building on the path" possible, and
// it only works because of the north gesture. A walk gives you two unknowns to
// pin before anything real-world can be drawn on top of it:
//
//   rotation    <- northOffsetDeg, from the collector facing north at record
//                  time (docs/path-schema.md §North calibration)
//   translation <- the GPS fix banked at the entrance / start
//
// With both, every local (x, z) has a lat/lon (world-align.js), so the reverse
// is also true: a building's real footprint polygon can be mapped INTO the
// local frame and drawn under the path. Without the north gesture the footprint
// would be drawn at an arbitrary yaw — the ±53° disagreement the old estimator
// produced — which is worse than drawing nothing.
//
// Data: web/data/cmu-buildings.json (regenerate: node tools/fetch-cmu-buildings.mjs).
// Fidelity is the building OUTLINE, not interior rooms — see that tool's header
// for why room-level plans aren't available to us.

import { latLonToLocal } from "./world-align.js";

const DEFAULT_URL = "./data/cmu-buildings.json";

let _cache;
export async function loadCmuBuildings(url = DEFAULT_URL) {
  if (_cache) return _cache;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`cmu-buildings.json ${res.status}`);
    const doc = await res.json();
    _cache = Array.isArray(doc?.buildings) ? doc.buildings : [];
  } catch (e) {
    console.warn("[floorplan] could not load footprints:", e.message);
    _cache = [];
  }
  return _cache;
}

// --- containment ------------------------------------------------------------

// Standard ray-cast point-in-polygon. `ring` is [[lon, lat], ...].
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) &&
        lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * The building a fix is inside, or null.
 *
 * Tries the detailed shape first, then the coarser hitbox. The hitbox fallback
 * is deliberate: an indoor GPS fix is ±15–25m and even an entrance fix is ±5m,
 * so a fix that lands just outside a wall is the normal case, not an error. A
 * strict shape-only test would reject most real recordings.
 */
export function buildingContaining(lat, lon, buildings) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  for (const b of buildings || []) {
    for (const ring of b.shape || []) if (pointInRing(lon, lat, ring)) return b;
  }
  for (const b of buildings || []) {
    if (b.hitbox?.length && pointInRing(lon, lat, b.hitbox)) return b;
  }
  return null;
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Resolve a typed building name or code ("wean", "WEH", "Wean Hall") against
 * the footprint set. This is the "we know the building by user prompting" path:
 * it's what runs when a walk has no usable GPS at all, so the collector's word
 * is the only thing saying which building to draw.
 */
export function resolveCmuBuilding(query, buildings) {
  const q = norm(query);
  if (!q) return null;
  const list = buildings || [];
  return (
    list.find((b) => norm(b.code) === q) ||
    list.find((b) => norm(b.name) === q) ||
    list.find((b) => norm(b.name).startsWith(q)) ||
    list.find((b) => norm(b.name).includes(q)) ||
    null
  );
}

// --- geometry into the local frame ------------------------------------------

/**
 * A building's footprint expressed in local meters.
 *
 * @param georef  { lat0, lon0, northOffsetDeg, mPerDegLat, mPerDegLon }. Pass
 *                northOffsetDeg: 0 when the walks have ALREADY been rotated by
 *                alignWalkToNorth — double-rotating is the easiest way to get a
 *                building that looks plausible and is silently wrong.
 * @returns { rings: [{x,z}[]], center: {x,z}, extentM }
 */
export function footprintToLocal(building, georef) {
  const rings = (building.shape || [])
    .map((ring) => ring.map(([lon, lat]) => latLonToLocal(lat, lon, georef)))
    .filter((r) => r.length >= 3);

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const r of rings) {
    for (const p of r) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
  }
  const has = Number.isFinite(minX);
  const label = building.label
    ? latLonToLocal(building.label.lat, building.label.lon, georef)
    : null;

  return {
    rings,
    center: has ? { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 } : { x: 0, z: 0 },
    label,
    extentM: has ? Math.hypot(maxX - minX, maxZ - minZ) : 0,
    bounds: has ? { minX, maxX, minZ, maxZ } : null,
  };
}

/**
 * Translate a footprint so its centre lands on `at` — the no-GPS fallback.
 *
 * When a walk carries no usable fix there is nothing to place the building
 * against, so we keep the building's true SHAPE and ORIENTATION (both of which
 * are real: the shape from OSM/CMU Maps, the orientation from the north
 * gesture) and drop it over the path. Position is then indicative only, which
 * the caller must say out loud rather than letting it read as a survey.
 */
export function centerFootprintOn(local, at) {
  const dx = at.x - local.center.x;
  const dz = at.z - local.center.z;
  const shift = (p) => ({ x: p.x + dx, z: p.z + dz });
  return {
    ...local,
    rings: local.rings.map((r) => r.map(shift)),
    center: { ...at },
    label: local.label ? shift(local.label) : null,
    bounds: local.bounds && {
      minX: local.bounds.minX + dx, maxX: local.bounds.maxX + dx,
      minZ: local.bounds.minZ + dz, maxZ: local.bounds.maxZ + dz,
    },
  };
}

/**
 * Every building a walk passes through, in the order first entered.
 *
 * A path is not one building: docs/path-schema.md §Entrances has walks crossing
 * a connector into a second building mid-recording, so the scene has to be able
 * to draw more than one footprint. Points are sampled rather than all tested —
 * a 700-point walk against 74 polygons is wasted work when consecutive samples
 * are 26cm apart.
 */
export function buildingsAlongWalk(walk, buildings, georef, { localToLatLon, sampleEvery = 15 } = {}) {
  const out = [];
  const seen = new Set();
  const add = (b, t) => {
    if (!b || seen.has(b.code)) return;
    seen.add(b.code);
    out.push({ building: b, enteredAtT: t ?? null });
  };

  // A declared entrance/transition beats any inference from a noisy fix.
  const declared = [walk?.startEntrance, ...(walk?.buildingTransitions || []), walk?.endEntrance];
  for (const d of declared) {
    if (!d?.buildingId) continue;
    const b = resolveCmuBuilding(d.buildingName || d.buildingId, buildings);
    if (b) add(b, d.t);
  }

  if (georef && typeof localToLatLon === "function") {
    const pts = walk?.points || [];
    for (let i = 0; i < pts.length; i += sampleEvery) {
      const { lat, lon } = localToLatLon(pts[i].x, pts[i].z, georef);
      add(buildingContaining(lat, lon, buildings), pts[i].t);
    }
  }
  return out;
}
