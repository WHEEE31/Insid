import Foundation
import ARKit
import CoreMotion
import CoreLocation
import Combine

// Recording engine: fuses ARKit VIO pose (position + tracking state) with the
// barometer (CMAltimeter) and a one-shot GPS fix + heading at start. Samples at
// ~10 Hz and emits a Walk conforming to the contract. See docs/path-schema.md.

// Lightweight metadata for a persisted walk JSON file. Backs the recordings list
// so the user can browse / export past walks without re-decoding full Walks.
struct Recording: Identifiable, Hashable {
    let id: String            // == walk.id, also the filename stem
    let url: URL              // stable location in the documents directory
    let pointCount: Int
    let duration: Double      // seconds (last point's t)
    let startAnchorId: String
    var recordedAt: String?   // ISO8601, if decodable (for sort/display)
}

final class Recorder: NSObject, ObservableObject, ARSessionDelegate, CLLocationManagerDelegate {
    // live UI state
    @Published var isRecording = false
    @Published var pointCount = 0
    @Published var trackingState = "—"
    @Published var relAltitude = 0.0
    @Published var startAnchorId = "demo-lobby-x"
    @Published var lastExportURL: URL?

    // persisted list of every recording (most recent first). Survives launches:
    // populated from disk in init(), appended to on each stopRecording().
    @Published var recordings: [Recording] = []

    let session = ARSession()

    private let altimeter = CMAltimeter()
    private let location = CLLocationManager()

    private var walk: Walk?
    private var startTime: TimeInterval = 0
    private var lastSample: TimeInterval = 0
    private let sampleInterval = 0.1 // ~10 Hz

    // latest barometer readings (updated async)
    private var latestPressureKPa: Double?
    private var latestRelAltitude: Double?
    private var baroReference: Double?

    // one-shot start fixes
    private var startLatLon: LatLon?
    private var startHeading: Heading?
    private var capturedHeading = false
    private var relAltOffset = 0.0 // relAltitude at record start, so points are 0-based
    private var latestLocation: CLLocation? // most recent GPS fix (continuous)
    @Published var gpsStatus = "—"          // live fix quality, for the UI

    override init() {
        super.init()
        session.delegate = self
        location.delegate = self
        location.desiredAccuracy = kCLLocationAccuracyBest
        loadRecordings()
    }

    func startSession() {
        let config = ARWorldTrackingConfiguration()
        config.worldAlignment = .gravity // Y = up; horizontal yaw arbitrary per session
        session.run(config, options: [.resetTracking, .removeExistingAnchors])

        // Warm the barometer at launch so it's delivering before the first Record
        // (avoids a startup gap from the one-time Motion permission prompt).
        if CMAltimeter.isRelativeAltitudeAvailable() {
            altimeter.startRelativeAltitudeUpdates(to: .main) { [weak self] data, _ in
                guard let self, let data else { return }
                self.latestPressureKPa = data.pressure.doubleValue // kPa
                self.latestRelAltitude = data.relativeAltitude.doubleValue
                self.relAltitude = data.relativeAltitude.doubleValue - self.relAltOffset
            }
        }
        // Ask for location up front and start CONTINUOUS updates so a fix (and its
        // accuracy) is ready by record time — indoors GPS can take a while to lock.
        location.requestWhenInUseAuthorization()
        location.startUpdatingLocation()
    }

    func startRecording() {
        guard !isRecording else { return }
        pointCount = 0
        startLatLon = nil
        startHeading = nil
        capturedHeading = false
        startTime = 0

        // barometer is already running (warmed in startSession) — zero it here so
        // each walk's relAltitude starts at 0, and snapshot the reference pressure.
        relAltOffset = latestRelAltitude ?? 0
        baroReference = latestPressureKPa

        walk = Walk(
            id: "walk-\(Int(Date().timeIntervalSince1970))",
            recordedAt: ISO8601DateFormatter().string(from: Date()),
            startAnchorId: startAnchorId
        )

        // snapshot the best current GPS fix as the walk's start location
        if let loc = latestLocation {
            startLatLon = LatLon(
                lat: loc.coordinate.latitude,
                lon: loc.coordinate.longitude,
                gpsAccuracy: loc.horizontalAccuracy
            )
        }
        if CLLocationManager.headingAvailable() { location.startUpdatingHeading() }

        isRecording = true
    }

    func stopRecording() {
        guard isRecording, var walk else { return }
        isRecording = false
        // keep the barometer running (warm) for the next walk
        location.stopUpdatingHeading()

        walk.baroReference = baroReference
        walk.startLatLon = startLatLon
        walk.startHeading = startHeading
        self.walk = walk
        export(walk)
    }

    // MARK: ARSessionDelegate

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard isRecording, walk != nil else {
            // still surface tracking state before recording
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
        gpsStatus = acc < 0 ? "no fix" : String(format: "±%.0fm", acc)
    }

    func locationManager(_ m: CLLocationManager, didUpdateHeading h: CLHeading) {
        guard !capturedHeading, h.headingAccuracy >= 0 else { return }
        capturedHeading = true
        startHeading = Heading(trueHeading: h.trueHeading, accuracy: h.headingAccuracy)
    }

    func locationManager(_ m: CLLocationManager, didFailWithError error: Error) {
        // GPS is optional (coarse display only) — ignore failures
    }

    // MARK: export + persistence

    // Stable, backed-up location that survives app launches and temp-dir purges.
    private var recordingsDir: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }

    private func export(_ walk: Walk) {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes]
        guard let data = try? enc.encode(walk) else { return }
        let url = recordingsDir.appendingPathComponent("\(walk.id).json")
        try? data.write(to: url)
        lastExportURL = url

        let rec = Recording(
            id: walk.id,
            url: url,
            pointCount: walk.points.count,
            duration: walk.points.last?.t ?? 0,
            startAnchorId: walk.startAnchorId,
            recordedAt: walk.recordedAt
        )
        // most recent first; replace any existing entry with the same id
        recordings.removeAll { $0.id == rec.id }
        recordings.insert(rec, at: 0)
    }

    // Scan the documents dir for walk-*.json and rebuild the recordings list.
    // Decodes each file just enough to fill metadata (points.count, last t, anchor).
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
            found.append(Recording(
                id: walk.id,
                url: url,
                pointCount: walk.points.count,
                duration: walk.points.last?.t ?? 0,
                startAnchorId: walk.startAnchorId,
                recordedAt: walk.recordedAt
            ))
        }
        // most recent first (recordedAt is ISO8601, so lexical sort == chronological)
        found.sort { ($0.recordedAt ?? "") > ($1.recordedAt ?? "") }
        recordings = found
        if lastExportURL == nil { lastExportURL = found.first?.url }
    }

    // Delete a persisted recording (file + list entry).
    func delete(_ recording: Recording) {
        try? FileManager.default.removeItem(at: recording.url)
        recordings.removeAll { $0.id == recording.id }
        if lastExportURL == recording.url { lastExportURL = recordings.first?.url }
    }

    func delete(at offsets: IndexSet) {
        for index in offsets { delete(recordings[index]) }
    }
}
