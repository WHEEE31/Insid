import Foundation
import Combine
import CoreLocation
import simd

// App-wide stage machine mirroring web/prototype.js `S` + `screens`.

enum AppStage: String, Hashable {
    case home
    case start, gps, entrance, north, ready, live
    case transition, exitPrompt, endGate, endEntrance, finish, recordings
    case dest, route
}

struct BuildingFormState {
    var query = ""
    var selectedId: String? = nil
    var floor: Int = 1
}

struct BuildingTransition: Identifiable, Hashable {
    let id = UUID()
    let buildingId: String
    let buildingName: String
    let floor: Int
    let t: Double
}

struct EntranceAnchor: Hashable {
    var buildingId: String
    var buildingName: String
    var floor: Int
    var gpsAccuracy: Double
    var lat: Double?
    var lon: Double?
}

struct WayfinderPlace: Identifiable, Hashable {
    let id: String
    let name: String
    let ref: String
    let kind: String
    let code: String?
    let floor: Int
    let x: Double
    let y: Double
    let z: Double
    var distanceM: Double = 0
}

struct RouteStep: Identifiable, Hashable {
    let id = UUID()
    let text: String
    let dist: Double
}

struct RouteResult: Hashable {
    var lengthM: Double
    var nodes: [WayfinderPlace]
    var steps: [RouteStep]
    var fromLabel: String
}

@MainActor
final class AppModel: ObservableObject {
    @Published var stage: AppStage = .home
    @Published var form = BuildingFormState()
    @Published var toast: String? = nil

    // Collector session (declared before recording starts / during live)
    @Published var buildingId: String? = nil
    @Published var floor: Int = 1
    @Published var northConfirmed = false
    @Published var northOffsetDeg: Double? = nil
    @Published var startEntrance: EntranceAnchor? = nil
    @Published var endEntrance: EntranceAnchor? = nil
    @Published var transitions: [BuildingTransition] = []
    @Published var pathName = ""
    @Published var hadExitFix = false
    var endEntranceBack: AppStage = .endGate

    // Wayfinder
    @Published var destQuery = ""
    @Published var destId: String? = nil
    @Published var routeResult: RouteResult? = nil
    @Published var cloudWalkCount = 0

    let buildings = BuildingStore()
    let nodes = NodeStore()
    let graph = WayfinderGraph()

    private var toastTask: Task<Void, Never>?

    func go(_ next: AppStage) {
        stage = next
    }

    func showToast(_ msg: String) {
        toast = msg
        toastTask?.cancel()
        toastTask = Task {
            try? await Task.sleep(nanoseconds: 1_300_000_000)
            if !Task.isCancelled { toast = nil }
        }
    }

    func resetCollectorSession() {
        form = BuildingFormState()
        buildingId = nil
        floor = 1
        northConfirmed = false
        northOffsetDeg = nil
        startEntrance = nil
        endEntrance = nil
        transitions = []
        pathName = ""
        hadExitFix = false
    }

    func beginContribute() {
        resetCollectorSession()
        go(.start)
    }

    func beginNavigate() {
        destQuery = ""
        destId = nil
        routeResult = nil
        rebuildGraph()
        go(.dest)
    }

    func rebuildGraph() {
        graph.rebuild(from: nodes.nodes)
        objectWillChange.send()
    }

    func confirmEntrance(from rec: Recorder) {
        guard let id = form.selectedId else { return }
        buildingId = id
        floor = form.floor
        let acc = rec.gpsAccuracyM >= 0 ? rec.gpsAccuracyM : 99
        startEntrance = EntranceAnchor(
            buildingId: id,
            buildingName: buildings.name(for: id),
            floor: form.floor,
            gpsAccuracy: acc,
            lat: rec.latitude,
            lon: rec.longitude
        )
        go(.north)
    }

    func confirmNorth(offsetDeg: Double) {
        northOffsetDeg = offsetDeg
        northConfirmed = true
        go(.ready)
    }

    func declareTransition(id: String, floor: Int, elapsed: Double) {
        buildingId = id
        self.floor = floor
        transitions.append(BuildingTransition(
            buildingId: id,
            buildingName: buildings.name(for: id),
            floor: floor,
            t: elapsed
        ))
        showToast("Entered \(buildings.name(for: id)) · F\(floor)")
        go(.live)
    }

    func captureEndEntrance(from rec: Recorder) {
        guard let id = form.selectedId else { return }
        buildingId = id
        floor = form.floor
        let acc = rec.gpsAccuracyM >= 0 ? rec.gpsAccuracyM : 99
        endEntrance = EntranceAnchor(
            buildingId: id,
            buildingName: buildings.name(for: id),
            floor: form.floor,
            gpsAccuracy: acc,
            lat: rec.latitude,
            lon: rec.longitude
        )
        hadExitFix = true
        go(.finish)
    }

    func refreshCloudStats() {
        // Best-effort walk count from Supabase; places come from node registry.
        guard let cfg = Self.supabaseConfig(),
              let url = URL(string: "\(cfg.url)/rest/v1/walks?select=id") else { return }
        var req = URLRequest(url: url)
        req.setValue(cfg.key, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(cfg.key)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        URLSession.shared.dataTask(with: req) { data, _, _ in
            guard let data,
                  let rows = try? JSONDecoder().decode([[String: String]].self, from: data)
            else { return }
            let count = rows.count
            DispatchQueue.main.async {
                self.cloudWalkCount = count
            }
        }.resume()
    }

    var placesCount: Int { max(nodes.nodes.count, graph.places.count) }

    private static func supabaseConfig() -> (url: String, key: String)? {
        var rawURL = SupabaseConfig.url
        var key = SupabaseConfig.anonKey
        if !rawURL.hasPrefix("http") || rawURL.contains("YOUR-") || key.isEmpty || key.contains("YOUR-") {
            let info = Bundle.main.infoDictionary
            rawURL = info?["SUPABASE_URL"] as? String ?? ""
            key = info?["SUPABASE_ANON_KEY"] as? String ?? ""
        }
        guard rawURL.hasPrefix("http"), !rawURL.contains("YOUR-"), !key.isEmpty, !key.contains("YOUR-")
        else { return nil }
        var url = rawURL
        while url.hasSuffix("/") { url = String(url.dropLast()) }
        if url.hasSuffix("/rest/v1") { url = String(url.dropLast("/rest/v1".count)) }
        return (url, key)
    }
}
