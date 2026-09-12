# Insid — iOS ARKit walk recorder

Records a continuous 3D walk (ARKit VIO pose) + barometer + GPS/heading, and
exports JSON matching `../docs/path-schema.md`. AirDrop the file to your Mac and
drop it into `../web/data/` to visualize.

> **The live Xcode project is `../Insid/`** — source of truth is `../Insid/Insid/*.swift`.
> Edit those. The setup steps below are how it was originally created (kept for
> reference); the project already exists.

## Requirements
- A Mac with Xcode (14+).
- A physical iPhone (ARKit needs a real device — the simulator has no camera/VIO).
  Any iPhone with an A12 chip or newer (iPhone XS / 2018 and later).

## Create the Xcode project (~5 min)
1. Xcode → **File ▸ New ▸ Project… ▸ iOS ▸ App**.
2. Product Name: **Insid**, Interface: **SwiftUI**, Language: **Swift**.
3. Delete the auto-generated `ContentView.swift` and `*App.swift`.
4. Drag the four files from `recorder/PathRecorder/` into the project
   (check "Copy items if needed"):
   - `InsidApp.swift`
   - `ContentView.swift`
   - `Recorder.swift`
   - `WalkModel.swift`
5. Add the usage-description keys (target ▸ **Info** tab, or Info.plist):
   - `NSCameraUsageDescription` → "Records your walking path via the camera."
   - `NSLocationWhenInUseUsageDescription` → "Tags where a walk started."
   - `NSMotionUsageDescription` → "Detects floor changes via the barometer."
6. Set your **Signing team** (target ▸ Signing & Capabilities), plug in the iPhone,
   pick it as the run destination, and **Run** (⌘R). Approve the permission prompts.

## Recording a walk
1. Stand on the shared physical start spot (e.g. a taped "X"), facing the same
   direction every time. This is what makes multiple walks line up.
2. Confirm the **start anchor** field (default `demo-lobby-x`) — use the SAME id for
   every walk you want stitched into one map.
3. Wait for **tracking: normal** (green), then tap **Record**. Walk normally.
   Point count climbs at ~10 Hz; Δalt shows barometric altitude change (floors).
4. Tap **Stop**, then the **share** button → AirDrop the JSON to your Mac.

## Getting it into the vis
1. Save/AirDrop the `walk-*.json` files into `web/data/`.
2. Create/append `web/data/index.json` listing them, e.g.
   `["walk-1699999999.json", "walk-1700000042.json"]`
3. Reload the vis — it loads `data/` automatically (falls back to synthetic if empty).

## Tips / gotchas
- Keep the camera pointed at feature-rich surfaces; blank walls / glass / fast turns
  degrade tracking (watch for `tracking: limited`).
- Walk a loop back to the start spot to sanity-check drift (start ≈ end).
- The barometer needs no calibration — `relAltitude` is relative to the start.
- Each recording's origin is the start pose; that's why the physical start spot +
  shared `startAnchorId` matter for stitching.
