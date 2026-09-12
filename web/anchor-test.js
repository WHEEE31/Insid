// Top-down compare: RAW (assume shared start) vs GPS+COMPASS anchored.
// Per-walk visibility toggles + S/E start/end markers. For the first two VISIBLE
// drawable walks, reports mean nearest-neighbor separation in meters.
import { loadWalks } from "./data-loader.js";
import { anchorAll } from "./pipeline/anchor.js";

const COLORS = ["#e0245e", "#1d9bf0", "#17bf63", "#f45d22", "#794bc4", "#ffad1f"];

const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");
let mode = "anchored"; // "raw" | "anchored"

const walks = await loadWalks();
const anchored = anchorAll(walks);
const visible = walks.map(() => true); // per-walk show/hide

// horizontal (x=east, z=north) point lists per mode
function pts(mode) {
  const src = mode === "anchored" ? anchored.walks : walks;
  return src.map((w) => ({
    id: w.id,
    anchoredOK: mode === "anchored" ? w.anchored : true,
    acc: w.startLatLon ? w.startLatLon.gpsAccuracy : null,
    hdg: w.startHeading ? w.startHeading.trueHeading : null,
    xs: w.points.map((p) => p.x),
    zs: w.points.map((p) => p.z),
  }));
}

// mean nearest-neighbor distance between two traces (the lateral gap)
function separation(a, b) {
  const nn = (A, B) => {
    let sum = 0;
    for (let i = 0; i < A.xs.length; i++) {
      let best = Infinity;
      for (let j = 0; j < B.xs.length; j++) {
        const dx = A.xs[i] - B.xs[j], dz = A.zs[i] - B.zs[j];
        const d = dx * dx + dz * dz;
        if (d < best) best = d;
      }
      sum += Math.sqrt(best);
    }
    return sum / A.xs.length;
  };
  return (nn(a, b) + nn(b, a)) / 2;
}

const drawable = (w, i) => visible[i] && !(mode === "anchored" && !w.anchoredOK);

function draw() {
  const dpr = Math.min(devicePixelRatio, 2);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#0d1117";
  ctx.fillRect(0, 0, innerWidth, innerHeight);

  const data = pts(mode);

  // fit bounds to VISIBLE drawable walks only
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  data.forEach((w, i) => {
    if (!drawable(w, i)) return;
    for (let k = 0; k < w.xs.length; k++) {
      minX = Math.min(minX, w.xs[k]); maxX = Math.max(maxX, w.xs[k]);
      minZ = Math.min(minZ, w.zs[k]); maxZ = Math.max(maxZ, w.zs[k]);
    }
  });
  if (!isFinite(minX)) { updateHud(data); return; } // nothing visible

  const pad = 70;
  const spanX = Math.max(1, maxX - minX), spanZ = Math.max(1, maxZ - minZ);
  const scale = Math.min((innerWidth - pad * 2) / spanX, (innerHeight - pad * 2) / spanZ);
  const ox = (innerWidth - spanX * scale) / 2 - minX * scale;
  const oy = (innerHeight - spanZ * scale) / 2 + maxZ * scale;
  const SX = (x) => ox + x * scale;
  const SY = (z) => oy - z * scale; // north up

  // grid every 5m
  ctx.strokeStyle = "#1b2230"; ctx.lineWidth = 1;
  for (let gx = Math.ceil(minX / 5) * 5; gx <= maxX; gx += 5) {
    ctx.beginPath(); ctx.moveTo(SX(gx), 0); ctx.lineTo(SX(gx), innerHeight); ctx.stroke();
  }
  for (let gz = Math.ceil(minZ / 5) * 5; gz <= maxZ; gz += 5) {
    ctx.beginPath(); ctx.moveTo(0, SY(gz)); ctx.lineTo(innerWidth, SY(gz)); ctx.stroke();
  }
  // 5m scale bar
  ctx.strokeStyle = "#5b6b7f"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(20, innerHeight - 24); ctx.lineTo(20 + 5 * scale, innerHeight - 24); ctx.stroke();
  ctx.fillStyle = "#8598ad"; ctx.font = "11px ui-monospace, monospace";
  ctx.fillText("5 m", 20, innerHeight - 30);

  // S/E label helper
  const tag = (x, z, txt, color) => {
    const X = SX(x), Y = SY(z);
    ctx.beginPath(); ctx.arc(X, Y, 4, 0, 7); ctx.fillStyle = color; ctx.fill();
    ctx.font = "bold 14px ui-monospace, monospace";
    ctx.lineWidth = 3; ctx.strokeStyle = "#0d1117";
    ctx.strokeText(txt, X + 7, Y - 7);
    ctx.fillStyle = color; ctx.fillText(txt, X + 7, Y - 7);
  };

  // walks
  data.forEach((w, i) => {
    if (!drawable(w, i)) return;
    const col = COLORS[i % COLORS.length];
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.globalAlpha = 0.9;
    ctx.beginPath();
    for (let k = 0; k < w.xs.length; k++) {
      const X = SX(w.xs[k]), Y = SY(w.zs[k]);
      k ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    tag(w.xs[0], w.zs[0], "S", col);
    tag(w.xs[w.xs.length - 1], w.zs[w.zs.length - 1], "E", col);
  });

  updateHud(data);
}

function updateHud(data) {
  const hud = document.getElementById("hud");
  const shown = data.map((w, i) => (drawable(w, i) ? i : -1)).filter((i) => i >= 0);
  let sep = "";
  if (shown.length === 2) {
    sep = `<div class="sep">separation (${data[shown[0]].id.slice(-3)}↔${data[shown[1]].id.slice(-3)}): <b>${separation(data[shown[0]], data[shown[1]]).toFixed(2)} m</b></div>`;
  } else if (shown.length > 2) {
    sep = `<div class="sep">show exactly 2 walks to measure separation</div>`;
  }
  const rows = data.map((w, i) =>
    `<label class="row ${visible[i] ? "" : "off"}"><input type="checkbox" data-i="${i}" ${visible[i] ? "checked" : ""}>` +
    `<i style="background:${COLORS[i % COLORS.length]}"></i>${w.id}` +
    (w.acc != null ? ` · gps ±${w.acc.toFixed(0)}m` : " · no gps") +
    (w.hdg != null ? ` · hdg ${w.hdg.toFixed(0)}°` : " · no hdg") +
    (mode === "anchored" && !w.anchoredOK ? ` · <span class="warn">NOT anchored</span>` : "") +
    `</label>`
  ).join("");
  hud.innerHTML =
    `<div class="title">ANCHOR TEST — ${mode === "anchored" ? "GPS + COMPASS" : "RAW (shared-origin)"}</div>` +
    sep + rows +
    `<div class="hint">check/uncheck to isolate walks · S = start, E = end</div>`;

  hud.querySelectorAll("input[data-i]").forEach((cb) => {
    cb.onchange = () => { visible[+cb.dataset.i] = cb.checked; draw(); };
  });
}

document.getElementById("raw").onclick = () => { mode = "raw"; draw(); };
document.getElementById("anchored").onclick = () => { mode = "anchored"; draw(); };
addEventListener("resize", draw);
draw();
