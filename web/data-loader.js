// Loads walk recordings + the node registry. Source-agnostic per docs/contracts.md:
//
//   - If web/config.js exists with Supabase creds, reads from the Supabase REST
//     API (walks + nodes tables).
//   - Otherwise falls back to local files: walks from web/data/*.json (listed in
//     web/data/index.json), nodes from web/data/nodes.json. If those are missing
//     too, walks fall back to synthetic sample data so the vis always renders.
//
// Same contract either way (docs/path-schema.md). Supabase snake_case columns
// (start_node_id) are mapped to the walk JSON camelCase (startNodeId) here so
// downstream code is unchanged. Dependency-free: plain fetch, no supabase-js.

import { walks as syntheticWalks } from "./sample-path.js";

// --- Supabase config (optional) -------------------------------------------
// Dynamic import so a missing web/config.js (the default) is not an error.
// Cached after the first attempt.
let _configPromise;
async function getConfig() {
  if (_configPromise === undefined) {
    _configPromise = import("./config.js")
      .then((m) => {
        const url = m.SUPABASE_URL;
        const key = m.SUPABASE_ANON_KEY;
        // Treat unfilled placeholders / blanks as "not configured".
        if (
          typeof url === "string" && url.startsWith("http") &&
          !url.includes("YOUR-") &&
          typeof key === "string" && key.length > 0 &&
          !key.includes("YOUR-")
        ) {
          // normalize to BASE url (tolerate a stray /rest/v1 or trailing slash)
          return { url: url.replace(/\/+$/, "").replace(/\/rest\/v1$/, ""), key };
        }
        return null;
      })
      .catch(() => null); // no config.js / not served -> local fallback
  }
  return _configPromise;
}

// GET rows from a Supabase table via the REST API with the anon key.
async function supabaseSelect(cfg, table, query = "select=*") {
  const res = await fetch(`${cfg.url}/rest/v1/${table}?${query}`, {
    headers: {
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
    },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Supabase ${table} query failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// Map a Supabase `walks` row (snake_case cols) to a walk object shaped like the
// walk JSON (camelCase) so downstream consumers don't care about the source.
function rowToWalk(row) {
  const walk = {
    schemaVersion: 4,
    id: row.id,
    device: row.device ?? "iphone-arkit",
    recordedAt: row.recorded_at,
    unit: "meters",
    up: "y",
    points: Array.isArray(row.points) ? row.points : (row.points ?? []),
  };
  // v3 optional node refs — only attach when present.
  if (row.start_node_id != null) walk.startNodeId = row.start_node_id;
  if (row.orient_node_id != null) walk.orientNodeId = row.orient_node_id;
  if (row.end_node_id != null) walk.endNodeId = row.end_node_id;
  if (row.baro_reference != null) walk.baroReference = row.baro_reference;

  // v4: GPS fix + compass + north calibration. Rebuilt into the nested shapes
  // the walk JSON uses (startLatLon / startHeading) so code downstream can't
  // tell whether a walk came from a file or the database. Older rows — and any
  // project that hasn't run the v4 ALTER in supabase/schema.sql — just omit them.
  if (row.start_lat != null && row.start_lon != null) {
    walk.startLatLon = {
      lat: row.start_lat,
      lon: row.start_lon,
      gpsAccuracy: row.gps_accuracy ?? null,
    };
  }
  if (row.start_heading != null) {
    walk.startHeading = {
      trueHeading: row.start_heading,
      accuracy: row.heading_accuracy ?? null,
    };
  }
  if (row.north_offset_deg != null) walk.northOffsetDeg = row.north_offset_deg;
  if (row.north_aligned != null) walk.northAligned = row.north_aligned;
  return walk;
}

// --- Public API (docs/contracts.md "Loader interface") ---------------------

// loadWalks(): Promise<Walk[]>
export async function loadWalks() {
  // 1) Supabase, if configured.
  const cfg = await getConfig();
  if (cfg) {
    try {
      const rows = await supabaseSelect(cfg, "walks", "select=*&order=recorded_at.asc");
      if (rows.length) {
        const walks = rows.map(rowToWalk);
        console.log(`[vis] loaded ${walks.length} walk(s) from Supabase`);
        return walks;
      }
      console.log("[vis] Supabase 'walks' is empty — falling back to local files");
    } catch (e) {
      console.warn("[vis] Supabase walks load failed, falling back to local:", e);
      // fall through to local files
    }
  }

  // 2) Local files listed in data/index.json.
  try {
    const res = await fetch("./data/index.json", { cache: "no-store" });
    if (res.ok) {
      const files = await res.json();
      if (Array.isArray(files) && files.length) {
        const loaded = await Promise.all(
          files.map((f) => fetch(`./data/${f}`, { cache: "no-store" }).then((r) => r.json()))
        );
        console.log(`[vis] loaded ${loaded.length} real walk(s) from data/`);
        return loaded;
      }
    }
  } catch (e) {
    // no manifest / not served — fall through to synthetic
  }

  // 3) Synthetic sample data so the vis always renders.
  console.log(`[vis] using ${syntheticWalks.length} synthetic walks (no data/index.json)`);
  return syntheticWalks;
}

// loadNodes(): Promise<Node[]>  where Node = { id, name, floor, x, y, z, lat?, lon? }
export async function loadNodes() {
  // 1) Supabase, if configured.
  const cfg = await getConfig();
  if (cfg) {
    try {
      const rows = await supabaseSelect(cfg, "nodes", "select=*");
      if (rows.length) {
        console.log(`[vis] loaded ${rows.length} node(s) from Supabase`);
        // Columns already match the Node shape (id,name,floor,x,y,z,lat,lon).
        return rows;
      }
      console.log("[vis] Supabase 'nodes' is empty — falling back to local file");
    } catch (e) {
      console.warn("[vis] Supabase nodes load failed, falling back to local:", e);
      // fall through to local file
    }
  }

  // 2) Local web/data/nodes.json -> .nodes[].
  try {
    const res = await fetch("./data/nodes.json", { cache: "no-store" });
    if (res.ok) {
      const doc = await res.json();
      const nodes = Array.isArray(doc?.nodes) ? doc.nodes : [];
      console.log(`[vis] loaded ${nodes.length} node(s) from data/nodes.json`);
      return nodes;
    }
  } catch (e) {
    // no nodes file — return empty registry
  }
  console.log("[vis] no nodes available (no Supabase config, no data/nodes.json)");
  return [];
}
