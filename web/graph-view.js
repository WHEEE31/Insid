// Graph debug view — plain top-down 2D render of the CONSOLIDATED routing
// graph (graph.js's merged nodes/edges), floor by floor. No three.js, no map
// tiles: just a canvas, so it's fast to load and easy to eyeball things the
// 3D vis makes hard to check at a glance -- edge count, whether any edge is
// longer than the 8ft cap, which floors/buildings exist, node degree.
//
// Owner: D (routing graph), same stream as pipeline/graph.js + db-graph.js.
// Reads the SAME database entry point as the rest of the app
// (loadGraphFromDatabase -> data-loader.js's Supabase/local/synthetic
// fallback), so "refresh to see a new walk" applies here too.

import { loadGraphFromDatabase } from "./pipeline/db-graph.js";
import { DEFAULT_MAX_EDGE_METERS } from "./pipeline/graph.js";

const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");

let graph = null;
let floors = [];
let currentFloor = null;
let buildingColors = new Map();

// view transform: screen = (world - origin) * scale + pan
let scale = 8; // px per meter, adjusted to fit on load
let panX = 0, panY = 0;
let dragging = false, lastX = 0, lastY = 0;
let selected = null;

function resize() {
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  draw();
}
addEventListener("resize", resize);

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  const { x: wx, y: wy } = screenToWorld(e.clientX, e.clientY);
  scale *= factor;
  // keep the point under the cursor fixed
  const s2 = screenFromWorld(wx, wy);
  panX += e.clientX - s2.x;
  panY += e.clientY - s2.y;
  draw();
}, { passive: false });

canvas.addEventListener("mousedown", (e) => {
  dragging = true; lastX = e.clientX; lastY = e.clientY;
});
addEventListener("mouseup", () => { dragging = false; });
addEventListener("mousemove", (e) => {
  if (!dragging) return;
  panX += e.clientX - lastX;
  panY += e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  draw();
});
canvas.addEventListener("click", (e) => {
  if (!graph) return;
  const { x: wx, y: wy } = screenToWorld(e.clientX, e.clientY);
  let best = null, bestD = Infinity;
  for (const n of graph.nodes.values()) {
    if (n.floor !== currentFloor) continue;
    const d = Math.hypot(n.x - wx, n.z - wy);
    if (d < bestD) { bestD = d; best = n; }
  }
  selected = bestD < 1.2 ? best : null; // within ~1.2m of the click
  draw();
});

function screenFromWorld(x, z) {
  return { x: x * scale + panX, y: z * scale + panY };
}
function screenToWorld(sx, sy) {
  return { x: (sx - panX) / scale, y: (sy - panY) / scale };
}

function colorForBuilding(building) {
  const key = building ?? "\0none";
  if (!buildingColors.has(key)) {
    const hue = (buildingColors.size * 67) % 360; // spread distinct hues
    buildingColors.set(key, building == null ? "#5b7c93" : `hsl(${hue} 70% 62%)`);
  }
  return buildingColors.get(key);
}

function fitToFloor() {
  if (!graph) return;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let any = false;
  for (const n of graph.nodes.values()) {
    if (n.floor !== currentFloor) continue;
    any = true;
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minZ = Math.min(minZ, n.z); maxZ = Math.max(maxZ, n.z);
  }
  if (!any) return;
  const w = Math.max(maxX - minX, 1), h = Math.max(maxZ - minZ, 1);
  const pad = 60;
  scale = Math.min((canvas.width - pad * 2) / w, (canvas.height - pad * 2) / h, 40);
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  panX = canvas.width / 2 - cx * scale;
  panY = canvas.height / 2 - cz * scale;
}

function draw() {
  ctx.fillStyle = "#02040a";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!graph || currentFloor == null) return;

  // faint 1m grid
  ctx.strokeStyle = "rgba(63,208,255,0.06)";
  ctx.lineWidth = 1;
  const step = scale; // 1 meter
  const x0 = -panX % step, y0 = -panY % step;
  for (let x = x0; x < canvas.width; x += step) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
  }
  for (let y = y0; y < canvas.height; y += step) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
  }

  const nodesOnFloor = new Set();
  for (const n of graph.nodes.values()) if (n.floor === currentFloor) nodesOnFloor.add(n.key);

  // edges: solid on-floor edges; dashed amber stubs where a vertical
  // connector touches this floor but goes to another one.
  for (const e of graph.edges.values()) {
    const a = graph.nodes.get(e.a), b = graph.nodes.get(e.b);
    if (!a || !b) continue;
    const aOn = a.floor === currentFloor, bOn = b.floor === currentFloor;
    if (!aOn && !bOn) continue;

    if (aOn && bOn) {
      const overCap = e.weight > DEFAULT_MAX_EDGE_METERS + 1e-6;
      ctx.strokeStyle = overCap ? "#ff5d5d" : "rgba(167,236,255,0.55)";
      ctx.lineWidth = overCap ? 2.5 : 1.4;
      const pa = screenFromWorld(a.x, a.z), pb = screenFromWorld(b.x, b.z);
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    } else {
      // stub toward the off-floor endpoint
      const on = aOn ? a : b, off = aOn ? b : a;
      const p = screenFromWorld(on.x, on.z);
      const dirX = off.x - on.x, dirZ = off.z - on.z;
      const len = Math.hypot(dirX, dirZ) || 1;
      const stub = 22; // px, fixed length regardless of real distance
      const ex = p.x + (dirX / len) * stub, ey = p.y + (dirZ / len) * stub;
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "#ffb057";
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#ffb057";
      ctx.font = "10px ui-monospace, monospace";
      ctx.fillText(`F${off.floor}`, ex + 3, ey + 3);
    }
  }

  // nodes
  for (const n of graph.nodes.values()) {
    if (n.floor !== currentFloor) continue;
    const p = screenFromWorld(n.x, n.z);
    ctx.beginPath();
    ctx.arc(p.x, p.y, n.synthetic ? 2.5 : 4, 0, Math.PI * 2);
    ctx.fillStyle = colorForBuilding(n.building);
    ctx.fill();
    if (selected === n) {
      ctx.strokeStyle = "#eafdff";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, Math.PI * 2); ctx.stroke();
    }
  }

  if (selected) drawSelectedPanel();
}

function drawSelectedPanel() {
  const lines = [
    `node ${selected.key}${selected.synthetic ? " (synthetic)" : ""}`,
    `floor ${selected.floor}   building ${selected.building ?? "—"}`,
    `x=${selected.x.toFixed(2)} y=${selected.y.toFixed(2)} z=${selected.z.toFixed(2)}`,
  ];
  let degree = 0, maxW = 0;
  for (const e of graph.edges.values()) {
    if (e.a === selected.key || e.b === selected.key) { degree++; maxW = Math.max(maxW, e.weight); }
  }
  lines.push(`degree ${degree}   longest edge ${maxW.toFixed(2)}m`);

  const padX = 12, padY = 10, lh = 16;
  const w = 340, h = padY * 2 + lh * lines.length;
  const x = canvas.width - w - 16, y = 16;
  ctx.fillStyle = "rgba(4,10,20,0.85)";
  ctx.strokeStyle = "rgba(63,208,255,0.35)";
  ctx.lineWidth = 1;
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = "#cdeeff";
  ctx.font = "12px ui-monospace, monospace";
  lines.forEach((line, i) => ctx.fillText(line, x + padX, y + padY + lh * i + 11));
}

function renderFloorButtons() {
  const el = document.getElementById("floors");
  el.innerHTML = "";
  for (const f of floors) {
    const btn = document.createElement("button");
    btn.textContent = `Floor ${f}`;
    btn.className = f === currentFloor ? "active" : "";
    btn.onclick = () => {
      currentFloor = f;
      selected = null;
      renderFloorButtons();
      fitToFloor();
      draw();
    };
    el.appendChild(btn);
  }
}

function renderLegend(buildingNames) {
  const el = document.getElementById("legend");
  el.innerHTML = "";
  for (const name of buildingNames) {
    const chip = document.createElement("div");
    chip.className = "chip";
    const dot = document.createElement("i");
    dot.style.background = colorForBuilding(name);
    chip.appendChild(dot);
    const label = document.createElement("span");
    label.textContent = name ?? "(no building tag)";
    chip.appendChild(label);
    el.appendChild(chip);
  }
}

async function main() {
  const { graph: g } = await loadGraphFromDatabase({});
  graph = g;

  const floorSet = new Set();
  const buildingSet = new Set();
  let maxEdge = 0;
  for (const n of graph.nodes.values()) { floorSet.add(n.floor); buildingSet.add(n.building ?? null); }
  for (const e of graph.edges.values()) maxEdge = Math.max(maxEdge, e.weight);
  floors = [...floorSet].sort((a, b) => a - b);
  currentFloor = floors[0] ?? 0;

  document.getElementById("stat-nodes").textContent = graph.nodes.size;
  document.getElementById("stat-edges").textContent = graph.edges.size;
  const overCap = maxEdge > DEFAULT_MAX_EDGE_METERS + 1e-6;
  const maxEdgeEl = document.getElementById("stat-maxedge");
  maxEdgeEl.textContent = `${maxEdge.toFixed(2)}m${overCap ? " ⚠" : ""}`;
  maxEdgeEl.className = overCap ? "v warn" : "v";
  document.getElementById("stat-buildings").textContent =
    [...buildingSet].filter((b) => b != null).length || "0 (untagged)";

  renderFloorButtons();
  renderLegend([...buildingSet]);
  resize();
  fitToFloor();
  draw();
}

main().catch((err) => {
  console.error(err);
  document.getElementById("stat-nodes").textContent = "error";
  const msg = document.createElement("div");
  msg.className = "row warn";
  msg.textContent = String(err.message || err);
  document.getElementById("hud").appendChild(msg);
});
