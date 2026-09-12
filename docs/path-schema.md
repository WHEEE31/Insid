# Path schema (the contract) — v2

The ONE thing the recorder and everything downstream (alignment, graph, vis)
share. Recorder writes it; processing + vis read it. Swap any side freely as
long as this holds.

**Design principle: record raw, align later.** The recorder logs *all* raw
signals it can (ARKit pose + barometer + GPS + a start-anchor tag). Floor
detection, walk stitching, and georeferencing are downstream steps that run on
these recordings — so we can try different strategies without re-walking.

## Coordinate convention (ARKit world frame)

- Units: **meters**
- **`y` is up** (elevation) — ARKit's `.gravity` alignment.
- Right-handed. Session origin `(0,0,0)` = device pose when recording started.
- Horizontal yaw (which way is north) is **arbitrary per session**. Walks are
  aligned to each other by sharing a `startAnchorId` (same physical start spot),
  NOT by compass. See "Anchoring" below.

## Format

```json
{
  "schemaVersion": 2,
  "id": "walk-001",
  "device": "iphone-arkit",
  "recordedAt": "2026-09-11T18:30:00Z",
  "unit": "meters",
  "up": "y",

  "startAnchorId": "wean-lobby-x",
  "startLatLon": { "lat": 40.4433, "lon": -79.9436, "gpsAccuracy": 8.0 },
  "startHeading": { "trueHeading": 274.0, "accuracy": 20.0 },
  "baroReference": 101.36,

  "points": [
    { "t": 0.0, "x": 0.0, "y": 0.0, "z": 0.0, "pressure": 101.36, "relAltitude": 0.0, "tracking": "normal" },
    { "t": 0.2, "x": 0.1, "y": 0.0, "z": 0.4, "pressure": 101.36, "relAltitude": 0.0, "tracking": "normal" }
  ]
}
```

## Fields

### Top level

| field           | required | notes                                                              |
|-----------------|----------|--------------------------------------------------------------------|
| `schemaVersion` | yes      | `2`. Bump on breaking changes so recorder/vis can evolve apart.    |
| `id`            | yes      | unique id for this walk                                            |
| `device`        | yes      | `iphone-arkit`, `synthetic`, …  — how it was captured              |
| `recordedAt`    | yes      | ISO-8601 UTC                                                       |
| `unit`          | yes      | always `meters`                                                   |
| `up`            | yes      | vertical axis — `y` for ARKit                                      |
| `startAnchorId` | yes      | shared-origin id. Walks with the SAME id share one frame (§Anchoring). |
| `startLatLon`   | no       | one-shot GPS at start — coarse Earth placement / display only.     |
| `startHeading`  | no       | compass heading at start (°, true). Unreliable indoors; advisory.  |
| `baroReference` | no       | pressure (kPa) at start; `relAltitude` is derived relative to it.  |
| `points[]`      | yes      | ordered samples, ~5–10 Hz                                          |

### Per point

| field         | required | notes                                                                |
|---------------|----------|----------------------------------------------------------------------|
| `t`           | yes      | seconds since session start                                          |
| `x` `y` `z`   | yes      | ARKit position, meters. **`y` = elevation.**                         |
| `pressure`    | no       | barometer, **kPa** (`CMAltitudeData.pressure`).                      |
| `relAltitude` | no       | meters of altitude change since start (`CMAltitudeData`). **Primary floor signal.** |
| `tracking`    | no       | ARKit tracking state: `normal` \| `limited` \| `notAvailable`. Lets the pipeline distrust drifty segments. |

## Anchoring — how walks line up (the crux)

Two senses of "real-world anchored", handled separately:

- **Stitch walks to each other** (the point of crowdsourcing): every walk that
  physically started at the same marked spot carries the same `startAnchorId`.
  Because ARKit's origin is the start pose, same spot + same facing ⇒ same frame,
  so those walks overlay directly. This does **not** use GPS or compass (both too
  noisy indoors). POC scaffolding; the eventual "no marker" version relocalizes
  into a saved ARWorldMap / cloud anchor but keeps this same contract.
- **Place on Earth / display**: `startLatLon` (coarse GPS) + an OSM building
  footprint let us drop the shared frame onto a world map. Display only — never
  used to align walks.

## Floors — why `relAltitude`, not GPS or ARKit `y`

`relAltitude` comes from the barometer and is accurate to ~0.3–1 m — well under a
~3–4 m floor height — and it does **not** drift the way integrated ARKit `y` can
over long walks, nor is it garbage like GPS altitude. Downstream floor detection
clusters `relAltitude` into discrete levels; ARKit `y` is a cross-check.
(Pressure→altitude: ~0.12 hPa ≈ 1 m; `pressure` is in kPa, so ~0.012 kPa/m.)
