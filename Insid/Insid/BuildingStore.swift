import Foundation
import Combine
import CoreLocation

// Campus building gazetteer — bundled copy of web/data/buildings.json.

struct Building: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let code: String?
    let aliases: [String]?
    let lat: Double
    let lon: Double
    let levels: Int?
    let floorHeightM: Double?
}

struct BuildingHit: Identifiable, Hashable {
    var id: String { building.id }
    let building: Building
    let score: Double
    let distanceM: Double?
}

final class BuildingStore: ObservableObject {
    @Published private(set) var buildings: [Building] = []

    init() { load() }

    func load() {
        guard let url = Bundle.main.url(forResource: "buildings", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let doc = try? JSONDecoder().decode(BuildingsDoc.self, from: data)
        else {
            buildings = Self.seed
            return
        }
        buildings = doc.buildings
    }

    func name(for id: String?) -> String {
        guard let id, let b = buildings.first(where: { $0.id == id }) else { return "—" }
        return b.name
    }

    func nearby(lat: Double, lon: Double, limit: Int = 5) -> [BuildingHit] {
        resolve(query: "", lat: lat, lon: lon, limit: limit)
    }

    func resolve(query: String, lat: Double?, lon: Double?, limit: Int = 5) -> [BuildingHit] {
        let q = Self.normalize(query)
        let here: (lat: Double, lon: Double)? = {
            guard let lat, let lon else { return nil }
            return (lat, lon)
        }()

        var scored: [BuildingHit] = []
        for b in buildings {
            var nameScore = 0.0
            for alias in b.aliases ?? [b.name, b.code].compactMap({ $0 }) {
                nameScore = max(nameScore, Self.aliasScore(q, Self.normalize(alias)))
                if nameScore == 1 { break }
            }
            let distanceM = here.map { Self.metersBetween($0.lat, $0.lon, b.lat, b.lon) }

            let score: Double
            if q.isEmpty {
                guard let d = distanceM else { continue }
                score = 1 / (1 + d / 50)
            } else if nameScore <= 0 {
                continue
            } else if let d = distanceM {
                score = nameScore + 0.12 * exp(-d / 200)
            } else {
                score = nameScore
            }
            scored.append(BuildingHit(building: b, score: score, distanceM: distanceM))
        }
        return scored.sorted { $0.score > $1.score }.prefix(limit).map { $0 }
    }

    private struct BuildingsDoc: Codable {
        let buildings: [Building]
    }

    private static func normalize(_ s: String) -> String {
        s.lowercased()
            .replacingOccurrences(of: "[^a-z0-9 ]+", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
    }

    private static func aliasScore(_ query: String, _ alias: String) -> Double {
        if query.isEmpty || alias.isEmpty { return 0 }
        if alias == query { return 1 }
        if query.count >= 3 && alias.hasPrefix(query) { return 0.88 }
        if alias.count >= 3 && query.hasPrefix(alias) { return 0.84 }
        if query.count >= 3 && alias.contains(query) { return 0.72 }
        let d = editDistance(query, alias, cap: 4)
        let span = max(query.count, alias.count)
        if d <= 2 && span >= 4 { return 0.65 - Double(d) * 0.1 }
        return 0
    }

    private static func editDistance(_ a: String, _ b: String, cap: Int) -> Int {
        let a = Array(a), b = Array(b)
        if abs(a.count - b.count) > cap { return cap + 1 }
        var prev = Array(0...b.count)
        for i in 1...a.count {
            var cur = [i]
            var rowMin = i
            for j in 1...b.count {
                let cost = a[i - 1] == b[j - 1] ? 0 : 1
                let v = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
                cur.append(v)
                rowMin = min(rowMin, v)
            }
            if rowMin > cap { return cap + 1 }
            prev = cur
        }
        return prev[b.count]
    }

    private static func metersBetween(_ lat1: Double, _ lon1: Double, _ lat2: Double, _ lon2: Double) -> Double {
        let mPerDegLat = 111_320.0
        let mLon = mPerDegLat * cos(((lat1 + lat2) / 2) * .pi / 180)
        return hypot((lat1 - lat2) * mPerDegLat, (lon1 - lon2) * mLon)
    }

    static let seed: [Building] = [
        Building(id: "wean-hall", name: "Wean Hall", code: "WEH", aliases: ["wean", "weh"], lat: 40.44267, lon: -79.94581, levels: nil, floorHeightM: nil),
        Building(id: "doherty-hall", name: "Doherty Hall", code: "DH", aliases: ["doherty", "dh"], lat: 40.44252, lon: -79.94450, levels: nil, floorHeightM: nil),
        Building(id: "gates-hillman", name: "Gates and Hillman Centers", code: "GHC", aliases: ["gates", "ghc"], lat: 40.4435, lon: -79.9446, levels: nil, floorHeightM: nil),
    ]
}
