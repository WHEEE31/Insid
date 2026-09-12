import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { loadWalks, loadNodes } from "./data-loader.js";
import { annotateFloors } from "./pipeline/floors.js";
import { buildGraph, route } from "./pipeline/graph.js";
import {
  makeBackgroundTexture,
  dotTexture,
  gridLineTexture,
  makeLabelSprite,
} from "./vis-helpers.js";

// ---- load + process (before palette so floorColor knows the level count) ----
const walks = await loadWalks();
const floors = annotateFloors(walks);
const graph = buildGraph(walks);

// stable, ordered view of the merged graph nodes. The graph-node Points cloud
// (built in addWalks) uses THIS order, so a raycast hit .index maps back here.
// Each entry may gain a `.namedId` when a registry node is attached to it.
const graphNodeList = [...graph.nodes.values()];
const graphNodeByKey = new Map(graphNodeList.map((n) => [n.key, n]));
let graphPoints = null; // THREE.Points of the merged graph nodes (set in addWalks)

// ---- near-monochrome holographic palette -----------------------------------
// Whole scene reads as ONE blue hologram; floors graduate deep-blue -> cyan so
// they're still distinguishable. Route = the single hottest near-white cyan.
const BLUE_DEEP = new THREE.Color(0x0b4f96);   // lowest floor
const BLUE_BRIGHT = new THREE.Color(0x6ff0ff); // highest floor
const ROUTE_COLOR = new THREE.Color(0xeafdff);  // hottest near-white cyan
const CONNECTOR_COLOR = new THREE.Color(0xa7ecff);
function floorColor(f) {
  const n = floors.levels.length;
  const t = n > 1 ? f / (n - 1) : 0.5;
  return BLUE_DEEP.clone().lerp(BLUE_BRIGHT, t);
}
const hexOf = (c) => c.getHexString();

// distinct per-WALK colors so the individual walks are easy to tell apart
// (floors are still readable from the stacked floor planes).
const WALK_COLORS = [0x22d3ee, 0xffa53f, 0xa78bfa, 0xff5db1, 0x7ef29a, 0xf4d03f];
const walkColor = (i) => new THREE.Color(WALK_COLORS[i % WALK_COLORS.length]);

// ---- renderer ----
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);

// ---- scene ----
const scene = new THREE.Scene();
scene.background = makeBackgroundTexture();
scene.fog = new THREE.FogExp2(0x02040a, 0.006);

const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.1, 5000);

// derived-data overlay (merged graph node dots + stair connectors); toggled apart
// from the raw walks, since it's computed from all walks combined, not one walk.
const graphGroup = new THREE.Group();
scene.add(graphGroup);

// named-node overlay (bright dot + HUD label sprite per named registry node).
// Kept separate from graphGroup so labels stay legible even if the raw graph
// dots are toggled off.
const namedGroup = new THREE.Group();
scene.add(namedGroup);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.4;
controls.minDistance = 6;
controls.maxDistance = 600;

// ---- overall bounds (used for framing + scanner scale) ----
const box = new THREE.Box3();
for (const w of walks) for (const p of w.points) box.expandByPoint(new THREE.Vector3(p.x, p.y, p.z));
const center = box.getCenter(new THREE.Vector3());
const bsize = box.getSize(new THREE.Vector3());
const lowestAlt = floors.levels.length
  ? Math.min(...floors.levels.map((l) => l.altitude))
  : box.min.y;

// ---- blueprint wireframe floor planes --------------------------------------
function addFloorPlanes() {
  // xz extent per floor from its assigned points
  const bounds = new Map();
  for (const w of walks) {
    for (const p of w.points) {
      const b = bounds.get(p.floor) || {
        minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity,
      };
      b.minX = Math.min(b.minX, p.x); b.maxX = Math.max(b.maxX, p.x);
      b.minZ = Math.min(b.minZ, p.z); b.maxZ = Math.max(b.maxZ, p.z);
      bounds.set(p.floor, b);
    }
  }
  const pad = 4;

  for (const lvl of floors.levels) {
    const b = bounds.get(lvl.floor);
    if (!b) continue;
    const w = b.maxX - b.minX + pad * 2;
    const d = b.maxZ - b.minZ + pad * 2;
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    const col = floorColor(lvl.floor);

    const slab = new THREE.Group();
    slab.position.set(cx, lvl.altitude, cz);
    slab.rotation.x = -Math.PI / 2; // lay flat; slab-local xy -> world xz
    scene.add(slab);

    // faint thin blueprint grid (~2m cells, normal blend so it reads as drawn)
    const gridTex = gridLineTexture().clone();
    gridTex.needsUpdate = true;
    gridTex.wrapS = gridTex.wrapT = THREE.RepeatWrapping;
    gridTex.repeat.set(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(d / 2)));
    const grid = new THREE.Mesh(
      new THREE.PlaneGeometry(w, d),
      new THREE.MeshBasicMaterial({
        map: gridTex, color: col, transparent: true, opacity: 0.18,
        side: THREE.DoubleSide, depthWrite: false,
      })
    );
    slab.add(grid);

    // crisp thin frame border
    const frame = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(w, d)),
      new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.6 })
    );
    frame.position.z = 0.01;
    slab.add(frame);

    // HUD corner-bracket ticks at each corner
    const L = Math.min(w, d) * 0.09 + 1.0;
    const hw = w / 2, hd = d / 2;
    const seg = [];
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const x = sx * hw, y = sy * hd;
        seg.push(x, y, 0, x - sx * L, y, 0);
        seg.push(x, y, 0, x, y - sy * L, 0);
      }
    }
    const brackets = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute(
        "position", new THREE.Float32BufferAttribute(seg, 3)
      ),
      new THREE.LineBasicMaterial({ color: BLUE_BRIGHT, transparent: true, opacity: 0.95 })
    );
    brackets.position.z = 0.02;
    slab.add(brackets);

    // instrument label near a corner, just above the plane
    const label = makeLabelSprite(`Floor ${lvl.floor}`, `#${hexOf(col)}`);
    label.position.set(cx - w / 2 + 3.5, lvl.altitude + 1.5, cz - d / 2 + 1.5);
    scene.add(label);
  }
}

// per-walk scene groups, so each walk can be toggled on/off from the HUD
const walkObjects = [];

// small start/end marker: a dot + an "S"/"E" label sprite, grouped so it toggles
function endpointMarker(p, letter, colorHex) {
  const g = new THREE.Group();
  g.position.set(p.x, p.y, p.z);
  g.add(new THREE.Mesh(
    new THREE.SphereGeometry(0.28, 16, 16),
    new THREE.MeshBasicMaterial({ color: colorHex })
  ));
  const label = makeLabelSprite(letter, `#${new THREE.Color(colorHex).getHexString()}`);
  label.scale.multiplyScalar(0.55);
  label.position.set(0, 1.1, 0);
  g.add(label);
  return g;
}

// ---- walk paths: thin wireframe lines + scattered vertex point-cloud --------
function addWalks() {
  walks.forEach((w, wi) => {
    const group = new THREE.Group();
    if (w.points.length >= 2) {
      // thin crisp line, colored by WALK (so the two walks are distinct)
      const wc = walkColor(wi);
      const pos = [], col = [];
      for (const p of w.points) {
        pos.push(p.x, p.y, p.z);
        col.push(wc.r, wc.g, wc.b);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
      group.add(new THREE.Line(geo, new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.6,
      })));

      // this walk's vertex point-cloud (evokes a mesh of vertices)
      const ppos = [], pcol = [];
      for (let i = 0; i < w.points.length; i += 2) {
        const p = w.points[i];
        ppos.push(p.x, p.y, p.z);
        pcol.push(wc.r, wc.g, wc.b);
      }
      const pgeo = new THREE.BufferGeometry();
      pgeo.setAttribute("position", new THREE.Float32BufferAttribute(ppos, 3));
      pgeo.setAttribute("color", new THREE.Float32BufferAttribute(pcol, 3));
      group.add(new THREE.Points(pgeo, new THREE.PointsMaterial({
        map: dotTexture(), size: 0.42, sizeAttenuation: true,
        vertexColors: true, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending,
      })));

      // S = start (green), E = end (warm red)
      group.add(endpointMarker(w.points[0], "S", 0x34e07a));
      group.add(endpointMarker(w.points[w.points.length - 1], "E", 0xff6b6b));
    }
    scene.add(group);
    walkObjects.push({ id: w.id, group });
  });

  // brighter dots at merged graph nodes (the actual "mesh" vertices).
  // Iterate graphNodeList (NOT graph.nodes) so buffer index === graphNodeList
  // index, which the edit-mode raycaster relies on to map a hit back to a node.
  const npos = [], ncol = [];
  for (const n of graphNodeList) {
    npos.push(n.x, n.y, n.z);
    const c = floorColor(n.floor).lerp(BLUE_BRIGHT, 0.4);
    ncol.push(c.r, c.g, c.b);
  }
  const ngeo = new THREE.BufferGeometry();
  ngeo.setAttribute("position", new THREE.Float32BufferAttribute(npos, 3));
  ngeo.setAttribute("color", new THREE.Float32BufferAttribute(ncol, 3));
  graphPoints = new THREE.Points(ngeo, new THREE.PointsMaterial({
    map: dotTexture(), size: 0.75, sizeAttenuation: true,
    vertexColors: true, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  graphGroup.add(graphPoints);
}

// ---- vertical connectors: thin bright lines + tick crossbars ----------------
function addConnectors() {
  const lineSeg = [], tickSeg = [];
  for (const e of graph.edges.values()) {
    if (!e.vertical) continue;
    const a = graph.nodes.get(e.a);
    const b = graph.nodes.get(e.b);
    lineSeg.push(a.x, a.y, a.z, b.x, b.y, b.z);
    // a few horizontal tick crossbars along the climb
    for (const u of [0.25, 0.5, 0.75]) {
      const x = a.x + (b.x - a.x) * u;
      const y = a.y + (b.y - a.y) * u;
      const z = a.z + (b.z - a.z) * u;
      tickSeg.push(x - 0.35, y, z, x + 0.35, y, z);
    }
  }
  if (lineSeg.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(lineSeg, 3));
    graphGroup.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      color: CONNECTOR_COLOR, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })));
  }
  if (tickSeg.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(tickSeg, 3));
    graphGroup.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      color: CONNECTOR_COLOR, transparent: true, opacity: 0.7,
    })));
  }
}

// ---- animated route playback -----------------------------------------------
let pulse = null, routeCurve = null;
function addRoute(startPos, endPos) {
  const r = route(graph, startPos, endPos);
  if (!r || r.nodes.length < 2) return null;
  const pts = r.nodes.map((n) => new THREE.Vector3(n.x, n.y, n.z));
  routeCurve = new THREE.CatmullRomCurve3(pts);

  // thin hot near-white route line drawn on top
  const samples = routeCurve.getPoints(pts.length * 12);
  const rgeo = new THREE.BufferGeometry().setFromPoints(samples);
  scene.add(new THREE.Line(rgeo, new THREE.LineBasicMaterial({
    color: ROUTE_COLOR, transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending, depthWrite: false,
  })));

  // traveling pulse: small crisp core + a single thin ring (no soft halo)
  pulse = new THREE.Group();
  pulse.add(new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
  ));
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.34, 0.02, 8, 32),
    new THREE.MeshBasicMaterial({
      color: ROUTE_COLOR, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })
  );
  ring.rotation.x = -Math.PI / 2;
  pulse.add(ring);
  scene.add(pulse);

  // start / end reticles (thin rings on the floor, not glowing blobs)
  const reticle = (p, c) => {
    const grp = new THREE.Group();
    grp.position.copy(p);
    const tor = new THREE.Mesh(
      new THREE.TorusGeometry(0.55, 0.04, 8, 40),
      new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.95 })
    );
    tor.rotation.x = -Math.PI / 2;
    grp.add(tor);
    const cross = [];
    for (const s of [-1, 1]) {
      cross.push(s * 0.75, 0, 0, s * 0.35, 0, 0);
      cross.push(0, 0, s * 0.75, 0, 0, s * 0.35);
    }
    grp.add(new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute(
        "position", new THREE.Float32BufferAttribute(cross, 3)
      ),
      new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: 0.85 })
    ));
    scene.add(grp);
  };
  reticle(pts[0], BLUE_BRIGHT);
  reticle(pts[pts.length - 1], ROUTE_COLOR);
  return r;
}

// ---- signature rotating scanner platform ------------------------------------
// Concentric tick rings, radial spokes, and counter-rotating dial arcs, laid
// flat below the lowest floor. Rotating sub-groups are returned for the loop.
const scannerDials = [];
function circleGeo(radius, segs = 128) {
  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0));
  }
  return new THREE.BufferGeometry().setFromPoints(pts);
}
function arcGeo(radius, a0, a1, segs = 96) {
  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const a = a0 + (a1 - a0) * (i / segs);
    pts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0));
  }
  return new THREE.BufferGeometry().setFromPoints(pts);
}
function addScanner() {
  const radius = Math.max(bsize.x, bsize.z) * 0.9 + 12;
  const root = new THREE.Group();
  root.position.set(center.x, lowestAlt - 4.0, center.z);
  root.rotation.x = -Math.PI / 2; // xy content -> world xz plane
  scene.add(root);

  const dim = new THREE.LineBasicMaterial({ color: BLUE_DEEP, transparent: true, opacity: 0.35 });
  const mid = new THREE.LineBasicMaterial({ color: 0x2c8fd6, transparent: true, opacity: 0.55 });
  const hot = new THREE.LineBasicMaterial({
    color: BLUE_BRIGHT, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });

  // concentric rings
  const ringR = [radius * 0.28, radius * 0.5, radius * 0.72, radius * 0.9, radius];
  ringR.forEach((r, i) => {
    root.add(new THREE.LineLoop(circleGeo(r), i === ringR.length - 1 ? mid : dim));
  });

  // outer tick-dash marks (major + minor) around the two outer rings
  const majorSeg = [], minorSeg = [];
  const rOut = radius;
  for (let i = 0; i < 360; i += 3) {
    const a = (i * Math.PI) / 180;
    const ca = Math.cos(a), sa = Math.sin(a);
    const major = i % 30 === 0;
    const inner = rOut * (major ? 0.955 : 0.978);
    const tgt = major ? majorSeg : minorSeg;
    tgt.push(ca * inner, sa * inner, 0, ca * rOut, sa * rOut, 0);
  }
  root.add(new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(majorSeg, 3)),
    mid
  ));
  root.add(new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(minorSeg, 3)),
    dim
  ));

  // radial spokes (slow-rotating group)
  const spokes = new THREE.Group();
  const spokeSeg = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    spokeSeg.push(ca * radius * 0.28, sa * radius * 0.28, 0, ca * radius * 0.9, sa * radius * 0.9, 0);
  }
  spokes.add(new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(spokeSeg, 3)),
    dim
  ));
  root.add(spokes);
  scannerDials.push({ grp: spokes, speed: 0.05 });

  // rotating dial arcs (bright, counter-rotating)
  const dialA = new THREE.Group();
  dialA.add(new THREE.Line(arcGeo(radius * 0.5, 0, Math.PI * 0.5), hot));
  dialA.add(new THREE.Line(arcGeo(radius * 0.5, Math.PI, Math.PI * 1.25), hot));
  root.add(dialA);
  scannerDials.push({ grp: dialA, speed: 0.3 });

  const dialB = new THREE.Group();
  dialB.add(new THREE.Line(arcGeo(radius * 0.72, Math.PI * 0.15, Math.PI * 0.75), hot));
  root.add(dialB);
  scannerDials.push({ grp: dialB, speed: -0.18 });

  // center crosshair
  const cross = [];
  const cr = radius * 0.06;
  cross.push(-cr, 0, 0, cr, 0, 0, 0, -cr, 0, 0, cr, 0);
  root.add(new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(cross, 3)),
    mid
  ));
}

// ---- subtle background "data rain" (faint vertical streaks, far behind) -----
function addDataRain() {
  const seg = [];
  const rng = (() => { let s = 20260911; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
  const spanY = Math.max(bsize.y, 8) * 6 + 40;
  for (let i = 0; i < 70; i++) {
    const ang = rng() * Math.PI * 2;
    const rad = 90 + rng() * 60;
    const x = center.x + Math.cos(ang) * rad;
    const z = center.z + Math.sin(ang) * rad;
    const h = spanY * (0.25 + rng() * 0.75);
    const y0 = center.y - spanY * 0.4 + rng() * spanY * 0.3;
    seg.push(x, y0, z, x, y0 + h, z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(seg, 3));
  scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({
    color: 0x2fbdf0, transparent: true, opacity: 0.05,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  })));
}

// ---- build the scene ----
addScanner();
addDataRain();
addFloorPlanes();
addWalks();
addConnectors();
// demo route: shared start spot -> a spot on the upper floor
const r = addRoute({ x: 0, y: 0, z: 0 }, { x: -8, y: 4, z: 14 });

// ---- frame camera on everything ----
const framedSize = box.getSize(new THREE.Vector3()).length();
controls.target.copy(center);
camera.position.set(
  center.x + framedSize * 0.9,
  center.y + framedSize * 0.75,
  center.z + framedSize * 1.0
);

// ---- post-processing (crisp, minimal bloom) ----
const composer = new EffectComposer(renderer);
composer.setPixelRatio(Math.min(devicePixelRatio, 2));
composer.setSize(innerWidth, innerHeight);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(
  new THREE.Vector2(innerWidth, innerHeight),
  0.35, // strength — subtle, keeps lines sharp
  0.4,  // radius
  0.2   // threshold
);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ============================================================================
// EDIT MODE — click-to-name graph nodes, in-scene naming overlay, persistence.
// ============================================================================
// registry: id -> { id, name, floor, x, y, z, lat, lon, nodeKey }
const namedById = new Map();
const markerById = new Map(); // id -> THREE.Group (bright dot + label sprite)
const LS_KEY = "vis-node-registry-v1";
// Raycast tolerance in WORLD meters around each dot. Graph cells are ~1.5m
// apart (buildGraph cellSize); 2.0m is forgiving to click yet we always pick
// the dot whose distance-to-ray is smallest, so overlap never mis-selects.
const NODE_PICK_THRESHOLD = 2.0;
const MATCH_DIST = 1.0;   // snap already-named nodes onto a graph node if <1m
const DRAG_SLOP_PX = 5;   // pointer travel above this = orbit drag, not a click

let editMode = false;
let selectedNode = null;  // graph node currently targeted by the overlay
let supabaseCfg = null;   // resolved once at init

// ---- id slug (same rules as the old standalone node-editor) ----
function slugify(name) {
  const s = String(name).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "node";
}
function uniqueId(name, excludeId) {
  const base = slugify(name);
  let id = base, n = 2;
  const taken = (cand) => {
    for (const key of namedById.keys()) {
      if (key === excludeId) continue;
      if (key === cand) return true;
    }
    return false;
  };
  while (taken(id)) id = `${base}-${n++}`;
  return id;
}

// ---- registry helpers ----
function normRec(n) {
  return {
    id: String(n.id),
    name: n.name != null ? String(n.name) : String(n.id),
    floor: Number.isFinite(n.floor) ? n.floor : 0,
    x: +n.x || 0, y: +n.y || 0, z: +n.z || 0,
    lat: n.lat == null ? null : +n.lat,
    lon: n.lon == null ? null : +n.lon,
    nodeKey: n.nodeKey != null ? String(n.nodeKey) : null,
  };
}
function exportNodes() {
  return [...namedById.values()].map((n) => ({
    id: n.id, name: n.name, floor: n.floor,
    x: n.x, y: n.y, z: n.z, lat: n.lat ?? null, lon: n.lon ?? null,
  }));
}
function saveLocal() {
  try { localStorage.setItem(LS_KEY, JSON.stringify([...namedById.values()])); }
  catch (e) { /* quota / private mode — non-fatal */ }
}
function loadLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const arr = raw ? JSON.parse(raw) : null;
    return Array.isArray(arr) ? arr : null;
  } catch (e) { return null; }
}

function nearestGraphNode(x, y, z, maxDist) {
  let best = null, bestD = maxDist * maxDist;
  for (const gn of graphNodeList) {
    const dx = gn.x - x, dy = gn.y - y, dz = gn.z - z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d <= bestD) { bestD = d; best = gn; }
  }
  return best;
}

// ---- markers (bright dot + label sprite) ----
function disposeGroup(g) {
  g.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      if (o.material.map) o.material.map.dispose();
      o.material.dispose();
    }
  });
}
function removeMarker(id) {
  const g = markerById.get(id);
  if (!g) return;
  namedGroup.remove(g);
  disposeGroup(g);
  markerById.delete(id);
}
function renderMarker(rec) {
  removeMarker(rec.id);
  const g = new THREE.Group();
  g.position.set(rec.x, rec.y, rec.z);
  g.add(new THREE.Mesh(
    new THREE.SphereGeometry(0.42, 16, 16),
    new THREE.MeshBasicMaterial({
      color: ROUTE_COLOR, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })
  ));
  const label = makeLabelSprite(rec.name, `#${hexOf(BLUE_BRIGHT)}`);
  label.scale.multiplyScalar(0.7);
  label.position.set(0, 1.5, 0);
  g.add(label);
  namedGroup.add(g);
  markerById.set(rec.id, g);
}

// attach a registry record to its graph node (by stored key, else nearest),
// snap its coords to the graph-node centroid, and render its marker.
function attachRecord(rec) {
  let gn = rec.nodeKey ? graphNodeByKey.get(rec.nodeKey) : null;
  if (!gn) gn = nearestGraphNode(rec.x, rec.y, rec.z, MATCH_DIST);
  if (gn) {
    rec.nodeKey = gn.key;
    rec.floor = gn.floor; rec.x = gn.x; rec.y = gn.y; rec.z = gn.z;
    gn.namedId = rec.id;
    renderMarker(rec);
  }
  namedById.set(rec.id, rec);
}

// ---- selection ring (thin highlight around the targeted node) ----
const selectionRing = new THREE.Mesh(
  new THREE.TorusGeometry(0.85, 0.05, 8, 40),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 })
);
selectionRing.rotation.x = -Math.PI / 2;
selectionRing.visible = false;
scene.add(selectionRing);

// ---- naming overlay (HTML, positioned near the cursor) ----
const overlay = document.getElementById("edit-overlay");
const eoHead = document.getElementById("eo-head");
const eoName = document.getElementById("eo-name");
const eoIdPreview = document.getElementById("eo-id");
const eoSave = document.getElementById("eo-save");
const eoClear = document.getElementById("eo-clear");
const eoCancel = document.getElementById("eo-cancel");

function updateIdPreview() {
  if (!selectedNode) return;
  const name = eoName.value.trim();
  const exclude = selectedNode.namedId || null;
  eoIdPreview.textContent = name ? uniqueId(name, exclude) : "—";
}
function positionOverlay(px, py) {
  const w = overlay.offsetWidth || 240;
  const h = overlay.offsetHeight || 130;
  let left = px + 14, top = py + 14;
  left = Math.max(10, Math.min(left, innerWidth - w - 10));
  top = Math.max(10, Math.min(top, innerHeight - h - 10));
  overlay.style.left = left + "px";
  overlay.style.top = top + "px";
}
function openOverlay(gn, px, py) {
  selectedNode = gn;
  const rec = gn.namedId ? namedById.get(gn.namedId) : null;
  eoHead.textContent =
    `floor ${gn.floor} · x ${gn.x.toFixed(1)} z ${gn.z.toFixed(1)}` +
    (rec ? "" : " · new");
  eoName.value = rec ? rec.name : "";
  eoClear.style.display = rec ? "" : "none";
  updateIdPreview();
  overlay.style.display = "block";
  positionOverlay(px, py);
  selectionRing.position.set(gn.x, gn.y, gn.z);
  selectionRing.visible = true;
  eoName.focus(); eoName.select();
}
function closeOverlay() {
  overlay.style.display = "none";
  selectionRing.visible = false;
  selectedNode = null;
}

function afterRegistryChange() {
  saveLocal();
  updateNamedCount();
}
function saveOverlay() {
  if (!selectedNode) return;
  const name = eoName.value.trim();
  if (!name) { eoName.focus(); return; }
  const gn = selectedNode;
  let rec;
  if (gn.namedId && namedById.has(gn.namedId)) {
    rec = namedById.get(gn.namedId);
    const newId = uniqueId(name, rec.id);
    if (newId !== rec.id) {
      namedById.delete(rec.id);
      removeMarker(rec.id);
      rec.id = newId;
      namedById.set(newId, rec);
      gn.namedId = newId;
    }
    rec.name = name;
  } else {
    const id = uniqueId(name, null);
    rec = normRec({ id, name, floor: gn.floor, x: gn.x, y: gn.y, z: gn.z, nodeKey: gn.key });
    namedById.set(id, rec);
    gn.namedId = id;
  }
  renderMarker(rec);
  afterRegistryChange();
  closeOverlay();
  if (supabaseCfg) upsertNodes([exportOne(rec)]); // fire-and-forget per-save upsert
}
function clearOverlay() {
  if (!selectedNode || !selectedNode.namedId) return;
  const id = selectedNode.namedId;
  namedById.delete(id);
  removeMarker(id);
  selectedNode.namedId = null;
  afterRegistryChange();
  closeOverlay();
}
const exportOne = (n) => ({
  id: n.id, name: n.name, floor: n.floor,
  x: n.x, y: n.y, z: n.z, lat: n.lat ?? null, lon: n.lon ?? null,
});

// ---- raycast pick against the graph-node Points cloud ----
const raycaster = new THREE.Raycaster();
raycaster.params.Points.threshold = NODE_PICK_THRESHOLD;
const ndc = new THREE.Vector2();
function pickNode(clientX, clientY) {
  if (!graphPoints) return null;
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(graphPoints, false);
  if (!hits.length) return null;
  // intersectObject sorts by distance-along-ray; we want the dot the click is
  // closest to on screen, so re-sort by perpendicular distance-to-ray.
  hits.sort((a, b) => a.distanceToRay - b.distanceToRay);
  return graphNodeList[hits[0].index] || null;
}

// pointer: distinguish a click (name a node) from an orbit drag.
let downX = 0, downY = 0, downBtn = 0;
renderer.domElement.addEventListener("pointerdown", (e) => {
  downX = e.clientX; downY = e.clientY; downBtn = e.button;
});
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!editMode || downBtn !== 0 || e.button !== 0) return;
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > DRAG_SLOP_PX) return; // drag
  const gn = pickNode(e.clientX, e.clientY);
  if (gn) openOverlay(gn, e.clientX, e.clientY);
  else closeOverlay();
});

function setEditMode(on) {
  editMode = on;
  controls.autoRotate = !on;               // stop the spin while aiming
  renderer.domElement.style.cursor = on ? "crosshair" : "";
  const btn = document.getElementById("editToggle");
  if (btn) btn.classList.toggle("on", on);
  if (!on) closeOverlay();
}

function updateNamedCount() {
  const el = document.getElementById("namedCount");
  if (el) el.textContent = namedById.size;
}
function setNodeStatus(msg, warn) {
  const el = document.getElementById("nodeStatus");
  if (!el) return;
  el.textContent = msg || "";
  el.style.color = warn ? "#ff6b6b" : "#6ff0ff";
}

// ---- persistence: Supabase upsert + nodes.json download ----
async function getConfig() {
  try {
    const m = await import("./config.js");
    const url = m.SUPABASE_URL, key = m.SUPABASE_ANON_KEY;
    if (typeof url === "string" && url.startsWith("http") && !url.includes("YOUR-") &&
        typeof key === "string" && key.length > 0 && !key.includes("YOUR-")) {
      // normalize to the BASE project URL (tolerate a stray /rest/v1 or trailing /)
      return { url: url.replace(/\/+$/, "").replace(/\/rest\/v1$/, ""), key };
    }
  } catch (e) { /* no config.js -> not configured */ }
  return null;
}
const NODES_ENDPOINT = (cfg) => `${cfg.url}/rest/v1/nodes`;
async function upsertNodes(rows) {
  if (!supabaseCfg || !rows.length) return;
  setNodeStatus(`Saving ${rows.length} node(s)…`);
  try {
    const res = await fetch(NODES_ENDPOINT(supabaseCfg), {
      method: "POST",
      headers: {
        apikey: supabaseCfg.key,
        Authorization: `Bearer ${supabaseCfg.key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(rows),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} ${await res.text().catch(() => "")}`.trim());
    setNodeStatus(`✓ Saved ${rows.length} node(s) to Supabase.`);
  } catch (e) {
    setNodeStatus(`Supabase save failed: ${e.message}`, true);
    console.error(e);
  }
}
function downloadNodesJson() {
  const doc = {
    frame: "building-local", unit: "meters", up: "y",
    nodes: exportNodes(),
  };
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "nodes.json";
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  setNodeStatus(`Downloaded nodes.json (${doc.nodes.length} node(s)).`);
}

// wire the naming overlay controls
if (overlay) {
  eoSave.onclick = saveOverlay;
  eoClear.onclick = clearOverlay;
  eoCancel.onclick = closeOverlay;
  eoName.addEventListener("input", updateIdPreview);
  eoName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); saveOverlay(); }
    if (e.key === "Escape") { e.preventDefault(); closeOverlay(); }
  });
}

// ---- init named nodes: existing registry, then in-progress local working set
supabaseCfg = await getConfig();
let seedRecords = (await loadNodes().catch(() => [])).map(normRec);
const localSet = loadLocal();
if (localSet) seedRecords = localSet.map(normRec);
for (const rec of seedRecords) attachRecord(rec);

// ---- HUD (instrument readout) ----
const hud = document.getElementById("hud");
if (hud) {
  const routeFloors = r ? [...new Set(r.nodes.map((n) => n.floor))].join(" / ") : "—";
  const routeLen = r ? `${r.length.toFixed(0)} m` : "n/a";
  hud.innerHTML =
    `<div class="corner tl"></div><div class="corner tr"></div>` +
    `<div class="corner bl"></div><div class="corner br"></div>` +
    `<div class="title">◤ INDOOR PATH SCAN</div>` +
    `<div class="stats">` +
      `<span class="k">WALKS</span><span class="v">${walks.length}</span>` +
      `<span class="k">FLOORS</span><span class="v">${floors.levels.length}</span>` +
      `<span class="k">NODES</span><span class="v">${graph.nodes.size}</span>` +
      `<span class="k">NAMED</span><span class="v" id="namedCount">${namedById.size}</span>` +
    `</div>` +
    `<div class="route">` +
      `<span class="rlabel">ROUTE</span><b>${routeLen}</b>` +
      `<span class="dim">LVL ${routeFloors}</span>` +
    `</div>` +
    `<div class="legend">` +
      floors.levels.map((l) =>
        `<span class="chip"><i style="background:#${hexOf(floorColor(l.floor))}"></i>F${l.floor}</span>`
      ).join("") +
    `</div>` +
    `<div class="walks">` +
      `<div class="wlabel">WALKS · S=start E=end</div>` +
      walks.map((w, i) =>
        `<label class="wrow"><input type="checkbox" data-w="${i}" checked>` +
        `<i style="background:#${hexOf(walkColor(i))}"></i>${w.id}</label>`
      ).join("") +
      `<label class="wrow"><input type="checkbox" data-graph checked>graph nodes / stairs</label>` +
    `</div>` +
    `<div class="editctl">` +
      `<button id="editToggle" class="ebtn">✎ Edit nodes</button>` +
      `<div class="ebtns">` +
        `<button id="btnDownload" class="ebtn small">⬇ nodes.json</button>` +
        `<button id="btnSupabase" class="ebtn small">☁ Save nodes</button>` +
      `</div>` +
      `<div id="nodeStatus" class="estatus"></div>` +
    `</div>` +
    `<div class="hint">DRAG ORBIT · SCROLL ZOOM · EDIT = CLICK A DOT TO NAME</div>`;

  // wire per-walk visibility toggles
  hud.querySelectorAll("input[data-w]").forEach((cb) => {
    cb.onchange = () => {
      const i = +cb.dataset.w;
      walkObjects[i].group.visible = cb.checked;
      cb.closest(".wrow").classList.toggle("off", !cb.checked);
    };
  });
  // wire the derived-graph overlay toggle
  const gcb = hud.querySelector("input[data-graph]");
  if (gcb) gcb.onchange = () => {
    graphGroup.visible = gcb.checked;
    gcb.closest(".wrow").classList.toggle("off", !gcb.checked);
  };

  // edit-mode toggle + persistence buttons
  const editBtn = document.getElementById("editToggle");
  if (editBtn) editBtn.onclick = () => setEditMode(!editMode);
  const dlBtn = document.getElementById("btnDownload");
  if (dlBtn) dlBtn.onclick = downloadNodesJson;
  const sbBtn = document.getElementById("btnSupabase");
  if (sbBtn) {
    if (supabaseCfg) {
      sbBtn.onclick = () => upsertNodes(exportNodes());
      sbBtn.title = `upsert into ${NODES_ENDPOINT(supabaseCfg)}`;
    } else {
      sbBtn.disabled = true;
      sbBtn.title = "configure web/config.js first";
    }
  }
}

// ---- loop ----
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  bloom.setSize(innerWidth, innerHeight);
});

const clock = new THREE.Clock();
(function animate() {
  requestAnimationFrame(animate);
  const t = clock.getElapsedTime();
  if (pulse && routeCurve) {
    const u = (t * 0.12) % 1; // ~8s per traversal
    pulse.position.copy(routeCurve.getPointAt(u));
    pulse.scale.setScalar(1 + Math.sin(t * 4) * 0.1);
  }
  for (const d of scannerDials) d.grp.rotation.z = t * d.speed;
  controls.update();
  composer.render();
})();
