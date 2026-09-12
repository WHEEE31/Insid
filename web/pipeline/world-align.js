// World alignment — relate the local (ARKit/graph) frame to the real world:
// which way is north, and where on Earth the frame's origin sits.
// Owner: D (routing graph / world alignment). See docs/contracts.md.
//
// Two conventions, used consistently everywhere below:
//   - Local frame: ARKit. y = up. A local vector (x, z) has "frame bearing"
//     atan2(x, -z) -- i.e. -z is forward/0°, +x is right/90°.
//   - North-aligned frame: the same thing, rotated so that -z = true north
//     and +x = true east. `northOffsetDeg` is the true bearing that the raw
//     frame's -z axis points toward; rotating by it yields the aligned frame.
//
// Why this module exists: ARKit's yaw is arbitrary per session, so two walks
// recorded in different sessions can't be overlaid without knowing each
// frame's north offset. Two ways to get it:
//   1. CALIBRATED (preferred, new recorder flow) -- the collector physically
//      faces north before walking, so trueHeading ~ 0 and the frame IS
//      north-aligned by construction. Nothing to estimate.
//   2. ESTIMATED (legacy walks) -- compare the compass heading recorded at
//      start against the bearing of the walk's first few meters of motion,
//      assuming the collector walked roughly the way they were facing. Rough
//      (the magnetometer is +-15-25 deg indoors), but good enough to narrow a
//      node list from 60+ down to the handful nearby.

const DEG = Math.PI / 180;
const EARTH_R = 6378137; // WGS84 semi-major axis (m)

// Rotate a local (x, z) pair by `headingDeg`, interpreting the rotation in
// bearing space: the result's frame bearing is the input's plus headingDeg.
// Used both to north-align points and to convert local -> east/north.
export function rotateByHeading(x, z, headingDeg) {
  const h = headingDeg * DEG;
  const c = Math.cos(h), s = Math.sin(h);
  const u = x, v = -z;           // (right, forward)
  const u2 = u * c + v * s;
  const v2 = -u * s + v * c;
  return { x: u2, z: -v2, east: u2, north: v2 };
}

export function metersPerDeg(lat0) {
  return {
    mPerDegLat: DEG * EARTH_R,
    mPerDegLon: DEG * EARTH_R * Math.cos(lat0 * DEG),
  };
}

// --- north alignment --------------------------------------------------------

// Bearing (in RAW frame coords, degrees 0-360) of the walk's initial motion:
// the direction from its first point to the first point at least `minDist`
// meters away. Returns null if the walk never moves that far.
export function initialFrameBearing(walk, minDist = 1.0) {
  const pts = walk && walk.points;
  if (!Array.isArray(pts) || pts.length < 2) return null;
  const p0 = pts[0];
  for (const p of pts) {
    const dx = p.x - p0.x, dz = p.z - p0.z;
    if (Math.hypot(dx, dz) >= minDist) {
      return norm360(Math.atan2(dx, -dz) / DEG);
    }
  }
  return null;
}

// The true bearing of the frame's -z axis, estimated from one walk:
// trueHeading (where the device faced, in the world) minus the bearing that
// the initial motion had in frame coords. Null if either input is missing.
export function frameNorthFromWalk(walk, minDist = 1.0) {
  const heading = walk?.startHeading?.trueHeading;
  if (!Number.isFinite(heading)) return null;
  const frameBearing = initialFrameBearing(walk, minDist);
  if (frameBearing == null) return null;
  return norm360(heading - frameBearing);
}

// Average the per-walk estimates circularly (so 359 deg and 1 deg average to 0,
// not 180). Walks already marked northAligned contribute an offset of 0.
// Returns { northOffsetDeg, n, spreadDeg } or null when nothing is usable.
export function estimateFrameNorth(walks, { minDist = 1.0 } = {}) {
  let sx = 0, sy = 0, n = 0;
  for (const w of walks || []) {
    const off = w.northAligned ? 0 : frameNorthFromWalk(w, minDist);
    if (off == null) continue;
    sx += Math.cos(off * DEG);
    sy += Math.sin(off * DEG);
    n += 1;
  }
  if (!n) return null;
  const northOffsetDeg = norm360(Math.atan2(sy, sx) / DEG);
  // resultant length -> 1 = perfect agreement, 0 = estimates cancel out
  const r = Math.hypot(sx, sy) / n;
  return { northOffsetDeg, n, spreadDeg: Math.acos(Math.max(-1, Math.min(1, r))) / DEG };
}

// Rotate every point of a walk so that -z = true north, +x = true east.
// Returns a NEW walk with northAligned: true. A walk recorded with the
// face-north calibration flow is already aligned and passes through untouched.
export function alignWalkToNorth(walk, { northOffsetDeg } = {}) {
  if (!walk || !Array.isArray(walk.points)) return walk;
  if (walk.northAligned) return walk;
  // Precedence: caller override > the recorder's calibrated offset > estimate.
  // walk.northOffsetDeg is what the face-north step produces on a real device:
  // ARKit's frame is fixed at SESSION start, not at calibration time, so the
  // recorder captures the camera's yaw within the frame at the moment the
  // collector confirms they're facing north (see docs/path-schema.md §North
  // calibration). Only a recorder that rotates points before saving may set
  // northAligned: true instead.
  const off = Number.isFinite(northOffsetDeg)
    ? northOffsetDeg
    : Number.isFinite(walk.northOffsetDeg)
      ? walk.northOffsetDeg
      : frameNorthFromWalk(walk);
  if (off == null) return { ...walk, northAligned: false, northAlign: { reason: "no heading" } };
  const points = walk.points.map((p) => {
    const r = rotateByHeading(p.x, p.z, off);
    return { ...p, x: r.x, z: r.z }; // y untouched
  });
  return { ...walk, points, northAligned: true, northAlign: { northOffsetDeg: off } };
}

// --- Earth anchoring --------------------------------------------------------

// Estimate where the local frame's ORIGIN sits on Earth, plus its north
// offset, from whatever walks carry startLatLon (and ideally startHeading).
// GPS fixes are weighted by 1/accuracy^2, so a +-5m fix outvotes a +-30m one.
//
// Returns a Georef: { lat0, lon0, northOffsetDeg, mPerDegLat, mPerDegLon,
//                     n, accuracyM } -- or null if no walk has a GPS fix.
export function estimateFrameGeoref(walks, { northOffsetDeg } = {}) {
  const north = Number.isFinite(northOffsetDeg)
    ? { northOffsetDeg, n: 0, spreadDeg: 0 }
    : estimateFrameNorth(walks);
  const off = north ? north.northOffsetDeg : 0;

  let wLat = 0, wLon = 0, wSum = 0, n = 0, accSum = 0;
  for (const w of walks || []) {
    const fix = w.startLatLon;
    const p0 = w.points && w.points[0];
    if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lon) || !p0) continue;
    const acc = Number.isFinite(fix.gpsAccuracy) && fix.gpsAccuracy > 0 ? fix.gpsAccuracy : 20;
    const weight = 1 / (acc * acc);
    const { mPerDegLat, mPerDegLon } = metersPerDeg(fix.lat);
    // Where is the frame ORIGIN, given this point sits at this lat/lon?
    const r = rotateByHeading(p0.x, p0.z, off);
    wLat += (fix.lat - r.north / mPerDegLat) * weight;
    wLon += (fix.lon - r.east / mPerDegLon) * weight;
    wSum += weight;
    accSum += acc;
    n += 1;
  }
  if (!n) return null;

  const lat0 = wLat / wSum;
  const lon0 = wLon / wSum;
  const { mPerDegLat, mPerDegLon } = metersPerDeg(lat0);
  return {
    lat0, lon0, northOffsetDeg: off, mPerDegLat, mPerDegLon,
    n,
    // rough 1-sigma: averaging n independent fixes shrinks error by sqrt(n)
    accuracyM: accSum / n / Math.sqrt(n),
    northSpreadDeg: north ? north.spreadDeg : null,
  };
}

export function localToLatLon(x, z, g) {
  const r = rotateByHeading(x, z, g.northOffsetDeg);
  return {
    lat: g.lat0 + r.north / g.mPerDegLat,
    lon: g.lon0 + r.east / g.mPerDegLon,
  };
}

export function latLonToLocal(lat, lon, g) {
  const north = (lat - g.lat0) * g.mPerDegLat;
  const east = (lon - g.lon0) * g.mPerDegLon;
  // inverse of rotateByHeading: rotate east/north back by -northOffsetDeg
  const h = -g.northOffsetDeg * DEG;
  const c = Math.cos(h), s = Math.sin(h);
  const u = east * c + north * s;
  const v = -east * s + north * c;
  return { x: u, z: -v };
}

// Ground distance in meters between two lat/lons (equirectangular — fine at
// campus scale, and far cheaper than haversine).
export function distanceMeters(lat1, lon1, lat2, lon2) {
  const { mPerDegLat, mPerDegLon } = metersPerDeg((lat1 + lat2) / 2);
  return Math.hypot((lat2 - lat1) * mPerDegLat, (lon2 - lon1) * mPerDegLon);
}

// Give every node a lat/lon derived from the frame georeference, WITHOUT
// overwriting a lat/lon that was already set for real. Returns new objects;
// derived ones are tagged geoDerived: true so the UI can say "rough".
export function nodesWithLatLon(nodes, g) {
  if (!g) return (nodes || []).map((n) => ({ ...n }));
  return (nodes || []).map((n) => {
    if (Number.isFinite(n.lat) && Number.isFinite(n.lon)) return { ...n };
    const ll = localToLatLon(n.x, n.z, g);
    return { ...n, lat: ll.lat, lon: ll.lon, geoDerived: true };
  });
}

// The k nodes closest to a lat/lon, nearest first, each tagged with its
// distance in meters. This is what turns "pick from 66 nodes" into "pick from
// the 5 near you". `floor` optionally restricts to one level.
export function nearestNodesToLatLon(nodes, lat, lon, { k = 5, floor = null } = {}) {
  const out = [];
  for (const n of nodes || []) {
    if (floor != null && n.floor !== floor) continue;
    if (!Number.isFinite(n.lat) || !Number.isFinite(n.lon)) continue;
    out.push({ ...n, distanceM: distanceMeters(lat, lon, n.lat, n.lon) });
  }
  out.sort((a, b) => a.distanceM - b.distanceM);
  return out.slice(0, k);
}

function norm360(d) {
  return ((d % 360) + 360) % 360;
}

// ---------------------------------------------------------------------------
// Self-test. Run: `node web/pipeline/world-align.js`
export function runSelfTest() {
  const results = [];
  const approx = (a, b, tol) => Math.abs(a - b) <= tol;

  // 1. A walk recorded facing due EAST (heading 90) that walks straight
  //    "forward" in frame coords should, once aligned, run due east (+x).
  const eastWalk = {
    id: "w-east",
    startHeading: { trueHeading: 90, accuracy: 10 },
    points: [
      { t: 0, x: 0, y: 0, z: 0 },
      { t: 1, x: 0, y: 0, z: -5 },   // 5m "forward" (-z) in frame coords
      { t: 2, x: 0, y: 0, z: -10 },
    ],
  };
  const aligned = alignWalkToNorth(eastWalk);
  const end = aligned.points[2];
  results.push({
    name: "facing-east walk aligns to +x (east)",
    end: { x: +end.x.toFixed(3), z: +end.z.toFixed(3) },
    pass: aligned.northAligned && approx(end.x, 10, 1e-6) && approx(end.z, 0, 1e-6),
  });

  // 2. A north-calibrated walk (heading 0) is unchanged by alignment.
  const northWalk = {
    id: "w-north",
    startHeading: { trueHeading: 0, accuracy: 5 },
    points: [{ t: 0, x: 0, y: 0, z: 0 }, { t: 1, x: 0, y: 0, z: -7 }],
  };
  const alignedN = alignWalkToNorth(northWalk);
  results.push({
    name: "north-calibrated walk passes through unrotated",
    end: { x: +alignedN.points[1].x.toFixed(3), z: +alignedN.points[1].z.toFixed(3) },
    pass: approx(alignedN.points[1].x, 0, 1e-6) && approx(alignedN.points[1].z, -7, 1e-6),
  });

  // 2b. A calibrated walk carries its own northOffsetDeg (captured from the
  //     camera yaw at the face-north confirmation) and must use it in
  //     preference to guessing from heading + initial motion.
  const calibrated = {
    id: "w-calibrated",
    northOffsetDeg: 270,                                  // frame -z points west
    startHeading: { trueHeading: 123, accuracy: 20, calibrated: true }, // would mislead
    points: [{ t: 0, x: 0, y: 0, z: 0 }, { t: 1, x: 0, y: 0, z: -6 }],
  };
  const alignedC = alignWalkToNorth(calibrated);
  results.push({
    name: "calibrated northOffsetDeg beats the heading estimate",
    end: { x: +alignedC.points[1].x.toFixed(3), z: +alignedC.points[1].z.toFixed(3) },
    used: alignedC.northAlign.northOffsetDeg,
    // walking "forward" in a frame whose -z is west means heading due west: -x
    pass: approx(alignedC.points[1].x, -6, 1e-6) && approx(alignedC.points[1].z, 0, 1e-6),
  });

  // 3. Georeference round-trip: build a frame at a known lat/lon, convert a
  //    local point out to lat/lon and back, and land where we started.
  const g = {
    lat0: 40.4433, lon0: -79.9436, northOffsetDeg: 33,
    ...metersPerDeg(40.4433),
  };
  const ll = localToLatLon(12, -20, g);
  const back = latLonToLocal(ll.lat, ll.lon, g);
  results.push({
    name: "localToLatLon / latLonToLocal round-trip",
    latlon: { lat: +ll.lat.toFixed(6), lon: +ll.lon.toFixed(6) },
    back: { x: +back.x.toFixed(4), z: +back.z.toFixed(4) },
    pass: approx(back.x, 12, 1e-3) && approx(back.z, -20, 1e-3),
  });

  // 4. Frame georeference recovered from a synthetic walk: place a walk whose
  //    first point sits 0,0 at a known fix and check we recover that origin.
  const fixLat = 40.44300, fixLon = -79.94360;
  const geoWalks = [{
    id: "w-geo",
    startHeading: { trueHeading: 0, accuracy: 5 },
    startLatLon: { lat: fixLat, lon: fixLon, gpsAccuracy: 5 },
    points: [{ t: 0, x: 0, y: 0, z: 0 }, { t: 1, x: 0, y: 0, z: -4 }],
  }];
  const gg = estimateFrameGeoref(geoWalks);
  results.push({
    name: "frame georef recovers the origin from a GPS fix at local (0,0)",
    lat0: gg && +gg.lat0.toFixed(6), lon0: gg && +gg.lon0.toFixed(6),
    northOffsetDeg: gg && +gg.northOffsetDeg.toFixed(2),
    pass: !!gg && approx(gg.lat0, fixLat, 1e-6) && approx(gg.lon0, fixLon, 1e-6)
      && approx(gg.northOffsetDeg, 0, 1e-6),
  });

  // 5. nearestNodesToLatLon returns the closest k, nearest first.
  const nodes = nodesWithLatLon([
    { id: "near", floor: 0, x: 1, y: 0, z: 0 },
    { id: "mid", floor: 0, x: 25, y: 0, z: 0 },
    { id: "far", floor: 0, x: 200, y: 0, z: 0 },
  ], gg);
  const here = localToLatLon(0, 0, gg);
  const near = nearestNodesToLatLon(nodes, here.lat, here.lon, { k: 2 });
  results.push({
    name: "nearestNodesToLatLon narrows + orders by distance",
    got: near.map((n) => `${n.id}@${n.distanceM.toFixed(1)}m`),
    pass: near.length === 2 && near[0].id === "near" && near[1].id === "mid",
  });

  return { pass: results.every((r) => r.pass), results };
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
