import SwiftUI
import ARKit
import SceneKit

// Minimal recorder UI: live AR camera preview, tracking/altitude/point readouts,
// a start-anchor field (walks sharing this id share a frame), record toggle, and
// a Share button to send the JSON off the phone (AirDrop to your Mac -> web/data/).

// Wraps an array of URLs so it can drive a `.sheet(item:)` share presentation.
struct SharePayload: Identifiable {
    let id = UUID()
    let urls: [URL]
}

struct ContentView: View {
    @StateObject private var rec = Recorder()
    @State private var showShare = false
    @State private var showRecordings = false

    // Upload (Supabase) state — drives the cloud button + a small status line.
    enum UploadStatus: Equatable {
        case idle, uploading, done, failed(String)
    }
    @State private var uploadStatus: UploadStatus = .idle

    var body: some View {
        ZStack(alignment: .bottom) {
            ARViewContainer(session: rec.session).ignoresSafeArea()

            VStack(spacing: 12) {
                stats
                anchorField
                controls
            }
            .padding()
            .background(.ultraThinMaterial)
            .clipShape(RoundedRectangle(cornerRadius: 20))
            .padding()
        }
        .onAppear { rec.startSession() }
        .sheet(isPresented: $showShare) {
            if let url = rec.lastExportURL { ShareSheet(items: [url]) }
        }
        .sheet(isPresented: $showRecordings) {
            RecordingsView(rec: rec)
        }
    }

    private var stats: some View {
        HStack {
            label("tracking", rec.trackingState, rec.trackingState == "normal" ? .green : .orange)
            Spacer()
            label("points", "\(rec.pointCount)", .primary)
            Spacer()
            label("Δalt", String(format: "%.1fm", rec.relAltitude), .primary)
            Spacer()
            label("gps", rec.gpsStatus, rec.gpsStatus.hasPrefix("±") ? .primary : .orange)
        }
        .font(.system(.footnote, design: .monospaced))
    }

    private var anchorField: some View {
        HStack {
            Text("start anchor").font(.caption).foregroundStyle(.secondary)
            TextField("anchor id", text: $rec.startAnchorId)
                .textFieldStyle(.roundedBorder)
                .disabled(rec.isRecording)
                .autocorrectionDisabled()
        }
    }

    private var controls: some View {
        VStack(spacing: 10) {
            HStack(spacing: 12) {
                Button(action: { rec.isRecording ? rec.stopRecording() : rec.startRecording() }) {
                    Text(rec.isRecording ? "Stop" : "Record")
                        .font(.headline).frame(maxWidth: .infinity).padding(.vertical, 12)
                        .background(rec.isRecording ? Color.red : Color.blue)
                        .foregroundStyle(.white).clipShape(Capsule())
                }
                Button(action: { showShare = true }) {
                    Image(systemName: "square.and.arrow.up")
                        .font(.headline).padding(.vertical, 12).padding(.horizontal, 18)
                        .background(Color(.systemGray5)).clipShape(Capsule())
                }
                .disabled(rec.lastExportURL == nil || rec.isRecording)

                Button(action: uploadLatest) {
                    Group {
                        if uploadStatus == .uploading {
                            ProgressView()
                        } else {
                            Image(systemName: "icloud.and.arrow.up")
                        }
                    }
                    .font(.headline).padding(.vertical, 12).padding(.horizontal, 18)
                    .background(Color(.systemGray5)).clipShape(Capsule())
                }
                .disabled(rec.lastExportURL == nil || rec.isRecording || uploadStatus == .uploading)
            }
            uploadStatusLabel
            Button(action: { showRecordings = true }) {
                HStack {
                    Image(systemName: "list.bullet")
                    Text("Recordings (\(rec.recordings.count))")
                }
                .font(.subheadline.weight(.medium))
                .frame(maxWidth: .infinity).padding(.vertical, 10)
                .background(Color(.systemGray5)).clipShape(Capsule())
            }
        }
    }

    // Small status line under the controls reflecting the last upload attempt.
    @ViewBuilder private var uploadStatusLabel: some View {
        switch uploadStatus {
        case .idle:
            EmptyView()
        case .uploading:
            Text("Uploading…").font(.caption).foregroundStyle(.secondary)
        case .done:
            Label("Uploaded to Supabase", systemImage: "checkmark.circle.fill")
                .font(.caption).foregroundStyle(.green)
        case .failed(let message):
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .font(.caption).foregroundStyle(.orange)
                .multilineTextAlignment(.center)
        }
    }

    // Upload the latest exported recording to Supabase via Uploader.
    private func uploadLatest() {
        guard let url = rec.lastExportURL else { return }
        uploadStatus = .uploading
        Uploader.shared.upload(fileURL: url) { result in
            switch result {
            case .success:
                uploadStatus = .done
            case .failure(let error):
                uploadStatus = .failed(error.localizedDescription)
            }
        }
    }

    private func label(_ k: String, _ v: String, _ c: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(k).font(.caption2).foregroundStyle(.secondary)
            Text(v).foregroundStyle(c)
        }
    }
}

// Scrollable list of persisted recordings (most recent first) with per-row share,
// swipe-to-delete, and a "Share All" toolbar action that hands every JSON URL to
// a single UIActivityViewController.
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

// Live ARKit preview (SceneKit) bound to the shared ARSession.
struct ARViewContainer: UIViewRepresentable {
    let session: ARSession
    func makeUIView(context: Context) -> ARSCNView {
        let v = ARSCNView()
        v.session = session
        v.automaticallyUpdatesLighting = true
        return v
    }
    func updateUIView(_ uiView: ARSCNView, context: Context) {}
}

// Wraps UIActivityViewController so we can AirDrop / Save the exported JSON.
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}
