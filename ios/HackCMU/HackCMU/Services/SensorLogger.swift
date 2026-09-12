import Combine
import CoreMotion
import Foundation

final class SensorLogger: ObservableObject {
    @Published private(set) var readings: [SensorReading] = []
    @Published private(set) var currentPath: [PathPoint] = []
    @Published private(set) var isRecording = false

    private let motionManager = CMMotionManager()
    private let queue = OperationQueue()
    private let deadReckoning = DeadReckoning()

    func start() {
        guard !isRecording else { return }
        readings.removeAll()
        currentPath = [PathPoint(x: 0, y: 0)]
        isRecording = true

        guard motionManager.isAccelerometerAvailable else { return }
        motionManager.accelerometerUpdateInterval = 1.0 / 50.0
        motionManager.startAccelerometerUpdates(to: queue) { [weak self] data, error in
            guard let self, let data, error == nil else { return }
            let reading = SensorReading(
                timestamp: Date(),
                type: .accelerometer,
                x: data.acceleration.x,
                y: data.acceleration.y,
                z: data.acceleration.z
            )
            let path = self.deadReckoning.update(with: reading)
            DispatchQueue.main.async {
                guard self.isRecording else { return }
                self.readings.append(reading)
                self.currentPath = path
            }
        }
    }

    func append(_ reading: SensorReading) {
        guard isRecording else { return }
        readings.append(reading)
    }

    func stop() -> Walk {
        motionManager.stopAccelerometerUpdates()
        isRecording = false
        return Walk(
            endTime: Date(),
            readings: readings,
            path: currentPath
        )
    }
}
