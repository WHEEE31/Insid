// Map overlay — draw recorded walks + registry nodes on a real OSM map,
// georeferenced from 2 control points, with OSM building footprints underneath.
// Owner: C. Imports only: data-loader (loadWalks/loadNodes), node-anchor.js
// (optional), pipeline/georef.js, pipeline/floors.js. See docs/contracts.md.

import * as loader from "./data-loader.js"; // loadWalks (always), loadNodes (maybe)
import { fitGeoreference, localToLatLon } from "./pipeline/georef.js";

// ---------------------------------------------------------------------------
// Config
const LS_KEY = "mapOverlay.controlPoints.v1";

// Default control points near CMU (40.4433, -79.9436). These map two
// building-local (x,z) points to plausible lat/lon so the page renders
// immediately; the user can override them with the editor below.
// x≈east, z≈north (meters), roughly the diagonal extent of the sample walks.
const DEFAULT_CONTROL_POINTS = [
  { x: 0, z: 0, lat: 40.4433, lon: -79.9436 },
  { x: 27.364, z: -29.163, lat: 40.443038, lon: -79.943277 },
];

const WALK_COLORS = [
  "#4da3ff", "#f4a259", "#a685e2", "#5ee0a0", "#ff7eb6",
  "#ffd166", "#8ecae6", "#e07a5f", "#b8f2e6", "#f28482",
];

// ---------------------------------------------------------------------------
// State
let map;
let controlPoints = loadControlPoints();
let georef = null;
let walks = [];
let nodes = [];
let anchorMod = null; // { anchorWalkToMap, nodesById } if available

const layers = {
  footprints: L.layerGroup(),
  walks: L.layerGroup(),
  nodes: L.layerGroup(),
  markers: L.layerGroup(), // start/end
};

// selectable source points for the control-point editor: {x, z}
let sourcePoints = [];

// editor state
const editor = { active: false, mode: "idle", draft: [], pendingLocal: null };

// ---------------------------------------------------------------------------
// localStorage
function loadControlPoints() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length >= 2) return arr;
    }
  } catch (e) { /* ignore */ }
  return DEFAULT_CONTROL_POINTS.map((p) => ({ ...p }));
}
function saveControlPoints() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(controlPoints)); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Boot
init().catch((err) => {
  console.error(err);
  setLoadStatus("Failed to initialize: " + err.message, "warn");
});

async function init() {
  map = L.map("map", { zoomControl: true }).setView(
    [controlPoints[0].lat, controlPoints[0].lon], 19
  );
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 22, maxNativeZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  layers.footprints.addTo(map);
  layers.walks.addTo(map);
  layers.markers.addTo(map);
  layers.nodes.addTo(map);

  map.on("click", onMapClick);

  wireHud();

  // Load data (walks always; nodes + anchoring best-effort).
  await loadData();

  // Fit georef and draw.
  refitAndDraw({ fitBounds: true });
}

async function loadData() {
  try {
    walks = await loader.loadWalks();
  } catch (e) {
    walks = [];
    console.error("loadWalks failed", e);
  }

  // loadNodes may not be added yet (parallel stream B).
  if (typeof loader.loadNodes === "function") {
    try { nodes = (await loader.loadNodes()) || []; } catch (e) { nodes = []; }
  } else {
    nodes = [];
  }

  // node-anchor.js may not exist yet (parallel stream A).
  try {
    anchorMod = await import("./pipeline/node-anchor.js");
    if (!(anchorMod && typeof anchorMod.anchorWalkToMap === "function")) anchorMod = null;
  } catch (e) {
    anchorMod = null;
  }

  // If anchoring + nodes are available, anchor each walk into building-local.
  // Otherwise treat walks as already sharing one frame (see contracts.md
  // "Current-data note").
  if (anchorMod && nodes.length) {
    const byId = typeof anchorMod.nodesById === "function"
      ? anchorMod.nodesById(nodes)
      : Object.fromEntries(nodes.map((n) => [n.id, n]));
    walks = walks.map((w) => {
      try { return anchorMod.anchorWalkToMap(w, byId); } catch (e) { return w; }
    });
  }

  // Optional floor annotation (adds p.floor); non-fatal if module/shape differs.
  try {
    const floorsMod = await import("./pipeline/floors.js");
    if (typeof floorsMod.annotateFloors === "function") floorsMod.annotateFloors(walks);
  } catch (e) { /* optional */ }

  const nAnchored = walks.filter((w) => w && w.anchored).length;
  const bits = [`${walks.length} walk(s)`];
  if (nodes.length) bits.push(`${nodes.length} node(s)`);
  bits.push(anchorMod && nodes.length
    ? `anchored ${nAnchored}/${walks.length}`
    : "shared-frame (no anchoring)");
  setLoadStatus(bits.join(" · "), "ok");
}

// ---------------------------------------------------------------------------
// Drawing
function refitAndDraw({ fitBounds = false } = {}) {
  try {
    georef = fitGeoreference(controlPoints);
  } catch (e) {
    setCpStatus("Georef fit failed: " + e.message, "warn");
    return;
  }
  drawAll({ fitBounds });
  renderCpList();
}

function drawAll({ fitBounds = false } = {}) {
  layers.footprints.clearLayers();
  layers.walks.clearLayers();
  layers.nodes.clearLayers();
  layers.markers.clearLayers();
  sourcePoints = [];

  const allLatLng = [];
  const walkLegend = [];

  // Walks as colored polylines, with start/end markers.
  walks.forEach((w, i) => {
    const pts = (w && w.points) || [];
    if (!pts.length) return;
    const color = WALK_COLORS[i % WALK_COLORS.length];
    const latlngs = pts.map((p) => {
      const ll = localToLatLon(p.x, p.z, georef);
      allLatLng.push([ll.lat, ll.lon]);
      return [ll.lat, ll.lon];
    });
    L.polyline(latlngs, { color, weight: 3, opacity: 0.9 })
      .bindTooltip(`${w.id || "walk " + (i + 1)} (${pts.length} pts)`)
      .addTo(layers.walks);

    // start (green) / end (red) markers — also selectable as control sources.
    addSourceMarker(pts[0], latlngs[0], "#2ecc71", `${w.id || "walk"} start`);
    addSourceMarker(pts[pts.length - 1], latlngs[latlngs.length - 1], "#e74c3c", `${w.id || "walk"} end`);

    walkLegend.push({ color, label: w.id || `walk ${i + 1}`, pts: pts.length });
  });

  // Registry nodes as labeled markers — also selectable as control sources.
  nodes.forEach((n) => {
    if (n == null || n.x == null || n.z == null) return;
    const ll = localToLatLon(n.x, n.z, georef);
    allLatLng.push([ll.lat, ll.lon]);
    const m = L.circleMarker([ll.lat, ll.lon], {
      radius: 6, color: "#fff", weight: 1, fillColor: "#4da3ff", fillOpacity: 0.95,
    }).bindTooltip(n.name || n.id, { permanent: false }).addTo(layers.nodes);
    registerSource(m, n.x, n.z, n.name || n.id);
  });

  renderWalkLegend(walkLegend);

  if (fitBounds && allLatLng.length) {
    map.fitBounds(L.latLngBounds(allLatLng).pad(0.35), { maxZoom: 20 });
  }

  // Building footprints around the georef center.
  const center = allLatLng.length
    ? L.latLngBounds(allLatLng).getCenter()
    : L.latLng(georef.lat0, georef.lon0);
  fetchFootprints(center.lat, center.lng);
}

// A start/end marker that is both a visual cue and a selectable control source.
function addSourceMarker(point, latlng, color, label) {
  const m = L.circleMarker(latlng, {
    radius: 5, color: "#fff", weight: 1, fillColor: color, fillOpacity: 0.95,
  }).bindTooltip(label).addTo(layers.markers);
  registerSource(m, point.x, point.z, label);
}

function registerSource(marker, x, z, label) {
  sourcePoints.push({ x, z, label });
  marker.on("click", (ev) => {
    if (ev.originalEvent) L.DomEvent.stopPropagation(ev.originalEvent);
    onSourceClick(x, z, label);
  });
}

// ---------------------------------------------------------------------------
// OSM building footprints via Overpass
// Query (radius 80 m, per spec):
//   [out:json][timeout:25];way["building"](around:80,LAT,LON);(._;>;);out;
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
function overpassQuery(lat, lon) {
  return `[out:json][timeout:25];way["building"](around:80,${lat.toFixed(6)},${lon.toFixed(6)});(._;>;);out;`;
}

async function fetchFootprints(lat, lon) {
  setOverpassStatus("Querying OSM building footprints…");
  const q = overpassQuery(lat, lon);
  try {
    const res = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(q),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const gj = overpassToGeoJSON(data);
    const count = gj.features.length;
    L.geoJSON(gj, {
      style: { color: "#e07a5f", weight: 1.5, fillColor: "#e07a5f", fillOpacity: 0.15 },
      onEachFeature: (f, layer) => {
        const t = f.properties && (f.properties.name || f.properties.building);
        if (t) layer.bindTooltip(String(t));
      },
    }).addTo(layers.footprints);
    setOverpassStatus(count
      ? `${count} building footprint(s) from OSM.`
      : "No OSM buildings within 80 m.", count ? "ok" : "warn");
  } catch (e) {
    setOverpassStatus("Overpass unavailable (" + e.message + "). Footprints skipped.", "warn");
  }
}

// Convert an Overpass JSON response into a GeoJSON FeatureCollection of building
// polygons. Nodes provide coordinates; ways with a "building" tag become polygons.
function overpassToGeoJSON(data) {
  const nodeById = new Map();
  for (const el of data.elements || []) {
    if (el.type === "node") nodeById.set(el.id, [el.lon, el.lat]);
  }
  const features = [];
  for (const el of data.elements || []) {
    if (el.type !== "way" || !el.nodes || !el.tags || !el.tags.building) continue;
    const coords = el.nodes.map((id) => nodeById.get(id)).filter(Boolean);
    if (coords.length < 3) continue;
    // close the ring
    const first = coords[0], last = coords[coords.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) coords.push(first);
    features.push({
      type: "Feature",
      properties: el.tags,
      geometry: { type: "Polygon", coordinates: [coords] },
    });
  }
  return { type: "FeatureCollection", features };
}

// ---------------------------------------------------------------------------
// Control-point editor
function wireHud() {
  document.getElementById("cpToggle").addEventListener("click", toggleEditor);
  document.getElementById("cpReset").addEventListener("click", () => {
    controlPoints = DEFAULT_CONTROL_POINTS.map((p) => ({ ...p }));
    saveControlPoints();
    setCpStatus("Reset to CMU defaults.", "ok");
    refitAndDraw({ fitBounds: true });
  });
  renderCpList();
}

function toggleEditor() {
  editor.active = !editor.active;
  const btn = document.getElementById("cpToggle");
  if (editor.active) {
    editor.mode = "awaitLocal";
    editor.draft = [];
    editor.pendingLocal = null;
    btn.classList.add("active");
    btn.textContent = "Cancel control-point editing";
    setCpStatus("Point 1/2 — click a source point (node or walk start/end marker).");
  } else {
    endEditor();
  }
}
function endEditor() {
  editor.active = false;
  editor.mode = "idle";
  editor.draft = [];
  editor.pendingLocal = null;
  const btn = document.getElementById("cpToggle");
  btn.classList.remove("active");
  btn.textContent = "Set control points…";
}

function onSourceClick(x, z, label) {
  if (!editor.active || editor.mode !== "awaitLocal") return;
  editor.pendingLocal = { x, z, label };
  editor.mode = "awaitMap";
  const n = editor.draft.length + 1;
  setCpStatus(`Point ${n}/2 — selected “${label}” (x=${x.toFixed(2)}, z=${z.toFixed(2)}). Now click its TRUE location on the map.`);
}

function onMapClick(ev) {
  if (!editor.active || editor.mode !== "awaitMap" || !editor.pendingLocal) return;
  const { x, z } = editor.pendingLocal;
  editor.draft.push({ x, z, lat: ev.latlng.lat, lon: ev.latlng.lng });
  editor.pendingLocal = null;

  if (editor.draft.length < 2) {
    editor.mode = "awaitLocal";
    setCpStatus("Point 2/2 — click another source point (node or walk start/end marker).");
  } else {
    controlPoints = editor.draft.slice(0, 2);
    saveControlPoints();
    endEditor();
    setCpStatus("Georeference updated from 2 new control points.", "ok");
    refitAndDraw({ fitBounds: true });
  }
}

// ---------------------------------------------------------------------------
// HUD rendering helpers
function renderCpList() {
  const el = document.getElementById("cpList");
  if (!georef) { el.textContent = ""; return; }
  const lines = controlPoints.slice(0, 2).map((p, i) =>
    `CP${i + 1}: local(${(+p.x).toFixed(2)}, ${(+p.z).toFixed(2)}) → ${(+p.lat).toFixed(6)}, ${(+p.lon).toFixed(6)}`
  );
  lines.push(`fit: scale=${georef.scale.toFixed(4)} m/unit · rot=${georef.rotationDeg.toFixed(2)}° · rms=${georef.rms.toFixed(3)} m`);
  el.textContent = lines.join("\n");
  el.style.whiteSpace = "pre-wrap";
}

function renderWalkLegend(items) {
  const el = document.getElementById("walkLegend");
  el.innerHTML = "";
  if (!items.length) { el.textContent = "No walks."; return; }
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<span class="swatch" style="background:${it.color}"></span>` +
      `<span>${escapeHtml(it.label)} <span class="note" style="display:inline">· ${it.pts} pts</span></span>`;
    el.appendChild(row);
  }
}

function setLoadStatus(msg, cls) { setText("loadStatus", msg, cls); }
function setCpStatus(msg, cls) { setText("cpStatus", msg, cls); }
function setOverpassStatus(msg, cls) { setText("overpassStatus", msg, cls); }
function setText(id, msg, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.className = el.id === "cpStatus" ? "status" : "note";
  if (cls) el.classList.add(cls);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
