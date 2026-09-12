// Visual helpers for the indoor-path vis — holographic-blueprint / HUD-scanner
// aesthetic. Pure three.js + canvas textures, no external assets, so it stays
// offline / CSP-safe. All textures are generated at runtime from a 2D canvas and
// reused; monochrome (white-on-transparent) so materials tint them per floor.

import * as THREE from "three";

// ---- deep-navy radial vignette (used as scene.background) ------------------
export function makeBackgroundTexture() {
  const size = 512;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(
    size / 2, size * 0.42, size * 0.04,
    size / 2, size / 2, size * 0.72
  );
  grad.addColorStop(0.0, "#0b1a2e"); // faint cool core glow
  grad.addColorStop(0.45, "#060f1e");
  grad.addColorStop(1.0, "#02040a"); // near-black edges (vignette)
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ---- crisp round vertex dot (for THREE.Points point-cloud) -----------------
let _dot = null;
export function dotTexture() {
  if (_dot) return _dot;
  const size = 64;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(
    size / 2, size / 2, 0,
    size / 2, size / 2, size / 2
  );
  grad.addColorStop(0.0, "rgba(255,255,255,1)");
  grad.addColorStop(0.32, "rgba(255,255,255,0.95)");
  grad.addColorStop(0.6, "rgba(255,255,255,0.35)");
  grad.addColorStop(1.0, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  _dot = new THREE.CanvasTexture(c);
  _dot.colorSpace = THREE.SRGBColorSpace;
  _dot.needsUpdate = true;
  return _dot;
}

// ---- thin blueprint grid cell (repeated across a floor plane) --------------
// White thin lines on transparent so the material color tints them per floor.
let _grid = null;
export function gridLineTexture() {
  if (_grid) return _grid;
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  g.clearRect(0, 0, size, size);
  g.strokeStyle = "rgba(255,255,255,0.55)";
  g.lineWidth = 1;
  // draw on two edges only -> tiles into a continuous grid
  g.beginPath();
  g.moveTo(0.5, 0);
  g.lineTo(0.5, size);
  g.moveTo(0, 0.5);
  g.lineTo(size, 0.5);
  g.stroke();
  _grid = new THREE.CanvasTexture(c);
  _grid.colorSpace = THREE.SRGBColorSpace;
  _grid.wrapS = _grid.wrapT = THREE.RepeatWrapping;
  _grid.needsUpdate = true;
  return _grid;
}

// ---- technical HUD label as a sprite ---------------------------------------
// Sharp-cornered instrument tag: thin cyan border, corner ticks, monospace
// uppercase text. hex is a numeric color (e.g. 0x38bdf8) for border + accent.
export function makeLabelSprite(text, hex, opts = {}) {
  const { fontPx = 52, pad = 22 } = opts;
  const label = String(text).toUpperCase();
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  const font = `600 ${fontPx}px ui-monospace, "SF Mono", Menlo, monospace`;
  ctx.font = font;
  const dotW = fontPx * 1.1;
  const textW = ctx.measureText(label).width;
  const w = Math.ceil(dotW + textW + pad * 2);
  const h = Math.ceil(fontPx + pad * 2);
  c.width = w;
  c.height = h;

  const col = new THREE.Color(hex);
  const cssCol = `rgb(${(col.r * 255) | 0},${(col.g * 255) | 0},${(col.b * 255) | 0})`;

  // translucent near-black panel (sharp corners)
  ctx.fillStyle = "rgba(4,10,20,0.72)";
  ctx.fillRect(0, 0, w, h);

  // thin border
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = cssCol;
  ctx.globalAlpha = 0.55;
  ctx.strokeRect(1, 1, w - 2, h - 2);
  ctx.globalAlpha = 1;

  // corner-bracket ticks
  const tick = Math.min(w, h) * 0.16;
  ctx.strokeStyle = cssCol;
  ctx.lineWidth = 2;
  const corners = [
    [2, 2, 1, 1], [w - 2, 2, -1, 1],
    [2, h - 2, 1, -1], [w - 2, h - 2, -1, -1],
  ];
  ctx.beginPath();
  for (const [x, y, sx, sy] of corners) {
    ctx.moveTo(x, y); ctx.lineTo(x + tick * sx, y);
    ctx.moveTo(x, y); ctx.lineTo(x, y + tick * sy);
  }
  ctx.stroke();

  // accent square (not a soft dot)
  ctx.fillStyle = cssCol;
  ctx.fillRect(pad + dotW * 0.18, h / 2 - fontPx * 0.22, fontPx * 0.44, fontPx * 0.44);

  // text
  ctx.font = font;
  ctx.fillStyle = "#d6f6ff";
  ctx.textBaseline = "middle";
  ctx.fillText(label, pad + dotW, h / 2 + 2);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;

  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });
  const sprite = new THREE.Sprite(mat);
  const worldH = 2.0;
  sprite.scale.set(worldH * (w / h), worldH, 1);
  return sprite;
}
