import Foundation
import CoreLocation

struct SensorReading: Codable, Identifiable {
    let id: UUID
    let timestamp: Date
    let type: ReadingType
    let x: Double?
    let y: Double?
    let z: Double?
    let latitude: Double?
    let longitude: Double?

    enum ReadingType: String, Codable {
        case accelerometer
        case gyroscope
        case location
    }

    init(
        id: UUID = UUID(),
        timestamp: Date = Date(),
        type: ReadingType,
        x: Double? = nil,
        y: Double? = nil,
        z: Double? = nil,
        latitude: Double? = nil,
        longitude: Double? = nil
    ) {
        self.id = id
        self.timestamp = timestamp
        self.type = type
        self.x = x
        self.y = y
        self.z = z
        self.latitude = latitude
        self.longitude = longitude
    }

    init(location: CLLocation) {
        self.init(
            timestamp: location.timestamp,
            type: .location,
            latitude: location.coordinate.latitude,
            longitude: location.coordinate.longitude
        )
    }
}

struct PathPoint: Codable, Identifiable, Equatable {
    let id: UUID
    let x: Double
    let y: Double

    init(id: UUID = UUID(), x: Double, y: Double) {
        self.id = id
        self.x = x
        self.y = y
    }
}

struct Walk: Codable, Identifiable {
    let id: UUID
    let floor: Int
    let startTime: Date
    var endTime: Date?
    var readings: [SensorReading]
    var path: [PathPoint]

    init(
        id: UUID = UUID(),
        floor: Int = 1,
        startTime: Date = Date(),
        endTime: Date? = nil,
        readings: [SensorReading] = [],
        path: [PathPoint] = []
    ) {
        self.id = id
        self.floor = floor
        self.startTime = startTime
        self.endTime = endTime
        self.readings = readings
        self.path = path
    }
}
