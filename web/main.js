import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { loadWalks } from "./data-loader.js";
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

  // brighter dots at merged graph nodes (the actual "mesh" vertices)
  const npos = [], ncol = [];
  for (const n of graph.nodes.values()) {
    npos.push(n.x, n.y, n.z);
    const c = floorColor(n.floor).lerp(BLUE_BRIGHT, 0.4);
    ncol.push(c.r, c.g, c.b);
  }
  const ngeo = new THREE.BufferGeometry();
  ngeo.setAttribute("position", new THREE.Float32BufferAttribute(npos, 3));
  ngeo.setAttribute("color", new THREE.Float32BufferAttribute(ncol, 3));
  graphGroup.add(new THREE.Points(ngeo, new THREE.PointsMaterial({
    map: dotTexture(), size: 0.75, sizeAttenuation: true,
    vertexColors: true, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending,
  })));
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
    `<div class="hint">DRAG ORBIT · SCROLL ZOOM</div>`;

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
