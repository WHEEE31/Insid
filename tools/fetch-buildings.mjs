// Regenerate web/data/buildings.json from OpenStreetMap.
//
//   node tools/fetch-buildings.mjs
//
// The collector types a building name mid-walk ("Roberts"); the app has to turn
// that into a specific building. That needs a gazetteer of real buildings with
// real coordinates, which is exactly what OSM has — so we pull it rather than
// hand-typing coordinates we'd get wrong.
//
// Scoped to a radius around the CMU academic core. Buildings outside it are
// dropped, which is what lets "Roberts" resolve unambiguously: we already know
// the collector is on this campus, not some other one.

import { writeFileSync } from "node:fs";

const CENTER = { lat: 40.4433, lon: -79.9436 }; // CMU academic core
const RADIUS_M = 750;
const BBOX = [40.4380, -79.9520, 40.4490, -79.9370];

// Local usage that isn't derivable from the OSM name.
const EXTRA_ALIASES = {
  "Cohon University Center": ["uc", "cuc", "cohon"],
  "Gates and Hillman Centers": ["ghc", "gates", "hillman"],
  "Newell-Simon Hall": ["nsh", "newell", "simon"],
  "College of Fine Arts": ["cfa"],
  "Margaret Morrison Carnegie Hall": ["mm", "mmch", "margaret morrison"],
  "Hamerschlag Hall": ["ham", "hh"],
  "Tepper School of Business": ["tepper"],
  "Roberts Engineering Hall": ["roberts"],
  "Wean Hall": ["wean", "wh"],
  "Doherty Hall": ["doherty", "dh"],
  "Purnell Center for the Arts": ["purnell", "pca"],
  "Mellon Institute": ["mi"],
};

const STOP = new Set(["and", "of", "for", "the", "at", "de"]);
const SUFFIX = /\s+(hall|center|centre|centers|building|house|library|institute)$/i;

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function aliasesFor(name) {
  const out = new Set();
  const lower = name.toLowerCase();
  out.add(lower);
  const noSuffix = lower.replace(SUFFIX, "").trim();
  if (noSuffix && noSuffix !== lower) out.add(noSuffix);
  const words = lower.split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w));
  if (words[0]) out.add(words[0]);
  if (words.length > 1) out.add(words.map((w) => w[0]).join(""));
  for (const a of EXTRA_ALIASES[name] || []) out.add(a.toLowerCase());
  return [...out];
}

const metersBetween = (a, b) => {
  const mLat = 111320, mLon = 111320 * Math.cos(CENTER.lat * Math.PI / 180);
  return Math.hypot((a.lat - b.lat) * mLat, (a.lon - b.lon) * mLon);
};

const query = `[out:json][timeout:60];
(
  way["building"](${BBOX.join(",")});
  relation["building"](${BBOX.join(",")});
);
out tags center;`;

const res = await fetch("https://overpass-api.de/api/interpreter", {
  method: "POST",
  // Overpass rejects requests without a User-Agent with 406 Not Acceptable.
  headers: { "Content-Type": "text/plain", "User-Agent": "hackcmu-indoor-mapping/1.0" },
  body: query,
});
if (!res.ok) throw new Error(`Overpass failed: ${res.status} ${res.statusText}`);
const data = await res.json();

// Merge duplicate ways that share a name (OSM often splits a building up).
const byName = new Map();
for (const el of data.elements) {
  const name = el.tags?.name;
  if (!name || !el.center) continue;
  if (metersBetween(el.center, CENTER) > RADIUS_M) continue;
  const rec = byName.get(name) || { name, lat: 0, lon: 0, n: 0, levels: null, osmIds: [] };
  rec.lat += el.center.lat;
  rec.lon += el.center.lon;
  rec.n += 1;
  rec.osmIds.push(`${el.type}/${el.id}`);
  const lv = parseInt(el.tags["building:levels"], 10);
  if (Number.isFinite(lv)) rec.levels = Math.max(rec.levels ?? 0, lv);
  byName.set(name, rec);
}

const buildings = [...byName.values()]
  .map((r) => ({
    id: slug(r.name),
    name: r.name,
    aliases: aliasesFor(r.name),
    lat: +(r.lat / r.n).toFixed(6),
    lon: +(r.lon / r.n).toFixed(6),
    levels: r.levels,
    // Per-building floor height, learned from collectors' declared floors
    // (see web/pipeline/building-floors.js). null = use the default until
    // enough declarations exist to solve for it.
    floorHeightM: null,
    osmIds: r.osmIds,
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

const doc = {
  source: "OpenStreetMap via Overpass API (ODbL)",
  generatedBy: "tools/fetch-buildings.mjs",
  generatedAt: new Date().toISOString(),
  center: CENTER,
  radiusM: RADIUS_M,
  note: "Coordinates are OSM building centroids, not entrances. Entrance positions come from collectors' GPS fixes at record time.",
  buildings,
};

writeFileSync(new URL("../web/data/buildings.json", import.meta.url), JSON.stringify(doc, null, 2) + "\n");
console.log(`wrote ${buildings.length} buildings to web/data/buildings.json`);
