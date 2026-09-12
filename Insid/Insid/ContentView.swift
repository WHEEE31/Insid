import SwiftUI
import ARKit

// Prototype phone UX — stage machine mirrors web/prototype.html / prototype.js.

struct ContentView: View {
    @StateObject private var rec = Recorder()
    @StateObject private var app = AppModel()

    var body: some View {
        ZStack {
            InsidBackground()
            stageView
                .transition(.asymmetric(
                    insertion: .opacity.combined(with: .offset(y: 4)),
                    removal: .opacity
                ))

            if let toast = app.toast {
                VStack {
                    ToastBanner(message: toast)
                        .padding(.top, 12)
                    Spacer()
                }
                .animation(.easeOut(duration: 0.2), value: app.toast)
                .zIndex(10)
            }
        }
        .preferredColorScheme(.dark)
        .onAppear {
            rec.startSession()
            app.rebuildGraph()
            app.refreshCloudStats()
        }
        .onReceive(app.nodes.$nodes) { _ in
            app.rebuildGraph()
        }
    }

    @ViewBuilder private var stageView: some View {
        switch app.stage {
        case .home:
            HomeView(app: app, rec: rec)
        case .start:
            CollectorBriefView(app: app, rec: rec)
        case .gps:
            GPSLockView(app: app, rec: rec, back: .start) {
                app.form = BuildingFormState()
                app.go(.entrance)
            }
        case .entrance:
            EntranceView(app: app, rec: rec)
        case .north:
            NorthView(app: app, rec: rec)
        case .ready:
            ReadyView(app: app, rec: rec)
        case .live:
            LiveRecordView(app: app, rec: rec)
        case .transition:
            TransitionView(app: app, rec: rec)
        case .exitPrompt:
            ExitPromptView(app: app, rec: rec)
        case .endGate:
            EndGateView(app: app, rec: rec)
        case .endEntrance:
            EndEntranceView(app: app, rec: rec)
        case .finish:
            FinishSaveView(app: app, rec: rec)
        case .recordings:
            RecordingsListView(app: app, rec: rec)
        case .dest:
            DestSearchView(app: app, rec: rec)
        case .route:
            RouteView(app: app)
        }
    }
}

#Preview {
    ContentView()
}
