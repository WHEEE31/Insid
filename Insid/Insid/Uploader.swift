import Foundation

// Uploads a completed Walk to Supabase (the DATABASE pipeline: phone -> Supabase
// -> web). POSTs to {SUPABASE_URL}/rest/v1/walks with the anon key. Dependency-
// free (URLSession); no supabase-js / SDK. See docs/contracts.md + supabase/.
//
// Config: reads two keys from the app's Info.plist —
//     SUPABASE_URL         e.g. https://abcdefgh.supabase.co
//     SUPABASE_ANON_KEY    the project's anon / public key
// Add them in Xcode: target -> Info tab -> add two String rows. If they're
// missing or still placeholders, upload() fails with .missingConfig instead of
// crashing. (Also documented in supabase/README.md.)

enum UploadError: LocalizedError {
    case missingConfig
    case encodingFailed
    case fileReadFailed
    case badResponse(Int, String)
    case transport(Error)

    var errorDescription: String? {
        switch self {
        case .missingConfig:
            return "Supabase not configured (set SUPABASE_URL + SUPABASE_ANON_KEY in Info.plist)."
        case .encodingFailed:
            return "Could not encode the walk."
        case .fileReadFailed:
            return "Could not read the recording file."
        case .badResponse(let code, let body):
            return "Server rejected upload (HTTP \(code)). \(body)"
        case .transport(let err):
            return "Network error: \(err.localizedDescription)"
        }
    }
}

final class Uploader {
    static let shared = Uploader()

    private let session: URLSession
    init(session: URLSession = .shared) { self.session = session }

    // The `walks` table row (snake_case columns per supabase/schema.sql). Points
    // are encoded as the SAME JSON array as the file export (Point is Codable).
    private struct WalkRow: Encodable {
        let id: String
        let recorded_at: String
        let device: String
        let start_node_id: String?
        let orient_node_id: String?
        let end_node_id: String?
        let baro_reference: Double?
        // v4: the GPS fix + compass heading captured at the start of the walk,
        // and the north calibration. These used to be dropped on upload (no
        // columns existed) — see supabase/schema.sql's v4 ALTER block.
        let start_lat: Double?
        let start_lon: Double?
        let gps_accuracy: Double?
        let start_heading: Double?
        let heading_accuracy: Double?
        let north_offset_deg: Double?
        let north_aligned: Bool?
        let points: [Point]
    }

    // Resolve Supabase config from Info.plist. Returns nil (=> .missingConfig)
    // if either key is absent, blank, or still a "YOUR-..." placeholder.
    private func config() -> (url: String, key: String)? {
        // Prefer the compiled-in SupabaseConfig; fall back to Info.plist keys.
        var rawURL = SupabaseConfig.url
        var key = SupabaseConfig.anonKey
        if !rawURL.hasPrefix("http") || rawURL.contains("YOUR-") || key.isEmpty || key.contains("YOUR-") {
            let info = Bundle.main.infoDictionary
            rawURL = info?["SUPABASE_URL"] as? String ?? ""
            key = info?["SUPABASE_ANON_KEY"] as? String ?? ""
        }
        guard rawURL.hasPrefix("http"), !rawURL.contains("YOUR-"), !key.isEmpty, !key.contains("YOUR-")
        else { return nil }
        // normalize to the BASE project URL (tolerate a stray /rest/v1 or trailing /)
        var url = rawURL
        while url.hasSuffix("/") { url = String(url.dropLast()) }
        if url.hasSuffix("/rest/v1") { url = String(url.dropLast("/rest/v1".count)) }
        return (url, key)
    }

    var isConfigured: Bool { config() != nil }

    // Upload a Walk value. The completion is always delivered on the main queue.
    func upload(_ walk: Walk, completion: @escaping (Result<Void, UploadError>) -> Void) {
        let done: (Result<Void, UploadError>) -> Void = { result in
            DispatchQueue.main.async { completion(result) }
        }

        guard let cfg = config() else { return done(.failure(.missingConfig)) }
        guard let endpoint = URL(string: "\(cfg.url)/rest/v1/walks") else {
            return done(.failure(.missingConfig))
        }

        // v3: node refs. v4: GPS/compass/north — all pass straight through to the
        // matching walks columns (null when the walk was recorded without them).
        let row = WalkRow(
            id: walk.id,
            recorded_at: walk.recordedAt,
            device: walk.device,
            start_node_id: walk.startNodeId,
            orient_node_id: walk.orientNodeId,
            end_node_id: walk.endNodeId,
            baro_reference: walk.baroReference,
            start_lat: walk.startLatLon?.lat,
            start_lon: walk.startLatLon?.lon,
            gps_accuracy: walk.startLatLon?.gpsAccuracy,
            start_heading: walk.startHeading?.trueHeading,
            heading_accuracy: walk.startHeading?.accuracy,
            north_offset_deg: walk.northOffsetDeg,
            north_aligned: walk.northAligned,
            points: walk.points
        )

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        guard let body = try? encoder.encode(row) else {
            return done(.failure(.encodingFailed))
        }

        var req = URLRequest(url: endpoint)
        req.httpMethod = "POST"
        req.setValue(cfg.key, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(cfg.key)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("return=minimal", forHTTPHeaderField: "Prefer")
        req.httpBody = body

        session.dataTask(with: req) { data, response, error in
            if let error {
                return done(.failure(.transport(error)))
            }
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            // PostgREST returns 201 (or 200) on a successful insert.
            if (200..<300).contains(code) {
                return done(.success(()))
            }
            let bodyText = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            return done(.failure(.badResponse(code, bodyText)))
        }.resume()
    }

    // Convenience: decode a persisted walk JSON file and upload it.
    func upload(fileURL: URL, completion: @escaping (Result<Void, UploadError>) -> Void) {
        guard
            let data = try? Data(contentsOf: fileURL),
            let walk = try? JSONDecoder().decode(Walk.self, from: data)
        else {
            DispatchQueue.main.async { completion(.failure(.fileReadFailed)) }
            return
        }
        upload(walk, completion: completion)
    }
}
