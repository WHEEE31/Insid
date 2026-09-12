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
| `web/pipeline/graph.js` | routing graph + Dijkstra across floors |
| `web/sample-path.js` | synthetic multi-floor walks (fallback data) |
| `web/data/` | drop real recorded `walk-*.json` here + `index.json` |

## Run the visualization

```
cd web && python3 -m http.server 8777
# open http://localhost:8777/index.html
# graph debug http://localhost:8000/graph-view.html
```

Loads real walks from `web/data/` if present, else synthetic sample data.

## Record real walks

See `recorder/README.md` — build the app in Xcode, walk from a shared start spot,
AirDrop the JSON into `web/data/`.

## Anchoring (the core idea)

"Anchored to the real world" is two things: **(a)** place on Earth for display →
coarse GPS + OSM footprint; **(b)** stitch different people's walks into one frame
→ a *shared physical start spot* + ARKit tracking (NOT GPS — too noisy indoors).
Floors come from the **barometer**, not GPS altitude. Details in the schema doc.
