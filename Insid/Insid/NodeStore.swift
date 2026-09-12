import Foundation
import Combine
import simd

// On-device node registry (building-local frame; see docs/contracts.md).
// - Loads nodes from Supabase (GET /rest/v1/nodes) when SUPABASE_URL +
//   SUPABASE_ANON_KEY are configured in Info.plist; otherwise (or on failure)
//   falls back to a small bundled seed list mirroring web/data/nodes.json.
// - Supports creating a new node at the current ARKit position ("＋ New node
//   here"), added locally and POSTed best-effort to Supabase.

struct Node: Codable, Identifiable, Hashable {
    let id: String
    var name: String
    var floor: Int
    var x: Double
    var y: Double
    var z: Double
    var lat: Double?
    var lon: Double?
}

final class NodeStore: ObservableObject {
    // Most recent / lowest floor first. Always non-empty (seeded synchronously).
    @Published private(set) var nodes: [Node]
    @Published private(set) var statusText = "bundled nodes"

    private let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
        self.nodes = Self.bundledNodes
        fetchRemote()
    }

    // Seed list — the 5 nodes from web/data/nodes.json.
    static let bundledNodes: [Node] = [
        Node(id: "lobby-door",      name: "Lobby Door",             floor: 0, x: 0,    y: 0,   z: 0,    lat: nil, lon: nil),
        Node(id: "corridor-a1",     name: "Corridor A Junction",    floor: 0, x: 12.5, y: 0,   z: 4.0,  lat: nil, lon: nil),
        Node(id: "elevator-lobby",  name: "Elevator Lobby",         floor: 0, x: 18.0, y: 0,   z: -2.5, lat: nil, lon: nil),
        Node(id: "stair-landing-0", name: "Stairwell Landing (G)",  floor: 0, x: 22.0, y: 0,   z: 9.0,  lat: nil, lon: nil),
        Node(id: "stair-landing-1", name: "Stairwell Landing (L1)", floor: 1, x: 22.0, y: 4.2, z: 9.0,  lat: nil, lon: nil)
    ]

    func name(for id: String?) -> String? {
        guard let id else { return nil }
        return nodes.first { $0.id == id }?.name
    }

    // MARK: Supabase config (same contract as Uploader)
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

    // MARK: remote load
    func fetchRemote() {
        guard let cfg = config(),
              let url = URL(string: "\(cfg.url)/rest/v1/nodes?select=*") else { return }
        var req = URLRequest(url: url)
        req.setValue(cfg.key, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(cfg.key)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")

        session.dataTask(with: req) { [weak self] data, _, _ in
            guard let self,
                  let data,
                  let rows = try? JSONDecoder().decode([Node].self, from: data),
                  !rows.isEmpty else { return }
            let sorted = rows.sorted { ($0.floor, $0.name) < ($1.floor, $1.name) }
            DispatchQueue.main.async {
                self.nodes = sorted
                self.statusText = "\(sorted.count) nodes · cloud"
            }
        }.resume()
    }

    // MARK: create
    // Create a node at the given ARKit-local position (floor inferred coarsely
    // from height, ~3.5 m per level). Adds it locally + best-effort POSTs it.
    @discardableResult
    func addNode(name: String, position: SIMD3<Float>) -> Node {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let display = trimmed.isEmpty ? "New Node" : trimmed
        let floor = max(0, Int((Double(position.y) / 3.5).rounded()))
        let node = Node(
            id: "node-\(Int(Date().timeIntervalSince1970))",
            name: display,
            floor: floor,
            x: Double(position.x),
            y: Double(position.y),
            z: Double(position.z),
            lat: nil, lon: nil
        )
        nodes.insert(node, at: 0)
        postNode(node)
        return node
    }

    private func postNode(_ node: Node) {
        guard let cfg = config(),
              let url = URL(string: "\(cfg.url)/rest/v1/nodes") else { return }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        guard let body = try? encoder.encode(node) else { return }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue(cfg.key, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(cfg.key)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("return=minimal", forHTTPHeaderField: "Prefer")
        req.httpBody = body
        session.dataTask(with: req) { _, _, _ in /* best effort */ }.resume()
    }
}
