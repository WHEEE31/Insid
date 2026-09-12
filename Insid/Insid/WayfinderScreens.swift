import SwiftUI
import simd

struct HomeView: View {
    @ObservedObject var app: AppModel
    @ObservedObject var rec: Recorder

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 24)

            VStack(spacing: 16) {
                InsidLogoMark(size: 72)
                Text("inSID")
                    .font(InsidFont.display(32, weight: .bold))
                    .tracking(2)
                    .foregroundStyle(InsidTheme.paper)
                Text("Walk a building once. Everyone who follows gets the route.")
                    .font(InsidFont.ui(15))
                    .foregroundStyle(InsidTheme.fog)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 28)
            }

            Spacer(minLength: 24)

            StatGrid(items: [
                .init(value: "\(max(app.cloudWalkCount, rec.recordings.count))", label: "Walks"),
                .init(value: "\(app.buildings.buildings.count)", label: "Buildings"),
                .init(value: "\(app.placesCount)", label: "Places"),
            ])
            .padding(.horizontal, 16)

            Spacer(minLength: 32)

            VStack(spacing: 10) {
                ChoiceButton(
                    title: "I need to go to…",
                    subtitle: "Search a room, get the indoor route"
                ) {
                    app.beginNavigate()
                }
                ChoiceButton(
                    title: "I want to contribute",
                    subtitle: "Map a building by walking it",
                    quiet: true
                ) {
                    app.beginContribute()
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 28)
        }
    }
}

struct DestSearchView: View {
    @ObservedObject var app: AppModel
    @ObservedObject var rec: Recorder

    private var hereX: Double { Double(rec.latestCameraPos?.x ?? 0) }
    private var hereZ: Double { Double(rec.latestCameraPos?.z ?? 0) }

    private var places: [WayfinderPlace] {
        app.graph.matches(query: app.destQuery, near: hereX, z: hereZ)
    }

    private var grouped: [(String, [WayfinderPlace])] {
        var map: [String: [WayfinderPlace]] = [:]
        var order: [String] = []
        for p in places {
            let key = "\((p.code ?? "F")) \(p.floor)"
            if map[key] == nil { order.append(key) }
            map[key, default: []].append(p)
        }
        return order.map { ($0, map[$0]!) }
    }

    private var picked: WayfinderPlace? {
        places.first { $0.id == app.destId }
    }

    var body: some View {
        ScreenChrome(title: "inSID · Wayfinder", backLabel: "Home", onBack: { app.go(.home) }) {
            Text("Where to?")
                .font(InsidFont.display(26))
                .foregroundStyle(InsidTheme.paper)
            Text(app.graph.places.isEmpty
                  ? "Not on the map yet — contribute a walk first."
                  : "Nearest places from the shared node map")
                .font(InsidFont.ui(13.5))
                .foregroundStyle(InsidTheme.fog)
                .padding(.bottom, 12)

            if places.isEmpty {
                Text(app.destQuery.isEmpty
                      ? "No map yet — record a path in Collector mode first."
                      : "Nothing matches \"\(app.destQuery)\". Try fewer letters, or a room number.")
                    .font(InsidFont.ui(13.5))
                    .foregroundStyle(InsidTheme.fog)
            } else {
                ForEach(grouped, id: \.0) { level, list in
                    Text(level)
                        .font(InsidFont.mono(10, weight: .medium))
                        .tracking(1.2)
                        .textCase(.uppercase)
                        .foregroundStyle(InsidTheme.amber)
                        .padding(.top, 8)
                        .padding(.bottom, 4)
                    ForEach(list) { n in
                        Button {
                            app.destId = n.id
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(n.name)
                                        .font(InsidFont.ui(14, weight: .semibold))
                                        .foregroundStyle(InsidTheme.paper)
                                    Text("\(n.ref) · \(n.kind)")
                                        .font(InsidFont.mono(11))
                                        .foregroundStyle(InsidTheme.fog)
                                }
                                Spacer()
                                Text(String(format: "%.0f m", n.distanceM))
                                    .font(InsidFont.mono(12))
                                    .foregroundStyle(InsidTheme.fogDim)
                            }
                            .padding(12)
                            .background(app.destId == n.id ? InsidTheme.cyanSoft : InsidTheme.surface)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                            .overlay(
                                RoundedRectangle(cornerRadius: 10)
                                    .stroke(app.destId == n.id ? InsidTheme.cyanLine : InsidTheme.line, lineWidth: 1)
                            )
                        }
                        .buttonStyle(.plain)
                        .padding(.bottom, 6)
                    }
                }
            }
        } actions: {
            Text(picked.map { "Going to \($0.name)" }
                   ?? (app.destQuery.isEmpty ? "Type a room, floor or building" : "Pick a match"))
                .font(InsidFont.ui(12))
                .foregroundStyle(InsidTheme.fog)
                .frame(maxWidth: .infinity, alignment: .leading)

            HStack(spacing: 10) {
                InsidTextField(placeholder: "Search destinations…", text: $app.destQuery)
                    .onChange(of: app.destQuery) { _, q in
                        if let id = app.destId,
                           let kept = app.graph.places.first(where: { $0.id == id }) {
                            let hay = [kept.name, kept.ref, kept.kind].joined(separator: " ").lowercased()
                            let words = q.lowercased().split(whereSeparator: \.isWhitespace)
                            if !words.isEmpty && !words.allSatisfy({ hay.contains($0) }) {
                                app.destId = nil
                            }
                        }
                    }

                Button {
                    startRoute()
                } label: {
                    Text("GO")
                        .font(InsidFont.display(16, weight: .bold))
                        .foregroundStyle(InsidTheme.ink)
                        .frame(width: 52, height: 52)
                        .background(InsidTheme.cyan)
                        .clipShape(Circle())
                        .opacity(app.destId == nil ? 0.4 : 1)
                }
                .buttonStyle(.plain)
                .disabled(app.destId == nil)
            }
        }
    }

    private func startRoute() {
        guard let id = app.destId else { return }
        app.routeResult = app.graph.route(from: rec.latestCameraPos, to: id)
        app.go(.route)
    }
}

struct RouteView: View {
    @ObservedObject var app: AppModel

    private var dest: WayfinderPlace? {
        app.graph.places.first { $0.id == app.destId }
    }

    var body: some View {
        ScreenChrome(title: "Wayfinder · Route", backLabel: "Dest", onBack: {
            app.routeResult = nil
            app.go(.dest)
        }) {
            Text(dest?.name ?? "Route")
                .font(InsidFont.display(26))
                .foregroundStyle(InsidTheme.paper)
            if let d = dest {
                Text("\(d.ref) · from \(app.routeResult?.fromLabel ?? "the map")")
                    .font(InsidFont.mono(12))
                    .foregroundStyle(InsidTheme.fog)
                    .padding(.bottom, 12)
            }

            if let r = app.routeResult {
                let floors = Set(r.nodes.map(\.floor)).count
                StatGrid(items: [
                    .init(value: String(format: "%.0f m", r.lengthM), label: "Dist"),
                    .init(value: "\(max(1, Int((r.lengthM / 1.3 / 60).rounded()))) min", label: "Walk"),
                    .init(value: "\(floors)", label: "Levels"),
                ])
                .padding(.bottom, 12)

                Text("Steps")
                    .font(InsidFont.mono(10, weight: .medium))
                    .tracking(1.6)
                    .textCase(.uppercase)
                    .foregroundStyle(InsidTheme.fogDim)
                    .padding(.bottom, 6)

                ForEach(Array(r.steps.enumerated()), id: \.element.id) { i, s in
                    HStack(alignment: .top, spacing: 12) {
                        Text("\(i + 1)")
                            .font(InsidFont.mono(12, weight: .medium))
                            .foregroundStyle(InsidTheme.ink)
                            .frame(width: 24, height: 24)
                            .background(InsidTheme.cyan)
                            .clipShape(Circle())
                        Text(s.text)
                            .font(InsidFont.ui(14))
                            .foregroundStyle(InsidTheme.paper)
                        Spacer()
                        Text(String(format: "%.0f m", s.dist))
                            .font(InsidFont.mono(11))
                            .foregroundStyle(InsidTheme.fogDim)
                    }
                    .padding(.vertical, 8)
                    .overlay(alignment: .bottom) {
                        Rectangle().fill(InsidTheme.line).frame(height: 1)
                    }
                }
            } else {
                InsidNote(text: "No route — nobody has walked a path connecting those yet.", warn: true)
                    .padding(.top, 8)
            }
        } actions: {
            InsidButton(title: "Pick another destination", kind: .quiet) {
                app.routeResult = nil
                app.go(.dest)
            }
        }
    }
}
