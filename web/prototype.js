// Interactive UI prototype for the Insid collector + wayfinder, in a browser.
// Owner: D. Purpose: iterate on the app's UX without an Xcode round-trip --
// everything here is meant to be ported to SwiftUI once the flow settles.
//
// It runs the REAL pipeline (data-loader -> floors -> graph -> routing) against
// real data, and fakes only the phone's sensors (compass, GPS, ARKit position),
// which the debug rail lets you drive by hand or simulate.
//
// Two flows it prototypes that the iOS app does NOT do yet:
//   1. North calibration -- the collector faces north before walking, so every
//      path starts at a known heading instead of an arbitrary one.
//   2. Location-scoped start-node picking -- rough GPS narrows 60+ registry
//      nodes down to the ~5 you could plausibly be standing on.

import { loadWalks, loadNodes } from "./data-loader.js";
import { annotateFloors } from "./pipeline/floors.js";
import { buildGraph, route as routeGraph } from "./pipeline/graph.js";
import * as WA from "./pipeline/world-align.js";

const NORTH_TOLERANCE_DEG = 12; // how close to north counts as "facing north"
const WALK_SPEED = 1.4;         // m/s
const SAMPLE_HZ = 10;

const S = {
  mode: "collector",
  stage: "start",
  internalMode: true,
  source: "…",
  walks: [], nodes: [], nodesGeo: [], nodesById: {}, graph: null, georef: null,
  sim: {
    heading: 137, x: 0, z: 0, floor: 0,
    gpsAccuracy: 9, autoWalk: false, speed: WALK_SPEED,
    target: null, gpsJitter: { dx: 0, dz: 0 },
  },
  rec: null,          // { points, startedAt, startNodeId, landmarks, northAligned, startHeading }
  recordings: [],
  pick: { selectedId: null, showAll: false },
  user: { startId: null, destId: null, result: null },
  autoScript: null,   // running end-to-end simulation
  log: [],
};

const $ = (sel) => document.querySelector(sel);
const screenEl = $("#screen");
const railEl = $("#rail");

function log(msg) {
  S.log.unshift(`${new Date().toLocaleTimeString().slice(0, 8)} ${msg}`);
  S.log = S.log.slice(0, 60);
}

// ---------------------------------------------------------------------------
// data
// ---------------------------------------------------------------------------
async function loadAll() {
  const [walks, nodes] = await Promise.all([
    loadWalks().catch(() => []),
    loadNodes().catch(() => []),
  ]);
  S.walks = walks;
  S.nodes = nodes;
  annotateFloors(S.walks);
  rebuild();

  // Derive a rough Earth anchor for the whole frame from whatever walks carry
  // a GPS fix. Supabase currently drops startLatLon (no column for it), so this
  // usually only finds fixes when reading the local web/data/*.json files.
  S.georef = WA.estimateFrameGeoref(S.walks);
  if (!S.georef) {
    // No GPS anywhere in the data: fall back to a nominal campus origin so the
    // location-scoped picker is still demonstrable. Clearly flagged in the rail.
    S.georef = {
      lat0: 40.44254, lon0: -79.94472, northOffsetDeg: 0,
      ...WA.metersPerDeg(40.44254), n: 0, accuracyM: 25, northSpreadDeg: null,
      synthetic: true,
    };
    log("no GPS in data — using a nominal campus origin");
  } else {
    log(`georef from ${S.georef.n} GPS fix(es), ±${S.georef.accuracyM.toFixed(1)}m`);
  }
  S.nodesGeo = WA.nodesWithLatLon(S.nodes, S.georef);
  S.nodesById = Object.fromEntries(S.nodesGeo.map((n) => [n.id, n]));

  // stand the avatar on a real node so the sim starts somewhere sensible
  const first = S.nodesGeo[0];
  if (first) { S.sim.x = first.x; S.sim.z = first.z; S.sim.floor = first.floor || 0; }

  S.source = S.walks.length
    ? `${S.walks.length} walks · ${S.nodes.length} nodes`
    : "no data";
  render();
}

function rebuild() {
  S.graph = buildGraph(S.walks);
}

// current simulated GPS reading (true position + a wander that mimics drift).
// Returns nulls until the georeference is resolved, since the render loop
// starts before loadAll() finishes.
function simGps() {
  if (!S.georef) return { lat: null, lon: null };
  const { x, z, gpsJitter } = S.sim;
  return WA.localToLatLon(x + gpsJitter.dx, z + gpsJitter.dz, S.georef);
}

function nearbyNodes(k = 5) {
  const { lat, lon } = simGps();
  if (lat == null) return [];
  return WA.nearestNodesToLatLon(S.nodesGeo, lat, lon, { k });
}

// ---------------------------------------------------------------------------
// recording
// ---------------------------------------------------------------------------
function beginRecording(startNodeId) {
  const node = S.nodesById[startNodeId];
  if (node) { S.sim.x = node.x; S.sim.z = node.z; S.sim.floor = node.floor || 0; }
  S.rec = {
    points: [{ t: 0, x: S.sim.x, y: floorAltitude(S.sim.floor), z: S.sim.z, floor: S.sim.floor, tracking: "normal" }],
    startedAt: performance.now(),
    startNodeId: startNodeId || null,
    landmarks: [],
    northAligned: true,
    startHeading: { trueHeading: 0, accuracy: 3, calibrated: true },
    startLatLon: { ...simGps(), gpsAccuracy: S.sim.gpsAccuracy },
  };
  log(`recording started at ${startNodeId || "(no node)"}`);
}

function recordSample() {
  if (!S.rec) return;
  const t = (performance.now() - S.rec.startedAt) / 1000;
  const last = S.rec.points[S.rec.points.length - 1];
  if (last && t - last.t < 1 / SAMPLE_HZ) return;
  S.rec.points.push({
    t, x: S.sim.x, y: floorAltitude(S.sim.floor), z: S.sim.z,
    floor: S.sim.floor, tracking: "normal",
  });
}

function finishRecording(name) {
  if (!S.rec) return null;
  const walk = {
    schemaVersion: 4,
    id: `proto-${Date.now()}`,
    name: name || null,
    device: "prototype",
    recordedAt: new Date().toISOString(),
    unit: "meters", up: "y",
    startAnchorId: S.rec.startNodeId || "prototype",
    startNodeId: S.rec.startNodeId,
    // The whole point of the calibration step: no rotation has to be estimated
    // downstream. The sim's frame is north-referenced, so its points really are
    // aligned and the offset is 0. On a real device the frame is fixed at
    // SESSION start, so the recorder stores the camera yaw captured at the
    // confirmation tap here instead — see docs/path-schema.md §North calibration.
    northAligned: true,
    northOffsetDeg: 0,
    startHeading: S.rec.startHeading,
    startLatLon: S.rec.startLatLon,
    landmarks: S.rec.landmarks,
    points: S.rec.points,
  };
  S.recordings.unshift(walk);
  S.walks.push(walk);
  annotateFloors(S.walks);
  rebuild();
  log(`saved ${walk.id} · ${walk.points.length} pts · ${pathLength(walk.points).toFixed(0)}m`);
  S.rec = null;
  return walk;
}

const floorAltitude = (f) => f * 4.0;
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

function graphNeighbors(key) {
  const out = [];
  if (!S.graph) return out;
  for (const e of S.graph.edges.values()) {
    if (e.a === key) out.push(S.graph.nodes.get(e.b));
    else if (e.b === key) out.push(S.graph.nodes.get(e.a));
  }
  return out.filter(Boolean);
}

function nearestGraphKey(x, z, floor) {
  if (!S.graph) return null;
  let best = null, bestD = Infinity;
  for (const n of S.graph.nodes.values()) {
    if (floor != null && n.floor !== floor) continue;
    const d = Math.hypot(n.x - x, n.z - z);
    if (d < bestD) { bestD = d; best = n; }
  }
  return best;
}

// Auto-walk follows real graph edges (so simulated paths look like corridors,
// not random drift), turning the heading toward each successive node.
function autoWalkTick(dt) {
  if (!S.graph || !S.graph.nodes.size) return;
  if (!S.sim.target) {
    const here = nearestGraphKey(S.sim.x, S.sim.z, null);
    const opts = here ? graphNeighbors(here.key) : [];
    S.sim.target = opts.length
      ? opts[Math.floor(Math.random() * opts.length)]
      : [...S.graph.nodes.values()][Math.floor(Math.random() * S.graph.nodes.size)];
  }
  const t = S.sim.target;
  const dx = t.x - S.sim.x, dz = t.z - S.sim.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.35) {
    S.sim.floor = t.floor;
    const opts = graphNeighbors(t.key);
    S.sim.target = opts.length ? opts[Math.floor(Math.random() * opts.length)] : null;
    return;
  }
  S.sim.heading = norm360(Math.atan2(dx, -dz) * 180 / Math.PI);
  const step = Math.min(dist, S.sim.speed * dt);
  S.sim.x += (dx / dist) * step;
  S.sim.z += (dz / dist) * step;
}

const norm360 = (d) => ((d % 360) + 360) % 360;
// signed difference from north, in [-180, 180]
const offNorth = (h) => { const d = norm360(h); return d > 180 ? d - 360 : d; };

// ---------------------------------------------------------------------------
// main loop
// ---------------------------------------------------------------------------
let lastT = performance.now();
function tick(now) {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;

  if (S.sim.autoWalk) autoWalkTick(dt);
  // GPS wander: a slow random walk bounded by the accuracy radius
  const j = S.sim.gpsJitter;
  j.dx += (Math.random() - 0.5) * dt * 2;
  j.dz += (Math.random() - 0.5) * dt * 2;
  const jm = Math.hypot(j.dx, j.dz), cap = S.sim.gpsAccuracy * 0.6;
  if (jm > cap) { j.dx *= cap / jm; j.dz *= cap / jm; }

  if (S.rec) recordSample();
  if (S.autoScript) S.autoScript(dt);

  redrawLive();
  requestAnimationFrame(tick);
}

// Only the canvases + a few live readouts update per frame; the rest of the DOM
// re-renders on state changes, so typing in the rail doesn't fight the loop.
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
    hr.style.color = ok ? "var(--green)" : "var(--cyan-dim)";
    const hint = $("#heading-hint");
    if (hint) {
      hint.className = "heading-hint" + (ok ? " ok" : "");
      hint.textContent = ok
        ? "✓ Facing north — you can start walking."
        : `Turn ${off > 0 ? "left" : "right"} ${Math.abs(Math.round(off))}° to face north.`;
    }
    const btn = $("#confirm-north");
    if (btn) btn.disabled = !ok;
  }
  for (const [id, val] of Object.entries(liveReadouts())) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }
  // keep the heading slider following the sim (auto-walk steers it too)
  const hs = document.getElementById("r-heading");
  if (hs) hs.value = String(Math.round(norm360(S.sim.heading)));
}

function liveReadouts() {
  const out = {};
  if (S.rec) {
    out["st-pts"] = S.rec.points.length;
    out["st-dist"] = `${pathLength(S.rec.points).toFixed(0)}m`;
    out["st-time"] = `${((performance.now() - S.rec.startedAt) / 1000).toFixed(0)}s`;
    out["st-floor"] = `F${S.sim.floor}`;
  }
  const g = simGps();
  out["dbg-pos"] = `${S.sim.x.toFixed(1)}, ${S.sim.z.toFixed(1)} · F${S.sim.floor}`;
  out["dbg-gps"] = g.lat == null ? "—" : `${g.lat.toFixed(5)}, ${g.lon.toFixed(5)}`;
  out["dbg-heading"] = `${Math.round(norm360(S.sim.heading))}°`;
  out["lbl-gps"] = `GPS accuracy · ±${Math.round(S.sim.gpsAccuracy)}m`;
  out["lbl-speed"] = `Speed · ${S.sim.speed.toFixed(1)} m/s`;
  return out;
}

// ---------------------------------------------------------------------------
// canvas: top-down map
// ---------------------------------------------------------------------------
function drawMap(canvas) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = canvas.clientWidth, h = +canvas.dataset.h || 240;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.height = h + "px";
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#020610";
  ctx.fillRect(0, 0, w, h);
  if (!S.graph || !S.graph.nodes.size) return;

  // fit to this floor's nodes, always including the avatar
  let minX = S.sim.x, maxX = S.sim.x, minZ = S.sim.z, maxZ = S.sim.z;
  for (const n of S.graph.nodes.values()) {
    if (n.floor !== S.sim.floor) continue;
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minZ = Math.min(minZ, n.z); maxZ = Math.max(maxZ, n.z);
  }
  const pad = 14;
  const spanX = Math.max(maxX - minX, 6), spanZ = Math.max(maxZ - minZ, 6);
  const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanZ);
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const px = (x) => (x - cx) * scale + w / 2;
  const py = (z) => (z - cz) * scale + h / 2;

  // edges on this floor
  ctx.strokeStyle = "rgba(120, 190, 230, 0.28)";
  ctx.lineWidth = 1;
  for (const e of S.graph.edges.values()) {
    const a = S.graph.nodes.get(e.a), b = S.graph.nodes.get(e.b);
    if (!a || !b || a.floor !== S.sim.floor || b.floor !== S.sim.floor) continue;
    ctx.beginPath(); ctx.moveTo(px(a.x), py(a.z)); ctx.lineTo(px(b.x), py(b.z)); ctx.stroke();
  }
  // registry nodes on this floor
  for (const n of S.nodesGeo) {
    if ((n.floor || 0) !== S.sim.floor) continue;
    ctx.beginPath(); ctx.arc(px(n.x), py(n.z), 2.6, 0, Math.PI * 2);
    ctx.fillStyle = n.id === S.pick.selectedId ? "#fbbf24" : "rgba(125, 232, 247, 0.8)";
    ctx.fill();
  }
  // route (user mode)
  const r = S.user.result;
  if (r && r.nodes.length > 1) {
    ctx.strokeStyle = "#eafdff"; ctx.lineWidth = 2.5;
    ctx.beginPath();
    r.nodes.forEach((n, i) => (i ? ctx.lineTo(px(n.x), py(n.z)) : ctx.moveTo(px(n.x), py(n.z))));
    ctx.stroke();
  }
  // live recording trail
  if (S.rec && S.rec.points.length > 1) {
    ctx.strokeStyle = "#22d3ee"; ctx.lineWidth = 2;
    ctx.beginPath();
    S.rec.points.forEach((p, i) => (i ? ctx.lineTo(px(p.x), py(p.z)) : ctx.moveTo(px(p.x), py(p.z))));
    ctx.stroke();
    for (const lm of S.rec.landmarks) {
      ctx.fillStyle = "#fbbf24";
      ctx.beginPath(); ctx.arc(px(lm.x), py(lm.z), 3.5, 0, Math.PI * 2); ctx.fill();
    }
  }
  // GPS accuracy halo
  const gpsR = S.sim.gpsAccuracy * scale;
  if (gpsR > 2) {
    ctx.fillStyle = "rgba(34, 211, 238, 0.07)";
    ctx.strokeStyle = "rgba(34, 211, 238, 0.25)";
    ctx.beginPath();
    ctx.arc(px(S.sim.x + S.sim.gpsJitter.dx), py(S.sim.z + S.sim.gpsJitter.dz), gpsR, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
  }
  // avatar + heading cone
  const ax = px(S.sim.x), az = py(S.sim.z);
  const hr = S.sim.heading * Math.PI / 180;
  ctx.fillStyle = "rgba(52, 224, 122, 0.25)";
  ctx.beginPath();
  ctx.moveTo(ax, az);
  ctx.arc(ax, az, 22, hr - Math.PI / 2 - 0.35, hr - Math.PI / 2 + 0.35);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#34e07a";
  ctx.beginPath(); ctx.arc(ax, az, 4.5, 0, Math.PI * 2); ctx.fill();
}

// ---------------------------------------------------------------------------
// canvas: compass dial for the north-calibration step
// ---------------------------------------------------------------------------
function drawCompass(canvas) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const size = 230;
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

  // target wedge: where north currently sits relative to the phone's facing
  ctx.save();
  ctx.translate(c, c);
  ctx.rotate(-S.sim.heading * Math.PI / 180);
  const tol = NORTH_TOLERANCE_DEG * Math.PI / 180;
  ctx.fillStyle = ok ? "rgba(52,224,122,0.18)" : "rgba(251,191,36,0.13)";
  ctx.beginPath(); ctx.moveTo(0, 0);
  ctx.arc(0, 0, R, -Math.PI / 2 - tol, -Math.PI / 2 + tol);
  ctx.closePath(); ctx.fill();

  // rotating dial: ticks + cardinal letters
  ctx.strokeStyle = "rgba(125,232,247,0.5)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();
  for (let d = 0; d < 360; d += 15) {
    const a = (d - 90) * Math.PI / 180;
    const major = d % 45 === 0;
    const r1 = R * (major ? 0.86 : 0.93);
    ctx.strokeStyle = major ? "rgba(125,232,247,0.85)" : "rgba(125,232,247,0.3)";
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
    ctx.lineTo(Math.cos(a) * R, Math.sin(a) * R);
    ctx.stroke();
  }
  ctx.font = "600 14px ui-monospace, monospace";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  [["N", 0], ["E", 90], ["S", 180], ["W", 270]].forEach(([letter, d]) => {
    const a = (d - 90) * Math.PI / 180;
    ctx.fillStyle = letter === "N" ? (ok ? "#34e07a" : "#fbbf24") : "rgba(143,182,207,0.85)";
    ctx.fillText(letter, Math.cos(a) * R * 0.72, Math.sin(a) * R * 0.72);
  });
  ctx.restore();

  // fixed phone pointer at the top
  ctx.fillStyle = ok ? "#34e07a" : "#22d3ee";
  ctx.beginPath();
  ctx.moveTo(c, 8); ctx.lineTo(c - 8, 26); ctx.lineTo(c + 8, 26);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = "rgba(234,253,255,0.6)";
  ctx.font = "9px ui-monospace, monospace";
  ctx.fillText("PHONE", c, 34);
}

// dragging the dial rotates the simulated phone
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
// screens
// ---------------------------------------------------------------------------
const screens = {
  // ---- collector ----
  start: () => ({
    label: "COLLECTOR · START",
    html: `
      <div style="text-align:center"><span class="pill">END-GOAL UX</span></div>
      <div class="spacer"></div>
      <div style="text-align:center">
        <button class="big" id="go" style="width:184px;height:184px;border-radius:50%;font-size:19px;line-height:1.25">
          🧭<br/>Start<br/>Mapping
        </button>
        <div class="sub" style="margin-top:20px">No setup — just face north and walk.<br/>The map builds itself.</div>
      </div>
      <div class="spacer"></div>
      <div style="border:1px dashed rgba(251,191,36,0.55);border-radius:12px;padding:10px 12px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;color:var(--amber);font-weight:700">
          <input type="checkbox" id="internal" ${S.internalMode ? "checked" : ""}/>
          INTERNAL · data-collection mode
        </label>
        <div class="sub" style="margin:6px 0 0;font-size:11px">
          ${S.internalMode
            ? "Adds the start-node step after north calibration."
            : "One-tap capture — north calibration only."}
        </div>
      </div>
      <button class="ghost" id="recs">Recordings (${S.recordings.length})</button>
      <div class="sub" style="text-align:center;margin:8px 0 0;font-size:10.5px">${S.source}</div>`,
    wire: () => {
      $("#go").onclick = () => go("north");
      $("#internal").onchange = (e) => { S.internalMode = e.target.checked; render(); };
      $("#recs").onclick = () => go("recordings");
    },
  }),

  north: () => ({
    label: "COLLECTOR · NORTH CALIBRATION",
    html: `
      <h2 class="title">Face north</h2>
      <div class="sub">Turn your body until the marker lines up with N, then confirm. This gives every path the same starting direction.</div>
      <div class="compass-wrap">
        <canvas id="compass" class="compass"></canvas>
        <div class="heading-read" id="heading-read">—</div>
        <div class="heading-hint" id="heading-hint"></div>
      </div>
      <div class="spacer"></div>
      <div class="sub" style="font-size:11px;border-left:2px solid var(--cyan);padding-left:9px">
        Without this, each path's heading is whatever the magnetometer guessed
        (±15–25° indoors) and every walk has to be rotated into place later.
      </div>
      <button class="big" id="confirm-north" disabled>Confirm facing north</button>
      <button class="ghost" id="back">Back</button>`,
    wire: () => {
      wireCompassDrag($("#compass"));
      $("#confirm-north").onclick = () => {
        log(`north confirmed at ${Math.round(norm360(S.sim.heading))}° (off by ${Math.round(offNorth(S.sim.heading))}°)`);
        // treat the confirmed facing as true north: zero the frame
        S.sim.heading = 0;
        if (!S.internalMode) beginRecording(null);
        go(S.internalMode ? "pickStart" : "live");
      };
      $("#back").onclick = () => go("start");
    },
  }),

  pickStart: () => {
    const list = S.pick.showAll
      ? S.nodesGeo.map((n) => ({ ...n, distanceM: null })).slice(0, 60)
      : nearbyNodes(5);
    const g = simGps();
    return {
      label: "COLLECTOR · START NODE",
      html: `
        <h2 class="title">Where are you?</h2>
        <div class="sub">Rough location picked these out of ${S.nodesGeo.length} nodes.</div>
        <canvas id="map" class="map" data-h="150"></canvas>
        <div class="kv" style="margin:8px 0 10px;font-size:11px">
          <span>GPS ${g.lat.toFixed(5)}, ${g.lon.toFixed(5)}</span>
          <b>±${Math.round(S.sim.gpsAccuracy)}m</b>
        </div>
        <div style="flex:1;overflow-y:auto;min-height:0">
          ${list.length ? list.map((n) => `
            <button class="card ${S.pick.selectedId === n.id ? "sel" : ""}" data-id="${n.id}">
              ${n.distanceM != null ? `<span class="dist">${n.distanceM.toFixed(0)}m</span>` : ""}
              <div class="nm">${n.name || n.id}</div>
              <div class="meta">Floor ${n.floor ?? 0} · ${n.geoDerived ? "derived position" : "surveyed"}</div>
            </button>`).join("")
            : `<div class="sub">No nodes available.</div>`}
        </div>
        <button class="ghost" id="toggle-all">${S.pick.showAll ? "← Show only nearby" : "None of these — show all"}</button>
        <button class="big" id="confirm" ${S.pick.selectedId ? "" : "disabled"}>Start mapping here</button>`,
      wire: () => {
        document.querySelectorAll(".card[data-id]").forEach((b) => {
          b.onclick = () => { S.pick.selectedId = b.dataset.id; render(); };
        });
        $("#toggle-all").onclick = () => { S.pick.showAll = !S.pick.showAll; render(); };
        $("#confirm").onclick = () => { beginRecording(S.pick.selectedId); go("live"); };
      },
    };
  },

  live: () => ({
    label: "COLLECTOR · LIVE MAPPING",
    html: `
      <div style="display:flex;align-items:center;gap:8px">
        <span class="pill green">● RECORDING</span>
        <span class="pill">N-ALIGNED</span>
      </div>
      <div class="stats">
        <div class="stat"><b id="st-pts">0</b><span>POINTS</span></div>
        <div class="stat"><b id="st-dist">0m</b><span>DISTANCE</span></div>
        <div class="stat"><b id="st-time">0s</b><span>ELAPSED</span></div>
        <div class="stat"><b id="st-floor">F0</b><span>FLOOR</span></div>
      </div>
      <canvas id="map" class="map" data-h="300"></canvas>
      <div class="sub" style="margin:10px 0 4px;font-size:11px">Drop a landmark</div>
      <div class="row">
        ${["Door", "Stairs", "Elevator", "Room"].map((l) =>
          `<button class="ghost" style="margin:0;font-size:11px;padding:9px 4px" data-lm="${l}">${l}</button>`).join("")}
      </div>
      <div class="spacer"></div>
      <button class="big" id="finish" style="background:var(--red);color:#fff">Finish path</button>`,
    wire: () => {
      document.querySelectorAll("[data-lm]").forEach((b) => {
        b.onclick = () => {
          S.rec.landmarks.push({ name: b.dataset.lm, x: S.sim.x, z: S.sim.z, floor: S.sim.floor });
          log(`landmark: ${b.dataset.lm}`);
          syncRail();
        };
      });
      $("#finish").onclick = () => go("finish");
    },
  }),

  finish: () => {
    const pts = S.rec ? S.rec.points.length : 0;
    const dist = S.rec ? pathLength(S.rec.points) : 0;
    return {
      label: "COLLECTOR · FINISH",
      html: `
        <h2 class="title">Path complete</h2>
        <div class="sub">Name it so it's findable later.</div>
        <div class="stats">
          <div class="stat"><b>${pts}</b><span>POINTS</span></div>
          <div class="stat"><b>${dist.toFixed(0)}m</b><span>DISTANCE</span></div>
          <div class="stat"><b>${S.rec ? S.rec.landmarks.length : 0}</b><span>LANDMARKS</span></div>
        </div>
        <label style="font-size:11px;color:var(--sub)">PATH NAME</label>
        <input id="nm" type="text" placeholder="e.g. Wean 2nd floor loop"
          style="width:100%;font:inherit;padding:11px;border-radius:10px;background:#061020;color:var(--text);border:1px solid var(--line);margin-top:4px"/>
        <div style="margin-top:14px;border:1px solid var(--line);border-radius:10px;padding:10px 12px">
          <div class="kv"><span>Start node</span><b>${S.rec?.startNodeId ? (S.nodesById[S.rec.startNodeId]?.name || S.rec.startNodeId) : "—"}</b></div>
          <div class="kv"><span>North aligned</span><b style="color:var(--green)">✓ calibrated</b></div>
          <div class="kv"><span>Start GPS</span><b>±${Math.round(S.sim.gpsAccuracy)}m</b></div>
        </div>
        <div class="spacer"></div>
        <button class="big" id="save">Save &amp; upload</button>
        <button class="ghost" id="discard">Discard</button>`,
      wire: () => {
        $("#save").onclick = () => { finishRecording($("#nm").value.trim()); go("start"); };
        $("#discard").onclick = () => { S.rec = null; log("recording discarded"); go("start"); };
      },
    };
  },

  recordings: () => ({
    label: "COLLECTOR · RECORDINGS",
    html: `
      <h2 class="title">Recordings</h2>
      <div class="sub">${S.recordings.length} captured this session.</div>
      <div style="flex:1;overflow-y:auto;min-height:0">
        ${S.recordings.length ? S.recordings.map((w) => `
          <div class="card" style="cursor:default">
            <div class="nm">${w.name || w.id}</div>
            <div class="meta">${w.points.length} pts · ${pathLength(w.points).toFixed(0)}m ·
              ${w.northAligned ? "N-aligned" : "unaligned"} · ${w.startNodeId || "no node"}</div>
          </div>`).join("")
          : `<div class="sub">Nothing yet — record a path, or use “simulate full run” in the debug rail.</div>`}
      </div>
      <button class="ghost" id="back">Back</button>`,
    wire: () => { $("#back").onclick = () => go("start"); },
  }),

  // ---- user (wayfinder) ----
  dest: () => {
    const near = nearbyNodes(5);
    const all = S.nodesGeo.slice(0, 60);
    return {
      label: "USER · DESTINATION",
      html: `
        <h2 class="title">Where to?</h2>
        <div class="sub">You're near <b style="color:var(--cyan-dim)">${near[0] ? (near[0].name || near[0].id) : "—"}</b>.</div>
        <canvas id="map" class="map" data-h="150"></canvas>
        <div class="sub" style="margin:10px 0 4px;font-size:10.5px;letter-spacing:0.14em">DESTINATION</div>
        <div style="flex:1;overflow-y:auto;min-height:0">
          ${all.map((n) => `
            <button class="card ${S.user.destId === n.id ? "sel" : ""}" data-id="${n.id}">
              <div class="nm">${n.name || n.id}</div>
              <div class="meta">Floor ${n.floor ?? 0}</div>
            </button>`).join("")}
        </div>
        <button class="big" id="go" ${S.user.destId ? "" : "disabled"}>Find route</button>`,
      wire: () => {
        document.querySelectorAll(".card[data-id]").forEach((b) => {
          b.onclick = () => { S.user.destId = b.dataset.id; render(); };
        });
        $("#go").onclick = () => {
          const from = nearbyNodes(1)[0];
          const to = S.nodesById[S.user.destId];
          S.user.startId = from ? from.id : null;
          S.user.result = from && to ? routeGraph(S.graph, from, to) : null;
          log(S.user.result
            ? `route ${from.id} → ${to.id}: ${S.user.result.length.toFixed(0)}m`
            : "no route found");
          go("route");
        };
      },
    };
  },

  route: () => {
    const r = S.user.result;
    const to = S.nodesById[S.user.destId];
    const from = S.nodesById[S.user.startId];
    const floorsOnRoute = r ? [...new Set(r.nodes.map((n) => n.floor))] : [];
    return {
      label: "USER · ROUTE",
      html: `
        <h2 class="title">${to ? (to.name || to.id) : "Route"}</h2>
        <div class="sub">${from ? `from ${from.name || from.id}` : ""}</div>
        ${r ? `
          <div class="stats">
            <div class="stat"><b>${r.length.toFixed(0)}m</b><span>DISTANCE</span></div>
            <div class="stat"><b>${Math.max(1, Math.round(r.length / 1.3 / 60))}min</b><span>WALK</span></div>
            <div class="stat"><b>${floorsOnRoute.length}</b><span>FLOORS</span></div>
          </div>
          <canvas id="map" class="map" data-h="300"></canvas>
          <div class="sub" style="margin:10px 0 4px;font-size:10.5px;letter-spacing:0.14em">STEPS</div>
          <div style="flex:1;overflow-y:auto;min-height:0">
            ${routeSteps(r).map((s, i) => `
              <div class="card" style="cursor:default">
                <span class="dist">${s.dist.toFixed(0)}m</span>
                <div class="nm">${i + 1}. ${s.text}</div>
              </div>`).join("")}
          </div>`
        : `<div class="sub" style="color:var(--amber)">No route — the graph has no path between those nodes.
             They're probably in areas nobody has walked between yet.</div><div class="spacer"></div>`}
        <button class="ghost" id="back">Pick another destination</button>`,
      wire: () => { $("#back").onclick = () => { S.user.result = null; go("dest"); }; },
    };
  },
};

// Collapse the node path into human-ish steps: one per floor change, plus a
// final leg. Enough to prototype what wayfinding instructions should read like.
function routeSteps(r) {
  const steps = [];
  let runDist = 0, curFloor = r.nodes[0].floor;
  for (let i = 1; i < r.nodes.length; i++) {
    const a = r.nodes[i - 1], b = r.nodes[i];
    runDist += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    if (b.floor !== curFloor) {
      steps.push({ text: `Follow the corridor, then take the stairs to floor ${b.floor}`, dist: runDist });
      runDist = 0; curFloor = b.floor;
    }
  }
  if (runDist > 0) steps.push({ text: "Continue to your destination", dist: runDist });
  return steps.length ? steps : [{ text: "You're basically there", dist: r.length }];
}

function go(stage) { S.stage = stage; render(); }

// ---------------------------------------------------------------------------
// debug rail
// ---------------------------------------------------------------------------
function railHtml() {
  const g = S.georef || {};
  const maxEdge = S.graph ? Math.max(0, ...[...S.graph.edges.values()].map((e) => e.weight)) : 0;
  return `
    <h3>DATA</h3>
    <div class="kv"><span>source</span><b>${S.source}</b></div>
    <div class="kv"><span>graph nodes / edges</span><b>${S.graph ? S.graph.nodes.size : 0} / ${S.graph ? S.graph.edges.size : 0}</b></div>
    <div class="kv"><span>longest edge</span><b>${maxEdge.toFixed(2)}m</b></div>
    <div class="kv"><span>frame north offset</span><b>${g.northOffsetDeg != null ? g.northOffsetDeg.toFixed(1) + "°" : "—"}</b></div>
    <div class="kv"><span>north estimate spread</span><b>${g.northSpreadDeg != null ? "±" + g.northSpreadDeg.toFixed(0) + "°" : "—"}</b></div>
    <div class="kv"><span>geo anchor</span><b>${g.n ? `${g.n} fix · ±${g.accuracyM.toFixed(1)}m` : "none"}</b></div>
    ${g.synthetic ? `<div class="warn">⚠ No walk in the database carries a GPS fix — <code>walks</code> has no lat/lon columns, so the phone's fix is dropped on upload. Using a nominal campus origin instead.</div>` : ""}
    ${g.northSpreadDeg > 25 ? `<div class="warn">⚠ Existing walks disagree about north by ±${g.northSpreadDeg.toFixed(0)}°. That's the guesswork the calibration step removes.</div>` : ""}

    <h3>SENSORS</h3>
    <label>Compass heading · <b id="dbg-heading">—</b></label>
    <input type="range" id="r-heading" min="0" max="359" value="${Math.round(norm360(S.sim.heading))}"/>
    <div class="grid2">
      <button id="b-north">Snap to north</button>
      <button id="b-rand-head">Randomize</button>
    </div>
    <label id="lbl-gps">GPS accuracy · ±${Math.round(S.sim.gpsAccuracy)}m</label>
    <input type="range" id="r-gps" min="2" max="40" value="${Math.round(S.sim.gpsAccuracy)}"/>
    <div class="kv"><span>position (x, z)</span><b id="dbg-pos">—</b></div>
    <div class="kv"><span>gps reading</span><b id="dbg-gps">—</b></div>
    <label>Floor</label>
    <select id="s-floor">${[0, 1, 2, 3].map((f) =>
      `<option value="${f}" ${S.sim.floor === f ? "selected" : ""}>Floor ${f}</option>`).join("")}</select>

    <h3>MOVEMENT</h3>
    <button id="b-auto" class="${S.sim.autoWalk ? "on" : ""}">${S.sim.autoWalk ? "◼ Stop auto-walk" : "▶ Simulate walking randomly"}</button>
    <label id="lbl-speed">Speed · ${S.sim.speed.toFixed(1)} m/s</label>
    <input type="range" id="r-speed" min="0.4" max="6" step="0.1" value="${S.sim.speed}"/>
    <div class="dpad">
      <div class="blank"></div><button id="b-fwd">▲</button><div class="blank"></div>
      <button id="b-left">◀ turn</button><button id="b-back">▼</button><button id="b-right">turn ▶</button>
    </div>
    <button id="b-teleport">⤓ Teleport to a random node</button>

    <h3>SCENARIOS</h3>
    <button id="b-addpath">＋ Add random path to the graph</button>
    <button id="b-fullrun" class="${S.autoScript ? "on" : ""}">${S.autoScript ? "◼ Stop simulated run" : "▶ Simulate a full collection run"}</button>
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
  on("b-north", "onclick", () => { S.sim.heading = 0; syncRail(); });
  on("b-rand-head", "onclick", () => { S.sim.heading = Math.random() * 360; syncRail(); });
  // sliders must NOT syncRail on input — rebuilding the rail mid-drag would
  // recreate the element under the pointer. Their labels update in redrawLive.
  on("r-gps", "oninput", (e) => { S.sim.gpsAccuracy = +e.target.value; });
  on("s-floor", "onchange", (e) => { S.sim.floor = +e.target.value; });
  on("r-speed", "oninput", (e) => { S.sim.speed = +e.target.value; });
  on("b-auto", "onclick", () => { S.sim.autoWalk = !S.sim.autoWalk; S.sim.target = null; syncRail(); });
  on("b-fwd", "onclick", () => stepForward(1));
  on("b-back", "onclick", () => stepForward(-1));
  on("b-left", "onclick", () => { S.sim.heading = norm360(S.sim.heading - 15); });
  on("b-right", "onclick", () => { S.sim.heading = norm360(S.sim.heading + 15); });
  on("b-teleport", "onclick", () => {
    const list = S.nodesGeo.length ? S.nodesGeo : [];
    const n = list[Math.floor(Math.random() * list.length)];
    if (n) { S.sim.x = n.x; S.sim.z = n.z; S.sim.floor = n.floor || 0; S.sim.target = null; log(`teleported to ${n.id}`); }
    syncRail();
  });
  on("b-addpath", "onclick", addRandomPath);
  on("b-fullrun", "onclick", () => (S.autoScript ? stopFullRun() : startFullRun()));
  on("b-reset", "onclick", () => {
    S.recordings = []; S.rec = null; S.autoScript = null; S.sim.autoWalk = false;
    S.user = { startId: null, destId: null, result: null };
    S.pick = { selectedId: null, showAll: false };
    log("session reset"); go("start");
  });
}

function syncRail() { railEl.innerHTML = railHtml(); wireRail(); }

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------
// Random-walk the existing graph to synthesize a plausible new path, so the
// graph can be stress-tested without recording anything by hand.
function addRandomPath() {
  if (!S.graph || !S.graph.nodes.size) { log("no graph to walk"); return; }
  const keys = [...S.graph.nodes.values()];
  let cur = keys[Math.floor(Math.random() * keys.length)];
  const points = [];
  let t = 0;
  for (let i = 0; i < 60; i++) {
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
        tracking: "normal",
      });
    }
    cur = next;
  }
  if (points.length < 2) { log("random path too short"); return; }
  const walk = {
    schemaVersion: 4, id: `rand-${Date.now()}`, device: "synthetic",
    recordedAt: new Date().toISOString(), unit: "meters", up: "y",
    northAligned: true, startAnchorId: "prototype", points,
  };
  S.walks.push(walk);
  annotateFloors(S.walks);
  rebuild();
  log(`added random path · ${points.length} pts · ${pathLength(points).toFixed(0)}m`);
  render();
}

// Drive the whole collector flow hands-free: calibrate north, pick the nearest
// node, walk for a while, finish and save. The fastest way to see the flow end
// to end after a UI change.
function startFullRun() {
  let phase = "north", elapsed = 0;
  S.sim.heading = Math.random() * 360;
  go("north");
  log("simulated run: turning to north…");
  S.autoScript = (dt) => {
    elapsed += dt;
    if (phase === "north") {
      const off = offNorth(S.sim.heading);
      S.sim.heading = norm360(S.sim.heading - Math.sign(off) * Math.min(Math.abs(off), 90 * dt));
      if (Math.abs(offNorth(S.sim.heading)) <= NORTH_TOLERANCE_DEG) {
        S.sim.heading = 0; phase = "pick"; elapsed = 0;
        go(S.internalMode ? "pickStart" : "live");
        log("simulated run: north confirmed");
      }
    } else if (phase === "pick") {
      if (elapsed > 0.8) {
        const near = nearbyNodes(5);
        S.pick.selectedId = near.length ? near[Math.floor(Math.random() * near.length)].id : null;
        beginRecording(S.pick.selectedId);
        S.sim.autoWalk = true; S.sim.target = null;
        phase = "walk"; elapsed = 0;
        go("live");
        log(`simulated run: starting at ${S.pick.selectedId || "(no node)"}`);
      }
    } else if (phase === "walk") {
      if (elapsed > 18) {
        S.sim.autoWalk = false;
        phase = "finish"; elapsed = 0;
        go("finish");
      }
    } else if (phase === "finish") {
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
  const key = S.mode === "user"
    ? (["dest", "route"].includes(S.stage) ? S.stage : "dest")
    : (screens[S.stage] ? S.stage : "start");
  if (S.mode === "user" && !["dest", "route"].includes(S.stage)) S.stage = "dest";
  const scr = screens[key]();
  $("#stage-label").textContent = scr.label;
  screenEl.innerHTML = scr.html;
  scr.wire?.();
  $("#src").innerHTML = `<b>${S.walks.length}</b> walks · <b>${S.nodes.length}</b> nodes · <b>${S.graph ? S.graph.nodes.size : 0}</b> graph nodes`;
  syncRail();
}

document.querySelectorAll(".modes button").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll(".modes button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    S.mode = b.dataset.mode;
    S.stage = S.mode === "user" ? "dest" : "start";
    render();
  };
});

// keyboard: arrows drive the sim, matching the dpad
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

render();
requestAnimationFrame(tick);
loadAll();
