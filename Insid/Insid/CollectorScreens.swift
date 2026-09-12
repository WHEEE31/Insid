import SwiftUI

// Collector screens — mirror web/prototype.js collector stages.

struct CollectorBriefView: View {
    @ObservedObject var app: AppModel
    @ObservedObject var rec: Recorder

    var body: some View {
        ScreenChrome(title: "Contribute", backLabel: "Home", onBack: { app.go(.home) }) {
            Text("What you'll be doing")
                .font(InsidFont.display(26))
                .foregroundStyle(InsidTheme.paper)
                .padding(.bottom, 12)

            VStack(alignment: .leading, spacing: 14) {
                briefPara("Step outside the door you're about to use and wait for a clean GPS fix — that's what pins your walk to the campus map. Name the building and floor, then face north, so the app knows which way your path points.")
                briefPara("Then just walk it, normally, the way you would anyway. Tap a marker as you pass a door, staircase, elevator or room, and tell the app when you cross into another building. Finish at an outside door so both ends are anchored.")
                briefPara("One walk, about five minutes. Everyone who needs that route afterwards gets it from you.")
            }
            .padding(.bottom, 16)

            StatGrid(items: [
                .init(value: "\(rec.recordings.count)", label: "Yours"),
                .init(value: "\(app.cloudWalkCount)", label: "Walks"),
                .init(value: "~5 min", label: "Per walk"),
            ])
            .padding(.bottom, 24)

            VStack(spacing: 8) {
                Button {
                    app.form = BuildingFormState()
                    app.go(.gps)
                } label: {
                    Text("START")
                        .font(InsidFont.display(28, weight: .bold))
                        .foregroundStyle(InsidTheme.ink)
                        .frame(width: 120, height: 120)
                        .background(InsidTheme.cyan)
                        .clipShape(Circle())
                        .shadow(color: InsidTheme.cyan.opacity(0.4), radius: 20)
                }
                .buttonStyle(.plain)
                Text("Start collection")
                    .font(InsidFont.mono(11))
                    .foregroundStyle(InsidTheme.fogDim)
                    .textCase(.uppercase)
                    .tracking(1.2)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
        } actions: {
            InsidButton(title: "Recordings · \(rec.recordings.count)", kind: .quiet) {
                app.go(.recordings)
            }
        }
    }

    private func briefPara(_ t: String) -> some View {
        Text(t)
            .font(InsidFont.ui(13.5))
            .foregroundStyle(InsidTheme.fog)
    }
}

struct GPSLockView: View {
    @ObservedObject var app: AppModel
    @ObservedObject var rec: Recorder
    var back: AppStage = .start
    var title: String = "Step outside"
    var note: String = "Stand just outside the entrance you're about to use — indoors the fix is too poor to anchor a path."
    var continueLabel: String = "Continue"
    var hint: String = "Walk out until the reading settles below 8 m."
    var onContinue: () -> Void

    var body: some View {
        ScreenChrome(title: "Collector · GPS", backLabel: "Back", onBack: { app.go(back) }) {
            Text(title)
                .font(InsidFont.display(26))
                .foregroundStyle(InsidTheme.paper)
                .padding(.bottom, 8)
            InsidNote(text: note)
                .padding(.bottom, 16)
            GPSSignalRing(accuracyM: rec.gpsAccuracyM)
            Text(hint)
                .font(InsidFont.ui(13))
                .foregroundStyle(InsidTheme.fog)
                .frame(maxWidth: .infinity)
                .multilineTextAlignment(.center)
                .padding(.top, 8)

            if let lat = rec.latitude, let lon = rec.longitude {
                Text(String(format: "%.5f, %.5f", lat, lon))
                    .font(InsidFont.mono(11))
                    .foregroundStyle(InsidTheme.fogDim)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 12)
            }
        } actions: {
            InsidButton(title: continueLabel, kind: .primary, enabled: rec.gpsIsGood, action: onContinue)
        }
    }
}

struct EntranceView: View {
    @ObservedObject var app: AppModel
    @ObservedObject var rec: Recorder

    var body: some View {
        ScreenChrome(title: "Collector · Entrance", backLabel: "GPS", onBack: { app.go(.gps) }) {
            Text("Which building?")
                .font(InsidFont.display(26))
                .foregroundStyle(InsidTheme.paper)
                .padding(.bottom, 12)
            BuildingFormView(
                buildings: app.buildings,
                form: $app.form,
                lat: rec.latitude,
                lon: rec.longitude,
                caption: "You're at its entrance. Pick the building you're about to enter, and the floor you'll walk in on."
            )
        } actions: {
            InsidButton(title: "Confirm entrance", kind: .primary, enabled: app.form.selectedId != nil) {
                app.confirmEntrance(from: rec)
            }
        }
    }
}

struct NorthView: View {
    @ObservedObject var app: AppModel
    @ObservedObject var rec: Recorder

    private var offNorth: Double {
        var d = rec.headingDeg.truncatingRemainder(dividingBy: 360)
        if d < 0 { d += 360 }
        return d > 180 ? d - 360 : d
    }

    private var aligned: Bool { abs(offNorth) <= InsidTheme.northToleranceDeg }

    var body: some View {
        ScreenChrome(title: "Collector · North", backLabel: "Entrance", onBack: { app.go(.entrance) }) {
            Text("Face north")
                .font(InsidFont.display(26))
                .foregroundStyle(InsidTheme.paper)
                .padding(.bottom, 8)
            InsidNote(text: "Turn until the marker lines up with N — this fixes the path's rotation, since the compass alone is off by 15–25° indoors.")
                .padding(.bottom, 16)
            NorthCompassCanvas(headingDeg: rec.headingDeg)
        } actions: {
            InsidButton(title: "Confirm facing north", kind: .primary, enabled: aligned) {
                // northOffsetDeg = ARKit yaw at confirmation (true bearing of -Z)
                app.confirmNorth(offsetDeg: rec.cameraYawDeg)
            }
        }
    }
}

struct ReadyView: View {
    @ObservedObject var app: AppModel
    @ObservedObject var rec: Recorder

    var body: some View {
        ScreenChrome(title: "Collector · Ready", onBack: nil) {
            VStack(spacing: 8) {
                Text("You're set")
                    .font(InsidFont.display(26))
                    .foregroundStyle(InsidTheme.paper)
                Text("Walk. Tell the app when you cross into a new building.")
                    .font(InsidFont.ui(13.5))
                    .foregroundStyle(InsidTheme.fog)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 24)

            VStack(spacing: 0) {
                SummaryRow(label: "Entrance", value: app.buildings.name(for: app.buildingId))
                SummaryRow(label: "Floor", value: "\(app.floor)")
                SummaryRow(
                    label: "GPS",
                    value: String(format: "±%.1f m", rec.gpsAccuracyM),
                    tone: rec.gpsIsGood ? .ok : .warn
                )
                SummaryRow(label: "North", value: "calibrated", tone: .ok)
            }
            .padding(.horizontal, 4)
            .background(InsidTheme.surface)
            .clipShape(RoundedRectangle(cornerRadius: 10))
        } actions: {
            InsidButton(title: "Start recording", kind: .primary) {
                let anchor = app.buildingId.map { "\($0)-F\(app.floor)" } ?? "entrance"
                rec.startRecording(anchorId: anchor, northOffset: app.northOffsetDeg)
                app.go(.live)
            }
        }
    }
}

struct LiveRecordView: View {
    @ObservedObject var app: AppModel
    @ObservedObject var rec: Recorder

    private let chips = ["Door", "Stairs", "Elevator", "Room"]

    var body: some View {
        ScreenChrome(title: "Collector · Recording", onBack: nil, scrollable: false) {
            HStack(spacing: 6) {
                InsidPill(text: "Rec", kind: .rec)
                InsidPill(text: "\(app.buildings.name(for: app.buildingId)) · F\(app.floor)")
                InsidPill(text: rec.gpsStatus, kind: rec.gpsIsGood ? .cyan : .amber)
            }
            .padding(.bottom, 10)

            StatGrid(items: [
                .init(value: "\(rec.pointCount)", label: "Points"),
                .init(value: String(format: "%.0f m", rec.distance), label: "Dist"),
                .init(value: timeString(rec.elapsed), label: "Time"),
                .init(value: "F\(app.floor)", label: "Where"),
            ])
            .padding(.bottom, 10)

            LiveMapView(recorder: rec)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .frame(minHeight: 220)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(InsidTheme.line, lineWidth: 1)
                )
                .padding(.bottom, 10)

            HStack(spacing: 6) {
                ForEach(chips, id: \.self) { name in
                    Button {
                        rec.dropLandmark(name: name)
                        app.showToast("\(name) added")
                    } label: {
                        Text(name)
                            .font(InsidFont.ui(12, weight: .semibold))
                            .foregroundStyle(InsidTheme.fog)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 7)
                            .background(InsidTheme.surfaceHi)
                            .clipShape(Capsule())
                            .overlay(Capsule().stroke(InsidTheme.line, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.bottom, 8)

            InsidButton(title: "New building", kind: .secondary) {
                app.form = BuildingFormState(query: "", selectedId: nil, floor: app.floor)
                app.go(.transition)
            }

            if !app.transitions.isEmpty {
                Text("Crossings")
                    .font(InsidFont.mono(10, weight: .medium))
                    .tracking(1.6)
                    .textCase(.uppercase)
                    .foregroundStyle(InsidTheme.fogDim)
                    .padding(.top, 12)
                ForEach(app.transitions) { t in
                    HStack {
                        Text("\(t.buildingName) · floor \(t.floor)")
                            .font(InsidFont.ui(13))
                            .foregroundStyle(InsidTheme.paper)
                        Spacer()
                        Text(String(format: "%.0f s", t.t))
                            .font(InsidFont.mono(11))
                            .foregroundStyle(InsidTheme.fogDim)
                    }
                    .padding(.vertical, 6)
                }
            }
        } actions: {
            InsidButton(title: "Finish at an entrance", kind: .danger) {
                if rec.gpsIsGood {
                    app.form = BuildingFormState(
                        query: app.buildings.name(for: app.buildingId),
                        selectedId: app.buildingId,
                        floor: app.floor
                    )
                    app.endEntranceBack = .live
                    app.go(.endEntrance)
                } else {
                    app.go(.exitPrompt)
                }
            }
        }
    }
}

struct TransitionView: View {
    @ObservedObject var app: AppModel
    @ObservedObject var rec: Recorder

    var body: some View {
        ScreenChrome(title: "Collector · Crossing", backLabel: "Live", onBack: { app.go(.live) }) {
            Text("New building")
                .font(InsidFont.display(26))
                .foregroundStyle(InsidTheme.paper)
                .padding(.bottom, 12)
            BuildingFormView(
                buildings: app.buildings,
                form: $app.form,
                lat: rec.latitude,
                lon: rec.longitude,
                caption: "Leaving \(app.buildings.name(for: app.buildingId)) (floor \(app.floor)). Check the signage — which building is this, and what floor does it call this level?"
            )
            InsidNote(text: "Floors don't line up between buildings — a connector can put you on floor 4 of one and floor 2 of the next. That's why it asks.")
                .padding(.top, 12)
        } actions: {
            InsidButton(title: "Confirm crossing", kind: .primary, enabled: app.form.selectedId != nil) {
                guard let id = app.form.selectedId else { return }
                app.declareTransition(id: id, floor: app.form.floor, elapsed: rec.elapsed)
            }
        }
    }
}

struct ExitPromptView: View {
    @ObservedObject var app: AppModel
    @ObservedObject var rec: Recorder

    private var st: (unanchoredM: Double, estDriftM: Double, secondsAgo: Double?, totalM: Double, lastFix: Bool) {
        rec.exitFixStatus()
    }

    var body: some View {
        ScreenChrome(title: "Collector · Finish?", backLabel: "Live", onBack: { app.go(.live) }) {
            VStack(spacing: 12) {
                Text("Finish outside if you can")
                    .font(InsidFont.ui(16, weight: .semibold))
                    .foregroundStyle(InsidTheme.paper)
                    .multilineTextAlignment(.center)

                Group {
                    if st.lastFix, let ago = st.secondsAgo {
                        Text("Your last good GPS fix was \(Int(ago))s ago. Everything up to there is anchored — the \(Int(st.unanchoredM)) m since then isn't.")
                    } else {
                        Text("Nothing has anchored this path since you started it. You've walked \(Int(st.totalM)) m.")
                    }
                }
                .font(InsidFont.ui(13.5))
                .foregroundStyle(InsidTheme.fog)
                .multilineTextAlignment(.center)

                VStack(spacing: 0) {
                    SummaryRow(label: "Unanchored so far", value: String(format: "%.0f m", st.unanchoredM))
                    SummaryRow(label: "Est. error at the end", value: String(format: "≈ %.1f m", st.estDriftM), tone: .warn)
                    SummaryRow(label: "Fixable later?", value: "No", tone: .bad)
                }
                .background(InsidTheme.surface)
                .clipShape(RoundedRectangle(cornerRadius: 10))

                InsidNote(text: "Stepping outside for a few seconds pins the end of the path and spreads the correction back over the whole walk. It can't be recovered afterwards.", warn: true)
            }
            .padding(.vertical, 16)
        } actions: {
            InsidButton(title: "Take me outside — keep recording", kind: .primary) {
                app.go(.endGate)
            }
            InsidButton(title: "Save without an exit fix", kind: .quiet) {
                app.hadExitFix = false
                rec.stopRecording()
                app.go(.finish)
            }
        }
    }
}

struct EndGateView: View {
    @ObservedObject var app: AppModel
    @ObservedObject var rec: Recorder

    var body: some View {
        ScreenChrome(title: "Collector · Finish outside", backLabel: "Live", onBack: { app.go(.live) }) {
            Text("Head outside")
                .font(InsidFont.display(26))
                .foregroundStyle(InsidTheme.paper)
                .padding(.bottom, 8)
            InsidNote(text: "Finish at a building entrance so the path gets a second GPS anchor — that's what bounds the drift.")
                .padding(.bottom, 16)
            GPSSignalRing(accuracyM: rec.gpsAccuracyM)
            Text("Still recording. Walk out until the reading settles.")
                .font(InsidFont.ui(13))
                .foregroundStyle(InsidTheme.fog)
                .frame(maxWidth: .infinity)
                .multilineTextAlignment(.center)
                .padding(.top, 8)
        } actions: {
            InsidButton(title: "I'm at an entrance", kind: .primary, enabled: rec.gpsIsGood) {
                app.form = BuildingFormState(
                    query: app.buildings.name(for: app.buildingId),
                    selectedId: app.buildingId,
                    floor: app.floor
                )
                app.endEntranceBack = .endGate
                app.go(.endEntrance)
            }
            HStack(spacing: 8) {
                InsidButton(title: "Keep walking", kind: .quiet) { app.go(.live) }
                InsidButton(title: "Save anyway", kind: .quiet) {
                    app.hadExitFix = false
                    rec.stopRecording()
                    app.go(.finish)
                }
            }
        }
    }
}

struct EndEntranceView: View {
    @ObservedObject var app: AppModel
    @ObservedObject var rec: Recorder

    var body: some View {
        ScreenChrome(title: "Collector · End entrance", backLabel: "Back", onBack: {
            app.go(app.endEntranceBack)
        }) {
            Text("Which entrance?")
                .font(InsidFont.display(26))
                .foregroundStyle(InsidTheme.paper)
                .padding(.bottom, 12)
            BuildingFormView(
                buildings: app.buildings,
                form: $app.form,
                lat: rec.latitude,
                lon: rec.longitude,
                caption: "Confirm the building you just walked out of, and the floor that entrance is on."
            )
        } actions: {
            InsidButton(title: "Confirm & finish", kind: .primary, enabled: app.form.selectedId != nil) {
                rec.stopRecording()
                app.captureEndEntrance(from: rec)
            }
        }
    }
}

struct FinishSaveView: View {
    @ObservedObject var app: AppModel
    @ObservedObject var rec: Recorder

    enum UploadStatus: Equatable { case idle, uploading, done, failed(String) }
    @State private var uploadStatus: UploadStatus = .idle
    @State private var sharePayload: SharePayload?

    var body: some View {
        ScreenChrome(title: "Collector · Save", onBack: nil) {
            Text("Path complete")
                .font(InsidFont.display(26))
                .foregroundStyle(InsidTheme.paper)
                .padding(.bottom, 12)

            StatGrid(items: [
                .init(value: "\(rec.pointCount)", label: "Points"),
                .init(value: String(format: "%.0f m", rec.distance), label: "Dist"),
                .init(value: "\(app.transitions.count + 1)", label: "Buildings"),
            ])
            .padding(.bottom, 12)

            Text("Path name")
                .font(InsidFont.mono(10, weight: .medium))
                .tracking(1.6)
                .textCase(.uppercase)
                .foregroundStyle(InsidTheme.fogDim)
            InsidTextField(placeholder: "e.g. Wean 4 → Doherty tunnel", text: $app.pathName)
                .padding(.bottom, 12)

            VStack(spacing: 0) {
                if let s = app.startEntrance {
                    SummaryRow(label: "Started", value: "\(s.buildingName) · F\(s.floor)")
                }
                ForEach(app.transitions) { t in
                    SummaryRow(label: "Crossed into", value: "\(t.buildingName) · F\(t.floor)")
                }
                SummaryRow(label: "Ended", value: "\(app.buildings.name(for: app.buildingId)) · F\(app.floor)")
                if app.hadExitFix, let e = app.endEntrance {
                    SummaryRow(label: "Exit fix", value: String(format: "±%.1f m", e.gpsAccuracy), tone: .ok)
                } else {
                    SummaryRow(label: "Exit fix", value: rec.gpsFixes.isEmpty ? "unanchored end" : "last mid-walk fix", tone: .warn)
                }
            }
            .background(InsidTheme.surface)
            .clipShape(RoundedRectangle(cornerRadius: 10))

            if !app.hadExitFix {
                InsidNote(text: "Saving without an exit fix. The path is still kept and still useful — it just can't have its end drift corrected.", warn: true)
                    .padding(.top, 12)
            }

            uploadLabel
                .padding(.top, 8)
        } actions: {
            InsidButton(title: uploadStatus == .uploading ? "Uploading…" : "Save & upload", kind: .primary, enabled: uploadStatus != .uploading) {
                saveAndUpload()
            }
            InsidButton(title: "Discard", kind: .quiet) {
                rec.discardWalk()
                app.resetCollectorSession()
                app.go(.start)
            }
        }
        .sheet(item: $sharePayload) { ShareSheet(items: $0.urls) }
    }

    @ViewBuilder private var uploadLabel: some View {
        switch uploadStatus {
        case .idle: EmptyView()
        case .uploading:
            Text("Uploading…").font(InsidFont.ui(12)).foregroundStyle(InsidTheme.fog)
        case .done:
            Label("Uploaded", systemImage: "checkmark.circle.fill")
                .font(InsidFont.ui(12)).foregroundStyle(InsidTheme.cyan)
        case .failed(let m):
            Label(m, systemImage: "exclamationmark.triangle.fill")
                .font(InsidFont.ui(12)).foregroundStyle(InsidTheme.amber)
        }
    }

    private func saveAndUpload() {
        let url = rec.saveWalk(
            displayName: app.pathName.isEmpty ? nil : app.pathName,
            buildingCount: app.transitions.count + 1,
            hadExitFix: app.hadExitFix
        )
        guard let url else { return }
        uploadStatus = .uploading
        Uploader.shared.upload(fileURL: url) { result in
            switch result {
            case .success:
                uploadStatus = .done
                app.cloudWalkCount += 1
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                    app.resetCollectorSession()
                    app.go(.start)
                }
            case .failure(let err):
                uploadStatus = .failed(err.localizedDescription)
                // Still leave local save; allow retry or continue
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                    app.resetCollectorSession()
                    app.go(.start)
                }
            }
        }
    }
}

struct RecordingsListView: View {
    @ObservedObject var app: AppModel
    @ObservedObject var rec: Recorder
    @State private var sharePayload: SharePayload?

    var body: some View {
        ScreenChrome(title: "Collector · Recordings", backLabel: "Brief", onBack: { app.go(.start) }) {
            Text("Recordings")
                .font(InsidFont.display(26))
                .foregroundStyle(InsidTheme.paper)
            Text("\(rec.recordings.count) captured on this device.")
                .font(InsidFont.ui(13.5))
                .foregroundStyle(InsidTheme.fog)
                .padding(.bottom, 12)

            if rec.recordings.isEmpty {
                Text("Nothing yet — record a path from Contribute.")
                    .font(InsidFont.ui(13.5))
                    .foregroundStyle(InsidTheme.fog)
            } else {
                ForEach(rec.recordings) { r in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(r.displayName ?? r.id)
                            .font(InsidFont.ui(14, weight: .semibold))
                            .foregroundStyle(InsidTheme.paper)
                            .lineLimit(1)
                        Text("\(r.pointCount) pts · \(String(format: "%.0f m", r.distanceM ?? 0)) · \((r.buildingCount ?? 1)) buildings")
                            .font(InsidFont.mono(11))
                            .foregroundStyle(InsidTheme.fog)
                        if let a = r.anchorEnd {
                            Text(anchorLabel(a))
                                .font(InsidFont.mono(11))
                                .foregroundStyle(a == "endEntrance" ? InsidTheme.cyan : InsidTheme.amber)
                        }
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(InsidTheme.surface)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .stroke(InsidTheme.line, lineWidth: 1)
                    )
                    .padding(.bottom, 8)
                    .contextMenu {
                        Button {
                            sharePayload = SharePayload(urls: [r.url])
                        } label: { Label("Share", systemImage: "square.and.arrow.up") }
                        Button(role: .destructive) {
                            rec.delete(r)
                        } label: { Label("Delete", systemImage: "trash") }
                    }
                }
            }
        } actions: {
            EmptyView()
        }
        .sheet(item: $sharePayload) { ShareSheet(items: $0.urls) }
    }

    private func anchorLabel(_ a: String) -> String {
        switch a {
        case "endEntrance": return "anchored both ends"
        case "gpsFix": return "mid-walk fix only"
        default: return "end unanchored"
        }
    }
}
