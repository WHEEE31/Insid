import Foundation
import Combine

// Minimal on-device wayfinder: treat registry nodes as a k-NN graph and run
// Dijkstra. Enough for dest search + numbered steps without porting the full
// web refine pipeline.

final class WayfinderGraph: ObservableObject {
    @Published private(set) var places: [WayfinderPlace] = []

    private var adj: [String: [(to: String, w: Double)]] = [:]
    private var byId: [String: WayfinderPlace] = [:]

    func rebuild(from nodes: [Node]) {
        let mapped: [WayfinderPlace] = nodes.map { n in
            WayfinderPlace(
                id: n.id,
                name: n.name,
                ref: n.id,
                kind: Self.kind(for: n.name),
                code: nil,
                floor: n.floor,
                x: n.x, y: n.y, z: n.z
            )
        }
        places = mapped
        byId = Dictionary(uniqueKeysWithValues: mapped.map { ($0.id, $0) })
        adj = Self.buildKNN(mapped, k: 4)
    }

    func matches(query: String, near x: Double, z: Double) -> [WayfinderPlace] {
        let all = places
            .map { p -> WayfinderPlace in
                var q = p
                q.distanceM = hypot(p.x - x, p.z - z)
                return q
            }
            .sorted { $0.distanceM < $1.distanceM }

        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if q.isEmpty { return Array(all.prefix(60)) }
        return all.filter { Self.matchesPlace($0, query: q) }
    }

    func route(from start: SIMD3<Float>?, to destId: String) -> RouteResult? {
        guard let dest = byId[destId] else { return nil }
        let here = start.map { (Double($0.x), Double($0.y), Double($0.z)) } ?? (0, 0, 0)

        // Snap start to nearest place
        guard let from = places.min(by: {
            hypot($0.x - here.0, $0.z - here.2) < hypot($1.x - here.0, $1.z - here.2)
        }) else { return nil }

        guard let pathIds = dijkstra(from: from.id, to: dest.id) else { return nil }
        let nodes = pathIds.compactMap { byId[$0] }
        guard nodes.count >= 1 else { return nil }

        var length = 0.0
        for i in 1..<nodes.count {
            let a = nodes[i - 1], b = nodes[i]
            length += hypot(b.x - a.x, hypot(b.y - a.y, b.z - a.z))
        }
        // Include snap distance from current pose onto first node
        length += hypot(from.x - here.0, from.z - here.2)

        return RouteResult(
            lengthM: length,
            nodes: nodes,
            steps: Self.steps(nodes: nodes, lengthM: length),
            fromLabel: from.name
        )
    }

    // MARK: - graph helpers

    private static func buildKNN(_ places: [WayfinderPlace], k: Int) -> [String: [(to: String, w: Double)]] {
        var adj: [String: [(to: String, w: Double)]] = [:]
        for p in places {
            let neighbors = places
                .filter { $0.id != p.id }
                .map { q -> (String, Double) in
                    let w = hypot(q.x - p.x, hypot(q.y - p.y, q.z - p.z))
                    return (q.id, w)
                }
                .sorted { $0.1 < $1.1 }
                .prefix(k)
            adj[p.id] = neighbors.map { (to: $0.0, w: $0.1) }
        }
        // Make undirected
        for (u, outs) in adj {
            for e in outs {
                var rev = adj[e.to] ?? []
                if !rev.contains(where: { $0.to == u }) {
                    rev.append((to: u, w: e.w))
                    adj[e.to] = rev
                }
            }
        }
        return adj
    }

    private func dijkstra(from: String, to: String) -> [String]? {
        if from == to { return [from] }
        var dist: [String: Double] = [from: 0]
        var prev: [String: String] = [:]
        var visited = Set<String>()
        var queue: [(String, Double)] = [(from, 0)]

        while !queue.isEmpty {
            queue.sort { $0.1 < $1.1 }
            let (u, du) = queue.removeFirst()
            if visited.contains(u) { continue }
            visited.insert(u)
            if u == to { break }
            for e in adj[u] ?? [] {
                let alt = du + e.w
                if alt < (dist[e.to] ?? .infinity) {
                    dist[e.to] = alt
                    prev[e.to] = u
                    queue.append((e.to, alt))
                }
            }
        }
        guard dist[to] != nil else { return nil }
        var path = [to]
        var cur = to
        while let p = prev[cur] {
            path.append(p)
            cur = p
        }
        return path.reversed()
    }

    private static func steps(nodes: [WayfinderPlace], lengthM: Double) -> [RouteStep] {
        guard !nodes.isEmpty else {
            return [RouteStep(text: "Head straight there", dist: lengthM)]
        }
        var steps: [RouteStep] = []
        var runDist = 0.0
        var curFloor = nodes[0].floor
        for i in 1..<nodes.count {
            let a = nodes[i - 1], b = nodes[i]
            runDist += hypot(b.x - a.x, hypot(b.y - a.y, b.z - a.z))
            if b.floor != curFloor {
                steps.append(RouteStep(
                    text: "Follow the corridor, then take the stairs to floor \(b.floor)",
                    dist: runDist
                ))
                runDist = 0
                curFloor = b.floor
            } else if b.kind == "junction" && runDist > 8 {
                steps.append(RouteStep(text: "Continue to the junction", dist: runDist))
                runDist = 0
            }
        }
        if runDist > 0.5 {
            steps.append(RouteStep(text: "Continue to your destination", dist: runDist))
        }
        return steps.isEmpty ? [RouteStep(text: "You're basically there", dist: lengthM)] : steps
    }

    private static func matchesPlace(_ n: WayfinderPlace, query: String) -> Bool {
        let hay = [n.name, n.ref, n.code, n.kind, "floor \(n.floor)"]
            .compactMap { $0 }
            .joined(separator: " ")
            .lowercased()
        return query.lowercased().split(whereSeparator: \.isWhitespace)
            .allSatisfy { hay.contains($0) }
    }

    private static func kind(for name: String) -> String {
        let l = name.lowercased()
        if l.contains("stair") { return "stairs" }
        if l.contains("elev") { return "elevator" }
        if l.contains("door") || l.contains("exit") { return "door" }
        if l.contains("junction") || l.contains("corridor") { return "junction" }
        return "room"
    }
}
