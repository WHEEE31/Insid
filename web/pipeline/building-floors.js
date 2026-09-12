// Per-building floor ladders.
// Owner: D. Replaces global altitude clustering for walks that declare buildings.
//
// Why not the global clustering in floors.js: it histograms relAltitude across
// ALL walks and splits levels at fixed gaps. On a campus built on a slope that
// is wrong twice over — one building's floor 1 can sit at the same altitude as
// another's floor 0 (so they merge), and buildings genuinely have different
// floor heights (so one global ladder can't fit both).
//
// What replaces it: the collector declares a building AND a floor at every
// threshold — the entrance they start at, every building transition mid-walk,
// and the entrance they finish at. Each declaration re-bases the ladder:
//
//     floor(p) = declaredFloor + round( (altitude(p) - altitudeAtDeclaration)
//                                       / floorHeight(building) )
//
// so altitude is only ever interpreted RELATIVE to the last declaration, inside
// one building. Nothing is compared across buildings or across walks, which is
// what makes weather drift and campus grade irrelevant.
//
// A transition also yields something useful for free: at the moment you cross
// from one building into another you are at the same physical altitude in both,
// so the inferred floor you're leaving and the declared floor you're entering
// form a correspondence — "Wean 4 connects to Doherty 2". Those come back as
// `floorLinks`.

export const DEFAULT_FLOOR_HEIGHT_M = 4.0;

// Barometric relAltitude is the primary signal (doesn't drift like integrated
// ARKit y); fall back to y so synthetic / partial data still works.
const altOf = (p) => (p.relAltitude != null ? p.relAltitude : p.y) ?? 0;

// Altitude at time t, linearly interpolated between samples.
export function altitudeAt(points, t) {
  if (!points?.length) return 0;
  if (t <= points[0].t) return altOf(points[0]);
  const last = points[points.length - 1];
  if (t >= last.t) return altOf(last);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (t <= b.t) {
      const span = b.t - a.t;
      const f = span > 1e-9 ? (t - a.t) / span : 0;
      return altOf(a) + (altOf(b) - altOf(a)) * f;
    }
  }
  return altOf(last);
}

// The declarations a walk carries, oldest first: the start entrance, each
// building transition, and the end entrance. Each is { buildingId, floor, t }.
export function declarationsOf(walk) {
  const out = [];
  const push = (d, kind) => {
    if (!d || d.buildingId == null) return;
    out.push({
      buildingId: d.buildingId,
      buildingName: d.buildingName ?? null,
      floor: Number.isFinite(d.floor) ? d.floor : 0,
      t: Number.isFinite(d.t) ? d.t : 0,
      kind,
    });
  };
  push(walk.startEntrance, "start");
  for (const tr of walk.buildingTransitions || []) push(tr, "transition");
  if (walk.endEntrance) {
    const e = walk.endEntrance;
    const t = Number.isFinite(e.t) ? e.t : (walk.points?.[walk.points.length - 1]?.t ?? 0);
    push({ ...e, t }, "end");
  }
  return out.sort((a, b) => a.t - b.t);
}

// Floor height to use for a building: an explicit gazetteer value, else a
// learned one, else the default.
function heightFor(buildingId, { learned, buildings, defaultHeight }) {
  const gaz = (buildings || []).find((b) => b.id === buildingId);
  if (Number.isFinite(gaz?.floorHeightM)) return gaz.floorHeightM;
  const l = learned?.[buildingId];
  if (Number.isFinite(l?.heightM)) return l.heightM;
  return defaultHeight;
}

/**
 * Learn each building's floor height from walks that declared two DIFFERENT
 * floors inside the same building (e.g. entered Wean on 2, left Wean from 5).
 * Only within a single walk, where altitude readings share one reference —
 * comparing across walks would be comparing across weather.
 *
 * @returns {Object} { [buildingId]: { heightM, samples } }
 */
export function learnFloorHeights(walks, { defaultHeight = DEFAULT_FLOOR_HEIGHT_M } = {}) {
  const samples = {};
  for (const walk of walks || []) {
    const decls = declarationsOf(walk);
    for (let i = 1; i < decls.length; i++) {
      const a = decls[i - 1], b = decls[i];
      if (a.buildingId !== b.buildingId) continue;      // different buildings
      const dFloor = b.floor - a.floor;
      if (dFloor === 0) continue;                        // no vertical info
      const dAlt = altitudeAt(walk.points, b.t) - altitudeAt(walk.points, a.t);
      const h = Math.abs(dAlt / dFloor);
      if (h < 2 || h > 8) continue;                      // implausible; drop it
      (samples[a.buildingId] ||= []).push(h);
    }
  }
  const out = {};
  for (const [id, list] of Object.entries(samples)) {
    list.sort((x, y) => x - y);
    out[id] = { heightM: list[Math.floor(list.length / 2)], samples: list.length };
  }
  return out;
}

/**
 * Annotate every point of every walk with { buildingId, floor, floorKey }.
 *
 * `floorKey` ("wean-hall:4") is what downstream should scope by: two buildings
 * both having a "floor 2" must never be treated as one level.
 *
 * Walks with no declarations are left untouched and returned in `unhandled`,
 * so the caller can fall back to the legacy global clustering in floors.js.
 *
 * @returns {{ floorHeights, floorLinks, handled, unhandled }}
 */
export function annotateBuildingFloors(walks, {
  buildings = [],
  defaultHeight = DEFAULT_FLOOR_HEIGHT_M,
  floorHeights = null,
} = {}) {
  const learned = floorHeights ?? learnFloorHeights(walks, { defaultHeight });
  const floorLinks = [];
  const handled = [], unhandled = [];

  for (const walk of walks || []) {
    const decls = declarationsOf(walk);
    if (!decls.length || !walk.points?.length) { unhandled.push(walk); continue; }

    // Each declaration opens a span that runs until the next one.
    const spans = decls.map((d, i) => ({
      ...d,
      tEnd: i + 1 < decls.length ? decls[i + 1].t : Infinity,
      baseAlt: altitudeAt(walk.points, d.t),
      heightM: heightFor(d.buildingId, { learned, buildings, defaultHeight }),
    }));

    const floorAt = (span, a) => span.floor + Math.round((a - span.baseAlt) / span.heightM);

    // "Wean 4 <-> Doherty 2": at a transition the collector is at one altitude
    // in both buildings, so the floor we infer for the building being left
    // corresponds to the floor they declare for the one being entered.
    for (let i = 1; i < spans.length; i++) {
      const prev = spans[i - 1], next = spans[i];
      if (prev.buildingId === next.buildingId) continue;
      const altHere = altitudeAt(walk.points, next.t);
      floorLinks.push({
        walkId: walk.id ?? null,
        from: { buildingId: prev.buildingId, floor: floorAt(prev, altHere) },
        to: { buildingId: next.buildingId, floor: next.floor },
        t: next.t,
      });
    }

    let si = 0;
    for (const p of walk.points) {
      while (si + 1 < spans.length && p.t >= spans[si].tEnd) si++;
      const span = spans[si];
      p.buildingId = span.buildingId;
      p.floor = floorAt(span, altOf(p));
      p.floorKey = `${span.buildingId}:${p.floor}`;
    }
    handled.push(walk);
  }

  return { floorHeights: learned, floorLinks, handled, unhandled };
}

// ---------------------------------------------------------------------------
// Self-test: node web/pipeline/building-floors.js
export function runSelfTest() {
  const results = [];

  // Walk: start in Wean on floor 4, climb nothing, cross into Doherty where the
  // collector declares floor 2, then finish at a Doherty entrance on floor 1.
  // Altitudes are flat across the crossing (that's the point of a connector)
  // and drop one Doherty floor before the exit.
  const walk = {
    id: "w1",
    startEntrance: { buildingId: "wean-hall", floor: 4, t: 0 },
    buildingTransitions: [{ buildingId: "doherty-hall", floor: 2, t: 10 }],
    endEntrance: { buildingId: "doherty-hall", floor: 1, t: 20 },
    points: [
      { t: 0, x: 0, y: 0, z: 0, relAltitude: 0 },
      { t: 5, x: 1, y: 0, z: 0, relAltitude: 0.1 },
      { t: 10, x: 2, y: 0, z: 0, relAltitude: 0.0 },   // crossing into Doherty
      { t: 15, x: 3, y: 0, z: 0, relAltitude: -1.9 },  // heading down
      { t: 20, x: 4, y: 0, z: 0, relAltitude: -3.8 },  // one Doherty floor down
    ],
  };

  const { floorLinks, floorHeights, handled, unhandled } = annotateBuildingFloors([walk], {});

  results.push({
    name: "points are scoped by building, not one global ladder",
    got: walk.points.map((p) => p.floorKey),
    pass: walk.points[0].floorKey === "wean-hall:4"
      && walk.points[4].floorKey === "doherty-hall:1"
      && handled.length === 1 && unhandled.length === 0,
  });

  results.push({
    name: "transition records the cross-building floor correspondence",
    got: floorLinks.map((l) => `${l.from.buildingId}:${l.from.floor} -> ${l.to.buildingId}:${l.to.floor}`),
    pass: floorLinks.length === 1
      && floorLinks[0].from.floor === 4 && floorLinks[0].to.floor === 2,
  });

  // Doherty: declared floor 2 at t=10 then floor 1 at t=20, over a 3.8m drop
  // -> that building's floor height is ~3.8m, learned rather than assumed.
  results.push({
    name: "floor height is learned per building from declarations",
    got: floorHeights,
    pass: Math.abs((floorHeights["doherty-hall"]?.heightM ?? 0) - 3.8) < 0.01,
  });

  // Two buildings whose floor 2 sits at very different altitudes must not merge.
  const a = {
    id: "wa", startEntrance: { buildingId: "wean-hall", floor: 2, t: 0 },
    points: [{ t: 0, x: 0, y: 0, z: 0, relAltitude: 0 }],
  };
  const b = {
    id: "wb", startEntrance: { buildingId: "baker-hall", floor: 2, t: 0 },
    points: [{ t: 0, x: 0, y: 0, z: 0, relAltitude: 30 }], // 30m higher on the hill
  };
  annotateBuildingFloors([a, b], {});
  results.push({
    name: "same floor number in different buildings stays distinct",
    got: [a.points[0].floorKey, b.points[0].floorKey],
    pass: a.points[0].floorKey === "wean-hall:2" && b.points[0].floorKey === "baker-hall:2"
      && a.points[0].floorKey !== b.points[0].floorKey,
  });

  // A walk with no declarations is handed back for the legacy path.
  const legacy = { id: "old", points: [{ t: 0, x: 0, y: 0, z: 0, relAltitude: 0 }] };
  const r = annotateBuildingFloors([legacy], {});
  results.push({
    name: "undeclared walks fall through to the legacy clusterer",
    pass: r.unhandled.length === 1 && legacy.points[0].floorKey === undefined,
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
