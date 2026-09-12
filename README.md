# hackcmu — Crowdsourced Indoor Mapping

Record the 3D path you walk indoors (with elevation), crowdsource many walks into
one shared map, and route/visualize it in 3D. HackCMU proof-of-concept.

## How it fits together

```
[iOS ARKit recorder]  --raw JSON-->  [pipeline]  -->  [three.js vis]
  pose + baro + GPS      floor detection · routing graph · route
  + start-anchor tag
```

Everything talks through one contract: **`docs/path-schema.md`**. Record raw
signals, align/floor-detect/route downstream — so any piece can be swapped
without re-walking.

## Layout

| path | what |
|------|------|
| `docs/path-schema.md` | the data contract (recorder ⇄ pipeline ⇄ vis) |
| `recorder/` | iOS ARKit recorder app + setup guide (build on a Mac) |
| `web/` | three.js visualization + processing pipeline |
| `web/pipeline/floors.js` | floor detection (barometric altitude peaks) |
| `web/pipeline/graph.js` | routing graph + Dijkstra across floors (8ft max edge) |
| `web/pipeline/world-align.js` | north alignment + rough lat/lon for the local frame |
| `web/sample-path.js` | synthetic multi-floor walks (fallback data) |
| `web/data/` | drop real recorded `walk-*.json` here + `index.json` |

## Run the visualization

```
cd web && python3 -m http.server 8777
```

| page | what it's for |
|---|---|
| `index.html` | the 3D hologram vis — walks, merged graph, routes |
| `graph-view.html` | 2D per-floor debug view of the merged graph (flags any edge over the 8ft cap) |
| `prototype.html` | **interactive app prototype** — collector + wayfinder flows in a phone frame, with simulated compass/GPS/walking. Iterate on UX here instead of rebuilding in Xcode. Append a stage to the URL (`prototype.html#north`) to open straight to one screen. |
| `map.html` | walks + nodes on a real OSM map |

Loads real walks from Supabase if `web/config.js` exists, else `web/data/`,
else synthetic sample data.

## Record real walks

See `recorder/README.md` — build the app in Xcode, walk from a shared start spot,
AirDrop the JSON into `web/data/`.

## Anchoring (the core idea)

"Anchored to the real world" is two things: **(a)** place on Earth for display →
coarse GPS + OSM footprint; **(b)** stitch different people's walks into one frame
→ a *shared physical start spot* + ARKit tracking (NOT GPS — too noisy indoors).
Floors come from the **barometer**, not GPS altitude. Details in the schema doc.
