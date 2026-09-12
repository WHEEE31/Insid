// GPS + compass anchoring — the EXPERIMENT.
//
// Maps each walk's ARKit-local points into ONE shared real-world frame using only
// its start GPS fix + start compass heading (no shared start spot). If GPS+compass
// are good enough indoors, walks down the same hallway will overlap after this.
// If not, the leftover gap IS the anchoring error, in meters, on real hardware.
//
// Output frame: local ENU meters (x = East, z = North, y = up) relative to a
// reference lat/lon, so the existing 3D vis can render it directly.

const DEG = Math.PI / 180;
const R_EARTH = 6371000;

// equirectangular lat/lon -> local east/north meters around a reference point
function toEN(lat, lon, refLat, refLon) {
  const east = (lon - refLon) * DEG * R_EARTH * Math.cos(refLat * DEG);
  const north = (lat - refLat) * DEG * R_EARTH;
  return { east, north };
}

// Pick a reference origin: the first walk that has a GPS start fix.
export function pickReference(walks) {
  const w = walks.find((w) => w.startLatLon);
  return w ? { lat: w.startLatLon.lat, lon: w.startLatLon.lon } : null;
}

// Anchor one walk. Returns a NEW walk object with transformed x/z (y/floor kept),
// plus `.anchor` diagnostics. Falls back to identity if GPS/heading missing.
export function anchorWalk(walk, ref) {
  const gps = walk.startLatLon;
  const hdg = walk.startHeading;
  if (!gps || !hdg || !ref) {
    return { ...walk, anchored: false, anchor: { reason: !gps ? "no GPS" : !hdg ? "no heading" : "no ref" } };
  }

  // GPS offset of this walk's origin in the shared ENU frame
  const { east: E0, north: N0 } = toEN(gps.lat, gps.lon, ref.lat, ref.lon);

  // ARKit .gravity frame: initial camera forward is local -Z. Its real-world
  // bearing is the compass trueHeading (deg clockwise from North). Rotate the
  // local horizontal plane so -Z points along that bearing in ENU.
  //   forward(-Z) -> (sinθ, cosθ),  right(+X) -> (cosθ, -sinθ)
  const th = hdg.trueHeading * DEG;
  const s = Math.sin(th);
  const c = Math.cos(th);

  const points = walk.points.map((p) => {
    // local (x, z) -> world (East, North)
    const east = p.x * c - p.z * s + E0;
    const north = -p.x * s - p.z * c + N0;
    return { ...p, x: east, z: north }; // y unchanged (barometer/ARKit height)
  });

  return {
    ...walk,
    points,
    anchored: true,
    anchor: { E0, N0, headingDeg: hdg.trueHeading, gpsAccuracy: gps.gpsAccuracy, headingAccuracy: hdg.accuracy },
  };
}

// Anchor all walks to a shared ENU frame. Returns { walks, ref, anchoredCount }.
export function anchorAll(walks) {
  const ref = pickReference(walks);
  const out = walks.map((w) => anchorWalk(w, ref));
  return { walks: out, ref, anchoredCount: out.filter((w) => w.anchored).length };
}
