import SwiftUI
import ARKit
import SceneKit
import simd

// Variant C · Live 3D Map — the mapper flow. The real-time 3D map is the hero;
// node-picking is temporary INTERNAL data-collection scaffolding. Holographic
// cyan-on-dark aesthetic (see web/ux-mockups.html · Variant C).
//
// Flow: Start → (internal) Select start node → (internal) Select orientation
// node → Live mapping (hero) → Finish & name → Save + Upload.

// MARK: - Holographic theme
extension Color {
    static let holoCyan   = Color(red: 0.13, green: 0.83, blue: 0.93) // #22d3ee
    static let holoCyanDim = Color(red: 0.49, green: 0.91, blue: 0.97)
    static let holoBg      = Color(red: 0.02, green: 0.03, blue: 0.05)
    static let holoBg2     = Color(red: 0.03, green: 0.06, blue: 0.10)
    static let holoText    = Color(red: 0.92, green: 0.99, blue: 1.0)
    static let holoSub     = Color(red: 0.56, green: 0.78, blue: 0.84)
    static let holoAmber   = Color(red: 0.98, green: 0.75, blue: 0.14)
}

struct HoloBackground: View {
    var body: some View {
        LinearGradient(
            colors: [Color.holoBg2, Color.holoBg],
            startPoint: .top, endPoint: .bottom
        )
        .ignoresSafeArea()
    }
}

// Wraps an array of URLs so it can drive a `.sheet(item:)` share presentation.
struct SharePayload: Identifiable {
    let id = UUID()
    let urls: [URL]
}

struct ContentView: View {
    @StateObject private var rec = Recorder()
    @StateObject private var nodes = NodeStore()

    enum Stage { case start, selectStart, selectOrient, live, finish }
    @State private var stage: Stage = .start
    @State private var internalMode = true
    @State private var showRecordings = false

    var body: some View {
        ZStack {
            HoloBackground()
            content
        }
        .preferredColorScheme(.dark)
        .onAppear { rec.startSession() }
        .sheet(isPresented: $showRecordings) { RecordingsView(rec: rec) }
    }

    @ViewBuilder private var content: some View {
        switch stage {
        case .start:
            StartScreen(
                internalMode: $internalMode,
                nodesStatus: nodes.statusText,
                recordingsCount: rec.recordings.count,
                onStart: startMapping,
                onShowRecordings: { showRecordings = true }
            )
        case .selectStart:
            NodePicker3DScreen(
                prompt: "Tap the node you're standing on",
                confirmLabel: "Confirm node",
                context: nil,
                nodes: nodes,
                currentPos: { rec.latestCameraPos },
                startNodeId: nil,
                onBack: { stage = .start },
                onConfirm: { node in
                    rec.startNodeId = node.id
                    stage = .selectOrient
                }
            )
        case .selectOrient:
            NodePicker3DScreen(
                prompt: "Tap the node you're facing",
                confirmLabel: "Begin live map →",
                context: (label: "Standing on", value: nodes.name(for: rec.startNodeId) ?? "—"),
                nodes: nodes,
                currentPos: { rec.latestCameraPos },
                startNodeId: rec.startNodeId,
                onBack: { stage = .selectStart },
                onConfirm: { node in
                    rec.orientNodeId = node.id
                    rec.startRecording()
                    stage = .live
                }
            )
        case .live:
            LiveMappingScreen(rec: rec) {
                rec.stopRecording()
                stage = .finish
            }
        case .finish:
            FinishScreen(rec: rec, nodes: nodes, onDone: resetFlow)
        }
    }

    private func startMapping() {
        rec.startNodeId = nil
        rec.orientNodeId = nil
        rec.endNodeId = nil
        if internalMode {
            stage = .selectStart
        } else {
            // future one-tap UX: straight to live mapping, no node scaffolding
            rec.startRecording()
            stage = .live
        }
    }

    private func resetFlow() {
        rec.startNodeId = nil
        rec.orientNodeId = nil
        rec.endNodeId = nil
        stage = .start
    }
}

// MARK: - Screen 1 · Start (end-goal entry)
struct StartScreen: View {
    @Binding var internalMode: Bool
    let nodesStatus: String
    let recordingsCount: Int
    let onStart: () -> Void
    let onShowRecordings: () -> Void

    @State private var pulse = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("END-GOAL UX")
                    .font(.system(size: 10, weight: .heavy)).tracking(1.5)
                    .foregroundStyle(Color.holoCyanDim)
                    .padding(.horizontal, 13).padding(.vertical, 6)
                    .overlay(Capsule().stroke(Color.holoCyan.opacity(0.45), lineWidth: 1))
                    .background(Capsule().fill(Color.holoCyan.opacity(0.08)))
            }
            .padding(.top, 20)

            Spacer()

            Button(action: onStart) {
                VStack(spacing: 6) {
                    Text("🧭").font(.system(size: 44))
                    Text("Start\nMapping")
                        .multilineTextAlignment(.center)
                        .font(.system(size: 19, weight: .black))
                        .foregroundStyle(Color(red: 0.02, green: 0.08, blue: 0.10))
                }
                .frame(width: 184, height: 184)
                .background(
                    RadialGradient(colors: [Color.holoCyan, Color(red: 0.03, green: 0.57, blue: 0.70)],
                                   center: .init(x: 0.5, y: 0.4), startRadius: 4, endRadius: 120)
                )
                .clipShape(Circle())
                .overlay(Circle().stroke(Color.holoCyan.opacity(0.6), lineWidth: 1))
                .shadow(color: Color.holoCyan.opacity(0.55), radius: 34)
                .scaleEffect(pulse ? 1.03 : 1.0)
            }
            .buttonStyle(.plain)
            .onAppear {
                withAnimation(.easeInOut(duration: 1.4).repeatForever(autoreverses: true)) {
                    pulse = true
                }
            }

            Text("No setup — just walk.\nThe map builds itself.")
                .multilineTextAlignment(.center)
                .font(.system(size: 15))
                .foregroundStyle(Color.holoSub)
                .padding(.top, 22)

            Spacer()

            // internal data-collection toggle
            VStack(spacing: 12) {
                Toggle(isOn: $internalMode) {
                    HStack(spacing: 7) {
                        Circle().fill(Color.holoAmber).frame(width: 8, height: 8)
                            .shadow(color: Color.holoAmber.opacity(0.9), radius: 4)
                        Text("INTERNAL · data-collection mode")
                            .font(.system(size: 12, weight: .bold)).tracking(0.4)
                            .foregroundStyle(Color.holoAmber)
                    }
                }
                .tint(Color.holoAmber)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .overlay(RoundedRectangle(cornerRadius: 12)
                    .stroke(style: StrokeStyle(lineWidth: 1, dash: [4]))
                    .foregroundStyle(Color.holoAmber.opacity(0.6)))

                Text(internalMode
                     ? "Inserts start + orientation node steps to anchor the walk."
                     : "One-tap capture — no node scaffolding.")
                    .font(.caption).foregroundStyle(Color.holoSub)
                    .multilineTextAlignment(.center)

                Button(action: onShowRecordings) {
                    HStack {
                        Image(systemName: "list.bullet")
                        Text("Recordings (\(recordingsCount))")
                    }
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Color.holoText)
                    .frame(maxWidth: .infinity).padding(.vertical, 10)
                    .background(Color.white.opacity(0.06)).clipShape(Capsule())
                    .overlay(Capsule().stroke(Color.holoCyan.opacity(0.25), lineWidth: 1))
                }

                Text(nodesStatus)
                    .font(.caption2).foregroundStyle(Color.holoSub.opacity(0.7))
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 24)
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Screen 4 · Live mapping (hero)
struct LiveMappingScreen: View {
    @ObservedObject var rec: Recorder
    let onFinish: () -> Void

    @State private var showLandmarkPrompt = false
    @State private var landmarkName = ""

    private let quickDrops = ["Door", "Stairs", "Elevator", "Room"]

    var body: some View {
        ZStack {
            LiveMapView(recorder: rec).ignoresSafeArea()

            VStack {
                // top chips
                HStack {
                    HStack(spacing: 7) {
                        Circle().fill(.white).frame(width: 9, height: 9)
                            .opacity(0.9)
                        Text("● LIVE").font(.system(size: 12, weight: .heavy))
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(Capsule().fill(Color(red: 1, green: 0.23, blue: 0.19).opacity(0.92)))
                    .shadow(color: Color.red.opacity(0.5), radius: 10)

                    Spacer()

                    HStack(spacing: 6) {
                        Circle()
                            .fill(rec.trackingState == "normal"
                                  ? Color(red: 0.20, green: 0.78, blue: 0.35) : Color.holoAmber)
                            .frame(width: 9, height: 9)
                        Text("tracking: \(rec.trackingState)")
                            .font(.system(size: 11, weight: .semibold))
                    }
                    .foregroundStyle(Color.holoCyanDim)
                }
                .padding(.horizontal, 16).padding(.top, 8)

                Spacer()

                // stats pill
                Text("\(rec.liveLandmarks.count) landmarks · \(Int(rec.distance)) m · \(timeString(rec.elapsed))")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.holoCyanDim)
                    .padding(.horizontal, 15).padding(.vertical, 7)
                    .background(Capsule().fill(Color.holoBg.opacity(0.82)))
                    .overlay(Capsule().stroke(Color.holoCyan.opacity(0.35), lineWidth: 1))
                    .shadow(color: .black.opacity(0.5), radius: 8)
                    .padding(.bottom, 10)

                // quick landmark chips
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(quickDrops, id: \.self) { name in
                            Button { rec.dropLandmark(name: name) } label: {
                                Text(name)
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(Color.holoCyanDim)
                                    .padding(.horizontal, 12).padding(.vertical, 7)
                                    .overlay(Capsule().stroke(Color.holoCyan.opacity(0.4), lineWidth: 1))
                            }
                        }
                    }
                    .padding(.horizontal, 20)
                }
                .padding(.bottom, 8)

                // controls: mic / +landmark + Finish
                HStack(spacing: 20) {
                    Button {
                        landmarkName = ""
                        showLandmarkPrompt = true
                    } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 26, weight: .bold))
                            .foregroundStyle(Color(red: 0.02, green: 0.08, blue: 0.10))
                            .frame(width: 64, height: 64)
                            .background(
                                LinearGradient(colors: [Color.holoCyan, Color(red: 0.03, green: 0.57, blue: 0.70)],
                                               startPoint: .topLeading, endPoint: .bottomTrailing)
                            )
                            .clipShape(Circle())
                            .shadow(color: Color.holoCyan.opacity(0.55), radius: 12)
                    }

                    Button(action: onFinish) {
                        Text("Finish ⏹")
                            .font(.system(size: 15, weight: .heavy))
                            .foregroundStyle(Color.holoText)
                            .padding(.horizontal, 28).padding(.vertical, 18)
                            .background(RoundedRectangle(cornerRadius: 16).fill(Color.holoBg.opacity(0.85)))
                            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color.holoCyan.opacity(0.5), lineWidth: 1))
                            .shadow(color: Color.holoCyan.opacity(0.3), radius: 12)
                    }
                }
                .padding(.bottom, 24)
            }
        }
        .alert("Drop a landmark", isPresented: $showLandmarkPrompt) {
            TextField("Name (e.g. Door)", text: $landmarkName)
            Button("Cancel", role: .cancel) {}
            Button("Drop") { rec.dropLandmark(name: landmarkName) }
        } message: {
            Text("Adds a named node at your current position.")
        }
    }
}

// MARK: - Screen 5 · Finish & name
struct FinishScreen: View {
    @ObservedObject var rec: Recorder
    @ObservedObject var nodes: NodeStore
    let onDone: () -> Void

    @State private var endName = ""
    @State private var saved = false
    @State private var sharePayload: SharePayload?

    enum UploadStatus: Equatable { case idle, uploading, done, failed(String) }
    @State private var uploadStatus: UploadStatus = .idle

    private let suggestions = ["Room 2401", "Kitchen", "Exit", "Office"]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("You arrived! 🎉")
                    .font(.system(size: 24, weight: .black))
                    .foregroundStyle(Color.holoText)
                    .padding(.top, 12)

                Text("NAME THIS SPOT")
                    .font(.system(size: 12, weight: .bold)).tracking(0.5)
                    .foregroundStyle(Color.holoSub)

                TextField("", text: $endName, prompt: Text("End spot name"))
                    .foregroundStyle(Color.holoText)
                    .padding(12)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(0.06)))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.holoCyan.opacity(0.3), lineWidth: 1))
                    .autocorrectionDisabled()

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(suggestions, id: \.self) { s in
                            Button { endName = s } label: {
                                Text(s)
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(endName == s ? Color.holoBg : Color.holoCyanDim)
                                    .padding(.horizontal, 12).padding(.vertical, 7)
                                    .background(Capsule().fill(endName == s ? Color.holoCyan : Color.clear))
                                    .overlay(Capsule().stroke(Color.holoCyan.opacity(0.4), lineWidth: 1))
                            }
                        }
                    }
                }

                summaryPanel

                if saved {
                    Label("Saved to device", systemImage: "checkmark.circle.fill")
                        .font(.caption).foregroundStyle(Color(red: 0.20, green: 0.78, blue: 0.35))
                }
                uploadStatusLabel

                Button(action: saveAndUpload) {
                    HStack {
                        if uploadStatus == .uploading { ProgressView().tint(Color.holoBg) }
                        Text(saved ? "Saved ✓  Re-upload ☁" : "Save & upload ☁")
                    }
                    .font(.headline)
                    .foregroundStyle(Color(red: 0.02, green: 0.08, blue: 0.10))
                    .frame(maxWidth: .infinity).padding(.vertical, 14)
                    .background(Capsule().fill(Color.holoCyan))
                    .shadow(color: Color.holoCyan.opacity(0.5), radius: 16)
                }
                .disabled(uploadStatus == .uploading)

                HStack(spacing: 12) {
                    Button {
                        if let url = rec.lastExportURL { sharePayload = SharePayload(urls: [url]) }
                    } label: {
                        Label("Share", systemImage: "square.and.arrow.up")
                            .font(.subheadline.weight(.medium)).foregroundStyle(Color.holoText)
                            .frame(maxWidth: .infinity).padding(.vertical, 11)
                            .overlay(Capsule().stroke(Color.holoCyan.opacity(0.35), lineWidth: 1))
                    }
                    .disabled(rec.lastExportURL == nil || !saved)

                    Button(action: onDone) {
                        Text("Done")
                            .font(.subheadline.weight(.medium)).foregroundStyle(Color.holoText)
                            .frame(maxWidth: .infinity).padding(.vertical, 11)
                            .background(Capsule().fill(Color.white.opacity(0.06)))
                            .overlay(Capsule().stroke(Color.holoCyan.opacity(0.25), lineWidth: 1))
                    }
                }
            }
            .padding(20)
        }
        .sheet(item: $sharePayload) { payload in ShareSheet(items: payload.urls) }
    }

    private var summaryPanel: some View {
        VStack(spacing: 0) {
            summaryRow("🟢", nodes.name(for: rec.startNodeId) ?? rec.startAnchorId, "Start")
            Divider().overlay(Color.holoCyan.opacity(0.15))
            summaryRow("🔵", endName.isEmpty ? "— (no end node)" : endName, "End")
            Divider().overlay(Color.holoCyan.opacity(0.15))
            summaryRow("📊",
                       "\(rec.liveLandmarks.count) landmarks · \(Int(rec.distance)) m · \(rec.pointCount) pts",
                       "Ready to save")
        }
        .padding(4)
        .background(RoundedRectangle(cornerRadius: 14).fill(Color.white.opacity(0.05)))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.holoCyan.opacity(0.2), lineWidth: 1))
    }

    private func summaryRow(_ icon: String, _ title: String, _ sub: String) -> some View {
        HStack(spacing: 12) {
            Text(icon).font(.title3)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Color.holoText)
                Text(sub).font(.caption).foregroundStyle(Color.holoSub)
            }
            Spacer()
        }
        .padding(12)
    }

    @ViewBuilder private var uploadStatusLabel: some View {
        switch uploadStatus {
        case .idle: EmptyView()
        case .uploading:
            Text("Uploading…").font(.caption).foregroundStyle(Color.holoSub)
        case .done:
            Label("Uploaded to Supabase", systemImage: "checkmark.circle.fill")
                .font(.caption).foregroundStyle(Color.holoCyan)
        case .failed(let message):
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .font(.caption).foregroundStyle(Color.holoAmber)
                .multilineTextAlignment(.leading)
        }
    }

    private func saveAndUpload() {
        // create end node if a name was given, at the last recorded position
        var endId: String? = nil
        let trimmed = endName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty, let pos = rec.latestCameraPos ?? rec.livePath.last {
            endId = nodes.addNode(name: trimmed, position: pos).id
        }
        rec.saveWalk(endNodeId: endId)
        saved = true

        guard let url = rec.lastExportURL else { return }
        uploadStatus = .uploading
        Uploader.shared.upload(fileURL: url) { result in
            switch result {
            case .success: uploadStatus = .done
            case .failure(let error): uploadStatus = .failed(error.localizedDescription)
            }
        }
    }
}

private func timeString(_ seconds: Double) -> String {
    let s = Int(seconds)
    return String(format: "%02d:%02d", s / 60, s % 60)
}

// MARK: - Recordings list (unchanged behavior, dark-themed by parent)
struct RecordingsView: View {
    @ObservedObject var rec: Recorder
    @Environment(\.dismiss) private var dismiss
    @State private var sharePayload: SharePayload?

    var body: some View {
        NavigationStack {
            Group {
                if rec.recordings.isEmpty {
                    ContentUnavailableViewCompat(
                        title: "No recordings yet",
                        subtitle: "Recorded walks will appear here."
                    )
                } else {
                    List {
                        ForEach(rec.recordings) { r in
                            row(r)
                        }
                        .onDelete { rec.delete(at: $0) }
                    }
                }
            }
            .navigationTitle("Recordings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        sharePayload = SharePayload(urls: rec.recordings.map(\.url))
                    } label: {
                        Label("Share All", systemImage: "square.and.arrow.up.on.square")
                    }
                    .disabled(rec.recordings.isEmpty)
                }
            }
            .sheet(item: $sharePayload) { payload in
                ShareSheet(items: payload.urls)
            }
        }
    }

    private func row(_ r: Recording) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(r.id).font(.system(.subheadline, design: .monospaced)).lineLimit(1)
                Text("\(r.pointCount) pts · \(String(format: "%.1fs", r.duration)) · \(r.startAnchorId)")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            Button {
                sharePayload = SharePayload(urls: [r.url])
            } label: {
                Image(systemName: "square.and.arrow.up").font(.body)
            }
            .buttonStyle(.borderless)
        }
        .padding(.vertical, 2)
    }
}

// Small fallback so this compiles/looks fine regardless of deployment target.
struct ContentUnavailableViewCompat: View {
    let title: String
    let subtitle: String
    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "tray").font(.largeTitle).foregroundStyle(.secondary)
            Text(title).font(.headline)
            Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}

// Wraps UIActivityViewController so we can AirDrop / Save the exported JSON.
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}
