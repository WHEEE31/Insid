import Foundation

// Codable structs matching docs/path-schema.md (v2). Encoding these to JSON
// produces exactly what the web pipeline + vis consume.

struct Walk: Codable {
    var schemaVersion = 2
    var id: String
    var device = "iphone-arkit"
    var recordedAt: String
    var unit = "meters"
    var up = "y"
    var startAnchorId: String
    var startLatLon: LatLon?
    var startHeading: Heading?
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
