import SwiftUI

struct WalkRecordingView: View {
    @ObservedObject var sensorLogger: SensorLogger
    @ObservedObject var locationManager: LocationManager
    @State private var completedWalk: Walk?

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: sensorLogger.isRecording ? "record.circle.fill" : "figure.walk")
                .font(.system(size: 64))
                .foregroundStyle(sensorLogger.isRecording ? .red : .accent)

            Text(sensorLogger.isRecording ? "Recording walk" : "Ready to record")
                .font(.title2.bold())

            Text("\(sensorLogger.readings.count) sensor readings")
                .foregroundStyle(.secondary)

            Button(sensorLogger.isRecording ? "Stop recording" : "Start recording") {
                if sensorLogger.isRecording {
                    completedWalk = sensorLogger.stop()
                    locationManager.stop()
                } else {
                    sensorLogger.start()
                    locationManager.requestAccessAndStart()
                }
            }
            .buttonStyle(.borderedProminent)
        }
        .padding()
        .navigationTitle("Walk recording")
    }
}
