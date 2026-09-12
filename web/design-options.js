// Design-options preview page (TEMPORARY / throwaway).
//
// Renders the REAL recorded walk data in 4 selectable visual treatments so we
// can pick a direction for the live vis. Does NOT touch main.js / index.html /
// vis-helpers.js — it only *reads* the shared data-loader + pipeline exports.
//
// One shared WebGLRenderer + scene + camera; switching a style disposes the
// previous scene contents and rebuilds. Thicker "sketch" lines use the
// three r160 lines addon (Line2 / LineSegments2 / LineMaterial / LineGeometry /
// LineSegmentsGeometry) since WebGL LineBasicMaterial.linewidth is 1px-clamped.
// Pure static site: only `three` + `three/addons/*`, all textures made in-canvas.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { loadWalks } from "./data-loader.js";
import { annotateFloors } from "./pipeline/floors.js";
import { buildGraph, route } from "./pipeline/graph.js";

// ---------------------------------------------------------------------------
// 1. Load + process the real data (identical contract to main.js)
// ---------------------------------------------------------------------------
const walks = await loadWalks();
const floors = annotateFloors(walks);
const graph = buildGraph(walks);

// ---------------------------------------------------------------------------
// 2. Precompute style-independent geometry ONCE
// ---------------------------------------------------------------------------
// Per-floor xz extent + a representative render-space altitude (mean point.y of
// the points assigned to that floor) so floor plates sit *with* their paths.
const floorAgg = new Map();
for (const w of walks) {
  for (const p of w.points) {
    const f = p.floor || 0;
    let b = floorAgg.get(f);
    if (!b) {
      b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, sumY: 0, n: 0 };
      floorAgg.set(f, b);
    }
    b.minX = Math.min(b.minX, p.x); b.maxX = Math.max(b.maxX, p.x);
    b.minZ = Math.min(b.minZ, p.z); b.maxZ = Math.max(b.maxZ, p.z);
    b.sumY += p.y; b.n += 1;
  }
}
const PAD = 3.0;
const floorRects = [...floorAgg.entries()]
  .map(([floor, b]) => ({
    floor,
    y: b.sumY / b.n,
    minX: b.minX - PAD, maxX: b.maxX + PAD,
    minZ: b.minZ - PAD, maxZ: b.maxZ + PAD,
    cx: (b.minX + b.maxX) / 2,
    cz: (b.minZ + b.maxZ) / 2,
  }))
  .sort((a, b) => a.y - b.y);

// Walk polylines (flat xyz arrays).
const walkLines = walks
  .filter((w) => w.points.length >= 2)
  .map((w) => {
    const flat = [];
    for (const p of w.points) flat.push(p.x, p.y, p.z);
    return flat;
  });

// Graph node positions (the merged "vertices").
const nodePts = [...graph.nodes.values()].map((n) => ({ x: n.x, y: n.y, z: n.z, floor: n.floor }));

// Vertical connectors (stairs / elevators) + tick crossbars along each climb.
const connectorSegs = [];
const connectorTicks = [];
for (const e of graph.edges.values()) {
  if (!e.vertical) continue;
  const a = graph.nodes.get(e.a);
  const b = graph.nodes.get(e.b);
  connectorSegs.push(a.x, a.y, a.z, b.x, b.y, b.z);
  for (const u of [0.25, 0.5, 0.75]) {
    const x = a.x + (b.x - a.x) * u;
    const y = a.y + (b.y - a.y) * u;
    const z = a.z + (b.z - a.z) * u;
    connectorTicks.push(x - 0.35, y, z, x + 0.35, y, z);
  }
}

// Demo route: first -> last recorded position (spans floors + the connector).
const allPts = walks.flatMap((w) => w.points);
const routeResult = allPts.length
  ? route(
      graph,
      { x: allPts[0].x, y: allPts[0].y, z: allPts[0].z },
      { x: allPts[allPts.length - 1].x, y: allPts[allPts.length - 1].y, z: allPts[allPts.length - 1].z }
    )
  : null;
const routePts = routeResult && routeResult.nodes.length >= 2
  ? routeResult.nodes.map((n) => new THREE.Vector3(n.x, n.y, n.z))
  : [];

// Overall bounds for framing + relative sizing.
const box = new THREE.Box3();
for (const w of walks) for (const p of w.points) box.expandByPoint(new THREE.Vector3(p.x, p.y, p.z));
const center = box.getCenter(new THREE.Vector3());
const sizeLen = box.getSize(new THREE.Vector3()).length() || 30;
const unit = Math.max(0.3, sizeLen * 0.012);            // crosshair / reticle base size
const yLo = floorRects.length ? floorRects[0].y : box.min.y;
const yHi = floorRects.length ? floorRects[floorRects.length - 1].y : box.max.y;
const uMinX = Math.min(...floorRects.map((f) => f.minX));
const uMaxX = Math.max(...floorRects.map((f) => f.maxX));
const uMinZ = Math.min(...floorRects.map((f) => f.minZ));
const uMaxZ = Math.max(...floorRects.map((f) => f.maxZ));

// Seeded RNG so the hand-drawn jitter is stable frame-to-frame.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// 3. Canvas texture helpers (offline / CSP-safe)
// ---------------------------------------------------------------------------
function solidBg(hex) {
  return { value: new THREE.Color(hex), tex: null };
}
// Off-white paper with faint grain + a whisper of vignette.
function paperBg(base) {
  const size = 512;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  g.fillStyle = base;
  g.fillRect(0, 0, size, size);
  const rng = mulberry32(1234567);
  for (let i = 0; i < 14000; i++) {
    const x = rng() * size, y = rng() * size;
    const v = rng();
    g.fillStyle = v > 0.5
      ? `rgba(0,0,0,${(v - 0.5) * 0.05})`
      : `rgba(255,255,255,${(0.5 - v) * 0.06})`;
    g.fillRect(x, y, 1, 1);
  }
  const grad = g.createRadialGradient(size / 2, size / 2, size * 0.1, size / 2, size / 2, size * 0.72);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(60,55,40,0.10)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return { value: tex, tex };
}
// Blueprint blue with a very faint fibre texture.
function blueprintBg(base) {
  const size = 512;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  g.fillStyle = base;
  g.fillRect(0, 0, size, size);
  const rng = mulberry32(99);
  for (let i = 0; i < 9000; i++) {
    const x = rng() * size, y = rng() * size;
    g.fillStyle = `rgba(255,255,255,${rng() * 0.03})`;
    g.fillRect(x, y, 1, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return { value: tex, tex };
}
// Drafting-style label sprite (thin uppercase, small, style-tinted).
function makeLabel(text, opts) {
  const { color, bg, border, rounded = false, fontPx = 40 } = opts;
  const label = String(text).toUpperCase();
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  const font = `500 ${fontPx}px ui-monospace, "SF Mono", Menlo, monospace`;
  ctx.font = font;
  const pad = fontPx * 0.55;
  const textW = ctx.measureText(label).width;
  const w = Math.ceil(textW + pad * 2);
  const h = Math.ceil(fontPx + pad * 1.2);
  c.width = w; c.height = h;

  ctx.font = font;
  const r = rounded ? h * 0.28 : 0;
  if (bg) {
    ctx.fillStyle = bg;
    roundRect(ctx, 1, 1, w - 2, h - 2, r);
    ctx.fill();
  }
  if (border) {
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = border;
    roundRect(ctx, 1, 1, w - 2, h - 2, r);
    ctx.stroke();
  }
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  // manual letter-spacing for a drafting feel
  let x = pad;
  const ls = fontPx * 0.06;
  for (const ch of label) {
    ctx.fillText(ch, x, h / 2 + 1);
    x += ctx.measureText(ch).width + ls;
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: true });
  const sprite = new THREE.Sprite(mat);
  const worldH = Math.max(1.4, sizeLen * 0.05);
  sprite.scale.set(worldH * (w / h), worldH, 1);
  return sprite;
}
function roundRect(ctx, x, y, w, h, r) {
  if (r <= 0) { ctx.beginPath(); ctx.rect(x, y, w, h); return; }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// 4. Style configs
// ---------------------------------------------------------------------------
const STYLES = [
  {
    id: "sketch",
    name: "Architectural Pencil Sketch",
    desc: "Graphite lines on off-white paper with drafting construction guides, crosshair ticks and a restrained red-pencil route.",
    bg: () => paperBg("#f4f2ea"),
    floorLine: "#2b2b2b", floorLineW: 1.6,
    fill: null,
    pathColor: "#242424", pathW: 2.4,
    routeColor: "#b5341f", routeW: 2.8,
    connector: "#2b2b2b", connectorW: 2.0,
    guides: true, guideColor: "#b9b3a4", guideW: 1.0, guideDashed: true,
    nodeColor: "#6f6a60", nodeW: 1.2,
    overrun: unit * 1.4,
    jitter: sizeLen * 0.006,
    label: { color: "#2b2b2b", bg: "rgba(244,242,234,0.55)", border: "#8f8a7c" },
    reticleStart: "#242424", reticleEnd: "#b5341f",
  },
  {
    id: "blueprint",
    name: "Classic Blueprint",
    desc: "Deep blueprint-blue paper with thin cyan-white ink, dashed reference guides and a lighter-tint route.",
    bg: () => blueprintBg("#0d2c66"),
    floorLine: "#cfe6ff", floorLineW: 1.5,
    fill: null,
    pathColor: "#eaf4ff", pathW: 2.2,
    routeColor: "#8fd6ff", routeW: 2.8,
    connector: "#cfe6ff", connectorW: 2.0,
    guides: true, guideColor: "#6f9be0", guideW: 1.0, guideDashed: true,
    nodeColor: "#a9c9f2", nodeW: 1.1,
    overrun: 0,
    jitter: 0,
    label: { color: "#eaf4ff", bg: "rgba(9,28,70,0.6)", border: "#7fb0e8" },
    reticleStart: "#eaf4ff", reticleEnd: "#8fd6ff",
  },
  {
    id: "modern",
    name: "Clean Modern Map",
    desc: "Light neutral background, soft gray floor plates and a bold Google-Maps-style blue route. Friendly and product-y.",
    bg: () => solidBg("#eef1f5"),
    floorLine: "#c2c8d0", floorLineW: 1.6,
    fill: "#d9dee5", fillOpacity: 0.55,
    pathColor: "#8a94a3", pathW: 2.6,
    routeColor: "#1a73e8", routeW: 5.0,
    connector: "#9aa3b1", connectorW: 3.0,
    guides: false, nodeColor: "#aab2be", nodeW: 1.4, nodeDots: true,
    overrun: 0,
    jitter: 0,
    label: { color: "#3c4655", bg: "rgba(255,255,255,0.92)", border: "#d3d8e0", rounded: true },
    reticleStart: "#5b6675", reticleEnd: "#1a73e8",
  },
  {
    id: "darkink",
    name: "Dark Ink / Architectural Dark",
    desc: "Near-black background with thin white ink (inverted sketch) and a single restrained amber accent route. Minimal and elegant.",
    bg: () => solidBg("#0b0d10"),
    floorLine: "#e8e8e8", floorLineW: 1.4,
    fill: null,
    pathColor: "#cfcfcf", pathW: 2.1,
    routeColor: "#d98c4a", routeW: 2.6,
    connector: "#e8e8e8", connectorW: 1.9,
    guides: true, guideColor: "#3b414a", guideW: 1.0, guideDashed: true,
    nodeColor: "#727a84", nodeW: 1.1,
    overrun: unit * 0.9,
    jitter: 0,
    label: { color: "#e8e8e8", bg: "rgba(16,18,22,0.6)", border: "#3f454e" },
    reticleStart: "#cfcfcf", reticleEnd: "#d98c4a",
  },
];

// ---------------------------------------------------------------------------
// 5. Renderer / scene / camera / controls (shared, persistent)
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(56, innerWidth / innerHeight, 0.1, 8000);
camera.position.set(center.x + sizeLen * 0.85, center.y + sizeLen * 0.6, center.z + sizeLen * 0.95);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.5;
controls.minDistance = Math.max(3, sizeLen * 0.15);
controls.maxDistance = sizeLen * 6;
controls.target.copy(center);

// ---------------------------------------------------------------------------
// 6. Build / dispose a styled scene
// ---------------------------------------------------------------------------
let current = null;

function jitterFlat(flat, amp, rng) {
  if (!amp) return flat;
  const out = new Array(flat.length);
  for (let i = 0; i < flat.length; i += 3) {
    out[i] = flat[i] + (rng() * 2 - 1) * amp;
    out[i + 1] = flat[i + 1];
    out[i + 2] = flat[i + 2] + (rng() * 2 - 1) * amp;
  }
  return out;
}
function circleFlat(cx, cz, y, r, segs = 48) {
  const a = [];
  for (let i = 0; i <= segs; i++) {
    const t = (i / segs) * Math.PI * 2;
    a.push(cx + Math.cos(t) * r, y, cz + Math.sin(t) * r);
  }
  return a;
}

function buildStyle(cfg) {
  const root = new THREE.Group();
  const lineMats = [];
  const rng = mulberry32(20260911);

  const mkLineMat = (color, width, opts = {}) => {
    const m = new LineMaterial({
      color: new THREE.Color(color),
      linewidth: width,
      transparent: opts.opacity != null,
      opacity: opts.opacity != null ? opts.opacity : 1,
      dashed: !!opts.dashed,
      dashSize: opts.dashSize || unit * 1.2,
      gapSize: opts.gapSize || unit * 0.9,
    });
    m.resolution.set(innerWidth, innerHeight);
    lineMats.push(m);
    return m;
  };
  const addLine = (flat, mat, dashed = false) => {
    const g = new LineGeometry();
    g.setPositions(flat);
    const l = new Line2(g, mat);
    if (dashed) l.computeLineDistances();
    root.add(l);
    return l;
  };
  const addSegs = (flat, mat, dashed = false) => {
    if (!flat.length) return null;
    const g = new LineSegmentsGeometry();
    g.setPositions(flat);
    const s = new LineSegments2(g, mat);
    if (dashed) s.computeLineDistances();
    root.add(s);
    return s;
  };

  // shared materials
  const floorMat = mkLineMat(cfg.floorLine, cfg.floorLineW);
  const pathMat = mkLineMat(cfg.pathColor, cfg.pathW);
  const routeMat = mkLineMat(cfg.routeColor, cfg.routeW);
  const connMat = mkLineMat(cfg.connector, cfg.connectorW);
  const guideMat = cfg.guides ? mkLineMat(cfg.guideColor, cfg.guideW, { opacity: 0.75, dashed: !!cfg.guideDashed }) : null;
  const guideSolidMat = cfg.guides ? mkLineMat(cfg.guideColor, cfg.guideW, { opacity: 0.85 }) : null;

  // ---- floor plates ----
  for (const fr of floorRects) {
    const { y, minX, maxX, minZ, maxZ } = fr;
    // soft fill (modern)
    if (cfg.fill) {
      const w = maxX - minX, d = maxZ - minZ;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(w, d),
        new THREE.MeshBasicMaterial({
          color: new THREE.Color(cfg.fill),
          transparent: true, opacity: cfg.fillOpacity != null ? cfg.fillOpacity : 0.5,
          side: THREE.DoubleSide, depthWrite: false,
        })
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set((minX + maxX) / 2, y - unit * 0.4, (minZ + maxZ) / 2);
      root.add(mesh);
    }
    // rectangle edges (with drafting overrun that crosses at the corners)
    const o = cfg.overrun || 0;
    let edges = [
      minX - o, y, minZ, maxX + o, y, minZ,
      minX - o, y, maxZ, maxX + o, y, maxZ,
      minX, y, minZ - o, minX, y, maxZ + o,
      maxX, y, minZ - o, maxX, y, maxZ + o,
    ];
    edges = jitterFlat(edges, cfg.jitter, rng);
    addSegs(edges, floorMat);
  }

  // ---- drafting construction guides ----
  if (cfg.guides) {
    // vertical dashed references linking the stacked floor corners
    if (floorRects.length > 1) {
      const vseg = [];
      const ext = unit * 2;
      for (const [x, z] of [[uMinX, uMinZ], [uMaxX, uMinZ], [uMinX, uMaxZ], [uMaxX, uMaxZ]]) {
        vseg.push(x, yLo - ext, z, x, yHi + ext, z);
      }
      addSegs(vseg, guideMat, !!cfg.guideDashed);
    }
    // faint reference extension lines reaching beyond the plates on each floor
    const rseg = [];
    const reach = Math.max(uMaxX - uMinX, uMaxZ - uMinZ) * 0.12 + unit * 2;
    for (const fr of floorRects) {
      const { y, minX, maxX, minZ, maxZ } = fr;
      rseg.push(minX - reach, y, minZ, minX, y, minZ);
      rseg.push(maxX, y, maxZ, maxX + reach, y, maxZ);
      rseg.push(minX, y, minZ - reach, minX, y, minZ);
      rseg.push(maxX, y, maxZ, maxX, y, maxZ + reach);
    }
    addSegs(rseg, guideMat, !!cfg.guideDashed);
    // crosshair ticks at every graph node (the drafting "points of interest")
    const cseg = [];
    const t = unit * 0.9;
    for (const n of nodePts) {
      cseg.push(n.x - t, n.y, n.z, n.x + t, n.y, n.z);
      cseg.push(n.x, n.y, n.z - t, n.x, n.y, n.z + t);
    }
    addSegs(cseg, guideSolidMat);
  }

  // ---- node dots (modern) ----
  if (cfg.nodeDots) {
    const pos = [];
    for (const n of nodePts) pos.push(n.x, n.y, n.z);
    const pgeo = new THREE.BufferGeometry();
    pgeo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    const pmat = new THREE.PointsMaterial({
      color: new THREE.Color(cfg.nodeColor), size: unit * 1.3, sizeAttenuation: true,
    });
    root.add(new THREE.Points(pgeo, pmat));
  }

  // ---- walk paths ----
  for (const wl of walkLines) {
    const flat = jitterFlat(wl, cfg.jitter, rng);
    addLine(flat, pathMat);
  }

  // ---- vertical connectors (stairs) ----
  if (connectorSegs.length) addSegs(connectorSegs, connMat);
  if (connectorTicks.length) addSegs(connectorTicks, connMat);

  // ---- animated route ----
  let pulse = null, routeCurve = null;
  if (routePts.length >= 2) {
    routeCurve = new THREE.CatmullRomCurve3(routePts);
    const samples = routeCurve.getPoints(routePts.length * 10);
    const flat = [];
    for (const p of samples) flat.push(p.x, p.y, p.z);
    addLine(flat, routeMat);

    // start / end reticles (ring + crosshair)
    const reticle = (p, color) => {
      const mat = mkLineMat(color, Math.max(1.4, cfg.routeW * 0.6), { opacity: 0.95 });
      addLine(circleFlat(p.x, p.z, p.y, unit * 1.6), mat);
      const t = unit * 2.2, gap = unit * 1.0;
      addSegs([
        p.x - t, p.y, p.z, p.x - gap, p.y, p.z,
        p.x + gap, p.y, p.z, p.x + t, p.y, p.z,
        p.x, p.y, p.z - t, p.x, p.y, p.z - gap,
        p.x, p.y, p.z + gap, p.x, p.y, p.z + t,
      ], mat);
    };
    reticle(routePts[0], cfg.reticleStart);
    reticle(routePts[routePts.length - 1], cfg.reticleEnd);

    // traveling marker: crisp core + flat ring
    pulse = new THREE.Group();
    const rCore = Math.max(0.18, unit * 0.9);
    pulse.add(new THREE.Mesh(
      new THREE.SphereGeometry(rCore, 20, 20),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(cfg.routeColor) })
    ));
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(rCore * 2.0, rCore * 0.16, 10, 36),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(cfg.routeColor), transparent: true, opacity: 0.85 })
    );
    ring.rotation.x = -Math.PI / 2;
    pulse.add(ring);
    root.add(pulse);
  }

  // ---- floor labels (drafting tags) ----
  for (const fr of floorRects) {
    const label = makeLabel(`Level ${fr.floor}`, cfg.label);
    label.position.set(fr.minX, fr.y + Math.max(1.2, sizeLen * 0.04), fr.minZ);
    root.add(label);
  }

  scene.add(root);
  return { root, lineMats, pulse, routeCurve, bg: cfg.bg() };
}

function disposeCurrent() {
  if (!current) return;
  scene.remove(current.root);
  current.root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      if (m.map) m.map.dispose();
      m.dispose();
    }
  });
  if (current.bg && current.bg.tex) current.bg.tex.dispose();
  scene.background = null;
  current = null;
}

function switchStyle(idx) {
  const cfg = STYLES[idx];
  disposeCurrent();
  current = buildStyle(cfg);
  scene.background = current.bg.value;

  // caption + active tab
  const cap = document.getElementById("caption");
  if (cap) {
    cap.querySelector(".cap-name").textContent = cfg.name;
    cap.querySelector(".cap-desc").textContent = cfg.desc;
    cap.querySelector(".cap-num").textContent = `${idx + 1} / ${STYLES.length}`;
  }
  for (const btn of document.querySelectorAll("#tabs button")) {
    btn.classList.toggle("active", Number(btn.dataset.idx) === idx);
  }
}

// ---------------------------------------------------------------------------
// 7. UI wiring (tab bar built from STYLES = single source of truth)
// ---------------------------------------------------------------------------
const tabs = document.getElementById("tabs");
STYLES.forEach((s, i) => {
  const b = document.createElement("button");
  b.textContent = s.name;
  b.dataset.idx = String(i);
  b.addEventListener("click", () => switchStyle(i));
  tabs.appendChild(b);
});

// stats line in the caption
const statsEl = document.getElementById("stats");
if (statsEl) {
  const routeLen = routeResult ? `${routeResult.length.toFixed(0)} m` : "n/a";
  statsEl.textContent = `${walks.length} walk(s) · ${floors.levels.length} floor(s) · ${graph.nodes.size} nodes · route ${routeLen}`;
}

// ---------------------------------------------------------------------------
// 8. Resize + animation loop
// ---------------------------------------------------------------------------
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  if (current) for (const m of current.lineMats) m.resolution.set(innerWidth, innerHeight);
});

const clock = new THREE.Clock();
(function animate() {
  requestAnimationFrame(animate);
  const t = clock.getElapsedTime();
  if (current && current.pulse && current.routeCurve) {
    const u = (t * 0.11) % 1; // ~9s per traversal
    current.pulse.position.copy(current.routeCurve.getPointAt(u));
    current.pulse.scale.setScalar(1 + Math.sin(t * 4) * 0.12);
  }
  controls.update();
  renderer.render(scene, camera);
})();

// initial style: the pencil sketch (the priority)
switchStyle(0);
