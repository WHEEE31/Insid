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

// --- entrance anchoring -----------------------------------------------------

// ONE shared frame for the whole campus: meters relative to a fixed origin,
// with +x = east and -z = north (the same convention as everywhere else).
// Every walk gets placed into this, which is what lets recordings made in
// separate sessions coexist without overlapping each other.
export function makeCampusFrame(lat0, lon0) {
  return { lat0, lon0, northOffsetDeg: 0, ...metersPerDeg(lat0) };
}

/**
 * Place a walk into the campus frame using the GPS fixes taken at the
 * entrances it started and finished at.
 *
 * North calibration fixes the walk's ROTATION; the start-entrance fix fixes its
 * TRANSLATION. Together they pin a session absolutely — no shared ARKit session
 * required, which is what stops two separately-recorded buildings from being
 * silently overlaid on top of each other.
 *
 * The end-entrance fix is a closure constraint: after placement the last point
 * should land on it, and whatever it misses by is accumulated tracking drift.
 * That residual is rubber-sheeted linearly over the walk (start stays pinned,
 * end lands on the fix) — the same trick node-anchor.js uses for node refs.
 *
 * It also gives a free check on the north gesture: over a long enough baseline
 * the bearing between two GPS fixes is far more trustworthy than a compass, so
 * `northCheckDeg` reports how far off the collector's calibration looks.
 *
 * @returns a NEW walk with campus-frame points, `.placed`, and `.placement`
 */
export function placeWalkByEntrances(walk, campus, {
  driftCorrect = true,
  maxDriftM = 60,
  maxClosureAccuracyM = 12,
} = {}) {
  const start = walk?.startEntrance;
  if (!start || !Number.isFinite(start.lat) || !Number.isFinite(start.lon)) {
    return { ...walk, placed: false, placement: { reason: "no start-entrance GPS fix" } };
  }
  const aligned = alignWalkToNorth(walk);
  if (!aligned.northAligned) {
    return { ...walk, placed: false, placement: { reason: "no north reference" } };
  }

  const pts = aligned.points;
  if (!pts?.length) return { ...walk, placed: false, placement: { reason: "no points" } };

  const origin = latLonToLocal(start.lat, start.lon, campus);
  const dx = origin.x - pts[0].x, dz = origin.z - pts[0].z;
  let points = pts.map((p) => ({ ...p, x: p.x + dx, z: p.z + dz }));

  const info = {
    anchor: "startEntrance",
    startBuildingId: start.buildingId ?? null,
    startAccuracyM: start.gpsAccuracy ?? null,
  };

  const closure = pickClosure(walk, maxClosureAccuracyM);
  if (closure) {
    // The point the closure fix corresponds to. For an end entrance that's the
    // last point; for an opportunistic mid-walk fix it's wherever the collector
    // was when the fix came in.
    const anchorIdx = closure.source === "endEntrance"
      ? points.length - 1
      : indexAtTime(points, closure.t);
    const last = points[anchorIdx];
    const target = latLonToLocal(closure.lat, closure.lon, campus);
    const rx = target.x - last.x, rz = target.z - last.z;
    const residualM = Math.hypot(rx, rz);
    info.residualM = residualM;
    info.anchorEnd = closure.source;
    info.endBuildingId = closure.buildingId ?? null;
    if (closure.source !== "endEntrance") {
      const tail = (points[points.length - 1].t ?? 0) - (closure.t ?? 0);
      info.warning = `no exit fix — drift is only bounded up to ${closure.t.toFixed(0)}s; ` +
        `the last ${tail.toFixed(0)}s stay uncorrected`;
    }

    // Cross-check north, but only when the GPS baseline is long enough to beat
    // its own error — otherwise the "check" is just noise.
    const baselineM = Math.hypot(target.x - origin.x, target.z - origin.z);
    const fixError = (start.gpsAccuracy ?? 10) + (closure.gpsAccuracy ?? 10);
    if (baselineM > fixError * 1.5) {
      const bearingOf = (ax, az, bx, bz) => norm360(Math.atan2(bx - ax, -(bz - az)) / DEG);
      const gps = bearingOf(origin.x, origin.z, target.x, target.z);
      const walked = bearingOf(points[0].x, points[0].z, last.x, last.z);
      let diff = norm360(gps - walked);
      if (diff > 180) diff -= 360;
      info.northCheckDeg = diff;
      info.baselineM = baselineM;
    }

    if (residualM > maxDriftM) {
      // Too far off to be ordinary drift — more likely a bad fix or a tracking
      // jump. Correcting it would smear that error across every point.
      info.driftCorrected = false;
      info.warning = `end residual ${residualM.toFixed(0)}m exceeds maxDriftM ${maxDriftM}m`;
    } else if (driftCorrect) {
      // Ramp the correction from 0 at the start to the full residual at the
      // anchor. Past the anchor we know nothing more, so the correction holds
      // flat rather than continuing to extrapolate.
      const t0 = points[0].t ?? 0;
      const tAnchor = last.t ?? 1;
      const span = (tAnchor - t0) || 1;
      points = points.map((p) => {
        const f = Math.min(1, ((p.t ?? t0) - t0) / span);
        return { ...p, x: p.x + rx * f, z: p.z + rz * f };
      });
      info.driftCorrected = true;
    }
  } else {
    info.anchorEnd = "none";
    info.warning = "no exit fix and no usable GPS during the walk — drift is unbounded";
  }

  return { ...aligned, points, placed: true, placement: info };
}

// Which fix closes the loop: the exit entrance if the collector reached one,
// otherwise the last good opportunistic fix taken during the walk. A mid-walk
// fix is worth using — it still bounds drift up to the moment it was taken,
// which is most of the walk if the collector passed outside at some point.
function pickClosure(walk, maxAccuracyM) {
  const end = walk.endEntrance;
  if (end && Number.isFinite(end.lat) && Number.isFinite(end.lon)) {
    return { ...end, source: "endEntrance" };
  }
  const usable = (walk.gpsFixes || []).filter(
    (f) => Number.isFinite(f.lat) && Number.isFinite(f.lon)
      && (f.gpsAccuracy ?? 99) <= maxAccuracyM
  );
  if (!usable.length) return null;
  const best = usable[usable.length - 1];
  return { ...best, source: "gpsFix" };
}

function indexAtTime(points, t) {
  let best = 0;
  for (let i = 0; i < points.length; i++) {
    if ((points[i].t ?? 0) <= t) best = i;
    else break;
  }
  return best;
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

  // 4b. Entrance anchoring: a walk that starts and ends at known entrances gets
  //     pinned at both ends, with the closure residual rubber-sheeted away.
  const campus = makeCampusFrame(40.4433, -79.9436);
  const startFix = localToLatLon(0, 0, campus);
  const endFix = localToLatLon(30, -40, campus); // 30m east, 40m north of origin
  // The walk "thinks" it went 30E/40N but drifted 5m by the end.
  const drifted = {
    id: "w-entrances",
    northAligned: true,
    startEntrance: { buildingId: "wean-hall", floor: 2, t: 0, gpsAccuracy: 4, ...startFix },
    endEntrance: { buildingId: "doherty-hall", floor: 1, t: 10, gpsAccuracy: 4, ...endFix },
    points: [
      { t: 0, x: 100, y: 0, z: 100 },            // arbitrary ARKit origin offset
      { t: 5, x: 115, y: 0, z: 80 },
      { t: 10, x: 133, y: 0, z: 57 },            // 33E/43N travelled: ~5m of drift
    ],
  };
  const placed = placeWalkByEntrances(drifted, campus);
  const pEnd = placed.points[2];
  const endLocal = latLonToLocal(endFix.lat, endFix.lon, campus);
  results.push({
    name: "entrance anchoring pins both ends and absorbs the drift",
    start: { x: +placed.points[0].x.toFixed(2), z: +placed.points[0].z.toFixed(2) },
    end: { x: +pEnd.x.toFixed(2), z: +pEnd.z.toFixed(2) },
    residualM: +placed.placement.residualM.toFixed(2),
    northCheckDeg: placed.placement.northCheckDeg != null
      ? +placed.placement.northCheckDeg.toFixed(1) : null,
    pass: placed.placed
      && approx(placed.points[0].x, 0, 1e-6) && approx(placed.points[0].z, 0, 1e-6)
      && approx(pEnd.x, endLocal.x, 1e-6) && approx(pEnd.z, endLocal.z, 1e-6)
      && placed.placement.driftCorrected === true,
  });

  // 4c. No exit fix, but the collector passed outside mid-walk: that fix still
  //     bounds drift up to the moment it was taken, and the tail after it is
  //     left alone rather than extrapolated.
  const midFix = localToLatLon(20, -20, campus);
  const noExit = {
    id: "w-no-exit",
    northAligned: true,
    startEntrance: { buildingId: "wean-hall", floor: 1, t: 0, gpsAccuracy: 4, ...startFix },
    endEntrance: null,
    gpsFixes: [{ t: 5, gpsAccuracy: 6, ...midFix }],
    points: [
      { t: 0, x: 0, y: 0, z: 0 },
      { t: 5, x: 23, y: 0, z: -23 },   // thinks it went further than GPS says
      { t: 10, x: 40, y: 0, z: -40 },
    ],
  };
  const partial = placeWalkByEntrances(noExit, campus);
  const midLocal = latLonToLocal(midFix.lat, midFix.lon, campus);
  const tailOffsetX = partial.points[2].x - noExit.points[2].x;
  const midOffsetX = partial.points[1].x - noExit.points[1].x;
  results.push({
    name: "a mid-walk fix anchors what it can and leaves the tail alone",
    anchorEnd: partial.placement.anchorEnd,
    midPinned: approx(partial.points[1].x, midLocal.x, 1e-6) && approx(partial.points[1].z, midLocal.z, 1e-6),
    warning: partial.placement.warning,
    // past the anchor the correction holds flat instead of extrapolating
    pass: partial.placed && partial.placement.anchorEnd === "gpsFix"
      && approx(partial.points[1].x, midLocal.x, 1e-6)
      && approx(tailOffsetX, midOffsetX, 1e-6),
  });

  results.push({
    name: "a walk with no start fix refuses to be placed",
    pass: placeWalkByEntrances({ id: "x", northAligned: true, points: [{ t: 0, x: 0, y: 0, z: 0 }] }, campus).placed === false,
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
