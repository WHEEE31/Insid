import Foundation
import ARKit
import CoreMotion
import CoreLocation
import Combine
import simd

// Recording engine: fuses ARKit VIO pose with barometer + continuous GPS/heading.
// Samples at ~10 Hz and emits a Walk conforming to docs/path-schema.md (v4).

struct Recording: Identifiable, Hashable {
    let id: String
    let url: URL
    let pointCount: Int
    let duration: Double
    let startAnchorId: String
    var recordedAt: String?
    var displayName: String?
    var buildingCount: Int?
    var distanceM: Double?
    var anchorEnd: String? // "endEntrance" | "gpsFix" | "none"
}

struct LiveLandmark: Identifiable, Hashable {
    let id = UUID()
    let name: String
    let pos: SIMD3<Float>
}

struct GPSFixSample: Hashable {
    let t: Double
    let lat: Double
    let lon: Double
    let accuracy: Double
}

final class Recorder: NSObject, ObservableObject, ARSessionDelegate, CLLocationManagerDelegate {
    @Published var isRecording = false
    @Published var pointCount = 0
    @Published var trackingState = "—"
    @Published var relAltitude = 0.0
    @Published var startAnchorId = "entrance"
    @Published var lastExportURL: URL?

    @Published private(set) var livePath: [SIMD3<Float>] = []
    @Published private(set) var liveLandmarks: [LiveLandmark] = []
    @Published private(set) var distance = 0.0
    @Published private(set) var elapsed = 0.0

    @Published var startNodeId: String?
    @Published var orientNodeId: String?
    @Published var endNodeId: String?

    // Continuous GPS / heading for prototype collector gates
    @Published var gpsAccuracyM: Double = -1
    @Published var gpsStatus = "—"
    @Published var latitude: Double? = nil
    @Published var longitude: Double? = nil
    @Published var headingDeg: Double = 0
    @Published var headingAccuracy: Double = -1
    @Published var cameraYawDeg: Double = 0 // ARKit yaw for northOffsetDeg

    // North calibration applied into the walk on save
    var northOffsetDeg: Double?
    var northAligned: Bool = false

    private(set) var latestCameraPos: SIMD3<Float>?
    @Published var recordings: [Recording] = []

    let session = ARSession()

    private let altimeter = CMAltimeter()
    private let location = CLLocationManager()

    private var walk: Walk?
    private var startTime: TimeInterval = 0
    private var lastSample: TimeInterval = 0
    private let sampleInterval = 0.1

    private var latestPressureKPa: Double?
    private var latestRelAltitude: Double?
    private var baroReference: Double?
    private var relAltOffset = 0.0

    private var startLatLon: LatLon?
    private var startHeading: Heading?
    private var capturedHeading = false
    private var latestLocation: CLLocation?
    private(set) var gpsFixes: [GPSFixSample] = []
    private var lastGoodFixElapsed: Double? = nil

    var gpsQuality: String {
        if gpsAccuracyM < 0 { return "none" }
        if gpsAccuracyM <= InsidTheme.gpsGoodM { return "good" }
        if gpsAccuracyM <= InsidTheme.gpsFairM { return "fair" }
        return "poor"
    }

    var gpsIsGood: Bool { gpsQuality == "good" }

    /// Estimated unanchored meters since last good GPS (for exit prompt).
    func exitFixStatus() -> (unanchoredM: Double, estDriftM: Double, secondsAgo: Double?, totalM: Double, lastFix: Bool) {
        let total = distance
        guard let lastT = lastGoodFixElapsed else {
            return (total, max(1, total * 0.02), nil, total, false)
        }
        let ago = max(0, elapsed - lastT)
        // Rough: distance grown since last good fix ≈ proportional to time share
        let unanchored = total * min(1, ago / max(elapsed, 1))
        return (unanchored, max(0.5, unanchored * 0.025), ago, total, true)
    }

    override init() {
        super.init()
        session.delegate = self
        location.delegate = self
        location.desiredAccuracy = kCLLocationAccuracyBest
        location.headingFilter = 1
        loadRecordings()
    }

    func startSession() {
        let config = ARWorldTrackingConfiguration()
        config.worldAlignment = .gravity
        session.run(config, options: [.resetTracking, .removeExistingAnchors])

        if CMAltimeter.isRelativeAltitudeAvailable() {
            altimeter.startRelativeAltitudeUpdates(to: .main) { [weak self] data, _ in
                guard let self, let data else { return }
                self.latestPressureKPa = data.pressure.doubleValue
                self.latestRelAltitude = data.relativeAltitude.doubleValue
                self.relAltitude = data.relativeAltitude.doubleValue - self.relAltOffset
            }
        }
        location.requestWhenInUseAuthorization()
        location.startUpdatingLocation()
        if CLLocationManager.headingAvailable() {
            location.startUpdatingHeading()
        }
    }

    func startRecording(anchorId: String, northOffset: Double?) {
        guard !isRecording else { return }
        pointCount = 0
        startLatLon = nil
        startHeading = nil
        capturedHeading = false
        startTime = 0
        lastSample = 0
        livePath = []
        liveLandmarks = []
        distance = 0
        elapsed = 0
        gpsFixes = []
        lastGoodFixElapsed = nil
        northOffsetDeg = northOffset
        northAligned = false
        startAnchorId = anchorId

        relAltOffset = latestRelAltitude ?? 0
        baroReference = latestPressureKPa

        walk = Walk(
            id: "walk-\(Int(Date().timeIntervalSince1970))",
            recordedAt: ISO8601DateFormatter().string(from: Date()),
            startAnchorId: startAnchorId
        )

        if let loc = latestLocation, loc.horizontalAccuracy >= 0 {
            startLatLon = LatLon(
                lat: loc.coordinate.latitude,
                lon: loc.coordinate.longitude,
                gpsAccuracy: loc.horizontalAccuracy
            )
            if loc.horizontalAccuracy <= InsidTheme.gpsGoodM {
                lastGoodFixElapsed = 0
            }
        }
        if headingAccuracy >= 0 {
            startHeading = Heading(trueHeading: headingDeg, accuracy: headingAccuracy)
            capturedHeading = true
        }

        isRecording = true
    }

    /// Legacy entry used by older call sites.
    func startRecording() {
        startRecording(anchorId: startAnchorId, northOffset: northOffsetDeg)
    }

    func stopRecording() {
        guard isRecording else { return }
        isRecording = false
    }

    @discardableResult
    func saveWalk(
        displayName: String? = nil,
        endNodeId overrideEnd: String? = nil,
        buildingCount: Int = 1,
        hadExitFix: Bool = false
    ) -> URL? {
        guard var walk else { return nil }
        walk.baroReference = baroReference
        walk.startLatLon = startLatLon
        walk.startHeading = startHeading
        walk.startNodeId = startNodeId
        walk.orientNodeId = orientNodeId
        walk.endNodeId = overrideEnd ?? endNodeId
        walk.northOffsetDeg = northOffsetDeg
        walk.northAligned = northAligned
        if let name = displayName, !name.isEmpty {
            // Keep id stable; name lives in Recording metadata only for UI.
        }
        self.walk = walk
        export(walk, displayName: displayName, buildingCount: buildingCount, hadExitFix: hadExitFix)
        return lastExportURL
    }

    func discardWalk() {
        walk = nil
        isRecording = false
        livePath = []
        liveLandmarks = []
        pointCount = 0
        distance = 0
        elapsed = 0
    }

    func dropLandmark(name: String) {
        let pos = latestCameraPos ?? livePath.last
        guard let pos else { return }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        liveLandmarks.append(LiveLandmark(name: trimmed.isEmpty ? "landmark" : trimmed, pos: pos))
    }

    // MARK: ARSessionDelegate

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        let cam = frame.camera.transform.columns.3
        latestCameraPos = SIMD3<Float>(cam.x, cam.y, cam.z)

        // Yaw of camera forward projected on XZ (degrees, 0 = -Z in ARKit)
        let forward = -frame.camera.transform.columns.2
        let yaw = atan2(Double(forward.x), Double(-forward.z)) * 180 / .pi
        DispatchQueue.main.async { self.cameraYawDeg = ((yaw.truncatingRemainder(dividingBy: 360)) + 360).truncatingRemainder(dividingBy: 360) }

        guard isRecording, walk != nil else {
            trackingState = Self.describe(frame.camera.trackingState)
            return
        }
        let t = frame.timestamp
        if startTime == 0 { startTime = t }
        guard t - lastSample >= sampleInterval else { return }
        lastSample = t

        let m = frame.camera.transform.columns.3
        let state = Self.describe(frame.camera.trackingState)
        trackingState = state

        walk?.points.append(Point(
            t: (t - startTime),
            x: Double(m.x), y: Double(m.y), z: Double(m.z),
            pressure: latestPressureKPa,
            relAltitude: latestRelAltitude.map { $0 - relAltOffset },
            tracking: state
        ))
        pointCount = walk?.points.count ?? 0

        let p = SIMD3<Float>(m.x, m.y, m.z)
        if let last = livePath.last { distance += Double(simd_distance(last, p)) }
        livePath.append(p)
        elapsed = t - startTime
    }

    static func describe(_ s: ARCamera.TrackingState) -> String {
        switch s {
        case .normal: return "normal"
        case .limited: return "limited"
        case .notAvailable: return "notAvailable"
        @unknown default: return "unknown"
        }
    }

    // MARK: CLLocationManagerDelegate

    func locationManager(_ m: CLLocationManager, didUpdateLocations locs: [CLLocation]) {
        guard let loc = locs.last else { return }
        latestLocation = loc
        let acc = loc.horizontalAccuracy
        gpsAccuracyM = acc
        gpsStatus = acc < 0 ? "no fix" : String(format: "±%.0fm", acc)
        if acc >= 0 {
            latitude = loc.coordinate.latitude
            longitude = loc.coordinate.longitude
        }
        if isRecording, acc >= 0, acc <= InsidTheme.gpsGoodM {
            let t = elapsed
            gpsFixes.append(GPSFixSample(t: t, lat: loc.coordinate.latitude, lon: loc.coordinate.longitude, accuracy: acc))
            lastGoodFixElapsed = t
        }
    }

    func locationManager(_ m: CLLocationManager, didUpdateHeading h: CLHeading) {
        guard h.headingAccuracy >= 0 else { return }
        headingDeg = h.trueHeading
        headingAccuracy = h.headingAccuracy
        if isRecording, !capturedHeading {
            capturedHeading = true
            startHeading = Heading(trueHeading: h.trueHeading, accuracy: h.headingAccuracy)
        }
    }

    func locationManager(_ m: CLLocationManager, didFailWithError error: Error) {}

    // MARK: export + persistence

    private var recordingsDir: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }

    private func export(_ walk: Walk, displayName: String?, buildingCount: Int, hadExitFix: Bool) {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes]
        guard let data = try? enc.encode(walk) else { return }
        let url = recordingsDir.appendingPathComponent("\(walk.id).json")
        try? data.write(to: url)
        lastExportURL = url

        let dist = zip(walk.points.dropFirst(), walk.points).reduce(0.0) { acc, pair in
            let (b, a) = pair
            return acc + hypot(b.x - a.x, hypot(b.y - a.y, b.z - a.z))
        }

        let rec = Recording(
            id: walk.id,
            url: url,
            pointCount: walk.points.count,
            duration: walk.points.last?.t ?? 0,
            startAnchorId: walk.startAnchorId,
            recordedAt: walk.recordedAt,
            displayName: displayName,
            buildingCount: buildingCount,
            distanceM: dist,
            anchorEnd: hadExitFix ? "endEntrance" : (gpsFixes.isEmpty ? "none" : "gpsFix")
        )
        recordings.removeAll { $0.id == rec.id }
        recordings.insert(rec, at: 0)
    }

    func loadRecordings() {
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(
            at: recordingsDir,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ) else { return }

        let dec = JSONDecoder()
        var found: [Recording] = []
        for url in files where url.pathExtension == "json"
            && url.lastPathComponent.hasPrefix("walk-") {
            guard let data = try? Data(contentsOf: url),
                  let walk = try? dec.decode(Walk.self, from: data) else { continue }
            let dist = zip(walk.points.dropFirst(), walk.points).reduce(0.0) { acc, pair in
                let (b, a) = pair
                return acc + hypot(b.x - a.x, hypot(b.y - a.y, b.z - a.z))
            }
            found.append(Recording(
                id: walk.id,
                url: url,
                pointCount: walk.points.count,
                duration: walk.points.last?.t ?? 0,
                startAnchorId: walk.startAnchorId,
                recordedAt: walk.recordedAt,
                displayName: nil,
                buildingCount: 1,
                distanceM: dist,
                anchorEnd: nil
            ))
        }
        found.sort { ($0.recordedAt ?? "") > ($1.recordedAt ?? "") }
        recordings = found
        if lastExportURL == nil { lastExportURL = found.first?.url }
    }

    func delete(_ recording: Recording) {
        try? FileManager.default.removeItem(at: recording.url)
        recordings.removeAll { $0.id == recording.id }
        if lastExportURL == recording.url { lastExportURL = recordings.first?.url }
    }

    func delete(at offsets: IndexSet) {
        for index in offsets { delete(recordings[index]) }
    }
}
