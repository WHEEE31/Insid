// Loads walk recordings. Drop real ARKit exports into web/data/ and list their
// filenames in web/data/index.json (e.g. ["walk-001.json","walk-002.json"]).
// If that manifest is missing/empty, falls back to synthetic sample data so the
// vis always renders. Same contract either way (docs/path-schema.md).

import { walks as syntheticWalks } from "./sample-path.js";

export async function loadWalks() {
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
  console.log(`[vis] using ${syntheticWalks.length} synthetic walks (no data/index.json)`);
  return syntheticWalks;
}
