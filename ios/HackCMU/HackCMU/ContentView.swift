import SwiftUI

struct ContentView: View {
    @StateObject private var sensorLogger = SensorLogger()
    @StateObject private var locationManager = LocationManager()

    var body: some View {
        TabView {
            MapView(path: sensorLogger.currentPath)
                .tabItem {
                    Label("Map", systemImage: "map")
                }

            WalkRecordingView(
                sensorLogger: sensorLogger,
                locationManager: locationManager
            )
            .tabItem {
                Label("Record", systemImage: "figure.walk")
            }
        }
    }
}

#Preview {
    ContentView()
}
