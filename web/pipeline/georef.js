// Georeference — map building-local (x,z) meters onto Earth (lat/lon).
// Owner: C (map overlay). Contract: docs/contracts.md §Georeference.
//
//   fitGeoreference(controlPoints) : Georef   // controlPoints = [{x,z,lat,lon}], >=2
//   localToLatLon(x, z, g)         : {lat, lon}
//
// Model: a 2D SIMILARITY (rotation + uniform scale + translation) from
// building-local (x,z) into LOCAL METERS (east,north), composed with an
// equirectangular projection around a reference lat/lon to reach lat/lon.
//
//   east  = a*x - b*z + tx           (a = s*cos T, b = s*sin T)
//   north = b*x + a*z + ty
//   lat   = lat0 + north / mPerDegLat
//   lon   = lon0 + east  / mPerDegLon
//
// (a,b,tx,ty) are solved by linear least squares — this 4-parameter Helmert
// form is exactly rotation+uniform-scale (orientation preserving, no reflection)
// and works for the exact 2-point case as well as N-point over-determined fits.

const EARTH_R = 6378137; // WGS84 semi-major axis (m)
const DEG = Math.PI / 180;

// meters-per-degree at a reference latitude (equirectangular local tangent).
function metersPerDeg(lat0) {
  const mPerDegLat = DEG * EARTH_R; // ~111320 m/deg, ~constant
  const mPerDegLon = DEG * EARTH_R * Math.cos(lat0 * DEG);
  return { mPerDegLat, mPerDegLon };
}

// Solve a 4x4 linear system A u = c by Gaussian elimination w/ partial pivoting.
// A is number[4][4] (mutated), c is number[4] (mutated). Returns number[4].
function solve4(A, c) {
  const n = 4;
  for (let col = 0; col < n; col++) {
    // pivot
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    }
    if (Math.abs(A[piv][col]) < 1e-12) {
      throw new Error("fitGeoreference: control points are degenerate (collinear/coincident)");
    }
    if (piv !== col) {
      [A[piv], A[col]] = [A[col], A[piv]];
      [c[piv], c[col]] = [c[col], c[piv]];
    }
    // eliminate
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      if (f === 0) continue;
      for (let k = col; k < n; k++) A[r][k] -= f * A[col][k];
      c[r] -= f * c[col];
    }
  }
  return [c[0] / A[0][0], c[1] / A[1][1], c[2] / A[2][2], c[3] / A[3][3]];
}

/**
 * Fit a similarity georeference from >=2 control points.
 * @param {{x:number,z:number,lat:number,lon:number}[]} controlPoints
 * @returns {{lat0:number,lon0:number,mPerDegLat:number,mPerDegLon:number,
 *            a:number,b:number,tx:number,ty:number,scale:number,rotationDeg:number,
 *            n:number,rms:number}} Georef
 */
export function fitGeoreference(controlPoints) {
  if (!Array.isArray(controlPoints) || controlPoints.length < 2) {
    throw new Error("fitGeoreference: need >= 2 control points");
  }
  // reference = mean lat/lon of the control points (keeps the tangent plane centered)
  let sLat = 0, sLon = 0;
  for (const p of controlPoints) { sLat += p.lat; sLon += p.lon; }
  const lat0 = sLat / controlPoints.length;
  const lon0 = sLon / controlPoints.length;
  const { mPerDegLat, mPerDegLon } = metersPerDeg(lat0);

  // Build src (x,z) -> dst (east,north meters) pairs and accumulate normal equations
  // for u = [a, b, tx, ty]. Each point contributes two rows:
  //   [ px, -pz, 1, 0 ] . u = qe
  //   [ pz,  px, 0, 1 ] . u = qn
  const AtA = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const Atc = [0, 0, 0, 0];
  const rows = [];
  for (const p of controlPoints) {
    const qe = (p.lon - lon0) * mPerDegLon;
    const qn = (p.lat - lat0) * mPerDegLat;
    const r1 = [p.x, -p.z, 1, 0];
    const r2 = [p.z, p.x, 0, 1];
    rows.push([r1, qe], [r2, qn]);
  }
  for (const [row, val] of rows) {
    for (let i = 0; i < 4; i++) {
      Atc[i] += row[i] * val;
      for (let j = 0; j < 4; j++) AtA[i][j] += row[i] * row[j];
    }
  }
  const [a, b, tx, ty] = solve4(AtA, Atc);

  const g = {
    lat0, lon0, mPerDegLat, mPerDegLon,
    a, b, tx, ty,
    scale: Math.hypot(a, b),
    rotationDeg: (Math.atan2(b, a) / DEG),
    n: controlPoints.length,
    rms: 0,
  };
  // residual RMS in meters (0 for the exact 2-point case)
  let se = 0;
  for (const p of controlPoints) {
    const ll = localToLatLon(p.x, p.z, g);
    const de = (ll.lon - p.lon) * mPerDegLon;
    const dn = (ll.lat - p.lat) * mPerDegLat;
    se += de * de + dn * dn;
  }
  g.rms = Math.sqrt(se / controlPoints.length);
  return g;
}

/**
 * Map a building-local (x,z) point to lat/lon using a fitted Georef.
 * @returns {{lat:number, lon:number}}
 */
export function localToLatLon(x, z, g) {
  const east = g.a * x - g.b * z + g.tx;
  const north = g.b * x + g.a * z + g.ty;
  return {
    lat: g.lat0 + north / g.mPerDegLat,
    lon: g.lon0 + east / g.mPerDegLon,
  };
}

// ---------------------------------------------------------------------------
// Self-test: prove the round-trip (control points reproduce within ~1e-6).
// Run: `node web/pipeline/georef.js`  (or import { runSelfTest }).
export function runSelfTest() {
  const results = [];

  // Case 1: exact 2-point fit near CMU (rot+scale+translation).
  const cp2 = [
    { x: 0, z: 0, lat: 40.4433, lon: -79.9436 },
    { x: 27.364, z: -29.163, lat: 40.443038, lon: -79.943277 },
  ];
  const g2 = fitGeoreference(cp2);
  let maxErr2 = 0;
  for (const p of cp2) {
    const ll = localToLatLon(p.x, p.z, g2);
    maxErr2 = Math.max(maxErr2, Math.abs(ll.lat - p.lat), Math.abs(ll.lon - p.lon));
  }
  results.push({ name: "2-point round-trip", maxDegErr: maxErr2, scale: g2.scale, rotationDeg: g2.rotationDeg, rmsMeters: g2.rms });

  // Case 2: synthesize points from a KNOWN similarity, then recover it exactly.
  const trueScale = 0.87, trueRotDeg = 33.0;
  const c = trueScale * Math.cos(trueRotDeg * DEG), s = trueScale * Math.sin(trueRotDeg * DEG);
  const lat0 = 40.4433, lon0 = -79.9436;
  const { mPerDegLat, mPerDegLon } = metersPerDeg(lat0);
  const src = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 0, z: 10 }, { x: 15, z: -7 }];
  const cpN = src.map(({ x, z }) => {
    const east = c * x - s * z + 5, north = s * x + c * z - 3; // tx=5, ty=-3
    return { x, z, lat: lat0 + north / mPerDegLat, lon: lon0 + east / mPerDegLon };
  });
  const gN = fitGeoreference(cpN);
  let maxErrN = 0;
  for (const p of cpN) {
    const ll = localToLatLon(p.x, p.z, gN);
    maxErrN = Math.max(maxErrN, Math.abs(ll.lat - p.lat), Math.abs(ll.lon - p.lon));
  }
  results.push({
    name: "N-point exact-similarity recovery", maxDegErr: maxErrN,
    scaleRecovered: gN.scale, scaleTrue: trueScale,
    rotRecovered: gN.rotationDeg, rotTrue: trueRotDeg, rmsMeters: gN.rms,
  });

  // Primary gate (the contract): control points reproduce within ~1e-6 deg.
  // Recovered scale/rotation are a secondary sanity check with looser tolerance
  // (the synthetic lat/lon round through the equirectangular projection, so a
  // few 1e-8 of float accumulation is expected and harmless).
  const pass = maxErr2 < 1e-6 && maxErrN < 1e-6 &&
    Math.abs(gN.scale - trueScale) < 1e-4 && Math.abs(gN.rotationDeg - trueRotDeg) < 1e-4;
  return { pass, results };
}

// Run when executed directly as a node script (not when imported).
// import.meta.url is the module's own file:// URL; argv[1] is the invoked file.
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
