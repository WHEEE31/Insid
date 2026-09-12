import Foundation

final class DeadReckoning {
    private(set) var path = [PathPoint(x: 0, y: 0)]
    private var lastStepTime: Date?

    func update(with reading: SensorReading) -> [PathPoint] {
        guard
            let x = reading.x,
            let y = reading.y,
            let z = reading.z
        else { return path }

        let magnitude = sqrt(x * x + y * y + z * z)
        let isStep = magnitude > 1.15
            && (lastStepTime == nil || reading.timestamp.timeIntervalSince(lastStepTime!) > 0.25)
        guard isStep, let previous = path.last else { return path }

        lastStepTime = reading.timestamp
        path.append(PathPoint(x: previous.x + 0.7, y: previous.y))
        return path
    }

    func reset() {
        path = [PathPoint(x: 0, y: 0)]
        lastStepTime = nil
    }
}
