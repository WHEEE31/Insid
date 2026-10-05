// Regenerate web/data/cmu-buildings.json — real CMU building footprints.
//
//   node tools/fetch-cmu-buildings.mjs
//
// Why this exists (and why it isn't Google): Google Maps has indoor floor plans
// for some CMU buildings, but they render only inside Google's own map widget —
// there is no API that hands you the geometry or a georeferenced floor-plan
// image, so there is nothing to overlay into a three.js scene. CMU's own
// schematic plans (cmu.edu/finance/property-space/floorplan-room/) are behind
// Andrew ID auth, and ScottyLabs' CMU Maps serves room-level plans from
// /floors/{code}/floorplan — which answers 401 Unauthenticated.
//
// What IS public and unauthenticated is the CMU Maps buildings endpoint:
// every campus building with its real lat/lon footprint polygon, its official
// registrar code ("WEH"), and the list of floors it has. That's a true
// georeferenced building outline per floor — enough to draw the building a path
// is actually inside, correctly placed and correctly rotated to north. Room
// interiors would need the authenticated endpoint (see README note).
//
// Separate from data/buildings.json (the OSM gazetteer used for NAME
// RESOLUTION when a collector types a building mid-walk). That one has
// centroids only; this one has geometry. Keeping them apart means regenerating
// either can't break the other.

import { writeFileSync } from "node:fs";

const API = "https://api.maps.scottylabs.org/buildings";

const res = await fetch(API, { headers: { "User-Agent": "hackcmu-indoor-mapping/1.0" } });
if (!res.ok) throw new Error(`CMU Maps buildings failed: ${res.status} ${res.statusText}`);
const raw = await res.json();

const ring = (pts) =>
  (pts || []).map((p) => [+p.longitude.toFixed(7), +p.latitude.toFixed(7)]);

const buildings = Object.values(raw)
  .filter((b) => b?.code && Array.isArray(b.shape) && b.shape.length)
  .map((b) => ({
    code: b.code,
    name: b.name,
    // Rings are [lon, lat] pairs — GeoJSON order, so they can be fed straight
    // to Leaflet/turf/anything else without another convention to remember.
    shape: b.shape.map(ring).filter((r) => r.length >= 3),
    // A single coarse ring CMU Maps uses for tap targets. Cheaper to test than
    // the detailed shape and forgiving of a GPS fix that lands a few meters
    // outside the wall, which is exactly what indoor fixes do.
    hitbox: ring(b.hitbox),
    label: { lat: b.labelLatitude, lon: b.labelLongitude },
    floors: Array.isArray(b.floors) ? b.floors : [],
    defaultFloor: b.defaultFloor ?? null,
    // CMU Maps' own flag for "we have room-level data for this one".
    isMapped: !!b.isMapped,
  }))
  .sort((a, b) => a.code.localeCompare(b.code));

const doc = {
  source: "ScottyLabs CMU Maps — https://api.maps.scottylabs.org/buildings",
  generatedBy: "tools/fetch-cmu-buildings.mjs",
  generatedAt: new Date().toISOString(),
  note:
    "Footprint polygons in [lon, lat]. Building-outline fidelity only — room-level " +
    "floor plans come from /floors/{code}-{floor}/floorplan, which requires auth.",
  buildings,
};

writeFileSync(
  new URL("../web/data/cmu-buildings.json", import.meta.url),
  JSON.stringify(doc) + "\n"
);
const mapped = buildings.filter((b) => b.isMapped).length;
console.log(
  `wrote ${buildings.length} buildings (${mapped} room-mapped) to web/data/cmu-buildings.json`
);
