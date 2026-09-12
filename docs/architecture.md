# HackCMU architecture

The iOS app records accelerometer and location readings while a user walks
through an indoor space. `DeadReckoning` turns motion readings into an ordered
path, and `NetworkManager` uploads the completed `Walk` as JSON.

The Flask backend receives a walk at `POST /api/walks`, persists its raw
readings in SQLite, and returns the saved record. The iOS client can attach
the processed path through `PATCH /api/walks/<id>/path`. `GET /api/walks`
returns all saved walks, with an optional `floor` query parameter for map
overlays and future heatmaps.

Generated Xcode files are intentionally not committed. Create the
`ios/HackCMU/HackCMU.xcodeproj` target in Xcode and add the checked-in source
files under `ios/HackCMU/HackCMU/`.
