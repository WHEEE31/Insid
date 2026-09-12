// Building gazetteer + name resolution.
// Owner: D. Data: web/data/buildings.json (regenerate: node tools/fetch-buildings.mjs).
//
// The collector declares a building by typing a name mid-walk ("Roberts"), so
// something has to turn that into a specific building. Two signals do it:
//   1. the name itself, matched against OSM names + derived aliases
//   2. where the collector actually is — the gazetteer only covers this campus,
//      so "Roberts" can't collide with a Roberts on some other campus, and a
//      GPS fix breaks ties between similarly-named buildings nearby.
//
// Resolution returns RANKED CANDIDATES rather than one answer: the collector
// confirms from a short list, so a wrong guess costs a tap, not a bad walk.

const DEFAULT_URL = "./data/buildings.json";

let _cache;
export async function loadBuildings(url = DEFAULT_URL) {
  if (_cache) return _cache;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`buildings.json ${res.status}`);
    const doc = await res.json();
    _cache = Array.isArray(doc?.buildings) ? doc.buildings : [];
  } catch (e) {
    console.warn("[buildings] could not load gazetteer:", e.message);
    _cache = [];
  }
  return _cache;
}

export function buildingById(buildings, id) {
  return (buildings || []).find((b) => b.id === id) || null;
}

const normalize = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

// Levenshtein, capped — we only care about near-misses ("robert", "robrets").
function editDistance(a, b, cap = 4) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

// How well one alias matches the typed query, 0..1.
function aliasScore(query, alias) {
  if (!query || !alias) return 0;
  if (alias === query) return 1;
  if (query.length >= 3 && alias.startsWith(query)) return 0.88;
  if (alias.length >= 3 && query.startsWith(alias)) return 0.84;
  if (query.length >= 3 && alias.includes(query)) return 0.72;
  const d = editDistance(query, alias);
  const span = Math.max(query.length, alias.length);
  if (d <= 2 && span >= 4) return 0.65 - d * 0.1;
  return 0;
}

const M_PER_DEG_LAT = 111320;
function metersBetween(a, b) {
  const mLon = M_PER_DEG_LAT * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  return Math.hypot((a.lat - b.lat) * M_PER_DEG_LAT, (a.lon - b.lon) * mLon);
}

/**
 * Rank gazetteer buildings against a typed name, optionally biased toward
 * where the collector is standing.
 *
 * @param {string} query        what the collector typed ("roberts")
 * @param {Array}  buildings    gazetteer entries
 * @param {object} opts         { lat, lon } current fix, { limit } default 5
 * @returns {Array} [{ ...building, score, nameScore, distanceM }] best first
 */
export function resolveBuilding(query, buildings, { lat, lon, limit = 5 } = {}) {
  const q = normalize(query);
  const here = Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  const scored = [];

  for (const b of buildings || []) {
    let nameScore = 0;
    for (const alias of b.aliases || []) {
      nameScore = Math.max(nameScore, aliasScore(q, normalize(alias)));
      if (nameScore === 1) break;
    }
    const distanceM = here ? metersBetween(here, b) : null;

    // With no query, this is "what's around me" — rank purely by distance.
    let score = nameScore;
    if (!q) {
      if (!here) continue;
      score = 1 / (1 + distanceM / 50);
    } else if (nameScore <= 0) {
      continue;
    } else if (distanceM != null) {
      // Proximity only ever breaks ties between name matches; it can't promote
      // a building the collector didn't name.
      score = nameScore + 0.12 * Math.exp(-distanceM / 200);
    }
    scored.push({ ...b, score, nameScore, distanceM });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// Buildings near a position, nearest first — for "which building are you at?"
// when the collector hasn't typed anything yet.
export function buildingsNear(buildings, lat, lon, { limit = 5 } = {}) {
  return resolveBuilding("", buildings, { lat, lon, limit });
}

// ---------------------------------------------------------------------------
// Self-test: node web/pipeline/buildings.js
export function runSelfTest() {
  const fixture = [
    { id: "roberts-engineering-hall", name: "Roberts Engineering Hall", aliases: ["roberts engineering hall", "roberts", "reh"], lat: 40.44245, lon: -79.94722 },
    { id: "robert-mehrabian", name: "Robert Mehrabian Collaborative Innovation Center", aliases: ["robert mehrabian collaborative innovation center", "robert", "rmcic"], lat: 40.44397, lon: -79.94657 },
    { id: "wean-hall", name: "Wean Hall", aliases: ["wean hall", "wean", "wh"], lat: 40.44267, lon: -79.94581 },
    { id: "doherty-hall", name: "Doherty Hall", aliases: ["doherty hall", "doherty", "dh"], lat: 40.44252, lon: -79.94450 },
  ];
  const results = [];

  const r1 = resolveBuilding("Roberts", fixture, { lat: 40.4424, lon: -79.9472 });
  results.push({
    name: "\"Roberts\" resolves to Roberts Engineering Hall",
    top: r1[0]?.name, runnerUp: r1[1]?.name,
    pass: r1[0]?.id === "roberts-engineering-hall",
  });

  const r2 = resolveBuilding("wean", fixture, {});
  results.push({
    name: "alias match works with no GPS fix",
    top: r2[0]?.name,
    pass: r2[0]?.id === "wean-hall" && r2.length === 1,
  });

  const r3 = resolveBuilding("dohrty", fixture, {}); // typo
  results.push({
    name: "typo still resolves (edit distance)",
    top: r3[0]?.name,
    pass: r3[0]?.id === "doherty-hall",
  });

  const r4 = buildingsNear(fixture, 40.44252, -79.94450, { limit: 2 });
  results.push({
    name: "buildingsNear ranks by distance",
    got: r4.map((b) => `${b.id}@${b.distanceM.toFixed(0)}m`),
    pass: r4[0]?.id === "doherty-hall",
  });

  const r5 = resolveBuilding("zzzz", fixture, { lat: 40.4425, lon: -79.9445 });
  results.push({
    name: "proximity never invents a match for an unknown name",
    got: r5.length,
    pass: r5.length === 0,
  });

  return { pass: results.every((r) => r.pass), results };
}

if (typeof process !== "undefined" && process.argv && process.argv[1]) {
  const invokedUrl = "file://" + process.argv[1].replace(/\\/g, "/");
  const meUrl = import.meta.url;
  if (invokedUrl === meUrl || meUrl.endsWith(process.argv[1].replace(/\\/g, "/"))) {
    const { pass, results } = runSelfTest();
    console.log(JSON.stringify(results, null, 2));
    console.log(pass ? "SELF-TEST: PASS" : "SELF-TEST: FAIL");
    if (!pass) process.exitCode = 1;
  }
}
