import Foundation

// Codable structs matching docs/path-schema.md (v4). Encoding these to JSON
// produces exactly what the web pipeline + vis consume.
//
// v3 adds optional node references (startNodeId / orientNodeId / endNodeId) used
// to anchor a walk into the shared building-local frame (see docs/contracts.md).
// v4 adds the north calibration (northOffsetDeg / northAligned).
// All are Optional, so older walk JSON (which omits them) still decodes.

struct Walk: Codable {
    var schemaVersion = 4
    var id: String
    var device = "iphone-arkit"
    var recordedAt: String
    var unit = "meters"
    var up = "y"
    var startAnchorId: String
    // v3 node references (optional — omitted by older walks + the future no-setup UX)
    var startNodeId: String?    // node the walk started on (translation anchor)
    var orientNodeId: String?   // node walked toward / faced (rotation anchor)
    var endNodeId: String?      // node at the end (optional drift correction)
    var startLatLon: LatLon?
    var startHeading: Heading?
    // v4 north calibration (see docs/path-schema.md §North calibration).
    // northOffsetDeg = the true bearing the recorded ARKit frame's -z axis
    // points toward, captured from the camera's yaw at the moment the collector
    // confirms they're facing north. ARKit fixes its frame at SESSION start, so
    // this is NOT simply 0 — it has to be read at the confirmation tap.
    // northAligned is only true if the recorder rotated the points itself.
    var northOffsetDeg: Double?
    var northAligned: Bool?
    var baroReference: Double?
    var points: [Point] = []
}

struct LatLon: Codable {
    var lat: Double
    var lon: Double
    var gpsAccuracy: Double
}

struct Heading: Codable {
    var trueHeading: Double
    var accuracy: Double
}

struct Point: Codable {
    var t: Double
    var x: Double
    var y: Double
    var z: Double
    var pressure: Double?     // kPa
    var relAltitude: Double?  // meters since start
    var tracking: String?     // "normal" | "limited" | "notAvailable"
}
