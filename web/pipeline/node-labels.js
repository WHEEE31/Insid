// Node labels — give every refined node a name a person can say out loud.
// Owner: D. Runs after refine.js, needs the gazetteer from buildings.js.
//
// Refined nodes are the ones worth naming (junctions, portals, corridor ends),
// but they come out of skeletonisation as anonymous geometry. This attaches:
//
//   ref   "WEH-4-J2"        the stable-ish handle, matching how CMU room
//                           numbers read (building code, floor, then which one)
//   name  "WEH 4 · Junction 2"   what the UI shows
//
// Building + floor is as specific as anything automatic can honestly get: the
// traces know which building and level they're on (declared at every entrance
// and crossing) but nothing about what a space is FOR. Anything more meaningful
// — "Kitchen", "4401", "the good printer" — has to come from a person, so
// `customName` always wins when set.
//
// ORDINAL STABILITY: nodes are numbered by sorting on quantised position, not
// by discovery order, so the same geometry always yields the same numbering no
// matter what order walks arrived in. It is not stable against the map itself
// changing — as coverage improves the centreline shifts and a junction can
// renumber — which is why user-assigned names bind to `customName` rather than
// to the ref.

const KINDS = {
  junction: { letter: "J", word: "Junction" },
  portal:   { letter: "P", word: "Stairs" },
  endpoint: { letter: "E", word: "End" },
  corridor: { letter: "C", word: "Corridor" },
};

const UNKNOWN_CODE = "UNK";

export function buildingCodeOf(buildings, buildingId) {
  if (!buildingId) return UNKNOWN_CODE;
  const b = (buildings || []).find((x) => x.id === buildingId);
  return b?.code || buildingId.slice(0, 3).toUpperCase();
}

/**
 * Label every node of a refined graph in place.
 *
 * @param {{nodes: Map, edges: Map}} refined
 * @param {object} opts  { buildings, customNames: {ref|id -> string} }
 * @returns {{labelled: number, byLevel: object}}
 */
export function labelRefinedGraph(refined, { buildings = [], customNames = {} } = {}) {
  if (!refined?.nodes?.size) return { labelled: 0, byLevel: {} };

  // group by building + floor + kind, so numbering restarts per level
  const groups = new Map();
  for (const node of refined.nodes.values()) {
    const code = buildingCodeOf(buildings, node.buildingId);
    const floor = Number.isFinite(node.floor) ? node.floor : 0;
    const kind = KINDS[node.kind] ? node.kind : "corridor";
    const key = `${code}|${floor}|${kind}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ node, code, floor, kind });
  }

  const byLevel = {};
  let labelled = 0;

  for (const [, members] of groups) {
    // Deterministic order from position, quantised so sub-decimetre jitter
    // between rebuilds doesn't reshuffle the numbering.
    members.sort((a, b) => {
      const ax = Math.round(a.node.x * 10), bx = Math.round(b.node.x * 10);
      if (ax !== bx) return ax - bx;
      return Math.round(a.node.z * 10) - Math.round(b.node.z * 10);
    });

    members.forEach((m, i) => {
      const { letter, word } = KINDS[m.kind];
      const n = i + 1;
      const ref = `${m.code}-${m.floor}-${letter}${n}`;
      m.node.code = m.code;
      m.node.ref = ref;
      m.node.autoName = `${m.code} ${m.floor} · ${word} ${n}`;
      m.node.customName = customNames[ref] ?? customNames[m.node.id] ?? m.node.customName ?? null;
      m.node.name = m.node.customName || m.node.autoName;
      labelled += 1;

      const levelKey = `${m.code} ${m.floor}`;
      byLevel[levelKey] = (byLevel[levelKey] || 0) + 1;
    });
  }

  // Edges read as the span between two labelled nodes, which is what a
  // direction ("follow WEH-4-J2 → WEH-4-P1") ends up referring to.
  for (const edge of refined.edges.values()) {
    const a = refined.nodes.get(edge.a), b = refined.nodes.get(edge.b);
    if (!a || !b) continue;
    edge.ref = `${a.ref} → ${b.ref}`;
    edge.name = edge.vertical && a.buildingId !== b.buildingId
      ? `${a.code} ${a.floor} → ${b.code} ${b.floor} crossing`
      : edge.vertical
        ? `${a.code} stairs ${a.floor}→${b.floor}`
        : `${a.code} ${a.floor} corridor`;
  }

  return { labelled, byLevel };
}

/** Attach a human name to a node, overriding the generated one. */
export function setCustomName(refined, nodeId, name) {
  const node = refined?.nodes?.get(nodeId);
  if (!node) return null;
  node.customName = name && name.trim() ? name.trim() : null;
  node.name = node.customName || node.autoName || node.id;
  return node;
}

/** Every custom name in the graph, keyed by ref so it survives a rebuild. */
export function collectCustomNames(refined) {
  const out = {};
  for (const n of refined?.nodes?.values() || []) {
    if (n.customName && n.ref) out[n.ref] = n.customName;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Self-test: node web/pipeline/node-labels.js
export function runSelfTest() {
  const results = [];
  const buildings = [
    { id: "wean-hall", name: "Wean Hall", code: "WEH", codeSource: "curated" },
    { id: "doherty-hall", name: "Doherty Hall", code: "DH", codeSource: "curated" },
  ];

  const mk = (id, buildingId, floor, kind, x, z) =>
    [id, { id, buildingId, floor, kind, x, y: 0, z }];

  const refined = {
    nodes: new Map([
      mk("n1", "wean-hall", 4, "junction", 10, 0),
      mk("n2", "wean-hall", 4, "junction", 2, 0),     // further west -> should be J1
      mk("n3", "wean-hall", 4, "portal", 6, 3),
      mk("n4", "doherty-hall", 2, "junction", 40, 0),
      mk("n5", null, 0, "endpoint", -5, -5),          // legacy, no building
    ]),
    edges: new Map([
      ["e1", { id: "e1", a: "n2", b: "n1", vertical: false }],
      ["e2", { id: "e2", a: "n3", b: "n4", vertical: true }],
    ]),
  };

  const { labelled, byLevel } = labelRefinedGraph(refined, { buildings });

  results.push({
    name: "nodes are named building-code + floor + kind",
    got: [...refined.nodes.values()].map((n) => `${n.id}=${n.ref}`),
    pass: refined.nodes.get("n1").ref === "WEH-4-J2"
      && refined.nodes.get("n2").ref === "WEH-4-J1"
      && refined.nodes.get("n3").ref === "WEH-4-P1"
      && refined.nodes.get("n4").ref === "DH-2-J1",
  });

  results.push({
    name: "ordinals follow position, not insertion order",
    // n2 was inserted after n1 but sits further west, so it takes J1
    pass: refined.nodes.get("n2").ref.endsWith("J1"),
  });

  results.push({
    name: "display name is readable",
    got: refined.nodes.get("n1").name,
    pass: refined.nodes.get("n1").name === "WEH 4 · Junction 2",
  });

  results.push({
    name: "a building crossing edge says where it goes",
    got: refined.edges.get("e2").name,
    pass: /WEH 4 → DH 2 crossing/.test(refined.edges.get("e2").name),
  });

  results.push({
    name: "legacy nodes with no building fall back to UNK",
    got: refined.nodes.get("n5").ref,
    pass: refined.nodes.get("n5").ref === "UNK-0-E1",
  });

  // A person names a node; that must win, and survive a relabel.
  setCustomName(refined, "n1", "Kitchen");
  const saved = collectCustomNames(refined);
  labelRefinedGraph(refined, { buildings, customNames: saved });
  results.push({
    name: "custom names beat generated ones and survive a rebuild",
    got: refined.nodes.get("n1").name,
    saved,
    pass: refined.nodes.get("n1").name === "Kitchen"
      && refined.nodes.get("n1").autoName === "WEH 4 · Junction 2",
  });

  results.push({ name: "counts by level", byLevel, labelled, pass: labelled === 5 });

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
