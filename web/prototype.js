// Interactive UI prototype for the Insid collector + wayfinder, in a browser.
// Owner: D. Purpose: iterate on the app's UX without an Xcode round-trip --
// everything here is meant to be ported to SwiftUI once the flow settles.
//
// It runs the REAL pipeline (buildings -> building-floors -> world-align ->
// graph -> routing) and fakes only the phone's sensors (compass, GPS, barometer,
// ARKit position), which the debug rail lets you drive by hand or simulate.
//
// The collector flow it prototypes:
//   start -> acquire GPS outside an entrance -> declare building + floor ->
//   face north -> record (declaring each building crossed) -> walk back out to
//   an entrance -> declare building + floor -> save
//
// Every one of those steps exists for a reason the pipeline depends on:
//   - the GPS gate gives each walk an absolute position (translation anchor)
//   - facing north gives it an absolute rotation
//   - building + floor declarations re-base the barometric floor ladder, which
//     can't be global because buildings differ in floor height and sit at
//     different grades
//   - the end fix bounds accumulated drift, and cross-checks the north gesture

import { loadWalks, loadNodes } from "./data-loader.js";
import { annotateFloors } from "./pipeline/floors.js";
import { buildGraph, route as routeGraph, splitOnTrackingLoss } from "./pipeline/graph.js";
import { loadBuildings, resolveBuilding, buildingsNear } from "./pipeline/buildings.js";
import { annotateBuildingFloors } from "./pipeline/building-floors.js";
import { refineGraph, snapToRefined, routeRefined } from "./pipeline/refine.js";
import { labelRefinedGraph, collectCustomNames } from "./pipeline/node-labels.js";
import * as WA from "./pipeline/world-align.js";

const NORTH_TOLERANCE_DEG = 12;
const GPS_GOOD_M = 8;    // green — good enough to anchor a walk
const GPS_FAIR_M = 15;   // amber — keep walking
const CAMPUS = { lat: 40.4433, lon: -79.9436 };
const SAMPLE_HZ = 10;

const S = {
  mode: "collector",
  stage: "home",
  source: "…",
  walks: [], nodes: [], nodesGeo: [], nodesById: {}, buildings: [],
  graph: null, refined: null, labels: null, customNames: {}, showRaw: true, campus: null, frameGeoref: null, floorLinks: [], floorHeights: {},
  sim: {
    heading: 137, x: 0, z: 0,
    buildingId: null, floor: 1, altitude: 0,
    gpsAccuracy: 24, seekingSignal: false, indoors: false,
    autoWalk: false, speed: 1.4, target: null,
    gpsJitter: { dx: 0, dz: 0 },
    trackingGlitch: 0,
  },
  rec: null,
  recordings: [],
  form: { query: "", selectedId: null, floor: 1 },  // building/floor declaration
  user: { startId: null, destId: null, result: null, query: "" },
  autoScript: null,
  log: [],
};

const $ = (sel) => document.querySelector(sel);
const screenEl = $("#screen");
const railEl = $("#rail");
const norm360 = (d) => ((d % 360) + 360) % 360;
const offNorth = (h) => { const d = norm360(h); return d > 180 ? d - 360 : d; };

function log(msg) {
  S.log.unshift(`${new Date().toLocaleTimeString().slice(0, 8)} ${msg}`);
  S.log = S.log.slice(0, 60);
}

// Standalone UI feedback for "something just happened" moments (a landmark
// drop, a crossing). Lives outside #screen in the DOM so a re-render never
// wipes it mid-animation; touches no app/recording state, purely cosmetic.
let toastTimer = null;
function toast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1300);
  navigator.vibrate?.(24);
}

// ---------------------------------------------------------------------------
// simulated building altitudes
// ---------------------------------------------------------------------------
// Buildings sit at different grades and have different floor heights — that's
// the whole reason floors can't be one global ladder — so the sim gives each a
// deterministic base altitude and floor height derived from its id.
function hashNum(s) {
  let h = 0;
  for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0;
  return Math.abs(h);
}
const baseAltOf = (id) => (id ? (hashNum(id) % 300) / 10 : 0);        // 0–30 m
const floorHeightOf = (id) => (id ? 3.6 + (hashNum(id) % 9) / 10 : 4.0); // 3.6–4.4 m

// ---------------------------------------------------------------------------
// data
// ---------------------------------------------------------------------------
async function loadAll() {
  const [walks, nodes, buildings] = await Promise.all([
    loadWalks().catch(() => []),
    loadNodes().catch(() => []),
    loadBuildings().catch(() => []),
  ]);
  S.buildings = buildings;
  S.nodes = nodes;
  S.campus = WA.makeCampusFrame(CAMPUS.lat, CAMPUS.lon);

  // Legacy walks live in an arbitrary ARKit frame. Estimate where that frame
  // sits on Earth, then re-express its points in the campus frame so old and
  // new recordings share one coordinate system.
  annotateFloors(walks);
  S.frameGeoref = WA.estimateFrameGeoref(walks);
  if (S.frameGeoref) {
    log(`legacy frame: ${S.frameGeoref.n} GPS fix(es), north ±${(S.frameGeoref.northSpreadDeg ?? 0).toFixed(0)}°`);
    S.walks = walks.map((w) => ({
      ...w,
      points: w.points.map((p) => {
        const ll = WA.localToLatLon(p.x, p.z, S.frameGeoref);
        const c = WA.latLonToLocal(ll.lat, ll.lon, S.campus);
        return { ...p, x: c.x, z: c.z };
      }),
    }));
  } else {
    S.walks = walks;
    log("no GPS on any walk — legacy paths left in their raw frame");
  }

  // Registry nodes ride along in the same frame.
  const nodeGeoref = S.frameGeoref || S.campus;
  S.nodesGeo = WA.nodesWithLatLon(nodes, nodeGeoref).map((n) => {
    const c = WA.latLonToLocal(n.lat, n.lon, S.campus);
    return { ...n, x: c.x, z: c.z };
  });
  S.nodesById = Object.fromEntries(S.nodesGeo.map((n) => [n.id, n]));

  rebuild();

  // stand the collector at a real building so the sim starts somewhere sensible
  const seed = S.buildings.find((b) => b.id === "wean-hall") || S.buildings[0];
  if (seed) {
    const c = WA.latLonToLocal(seed.lat, seed.lon, S.campus);
    S.sim.x = c.x; S.sim.z = c.z;
    S.sim.buildingId = null; // not declared until the collector says so
    S.sim.altitude = baseAltOf(seed.id) + 1 * floorHeightOf(seed.id);
  }

  S.source = `${S.walks.length} walks · ${S.nodes.length} nodes · ${S.buildings.length} buildings`;
  render();
}

function rebuild() {
  // Split on tracking loss BEFORE clustering, so a relocalization jump becomes
  // a gap instead of a fabricated corridor of synthetic nodes.
  const fragments = splitOnTrackingLoss(S.walks);
  const declared = fragments.filter((w) => w.startEntrance);
  const legacy = fragments.filter((w) => !w.startEntrance);
  const res = annotateBuildingFloors(declared, { buildings: S.buildings });
  S.floorLinks = res.floorLinks;
  S.floorHeights = res.floorHeights;
  if (legacy.length) annotateFloors(legacy);
  S.graph = buildGraph(fragments);
  // The wayfinder routes over the REFINED graph, not the raw trace cells —
  // see web/pipeline/refine.js for why.
  const customNames = S.refined ? collectCustomNames(S.refined) : (S.customNames || {});
  S.customNames = customNames;
  S.refined = refineGraph(S.graph);
  // Name them: building code + floor + which one ("WEH-4-J2"). Any name a
  // person gave a node is keyed by ref, so it survives this rebuild.
  S.labels = labelRefinedGraph(S.refined, { buildings: S.buildings, customNames });
}

function simGps() {
  if (!S.campus) return { lat: null, lon: null };
  const { x, z, gpsJitter } = S.sim;
  return WA.localToLatLon(x + gpsJitter.dx, z + gpsJitter.dz, S.campus);
}

const gpsQuality = () =>
  S.sim.gpsAccuracy <= GPS_GOOD_M ? "good" : S.sim.gpsAccuracy <= GPS_FAIR_M ? "fair" : "poor";

function nearbyNodes(k = 5) {
  const { lat, lon } = simGps();
  if (lat == null) return [];
  return WA.nearestNodesToLatLon(S.nodesGeo, lat, lon, { k });
}

const buildingName = (id) =>
  S.buildings.find((b) => b.id === id)?.name || id || "—";

// ---------------------------------------------------------------------------
// recording
// ---------------------------------------------------------------------------
function beginRecording() {
  const fix = simGps();
  S.sim.altitude = baseAltOf(S.sim.buildingId) + S.sim.floor * floorHeightOf(S.sim.buildingId);
  S.rec = {
    startedAt: performance.now(),
    baseAltitude: S.sim.altitude,
    startEntrance: {
      buildingId: S.sim.buildingId,
      buildingName: buildingName(S.sim.buildingId),
      floor: S.sim.floor,
      lat: fix.lat, lon: fix.lon, gpsAccuracy: S.sim.gpsAccuracy,
      t: 0,
    },
    buildingTransitions: [],
    landmarks: [],
    // Opportunistic fixes taken whenever signal is good mid-walk. GPS isn't
    // only available at the two endpoints — if the collector passes outside
    // between buildings, that moment anchors everything up to it, so ending
    // without an exit fix costs much less than it otherwise would.
    gpsFixes: [],
    endEntrance: null,
    points: [samplePoint(0)],
  };
  S.sim.indoors = true;   // signal starts decaying from here
  log(`recording started · ${buildingName(S.sim.buildingId)} floor ${S.sim.floor}`);
}

function samplePoint(t) {
  return {
    t,
    x: S.sim.x, y: S.sim.altitude, z: S.sim.z,
    relAltitude: S.sim.altitude - (S.rec ? S.rec.baseAltitude : S.sim.altitude),
    // a forced glitch marks points as untracked so the split can be demonstrated
    tracking: S.sim.trackingGlitch > 0 ? "notAvailable" : "normal",
  };
}

const GPS_FIX_INTERVAL_S = 4;

function recordSample() {
  if (!S.rec) return;
  const t = (performance.now() - S.rec.startedAt) / 1000;
  const last = S.rec.points[S.rec.points.length - 1];
  if (last && t - last.t < 1 / SAMPLE_HZ) return;
  S.rec.points.push(samplePoint(t));

  // bank a fix whenever the signal is good enough to be worth anything
  const fixes = S.rec.gpsFixes;
  const lastFix = fixes[fixes.length - 1];
  if (gpsQuality() === "good" && (!lastFix || t - lastFix.t >= GPS_FIX_INTERVAL_S)) {
    const g = simGps();
    fixes.push({ t, lat: g.lat, lon: g.lon, gpsAccuracy: S.sim.gpsAccuracy });
  }
}

// How well anchored the recording currently is, and what ending right now costs.
// ARKit drift runs roughly 1-2% of distance travelled; 1.5% is used as an
// estimate, clearly labelled as one in the UI.
const DRIFT_RATE = 0.015;
function exitFixStatus() {
  if (!S.rec) return null;
  const now = (performance.now() - S.rec.startedAt) / 1000;
  const fixes = S.rec.gpsFixes;
  const last = fixes.length ? fixes[fixes.length - 1] : null;
  const since = last
    ? pathLength(S.rec.points.filter((p) => p.t >= last.t))
    : pathLength(S.rec.points);
  return {
    lastFix: last,
    secondsAgo: last ? now - last.t : null,
    unanchoredM: since,
    estDriftM: since * DRIFT_RATE,
    totalM: pathLength(S.rec.points),
  };
}

// The collector crossed into a new building — usually because they saw signage.
// This re-bases the floor ladder: altitude is unchanged (you're at the same
// physical level) but the building and its floor NUMBER both change.
function declareTransition(buildingId, floor) {
  if (!S.rec) return;
  const t = (performance.now() - S.rec.startedAt) / 1000;
  S.rec.buildingTransitions.push({
    buildingId, buildingName: buildingName(buildingId), floor, t,
  });
  const wasBuilding = S.sim.buildingId, wasFloor = S.sim.floor;
  S.sim.buildingId = buildingId;
  S.sim.floor = floor;           // altitude deliberately NOT changed
  log(`crossed ${buildingName(wasBuilding)} ${wasFloor} → ${buildingName(buildingId)} ${floor}`);
}

function captureEndEntrance() {
  if (!S.rec) return;
  const fix = simGps();
  S.rec.endEntrance = {
    buildingId: S.sim.buildingId,
    buildingName: buildingName(S.sim.buildingId),
    floor: S.sim.floor,
    lat: fix.lat, lon: fix.lon, gpsAccuracy: S.sim.gpsAccuracy,
    t: (performance.now() - S.rec.startedAt) / 1000,
  };
}

function finishRecording(name) {
  if (!S.rec) return null;
  const walk = {
    schemaVersion: 5,
    id: `proto-${Date.now()}`,
    name: name || null,
    device: "prototype",
    recordedAt: new Date().toISOString(),
    unit: "meters", up: "y",
    northAligned: true, northOffsetDeg: 0,
    startHeading: { trueHeading: 0, accuracy: 3, calibrated: true },
    startEntrance: S.rec.startEntrance,
    buildingTransitions: S.rec.buildingTransitions,
    // null when the collector chose to stop without reaching an exit — the
    // walk is still saved, and placeWalkByEntrances falls back to the last
    // good mid-walk fix rather than discarding the path.
    endEntrance: S.rec.endEntrance,
    gpsFixes: S.rec.gpsFixes,
    landmarks: S.rec.landmarks,
    points: S.rec.points,
  };

  // Place it into the campus frame from its two entrance fixes, exactly as the
  // real pipeline would, so the drift correction is visible in the prototype.
  const placed = WA.placeWalkByEntrances(walk, S.campus);
  const finalWalk = placed.placed ? placed : walk;
  S.recordings.unshift(finalWalk);
  S.walks.push(finalWalk);
  rebuild();

  const p = placed.placement || {};
  const anchor = { endEntrance: "exit fix", gpsFix: "mid-walk fix only", none: "UNANCHORED" }[p.anchorEnd] || "—";
  log(`saved ${walk.id} · ${walk.points.length} pts · ${anchor}` +
      (p.residualM != null ? ` · drift ${p.residualM.toFixed(1)}m ${p.driftCorrected ? "corrected" : "UNCORRECTED"}` : ""));
  if (p.northCheckDeg != null) log(`north cross-check: off by ${p.northCheckDeg.toFixed(1)}°`);
  S.rec = null;
  return finalWalk;
}

function pathLength(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) {
    d += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  }
  return d;
}

// ---------------------------------------------------------------------------
// movement
// ---------------------------------------------------------------------------
function stepForward(meters) {
  const h = S.sim.heading * Math.PI / 180;
  S.sim.x += Math.sin(h) * meters;
  S.sim.z += -Math.cos(h) * meters;
}

function changeFloor(delta) {
  S.sim.floor += delta;
  S.sim.altitude += delta * floorHeightOf(S.sim.buildingId);
}

function graphNeighbors(key) {
  const out = [];
  if (!S.graph) return out;
  for (const e of S.graph.edges.values()) {
    if (e.a === key) out.push(S.graph.nodes.get(e.b));
    else if (e.b === key) out.push(S.graph.nodes.get(e.a));
  }
  return out.filter(Boolean);
}

function nearestGraphNode(x, z) {
  if (!S.graph) return null;
  let best = null, bestD = Infinity;
  for (const n of S.graph.nodes.values()) {
    const d = Math.hypot(n.x - x, n.z - z);
    if (d < bestD) { bestD = d; best = n; }
  }
  return best;
}

function autoWalkTick(dt) {
  if (!S.graph || !S.graph.nodes.size) { stepForward(S.sim.speed * dt); return; }
  if (!S.sim.target) {
    const here = nearestGraphNode(S.sim.x, S.sim.z);
    const opts = here ? graphNeighbors(here.key) : [];
    S.sim.target = opts.length
      ? opts[Math.floor(Math.random() * opts.length)]
      : [...S.graph.nodes.values()][Math.floor(Math.random() * S.graph.nodes.size)];
  }
  const t = S.sim.target;
  const dx = t.x - S.sim.x, dz = t.z - S.sim.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.4) {
    const opts = graphNeighbors(t.key);
    S.sim.target = opts.length ? opts[Math.floor(Math.random() * opts.length)] : null;
    return;
  }
  S.sim.heading = norm360(Math.atan2(dx, -dz) * 180 / Math.PI);
  const step = Math.min(dist, S.sim.speed * dt);
  S.sim.x += (dx / dist) * step;
  S.sim.z += (dz / dist) * step;
}

// ---------------------------------------------------------------------------
// main loop
// ---------------------------------------------------------------------------
let lastT = performance.now();
function tick(now) {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;

  if (S.sim.autoWalk) autoWalkTick(dt);
  if (S.sim.trackingGlitch > 0) S.sim.trackingGlitch -= dt;

  // Signal follows where the collector is: it recovers within seconds of
  // stepping outside and decays once they're inside. Without the decay the
  // prototype would bank a usable fix the whole way through a building, which
  // is the opposite of what actually happens.
  if (S.sim.seekingSignal) {
    S.sim.gpsAccuracy = Math.max(3.5, S.sim.gpsAccuracy - dt * 6);
    if (S.sim.gpsAccuracy <= 4) { S.sim.seekingSignal = false; S.sim.indoors = false; }
  } else if (S.sim.indoors) {
    S.sim.gpsAccuracy = Math.min(28, S.sim.gpsAccuracy + dt * 3);
  }

  const j = S.sim.gpsJitter;
  j.dx += (Math.random() - 0.5) * dt * 2;
  j.dz += (Math.random() - 0.5) * dt * 2;
  const jm = Math.hypot(j.dx, j.dz), cap = S.sim.gpsAccuracy * 0.5;
  if (jm > cap) { j.dx *= cap / jm; j.dz *= cap / jm; }

  if (S.rec) recordSample();
  if (S.autoScript) S.autoScript(dt);

  redrawLive();
  requestAnimationFrame(tick);
}

function redrawLive() {
  const map = $("#map");
  if (map) drawMap(map);
  const comp = $("#compass");
  if (comp) drawCompass(comp);

  const hr = $("#heading-read");
  if (hr) {
    const off = offNorth(S.sim.heading);
    const ok = Math.abs(off) <= NORTH_TOLERANCE_DEG;
    hr.textContent = `${Math.round(norm360(S.sim.heading))}°`;
    hr.style.color = ok ? "var(--cyan)" : "var(--paper)";
    const hint = $("#heading-hint");
    if (hint) {
      hint.className = "heading-hint" + (ok ? " ok" : "");
      hint.textContent = ok
        ? "✓ Facing north — confirm to continue."
        : `Turn ${off > 0 ? "left" : "right"} ${Math.abs(Math.round(off))}° to face north.`;
    }
    const btn = $("#confirm-north");
    if (btn) btn.disabled = !ok;
  }

  // GPS gate screens
  const ring = $("#sig-ring");
  if (ring) {
    const q = gpsQuality();
    ring.className = "sig-ring " + q;
    const label = $("#sig-label");
    if (label) {
      label.textContent = { good: "Good signal", fair: "Fair — keep walking", poor: "Poor signal" }[q];
      label.className = "sig-label " + q;
    }
    const acc = $("#sig-acc");
    if (acc) acc.textContent = `±${S.sim.gpsAccuracy.toFixed(1)} m`;
    const go = $("#sig-continue");
    if (go) go.disabled = q !== "good";
  }

  // live anchor state — so the collector knows before they're standing at the
  // finish button, not only once they press it
  const ap = $("#anchor-pill");
  if (ap && S.rec) {
    const st = exitFixStatus();
    const good = st.lastFix && st.unanchoredM < 30;
    ap.textContent = st.lastFix
      ? `anchored ${Math.round(st.secondsAgo)}s ago`
      : "no anchor yet";
    ap.className = "pill " + (good ? "pill--cyan" : "pill--amber");
  }

  for (const [id, val] of Object.entries(liveReadouts())) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }
  const hs = document.getElementById("r-heading");
  if (hs) hs.value = String(Math.round(norm360(S.sim.heading)));
  const gs = document.getElementById("r-gps");
  if (gs && document.activeElement !== gs) gs.value = String(Math.round(S.sim.gpsAccuracy));
}

function liveReadouts() {
  const out = {};
  if (S.rec) {
    out["st-pts"] = S.rec.points.length;
    out["st-dist"] = `${pathLength(S.rec.points).toFixed(0)} m`;
    out["st-time"] = `${((performance.now() - S.rec.startedAt) / 1000).toFixed(0)} s`;
    out["st-bldg"] = `${buildingName(S.sim.buildingId).split(" ")[0]} ${S.sim.floor}`;
  }
  const g = simGps();
  out["dbg-pos"] = `${S.sim.x.toFixed(1)}, ${S.sim.z.toFixed(1)}`;
  out["dbg-gps"] = g.lat == null ? "—" : `${g.lat.toFixed(5)}, ${g.lon.toFixed(5)}`;
  out["dbg-heading"] = `${Math.round(norm360(S.sim.heading))}°`;
  out["dbg-alt"] = `${S.sim.altitude.toFixed(1)} m`;
  out["dbg-where"] = `${buildingName(S.sim.buildingId)} · F${S.sim.floor}`;
  out["lbl-gps"] = `GPS accuracy · ±${Math.round(S.sim.gpsAccuracy)}m`;
  out["lbl-speed"] = `Speed · ${S.sim.speed.toFixed(1)} m/s`;
  return out;
}

// ---------------------------------------------------------------------------
// canvas: top-down map
// ---------------------------------------------------------------------------
// Canvas can't read the CSS tokens, so the two typefaces it needs are named
// once here. Colours stay literal below but track prototype.html's palette.
const MONO = "'IBM Plex Mono', ui-monospace, monospace";
const MAP_FONT = "400 9px " + MONO;
function drawMap(canvas) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = canvas.clientWidth, h = +canvas.dataset.h || 240;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.height = h + "px";
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#050a10";
  ctx.fillRect(0, 0, w, h);

  // follow the collector at a fixed scale — a campus-wide fit would be useless
  const scale = +canvas.dataset.scale || 3.2;
  const px = (x) => (x - S.sim.x) * scale + w / 2;
  const py = (z) => (z - S.sim.z) * scale + h / 2;

  // nearby building footprint markers
  if (S.buildings.length && S.campus) {
    ctx.font = MAP_FONT;
    for (const b of S.buildings) {
      const c = WA.latLonToLocal(b.lat, b.lon, S.campus);
      const sx = px(c.x), sy = py(c.z);
      if (sx < -40 || sy < -40 || sx > w + 40 || sy > h + 40) continue;
      ctx.fillStyle = b.id === S.sim.buildingId ? "rgba(245,169,59,0.9)" : "rgba(233,241,244,0.30)";
      ctx.beginPath(); ctx.arc(sx, sy, 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillText(b.name.split(" ")[0], sx + 5, sy + 3);
    }
  }

  // raw trace cells, faint — evidence, not structure
  if (S.graph && S.showRaw) {
    ctx.strokeStyle = "rgba(233, 241, 244, 0.09)";
    ctx.lineWidth = 1;
    for (const e of S.graph.edges.values()) {
      const a = S.graph.nodes.get(e.a), b = S.graph.nodes.get(e.b);
      if (!a || !b) continue;
      ctx.beginPath(); ctx.moveTo(px(a.x), py(a.z)); ctx.lineTo(px(b.x), py(b.z)); ctx.stroke();
    }
  }
  // the refined graph, drawn as the real map: thickness follows evidence
  if (S.refined) {
    for (const e of S.refined.edges.values()) {
      ctx.strokeStyle = e.vertical ? "rgba(245,169,59,0.85)" : "rgba(47,226,204,0.75)";
      ctx.lineWidth = Math.min(4, 1.2 + Math.log2(1 + e.evidence) * 0.5);
      ctx.beginPath();
      e.polyline.forEach((p, i) => (i ? ctx.lineTo(px(p.x), py(p.z)) : ctx.moveTo(px(p.x), py(p.z))));
      ctx.stroke();
    }
    ctx.font = MAP_FONT;
    for (const n of S.refined.nodes.values()) {
      if (n.kind === "corridor") continue;
      const sx = px(n.x), sy = py(n.z);
      ctx.fillStyle = n.kind === "junction" ? "#e9f1f4" : n.kind === "portal" ? "#f5a93b" : "rgba(47,226,204,0.65)";
      ctx.beginPath(); ctx.arc(sx, sy, n.kind === "junction" ? 3.4 : 2.6, 0, Math.PI * 2); ctx.fill();
      // labels only near the viewer, or the map turns into a wall of text
      if (n.ref && Math.hypot(n.x - S.sim.x, n.z - S.sim.z) < 30) {
        ctx.fillStyle = n.customName ? "#2fe2cc" : "rgba(233,241,244,0.45)";
        ctx.fillText(n.customName || n.ref, sx + 5, sy - 4);
      }
    }
  }

  const r = S.user.result;
  if (r && r.polyline && r.polyline.length > 1) {
    ctx.strokeStyle = "#e9f1f4"; ctx.lineWidth = 3;
    ctx.beginPath();
    r.polyline.forEach((p, i) => (i ? ctx.lineTo(px(p.x), py(p.z)) : ctx.moveTo(px(p.x), py(p.z))));
    ctx.stroke();
    // where the endpoints snapped ONTO the refined graph
    for (const s of [r.snapFrom, r.snapTo]) {
      if (!s) continue;
      ctx.strokeStyle = "rgba(47,226,204,0.9)"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(px(s.point.x), py(s.point.z), 5, 0, Math.PI * 2); ctx.stroke();
    }
  }

  if (S.rec && S.rec.points.length > 1) {
    ctx.strokeStyle = "#2fe2cc"; ctx.lineWidth = 2;
    ctx.beginPath();
    S.rec.points.forEach((p, i) => (i ? ctx.lineTo(px(p.x), py(p.z)) : ctx.moveTo(px(p.x), py(p.z))));
    ctx.stroke();
    for (const tr of S.rec.buildingTransitions) {
      const pt = S.rec.points.find((p) => p.t >= tr.t);
      if (!pt) continue;
      ctx.strokeStyle = "#f5a93b"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px(pt.x), py(pt.z), 6, 0, Math.PI * 2); ctx.stroke();
    }
    for (const lm of S.rec.landmarks) {
      ctx.fillStyle = "#f5a93b";
      ctx.beginPath(); ctx.arc(px(lm.x), py(lm.z), 3.5, 0, Math.PI * 2); ctx.fill();
    }
  }

  // GPS accuracy halo — drawn only where the fix is the thing being decided.
  const gpsR = S.sim.gpsAccuracy * scale;
  if (gpsR > 2 && (S.stage === "gps" || S.stage === "endGate")) {
    const q = gpsQuality();
    ctx.fillStyle = q === "good" ? "rgba(47,226,204,0.07)" : "rgba(245,169,59,0.06)";
    ctx.strokeStyle = q === "good" ? "rgba(47,226,204,0.32)" : "rgba(245,169,59,0.28)";
    ctx.beginPath();
    ctx.arc(px(S.sim.x + S.sim.gpsJitter.dx), py(S.sim.z + S.sim.gpsJitter.dz), gpsR, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
  }

  const ax = px(S.sim.x), az = py(S.sim.z);
  const hr = S.sim.heading * Math.PI / 180;
  ctx.fillStyle = "rgba(47, 226, 204, 0.22)";
  ctx.beginPath();
  ctx.moveTo(ax, az);
  ctx.arc(ax, az, 22, hr - Math.PI / 2 - 0.35, hr - Math.PI / 2 + 0.35);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#2fe2cc";
  ctx.beginPath(); ctx.arc(ax, az, 4.5, 0, Math.PI * 2); ctx.fill();
}

// ---------------------------------------------------------------------------
// canvas: compass
// ---------------------------------------------------------------------------
function drawCompass(canvas) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const size = 210;
  if (canvas.width !== size * dpr) {
    canvas.width = canvas.height = size * dpr;
    canvas.style.width = canvas.style.height = size + "px";
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  const c = size / 2, R = c - 16;
  const off = offNorth(S.sim.heading);
  const ok = Math.abs(off) <= NORTH_TOLERANCE_DEG;

  ctx.save();
  ctx.translate(c, c);
  ctx.rotate(-S.sim.heading * Math.PI / 180);
  const tol = NORTH_TOLERANCE_DEG * Math.PI / 180;
  ctx.fillStyle = ok ? "rgba(47,226,204,0.16)" : "rgba(245,169,59,0.12)";
  ctx.beginPath(); ctx.moveTo(0, 0);
  ctx.arc(0, 0, R, -Math.PI / 2 - tol, -Math.PI / 2 + tol);
  ctx.closePath(); ctx.fill();

  ctx.strokeStyle = "rgba(233,241,244,0.18)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();
  for (let d = 0; d < 360; d += 15) {
    const a = (d - 90) * Math.PI / 180;
    const major = d % 45 === 0;
    const r1 = R * (major ? 0.86 : 0.93);
    ctx.strokeStyle = major ? "rgba(233,241,244,0.5)" : "rgba(233,241,244,0.16)";
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
    ctx.lineTo(Math.cos(a) * R, Math.sin(a) * R);
    ctx.stroke();
  }
  ctx.font = "500 13px " + MONO;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  [["N", 0], ["E", 90], ["S", 180], ["W", 270]].forEach(([letter, d]) => {
    const a = (d - 90) * Math.PI / 180;
    ctx.fillStyle = letter === "N" ? (ok ? "#2fe2cc" : "#f5a93b") : "rgba(233,241,244,0.42)";
    ctx.fillText(letter, Math.cos(a) * R * 0.72, Math.sin(a) * R * 0.72);
  });
  ctx.restore();

  ctx.fillStyle = ok ? "#2fe2cc" : "#e9f1f4";
  ctx.beginPath();
  ctx.moveTo(c, 9); ctx.lineTo(c - 7, 24); ctx.lineTo(c + 7, 24);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = "rgba(233,241,244,0.40)";
  ctx.font = "500 9px " + MONO;
  ctx.fillText("PHONE", c, 36);
}

function wireCompassDrag(canvas) {
  let dragging = false, lastAngle = 0;
  const angleAt = (e) => {
    const r = canvas.getBoundingClientRect();
    return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2));
  };
  canvas.addEventListener("pointerdown", (e) => {
    dragging = true; lastAngle = angleAt(e); canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const a = angleAt(e);
    S.sim.heading = norm360(S.sim.heading - (a - lastAngle) * 180 / Math.PI);
    lastAngle = a;
  });
  canvas.addEventListener("pointerup", () => { dragging = false; });
}

// ---------------------------------------------------------------------------
// shared UI fragments
// ---------------------------------------------------------------------------
// Every screen is built from the same three slots — nav / body / actions — so
// the furniture never moves between steps. That consistency is most of what
// "clean" means here; the type and colour scale in prototype.html does the
// rest. Two rules worth keeping when porting to SwiftUI:
//   - one primary button per screen, and it's the only filled thing on it.
//     Back and escape hatches are quiet text, not slabs.
//   - display font for headings and numerals, sans for sentences, mono for
//     machine facts (units, refs, state). Never mix the jobs.
const logo = (cls = "") =>
  `<svg class="${cls}" viewBox="0 0 24 24" role="img" aria-label="Insid"><use href="#logo-mark"/></svg>`;

const nav = (label, back) => `
  <div class="nav">
    ${back ? `<button class="nav-back" data-back="${back}" aria-label="Back">&#8592;</button>` : ""}
    <span class="nav-label">${label}</span>
  </div>`;

function signalBlock(hint) {
  return `
    <div class="sig">
      <div class="sig-ring poor" id="sig-ring"><div class="sig-core"></div></div>
      <div class="sig-acc" id="sig-acc">—</div>
      <div class="sig-label poor" id="sig-label">—</div>
      <div class="t-body" style="text-align:center;max-width:236px">${hint}</div>
    </div>`;
}

// Building declaration: type a name, confirm from ranked candidates, set floor.
// The floor stepper sits below the scrolling list rather than inside it, so it
// stays reachable however long the list gets.
function buildingForm(promptText) {
  const fix = simGps();
  const list = S.form.query.trim()
    ? resolveBuilding(S.form.query, S.buildings, { lat: fix.lat, lon: fix.lon, limit: 5 })
    : buildingsNear(S.buildings, fix.lat, fix.lon, { limit: 5 });
  return `
    <p class="t-body">${promptText}</p>
    <input id="bq" class="input" type="text" placeholder="Search buildings…"
      value="${S.form.query.replace(/"/g, "&quot;")}" style="margin-top:12px"/>
    <div class="scroll" style="margin-top:10px">
      ${list.length ? list.map((b) => `
        <button class="card ${S.form.selectedId === b.id ? "sel" : ""}" data-bid="${b.id}">
          ${b.distanceM != null ? `<span class="dist">${b.distanceM.toFixed(0)} m</span>` : ""}
          <div class="nm">${b.name}</div>
          <div class="meta">${b.nameScore ? `match ${(b.nameScore * 100).toFixed(0)}%` : "nearby"}${b.levels ? ` · ${b.levels} levels` : ""}</div>
        </button>`).join("")
        : `<p class="t-body">No match. Try fewer letters.</p>`}
    </div>
    <div class="floor-row">
      <span>Floor you'll be on</span>
      <div class="stepper">
        <button data-fl="-1" aria-label="Floor down">&minus;</button>
        <b id="floor-val">${S.form.floor}</b>
        <button data-fl="1" aria-label="Floor up">+</button>
      </div>
    </div>`;
}

function wireBuildingForm(onPick) {
  const q = $("#bq");
  if (q) {
    q.oninput = (e) => { S.form.query = e.target.value; S.form.selectedId = null; render(); $("#bq")?.focus(); };
  }
  document.querySelectorAll("[data-bid]").forEach((b) => {
    b.onclick = () => { S.form.selectedId = b.dataset.bid; render(); };
  });
  document.querySelectorAll("[data-fl]").forEach((b) => {
    b.onclick = () => { S.form.floor += +b.dataset.fl; render(); };
  });
  const go = $("#form-go");
  if (go) go.onclick = () => onPick(S.form.selectedId, S.form.floor);
}

// ---------------------------------------------------------------------------
// screens
// ---------------------------------------------------------------------------
const screens = {
  // The one screen both sides of the app open on. It is the collector start
  // screen's layout — mark, line, stats, two actions — with the wordmark
  // swapped for the mark itself, and the mode chosen here instead of in
  // desktop chrome the phone doesn't have.
  home: () => ({
    label: "Insid · Home",
    html: `
      <div class="body">
        <div class="spacer"></div>
        <div class="hero">
          ${logo("hero-mark")}
          <p class="hero-line">Walk a building once. Everyone who follows gets the route.</p>
        </div>
        <div class="spacer"></div>
        <div class="stats">
          <div class="stat"><b>${S.walks.length}</b><span>Walks</span></div>
          <div class="stat"><b>${S.buildings.length}</b><span>Buildings</span></div>
          <div class="stat"><b>${S.refined ? S.refined.nodes.size : 0}</b><span>Places</span></div>
        </div>
        <div class="spacer"></div>
      </div>
      <div class="actions">
        <button class="choice" id="to-nav">
          <span>
            <span class="big">I need to go to&hellip;</span>
            <span class="sub">Search a room, get the indoor route</span>
          </span>
          <span class="arrow">&#8594;</span>
        </button>
        <button class="choice choice--quiet" id="to-collect">
          <span>
            <span class="big">I want to contribute</span>
            <span class="sub">Map a building by walking it</span>
          </span>
          <span class="arrow">&#8594;</span>
        </button>
      </div>`,
    wire: () => {
      $("#to-nav").onclick = () => {
        S.mode = "user";
        S.user = { startId: null, destId: null, result: null, query: "" };
        syncModeButtons();
        go("dest");
      };
      $("#to-collect").onclick = () => {
        S.mode = "collector";
        syncModeButtons();
        go("start");
      };
    },
  }),

  // The collector brief: what the job actually is, then one switch to begin.
  // Everything a collector has to understand lives here, so the four steps
  // that follow can each ask for exactly one thing.
  start: () => ({
    label: "Collector · Brief",
    html: `
      ${nav("Contribute", "home")}
      <div class="body">
        <h2 class="t-display">What you'll be doing</h2>
        <div class="brief">
          <p>
            Step outside the door you're about to use and wait for a <b>clean GPS
            fix</b> — that's what pins your walk to the campus map. Name the
            <b>building and floor</b>, then <b>face north</b>, so the app knows
            which way your path points.
          </p>
          <p>
            Then just <b>walk it</b>, normally, the way you would anyway. Tap a
            marker as you pass a <b>door, staircase, elevator or room</b>, and tell
            the app when you cross into another building. Finish at an
            <b>outside door</b> so both ends are anchored.
          </p>
          <p>
            One walk, about five minutes. Everyone who needs that route
            afterwards gets it from you.
          </p>
        </div>
        <div class="stats">
          <div class="stat"><b>${S.recordings.length}</b><span>Yours</span></div>
          <div class="stat"><b>${S.walks.length}</b><span>Walks</span></div>
          <div class="stat"><b>~5 min</b><span>Per walk</span></div>
        </div>
        <div class="spacer"></div>
        <div class="go-center">
          <button class="go go--lg" id="go" aria-label="Start collection">START</button>
          <span class="cap">Start collection</span>
        </div>
        <div class="spacer"></div>
      </div>
      <div class="actions">
        <button class="btn btn--quiet" id="recs">Recordings &middot; ${S.recordings.length}</button>
      </div>`,
    wire: () => {
      $("#go").onclick = () => {
        S.sim.gpsAccuracy = 24; S.sim.seekingSignal = false;
        S.form = { query: "", selectedId: null, floor: 1 };
        go("gps");
      };
      $("#recs").onclick = () => go("recordings");
    },
  }),

  gps: () => ({
    label: "Collector · GPS lock",
    html: `
      ${nav("Collector · GPS lock", "start")}
      <div class="body">
        <h2 class="t-display">Step outside</h2>
        <p class="note">Stand just outside the entrance you're about to use — indoors the fix is too poor to anchor a path.</p>
        ${signalBlock("Walk out until the reading settles below 8 m.")}
        <canvas id="map" class="map" data-h="130" data-scale="1.6"></canvas>
      </div>
      <div class="actions">
        <button class="btn btn--primary" id="sig-continue" disabled>Continue</button>
        <button class="btn btn--quiet" id="outside">Simulate stepping outside</button>
      </div>`,
    wire: () => {
      $("#outside").onclick = () => { S.sim.seekingSignal = true; log("walking outside for signal…"); };
      $("#sig-continue").onclick = () => go("entrance");
    },
  }),

  entrance: () => ({
    label: "Collector · Entrance",
    html: `
      ${nav("Collector · Entrance", "gps")}
      <div class="body">
        <h2 class="t-display">Which building?</h2>
        ${buildingForm("You're at its entrance. Pick the building you're about to enter, and the floor you'll walk in on.")}
      </div>
      <div class="actions">
        <button class="btn btn--primary" id="form-go" ${S.form.selectedId ? "" : "disabled"}>Confirm entrance</button>
      </div>`,
    wire: () => {
      wireBuildingForm((id, floor) => {
        S.sim.buildingId = id;
        S.sim.floor = floor;
        log(`entrance: ${buildingName(id)} floor ${floor}`);
        go("north");
      });
    },
  }),

  north: () => ({
    label: "Collector · North",
    html: `
      ${nav("Collector · North", "entrance")}
      <div class="body">
        <h2 class="t-display">Face north</h2>
        <p class="note">Turn until the marker lines up with N — this fixes the path's rotation, since the compass alone is off by 15–25° indoors.</p>
        <div class="compass-wrap">
          <canvas id="compass" class="compass"></canvas>
          <div class="heading-read" id="heading-read">—</div>
          <div class="heading-hint" id="heading-hint"></div>
        </div>
      </div>
      <div class="actions">
        <button class="btn btn--primary" id="confirm-north" disabled>Confirm facing north</button>
      </div>`,
    wire: () => {
      wireCompassDrag($("#compass"));
      $("#confirm-north").onclick = () => {
        log(`north confirmed (off by ${Math.round(offNorth(S.sim.heading))}°)`);
        S.sim.heading = 0;
        go("ready");
      };
    },
  }),

  ready: () => ({
    label: "Collector · Ready",
    html: `
      ${nav("Collector · Ready")}
      <div class="body">
        <div class="spacer"></div>
        <h2 class="t-display" style="text-align:center">You're set</h2>
        <p class="t-body" style="text-align:center;margin-top:6px">Walk. Tell the app when you cross into a new building.</p>
        <div class="spacer"></div>
        <div class="summary">
          <div class="kv"><span>Entrance</span><b>${buildingName(S.sim.buildingId)}</b></div>
          <div class="kv"><span>Floor</span><b>${S.sim.floor}</b></div>
          <div class="kv"><span>GPS</span><b class="${gpsQuality() === "good" ? "ok" : "warn"}">±${S.sim.gpsAccuracy.toFixed(1)} m</b></div>
          <div class="kv"><span>North</span><b class="ok">calibrated</b></div>
        </div>
        <div class="spacer"></div>
      </div>
      <div class="actions">
        <button class="btn btn--primary" id="rec">Start recording</button>
      </div>`,
    wire: () => {
      $("#rec").onclick = () => { beginRecording(); go("live"); };
    },
  }),

  live: () => ({
    label: "Collector · Recording",
    html: `
      ${nav("Collector · Recording")}
      <div class="body">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <span class="pill pill--rec"><span class="dot"></span>Rec</span>
          <span class="pill">${buildingName(S.sim.buildingId)} · F${S.sim.floor}</span>
          <span class="pill" id="anchor-pill">—</span>
        </div>
        <div class="stats">
          <div class="stat"><b id="st-pts">0</b><span>Points</span></div>
          <div class="stat"><b id="st-dist">0 m</b><span>Dist</span></div>
          <div class="stat"><b id="st-time">0 s</b><span>Time</span></div>
          <div class="stat"><b id="st-bldg">—</b><span>Where</span></div>
        </div>
        <div class="map-wrap">
          <canvas id="map" class="map" data-h="340" data-scale="3.2"></canvas>
          <div class="map-overlay">
            <div style="display:flex;gap:6px">
              ${["Door", "Stairs", "Elevator", "Room"].map((l) =>
                `<button class="chip" data-lm="${l}">${l}</button>`).join("")}
            </div>
            <button class="chip chip--wide" id="cross">New building</button>
          </div>
        </div>
        ${S.rec?.buildingTransitions.length ? `
          <div class="label">Crossings</div>
          ${S.rec.buildingTransitions.map((t) =>
            `<div class="crossing">${t.buildingName} · floor ${t.floor}<span>${t.t.toFixed(0)} s</span></div>`).join("")}` : ""}
      </div>
      <div class="actions">
        <button class="btn btn--danger" id="finish">Finish at an entrance</button>
      </div>`,
    wire: () => {
      $("#cross").onclick = () => {
        S.form = { query: "", selectedId: null, floor: S.sim.floor };
        go("transition");
      };
      document.querySelectorAll("[data-lm]").forEach((b) => {
        b.onclick = () => {
          S.rec.landmarks.push({ name: b.dataset.lm, x: S.sim.x, z: S.sim.z, floor: S.sim.floor });
          log(`landmark: ${b.dataset.lm}`);
          toast(`${b.dataset.lm} added`);
          render();
        };
      });
      // Already outside with a solid fix? Skip the nagging and go confirm the
      // entrance. Otherwise explain what stopping here actually costs.
      $("#finish").onclick = () => {
        if (gpsQuality() === "good") {
          S.form = { query: "", selectedId: S.sim.buildingId, floor: S.sim.floor };
          go("endEntrance");
        } else {
          go("exitPrompt");
        }
      };
    },
  }),

  // Soft gate: never blocks saving (that would throw away real walking), but
  // states the cost in meters rather than waving at "accuracy".
  exitPrompt: () => {
    const st = exitFixStatus() || { unanchoredM: 0, estDriftM: 0, secondsAgo: null, totalM: 0 };
    const hasFix = !!st.lastFix;
    return {
      label: "Collector · Finish?",
      html: `
        ${nav("Collector · Finish?", "live")}
        <div class="body">
          <div class="spacer"></div>
          <div class="sheet">
            <h2 class="t-title" style="text-align:center">Finish outside if you can</h2>
            <p class="t-body" style="text-align:center;margin-top:8px">
              ${hasFix
                ? `Your last good GPS fix was <b style="color:var(--paper);font-weight:500">${Math.round(st.secondsAgo)}s ago</b>.
                   Everything up to there is anchored — the
                   <b style="color:var(--amber);font-weight:500">${st.unanchoredM.toFixed(0)} m</b> since then isn't.`
                : `Nothing has anchored this path since you started it.
                   You've walked <b style="color:var(--amber);font-weight:500">${st.totalM.toFixed(0)} m</b>.`}
            </p>
            <div class="cost">
              <div class="kv"><span>Unanchored so far</span><b>${st.unanchoredM.toFixed(0)} m</b></div>
              <div class="kv"><span>Est. error at the end</span><b class="warn">≈ ${st.estDriftM.toFixed(1)} m</b></div>
              <div class="kv"><span>Fixable later?</span><b class="bad">No</b></div>
            </div>
            <p class="note note--warn">
              Stepping outside for a few seconds pins the end of the path and
              spreads the correction back over the whole walk. It can't be
              recovered afterwards.
            </p>
            <div class="stack">
              <button class="btn btn--primary" id="go-out">Take me outside — keep recording</button>
              <button class="btn btn--quiet" id="save-anyway">Save without an exit fix</button>
            </div>
          </div>
        </div>`,
      wire: () => {
        $("#go-out").onclick = () => { S.sim.gpsAccuracy = 24; go("endGate"); };
        $("#save-anyway").onclick = () => {
          log(`finishing without an exit fix · ~${st.estDriftM.toFixed(1)}m unanchored`);
          go("finish");
        };
      },
    };
  },

  transition: () => ({
    label: "Collector · Crossing",
    html: `
      ${nav("Collector · Crossing", "live")}
      <div class="body">
        <h2 class="t-display">New building</h2>
        ${buildingForm(`Leaving ${buildingName(S.sim.buildingId)} (floor ${S.sim.floor}). Check the signage — which building is this, and what floor does it call this level?`)}
        <p class="note">
          Floors don't line up between buildings — a connector can put you on
          floor 4 of one and floor 2 of the next. That's why it asks.
        </p>
      </div>
      <div class="actions">
        <button class="btn btn--primary" id="form-go" ${S.form.selectedId ? "" : "disabled"}>Confirm crossing</button>
      </div>`,
    wire: () => {
      wireBuildingForm((id, floor) => {
        declareTransition(id, floor);
        toast(`Entered ${buildingName(id)} · F${floor}`);
        go("live");
      });
    },
  }),

  endGate: () => ({
    label: "Collector · Finish outside",
    html: `
      ${nav("Collector · Finish outside", "live")}
      <div class="body">
        <h2 class="t-display">Head outside</h2>
        <p class="note">Finish at a building entrance so the path gets a second GPS anchor — that's what bounds the drift.</p>
        ${signalBlock("Still recording. Walk out until the reading settles.")}
        <canvas id="map" class="map" data-h="126" data-scale="2.4"></canvas>
      </div>
      <div class="actions">
        <button class="btn btn--primary" id="sig-continue" disabled>I'm at an entrance</button>
        <button class="btn btn--quiet" id="outside">Simulate stepping outside</button>
        <div class="row">
          <button class="btn btn--quiet" id="keep">Keep walking</button>
          <button class="btn btn--quiet" id="give-up">Save anyway</button>
        </div>
      </div>`,
    wire: () => {
      $("#outside").onclick = () => { S.sim.seekingSignal = true; };
      $("#sig-continue").onclick = () => {
        S.form = { query: "", selectedId: S.sim.buildingId, floor: S.sim.floor };
        go("endEntrance");
      };
      $("#keep").onclick = () => go("live");
      // Outside but the signal still won't lock — tall buildings do exactly
      // this. A dead end here would be worse than a weaker anchor.
      $("#give-up").onclick = () => { log("finished without a usable exit fix"); go("finish"); };
    },
  }),

  endEntrance: () => ({
    label: "Collector · End entrance",
    html: `
      ${nav("Collector · End entrance", "endGate")}
      <div class="body">
        <h2 class="t-display">Which entrance?</h2>
        ${buildingForm("Confirm the building you just walked out of, and the floor that entrance is on.")}
      </div>
      <div class="actions">
        <button class="btn btn--primary" id="form-go" ${S.form.selectedId ? "" : "disabled"}>Confirm &amp; finish</button>
      </div>`,
    wire: () => {
      wireBuildingForm((id, floor) => {
        S.sim.buildingId = id; S.sim.floor = floor;
        captureEndEntrance();       // this is what makes the walk fully anchored
        go("finish");
      });
    },
  }),

  finish: () => {
    const pts = S.rec ? S.rec.points.length : 0;
    const dist = S.rec ? pathLength(S.rec.points) : 0;
    const crossings = S.rec ? S.rec.buildingTransitions : [];
    return {
      label: "Collector · Save",
      html: `
        ${nav("Collector · Save")}
        <div class="body">
          <h2 class="t-display">Path complete</h2>
          <div class="stats">
            <div class="stat"><b>${pts}</b><span>Points</span></div>
            <div class="stat"><b>${dist.toFixed(0)} m</b><span>Dist</span></div>
            <div class="stat"><b>${crossings.length + 1}</b><span>Buildings</span></div>
          </div>
          <div class="label">Path name</div>
          <input id="nm" class="input" type="text" placeholder="e.g. Wean 4 → Doherty tunnel"/>
          <div class="summary" style="margin-top:12px">
            <div class="kv"><span>Started</span><b>${S.rec ? S.rec.startEntrance.buildingName + " · F" + S.rec.startEntrance.floor : "—"}</b></div>
            ${crossings.map((c) => `<div class="kv"><span>Crossed into</span><b>${c.buildingName} · F${c.floor}</b></div>`).join("")}
            <div class="kv"><span>Ended</span><b>${buildingName(S.sim.buildingId)} · F${S.sim.floor}</b></div>
            ${S.rec?.endEntrance
              ? `<div class="kv"><span>Exit fix</span><b class="ok">±${S.rec.endEntrance.gpsAccuracy.toFixed(1)} m</b></div>`
              : `<div class="kv"><span>Exit fix</span><b class="warn">${
                   S.rec?.gpsFixes.length ? "last mid-walk fix" : "unanchored end"}</b></div>`}
          </div>
          ${!S.rec?.endEntrance ? `<p class="note note--warn">
            Saving without an exit fix. The path is still kept and still useful —
            it just can't have its end drift corrected.
          </p>` : ""}
          <div class="spacer"></div>
        </div>
        <div class="actions">
          <button class="btn btn--primary" id="save">Save &amp; upload</button>
          <button class="btn btn--quiet" id="discard">Discard</button>
        </div>`,
      wire: () => {
        $("#save").onclick = () => { finishRecording($("#nm").value.trim()); go("start"); };
        $("#discard").onclick = () => { S.rec = null; log("recording discarded"); go("start"); };
      },
    };
  },

  recordings: () => ({
    label: "Collector · Recordings",
    html: `
      ${nav("Collector · Recordings", "start")}
      <div class="body">
        <h2 class="t-display">Recordings</h2>
        <p class="t-body" style="margin-bottom:12px">${S.recordings.length} captured this session.</p>
        <div class="scroll">
          ${S.recordings.length ? S.recordings.map((w) => {
            const p = w.placement || {};
            const anchor = { endEntrance: "anchored both ends", gpsFix: "mid-walk fix only", none: "end unanchored" }[p.anchorEnd] || "not placed";
            return `<div class="card card--static">
              <div class="nm">${w.name || w.id}</div>
              <div class="meta">${w.points.length} pts · ${pathLength(w.points).toFixed(0)} m ·
                ${(w.buildingTransitions?.length || 0) + 1} buildings</div>
              <div class="meta" style="color:${p.anchorEnd === "endEntrance" ? "var(--cyan)" : "var(--amber)"}">${anchor}</div>
              <div class="meta">${p.residualM != null
                ? `drift ${p.residualM.toFixed(1)} m ${p.driftCorrected ? "corrected" : "not corrected"}`
                : "no closure fix"}${p.northCheckDeg != null ? ` · north off ${p.northCheckDeg.toFixed(0)}°` : ""}</div>
            </div>`;
          }).join("")
            : `<p class="t-body">Nothing yet — record a path, or use “simulate a full run” in the debug rail.</p>`}
        </div>
      </div>`,
    wire: () => {},
  }),

  // ---- user (wayfinder) ----
  dest: () => {
    // Destinations come from the LABELLED REFINED graph, not the raw registry:
    // those are the places with names a person can read ("WEH 4 · Junction 2")
    // rather than grid cells named after their own coordinates.
    const here = { x: S.sim.x, y: S.sim.altitude, z: S.sim.z };
    const all = [...(S.refined?.nodes.values() || [])]
      .filter((n) => n.kind !== "corridor")
      .map((n) => ({ ...n, distanceM: Math.hypot(n.x - here.x, n.z - here.z) }))
      .sort((a, b) => a.distanceM - b.distanceM);

    // Search beats scrolling: with a query the nearest-60 window is dropped,
    // because the room someone typed may well be the furthest one on campus.
    const q = S.user.query.trim();
    const places = q ? all.filter((n) => matchesPlace(n, q)) : all.slice(0, 60);
    const snap = S.refined ? snapToRefined(S.refined, here) : null;

    // group by level so a long list stays readable
    const groups = new Map();
    for (const p of places) {
      const key = `${p.code ?? "UNK"} ${p.floor ?? 0}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }

    const picked = places.find((n) => n.id === S.user.destId);

    return {
      label: "Wayfinder · Destination",
      html: `
        ${nav("Insid · Wayfinder", "home")}
        <div class="body">
          <h2 class="t-display">Where to?</h2>
          <p class="t-body" style="margin-top:4px">${snap
            ? `On ${snap.edge.name || "the map"}, ${snap.distanceM.toFixed(1)} m from the line`
            : "Not on the map yet"}</p>
          <canvas id="map" class="map" data-h="118" data-scale="3" style="margin-top:12px"></canvas>
          <div class="label">${q ? `Matches &middot; ${places.length}` : "Nearest places"}</div>
          <div class="scroll">
            ${!all.length
              ? `<p class="t-body">No map yet — record a path in Collector mode first.</p>`
              : places.length ? [...groups].map(([level, list]) => `
              <div class="levelhead">${level}</div>
              ${list.map((n) => `
                <button class="card ${S.user.destId === n.id ? "sel" : ""}" data-id="${n.id}">
                  <span class="dist">${n.distanceM.toFixed(0)} m</span>
                  <div class="nm">${n.name}</div>
                  <div class="meta">${n.ref}${n.customName ? " · named" : ""} · ${n.kind}</div>
                </button>`).join("")}`).join("")
              : `<p class="t-body">Nothing matches &ldquo;${escapeHtml(q)}&rdquo;. Try fewer letters, or a room number.</p>`}
          </div>
        </div>
        <div class="actions">
          <div class="prompt-hint">${picked
            ? `Going to <b>${picked.name}</b>`
            : q ? "Pick a match, or press enter for the first" : "Type a room, floor or building"}</div>
          <div class="prompt">
            <input id="dq" class="input" type="text" autocomplete="off"
              placeholder="Search destinations…"
              value="${S.user.query.replace(/"/g, "&quot;")}"/>
            <button class="go" id="go" ${S.user.destId ? "" : "disabled"} aria-label="Navigate">GO</button>
          </div>
        </div>`,
      wire: () => {
        const start = (id) => {
          const to = S.refined?.nodes.get(id);
          S.user.startId = null;
          // Route over the refined graph, snapping onto an EDGE rather than the
          // nearest raw cell — junctions are sparse by design.
          S.user.result = to && S.refined ? routeRefined(S.refined, here, to) : null;
          const res = S.user.result;
          log(res
            ? `route to ${to.name}: ${res.lengthM.toFixed(0)}m · snapped ${res.snapFrom.distanceM.toFixed(1)}m onto ${res.snapFrom.edge.ref || "the map"}`
            : "no route found");
          go("route");
        };

        document.querySelectorAll(".card[data-id]").forEach((b) => {
          b.onclick = () => { S.user.destId = b.dataset.id; render(); };
        });

        const input = $("#dq");
        input.oninput = (e) => {
          S.user.query = e.target.value;
          // A narrowed query that no longer matches the pick shouldn't leave GO
          // armed for it. Checked against the new query, not the list that was
          // on screen a keystroke ago.
          const q2 = S.user.query.trim();
          const kept = S.refined?.nodes.get(S.user.destId);
          if (q2 && kept && !matchesPlace(kept, q2)) S.user.destId = null;
          render();
          const f = $("#dq");
          if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
        };
        // Enter behaves like the circle: commit the pick, or the top match.
        input.onkeydown = (e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          const id = S.user.destId || places[0]?.id;
          if (id) { S.user.destId = id; start(id); }
        };

        $("#go").onclick = () => start(S.user.destId);
      },
    };
  },

  route: () => {
    const r = S.user.result;
    const to = S.refined?.nodes.get(S.user.destId);
    const from = r?.snapFrom?.edge;
    const floors = r ? [...new Set(r.nodes.map((n) => n.floorKey ?? n.floor))] : [];
    return {
      label: "Wayfinder · Route",
      html: `
        ${nav("Wayfinder · Route", "dest")}
        <div class="body">
          <h2 class="t-display">${to ? to.name : "Route"}</h2>
          <p class="t-mono" style="margin-top:2px">${to ? to.ref : ""}${from ? ` · from ${from.name || from.ref || "the map"}` : ""}</p>
          ${r ? `
            <div class="stats">
              <div class="stat"><b>${r.lengthM.toFixed(0)} m</b><span>Dist</span></div>
              <div class="stat"><b>${Math.max(1, Math.round(r.lengthM / 1.3 / 60))} min</b><span>Walk</span></div>
              <div class="stat"><b>${floors.length}</b><span>Levels</span></div>
            </div>
            <canvas id="map" class="map" data-h="260" data-scale="3"></canvas>
            <div class="label">Steps</div>
            <div class="scroll">
              ${routeSteps(r).map((s, i) => `
                <div class="step">
                  <span class="n">${i + 1}</span>
                  <span class="txt">${s.text}</span>
                  <span class="d">${s.dist.toFixed(0)} m</span>
                </div>`).join("")}
            </div>`
          : `<p class="note note--warn">No route — nobody has walked a path connecting those yet.</p><div class="spacer"></div>`}
        </div>
        <div class="actions">
          <button class="btn btn--quiet" id="back">Pick another destination</button>
        </div>`,
      wire: () => {
        const again = () => { S.user.result = null; go("dest"); };
        $("#back").onclick = again;
        const nb = document.querySelector(".nav-back");
        if (nb) nb.onclick = again;
      },
    };
  },
};

const escapeHtml = (t) => String(t).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Destination search. Every word typed has to appear somewhere in the place —
// its name, its ref, its building code, its kind — so "weh 4 stair" narrows
// across all four at once and word order doesn't matter.
function matchesPlace(n, query) {
  const hay = [n.name, n.ref, n.code, n.kind, n.customName, n.floor != null ? `floor ${n.floor}` : ""]
    .filter(Boolean).join(" ").toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

// Directions come from the REFINED nodes, which is the payoff of refining at
// all: its nodes are junctions and portals — the things worth mentioning —
// rather than a few hundred grid cells nobody would name.
function routeSteps(r) {
  const steps = [];
  if (!r.nodes.length) return [{ text: "Head straight there", dist: r.lengthM }];

  let runDist = 0;
  let cur = r.nodes[0];
  let curKey = cur.floorKey ?? String(cur.floor);

  for (let i = 1; i < r.nodes.length; i++) {
    const a = r.nodes[i - 1], b = r.nodes[i];
    runDist += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    const key = b.floorKey ?? String(b.floor);

    if (key !== curKey) {
      const sameBuilding = a.buildingId && b.buildingId && a.buildingId === b.buildingId;
      steps.push({
        text: sameBuilding
          ? `Follow the corridor, then take the stairs to floor ${b.floor}`
          : `Follow the corridor through into ${buildingName(b.buildingId)} (floor ${b.floor})`,
        dist: runDist,
      });
      runDist = 0; curKey = key;
    } else if (b.kind === "junction" && runDist > 8) {
      steps.push({ text: "Continue to the junction", dist: runDist });
      runDist = 0;
    }
  }
  if (runDist > 0.5) steps.push({ text: "Continue to your destination", dist: runDist });
  return steps.length ? steps : [{ text: "You're basically there", dist: r.lengthM }];
}

// The stage lives in the URL hash, so prototype.html#north opens straight to
// that step. Iterating on one screen shouldn't mean clicking through four.
function go(stage) {
  S.stage = stage;
  if (location.hash.slice(1) !== stage) history.replaceState(null, "", "#" + stage);
  render();
}

// ---------------------------------------------------------------------------
// debug rail
// ---------------------------------------------------------------------------
function railHtml() {
  const maxEdge = S.graph ? Math.max(0, ...[...S.graph.edges.values()].map((e) => e.weight)) : 0;
  const g = S.frameGeoref || {};
  return `
    <h3>DATA</h3>
    <div class="kv"><span>source</span><b>${S.source}</b></div>
    <div class="kv"><span>raw cells (evidence)</span><b>${S.graph ? S.graph.nodes.size : 0} / ${S.graph ? S.graph.edges.size : 0}</b></div>
    <div class="kv"><span>refined map</span><b>${S.refined ? S.refined.nodes.size : 0} / ${S.refined ? S.refined.edges.size : 0}</b></div>
    <div class="kv"><span>reduction</span><b>${
      S.refined && S.graph && S.refined.nodes.size
        ? (S.graph.nodes.size / S.refined.nodes.size).toFixed(1) + "×" : "—"}</b></div>
    <div class="kv"><span>labelled nodes</span><b>${S.labels ? S.labels.labelled : 0}</b></div>
    ${S.labels && Object.keys(S.labels.byLevel).length ? Object.entries(S.labels.byLevel).slice(0, 6).map(([lvl, n]) =>
      `<div class="kv"><span style="padding-left:8px">${lvl}</span><b>${n} nodes</b></div>`).join("") : ""}
    <div class="kv"><span>junctions / portals</span><b>${
      S.refined ? [...S.refined.nodes.values()].filter((n) => n.kind === "junction").length : 0} / ${
      S.refined ? [...S.refined.nodes.values()].filter((n) => n.kind === "portal").length : 0}</b></div>
    <div class="kv"><span>longest raw edge</span><b>${maxEdge.toFixed(2)} m</b></div>
    <button id="b-showraw" class="${S.showRaw ? "on" : ""}">${S.showRaw ? "◼ Hide raw trace cells" : "▢ Show raw trace cells"}</button>
    <div class="kv"><span>legacy north spread</span><b>${g.northSpreadDeg != null ? "±" + g.northSpreadDeg.toFixed(0) + "°" : "—"}</b></div>
    ${Object.keys(S.floorHeights).length ? `
      <div class="kv"><span>learned floor heights</span><b></b></div>
      ${Object.entries(S.floorHeights).map(([id, v]) =>
        `<div class="kv"><span style="padding-left:8px">${id}</span><b>${v.heightM.toFixed(2)} m ×${v.samples}</b></div>`).join("")}` : ""}
    ${S.floorLinks.length ? `
      <div class="kv"><span>cross-building links</span><b></b></div>
      ${S.floorLinks.slice(0, 6).map((l) =>
        `<div class="kv"><span style="padding-left:8px">${l.from.buildingId.split("-")[0]} ${l.from.floor}</span><b>→ ${l.to.buildingId.split("-")[0]} ${l.to.floor}</b></div>`).join("")}` : ""}

    <h3>SENSORS</h3>
    <div class="kv"><span>where</span><b id="dbg-where">—</b></div>
    <div class="kv"><span>altitude</span><b id="dbg-alt">—</b></div>
    <div class="kv"><span>position (x, z)</span><b id="dbg-pos">—</b></div>
    <div class="kv"><span>gps reading</span><b id="dbg-gps">—</b></div>
    <label>Compass heading · <b id="dbg-heading">—</b></label>
    <input type="range" id="r-heading" min="0" max="359" value="${Math.round(norm360(S.sim.heading))}"/>
    <div class="grid2">
      <button id="b-north">Snap to north</button>
      <button id="b-rand-head">Randomize</button>
    </div>
    <label id="lbl-gps">GPS accuracy · ±${Math.round(S.sim.gpsAccuracy)}m</label>
    <input type="range" id="r-gps" min="3" max="40" value="${Math.round(S.sim.gpsAccuracy)}"/>
    <div class="grid2">
      <button id="b-gps-good">Force good</button>
      <button id="b-gps-poor">Force poor</button>
    </div>

    <h3>FLOOR / BUILDING</h3>
    <div class="grid2">
      <button id="b-fl-down">▼ floor −1</button>
      <button id="b-fl-up">▲ floor +1</button>
    </div>
    <div class="sub" style="font-size:10.5px;margin-top:6px">
      Changing floors moves altitude by this building's floor height
      (${floorHeightOf(S.sim.buildingId).toFixed(2)}m).
    </div>

    <h3>MOVEMENT</h3>
    <button id="b-auto" class="${S.sim.autoWalk ? "on" : ""}">${S.sim.autoWalk ? "◼ Stop auto-walk" : "▶ Simulate walking randomly"}</button>
    <label id="lbl-speed">Speed · ${S.sim.speed.toFixed(1)} m/s</label>
    <input type="range" id="r-speed" min="0.4" max="6" step="0.1" value="${S.sim.speed}"/>
    <div class="dpad">
      <div class="blank"></div><button id="b-fwd">▲</button><div class="blank"></div>
      <button id="b-left">◀ turn</button><button id="b-back">▼</button><button id="b-right">turn ▶</button>
    </div>

    <h3>SCENARIOS</h3>
    <button id="b-fullrun" class="${S.autoScript ? "on" : ""}">${S.autoScript ? "◼ Stop simulated run" : "▶ Simulate a full collection run"}</button>
    <button id="b-addpath">＋ Add random path to the graph</button>
    <button id="b-glitch">Inject a tracking dropout</button>
    <button id="b-reset">↺ Reset session</button>

    <h3>SESSION</h3>
    <div class="kv"><span>recordings</span><b>${S.recordings.length}</b></div>
    <div class="kv"><span>walks in graph</span><b>${S.walks.length}</b></div>
    <div class="kv"><span>recording</span><b>${S.rec ? S.rec.points.length + " pts" : "idle"}</b></div>
    <div class="log">${S.log.map((l) => `<div>${l}</div>`).join("")}</div>`;
}

function wireRail() {
  const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el[ev] = fn; };
  on("r-heading", "oninput", (e) => { S.sim.heading = +e.target.value; });
  on("b-north", "onclick", () => { S.sim.heading = 0; });
  on("b-rand-head", "onclick", () => { S.sim.heading = Math.random() * 360; });
  on("r-gps", "oninput", (e) => { S.sim.gpsAccuracy = +e.target.value; S.sim.seekingSignal = false; S.sim.indoors = false; });
  on("b-gps-good", "onclick", () => { S.sim.gpsAccuracy = 4; S.sim.seekingSignal = false; S.sim.indoors = false; });
  on("b-gps-poor", "onclick", () => { S.sim.gpsAccuracy = 28; S.sim.seekingSignal = false; S.sim.indoors = true; });
  on("b-fl-up", "onclick", () => { changeFloor(1); render(); });
  on("b-fl-down", "onclick", () => { changeFloor(-1); render(); });
  on("r-speed", "oninput", (e) => { S.sim.speed = +e.target.value; });
  on("b-auto", "onclick", () => { S.sim.autoWalk = !S.sim.autoWalk; S.sim.target = null; syncRail(); });
  on("b-fwd", "onclick", () => stepForward(1));
  on("b-back", "onclick", () => stepForward(-1));
  on("b-left", "onclick", () => { S.sim.heading = norm360(S.sim.heading - 15); });
  on("b-right", "onclick", () => { S.sim.heading = norm360(S.sim.heading + 15); });
  on("b-showraw", "onclick", () => { S.showRaw = !S.showRaw; syncRail(); });
  on("b-addpath", "onclick", addRandomPath);
  on("b-glitch", "onclick", () => {
    S.sim.trackingGlitch = 0.6;
    S.sim.x += 40; S.sim.z += 12;   // relocalization jump
    log("tracking dropout + 42m jump injected");
  });
  on("b-fullrun", "onclick", () => (S.autoScript ? stopFullRun() : startFullRun()));
  on("b-reset", "onclick", () => {
    S.recordings = []; S.rec = null; S.autoScript = null; S.sim.autoWalk = false;
    S.user = { startId: null, destId: null, result: null, query: "" };
    log("session reset"); go("home");
  });
}

function syncRail() { railEl.innerHTML = railHtml(); wireRail(); }

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------
function addRandomPath() {
  if (!S.graph || !S.graph.nodes.size) { log("no graph to walk"); return; }
  const keys = [...S.graph.nodes.values()];
  let cur = keys[Math.floor(Math.random() * keys.length)];
  const points = [];
  let t = 0;
  for (let i = 0; i < 50; i++) {
    const nbrs = graphNeighbors(cur.key);
    if (!nbrs.length) break;
    const next = nbrs[Math.floor(Math.random() * nbrs.length)];
    const segs = Math.max(2, Math.round(Math.hypot(next.x - cur.x, next.z - cur.z) / 0.3));
    for (let s = 0; s < segs; s++) {
      const f = s / segs;
      points.push({
        t: (t += 0.1),
        x: cur.x + (next.x - cur.x) * f + (Math.random() - 0.5) * 0.15,
        y: cur.y + (next.y - cur.y) * f,
        z: cur.z + (next.z - cur.z) * f + (Math.random() - 0.5) * 0.15,
        relAltitude: cur.y + (next.y - cur.y) * f,
        tracking: "normal",
      });
    }
    cur = next;
  }
  if (points.length < 2) { log("random path too short"); return; }
  S.walks.push({
    schemaVersion: 5, id: `rand-${Date.now()}`, device: "synthetic",
    recordedAt: new Date().toISOString(), unit: "meters", up: "y",
    northAligned: true, northOffsetDeg: 0, points,
  });
  rebuild();
  log(`added random path · ${points.length} pts`);
  render();
}

// Drive the whole collector flow hands-free, including a mid-walk building
// crossing — the fastest way to see the flow end to end after a UI change.
function startFullRun() {
  // The run drives collector stages directly, so the mode has to follow or
  // render() bounces every one of them back to the wayfinder.
  S.mode = "collector";
  syncModeButtons();
  let phase = "gps", elapsed = 0;
  S.sim.gpsAccuracy = 26;
  S.sim.seekingSignal = true;
  S.sim.heading = Math.random() * 360;
  S.form = { query: "", selectedId: null, floor: 1 };
  go("gps");
  log("simulated run: walking outside for signal…");

  S.autoScript = (dt) => {
    elapsed += dt;
    if (phase === "gps") {
      if (gpsQuality() === "good") {
        phase = "entrance"; elapsed = 0;
        const fix = simGps();
        const near = buildingsNear(S.buildings, fix.lat, fix.lon, { limit: 5 });
        S.form.selectedId = near[0]?.id || S.buildings[0]?.id;
        S.form.floor = 1 + Math.floor(Math.random() * 3);
        go("entrance");
      }
    } else if (phase === "entrance") {
      if (elapsed > 0.8) {
        S.sim.buildingId = S.form.selectedId;
        S.sim.floor = S.form.floor;
        log(`simulated run: entering ${buildingName(S.sim.buildingId)} F${S.sim.floor}`);
        phase = "north"; elapsed = 0;
        go("north");
      }
    } else if (phase === "north") {
      const off = offNorth(S.sim.heading);
      S.sim.heading = norm360(S.sim.heading - Math.sign(off) * Math.min(Math.abs(off), 110 * dt));
      if (Math.abs(offNorth(S.sim.heading)) <= NORTH_TOLERANCE_DEG) {
        S.sim.heading = 0; phase = "ready"; elapsed = 0;
        go("ready");
      }
    } else if (phase === "ready") {
      if (elapsed > 0.7) {
        beginRecording();
        S.sim.autoWalk = true; S.sim.target = null;
        phase = "walkA"; elapsed = 0;
        go("live");
      }
    } else if (phase === "walkA") {
      if (elapsed > 9) {
        // cross into a different nearby building, on an unrelated floor
        const fix = simGps();
        const near = buildingsNear(S.buildings, fix.lat, fix.lon, { limit: 6 })
          .filter((b) => b.id !== S.sim.buildingId);
        const pick = near[Math.floor(Math.random() * Math.min(3, near.length))];
        if (pick) declareTransition(pick.id, 1 + Math.floor(Math.random() * 4));
        phase = "walkB"; elapsed = 0;
        go("live");
      }
    } else if (phase === "walkB") {
      if (elapsed > 9) {
        S.sim.autoWalk = false;
        S.sim.gpsAccuracy = 26; S.sim.seekingSignal = true;
        phase = "endGate"; elapsed = 0;
        go("endGate");
      }
    } else if (phase === "endGate") {
      if (gpsQuality() === "good") {
        S.form = { query: "", selectedId: S.sim.buildingId, floor: S.sim.floor };
        captureEndEntrance();
        phase = "save"; elapsed = 0;
        go("finish");
      }
    } else if (phase === "save") {
      if (elapsed > 1.2) {
        finishRecording(`Simulated run ${S.recordings.length + 1}`);
        S.autoScript = null;
        go("start");
        syncRail();
      }
    }
  };
  syncRail();
}

function stopFullRun() {
  S.autoScript = null; S.sim.autoWalk = false;
  log("simulated run stopped");
  syncRail();
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------
function render() {
  // home belongs to neither mode — it is where the mode gets chosen — so it
  // is the one stage neither bounce may touch.
  if (S.stage !== "home") {
    if (S.mode === "user" && !["dest", "route"].includes(S.stage)) S.stage = "dest";
    if (S.mode === "collector" && ["dest", "route"].includes(S.stage)) S.stage = "start";
  }
  const scr = (screens[S.stage] || screens.start)();
  $("#stage-label").textContent = scr.label;
  screenEl.innerHTML = scr.html;
  // Back is declared in markup (data-back) and wired once, before the screen's
  // own wiring — so a screen that needs to do more on the way out can simply
  // rebind .nav-back instead of every screen hand-rolling a back button.
  document.querySelectorAll("[data-back]").forEach((b) => {
    b.onclick = () => go(b.dataset.back);
  });
  scr.wire?.();
  $("#src").innerHTML =
    `<b>${S.walks.length}</b> walks · <b>${S.buildings.length}</b> buildings · <b>${S.graph ? S.graph.nodes.size : 0}</b> nodes`;
  syncRail();
}

// The desktop segmented control is a shortcut past the landing screen, for
// iterating on one side without clicking through it. The phone picks its mode
// on home instead, which is why both go through syncModeButtons().
function syncModeButtons() {
  document.querySelectorAll(".seg button").forEach((b) =>
    b.classList.toggle("on", b.dataset.mode === S.mode));
}

document.querySelectorAll(".seg button").forEach((b) => {
  b.onclick = () => {
    S.mode = b.dataset.mode;
    syncModeButtons();
    S.stage = S.mode === "user" ? "dest" : "start";
    render();
  };
});

addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  const map = {
    ArrowUp: () => stepForward(0.6),
    ArrowDown: () => stepForward(-0.6),
    ArrowLeft: () => { S.sim.heading = norm360(S.sim.heading - 6); },
    ArrowRight: () => { S.sim.heading = norm360(S.sim.heading + 6); },
  };
  if (map[e.key]) { e.preventDefault(); map[e.key](); }
});

// Honour a deep link on load; the mode has to follow, or render() bounces the
// stage back to that mode's first screen.
const deepLink = location.hash.slice(1);
if (screens[deepLink]) {
  S.stage = deepLink;
  S.mode = ["dest", "route"].includes(deepLink) ? "user" : "collector";
  syncModeButtons();
}

render();
requestAnimationFrame(tick);
loadAll();
