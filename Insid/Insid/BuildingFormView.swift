import SwiftUI

// Shared building + floor picker used by entrance / transition / endEntrance.

struct BuildingFormView: View {
    @ObservedObject var buildings: BuildingStore
    @Binding var form: BuildingFormState
    var lat: Double?
    var lon: Double?
    let caption: String

    private var hits: [BuildingHit] {
        if form.query.trimmingCharacters(in: .whitespaces).isEmpty {
            if let lat, let lon {
                return buildings.nearby(lat: lat, lon: lon, limit: 8)
            }
            return buildings.buildings.prefix(8).map {
                BuildingHit(building: $0, score: 0, distanceM: nil)
            }
        }
        return buildings.resolve(query: form.query, lat: lat, lon: lon, limit: 8)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(caption)
                .font(InsidFont.ui(13.5))
                .foregroundStyle(InsidTheme.fog)

            InsidTextField(placeholder: "Search buildings…", text: $form.query)

            FloorStepper(floor: $form.floor)

            Text("Nearby / matches")
                .font(InsidFont.mono(10, weight: .medium))
                .tracking(1.6)
                .textCase(.uppercase)
                .foregroundStyle(InsidTheme.fogDim)
                .padding(.top, 4)

            ForEach(hits) { hit in
                Button {
                    form.selectedId = hit.building.id
                    form.query = hit.building.name
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(hit.building.name)
                                .font(InsidFont.ui(14, weight: .semibold))
                                .foregroundStyle(InsidTheme.paper)
                            HStack(spacing: 6) {
                                if let code = hit.building.code {
                                    Text(code)
                                        .font(InsidFont.mono(11))
                                        .foregroundStyle(InsidTheme.fogDim)
                                }
                                if let d = hit.distanceM {
                                    Text(String(format: "%.0f m", d))
                                        .font(InsidFont.mono(11))
                                        .foregroundStyle(InsidTheme.fog)
                                }
                            }
                        }
                        Spacer()
                        if form.selectedId == hit.building.id {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(InsidTheme.cyan)
                        }
                    }
                    .padding(12)
                    .background(
                        form.selectedId == hit.building.id
                            ? InsidTheme.cyanSoft : InsidTheme.surface
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(
                                form.selectedId == hit.building.id
                                    ? InsidTheme.cyanLine : InsidTheme.line,
                                lineWidth: 1
                            )
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }
}

struct NorthCompassCanvas: View {
    let headingDeg: Double // device true heading; 0 = north

    private var offNorth: Double {
        var d = headingDeg.truncatingRemainder(dividingBy: 360)
        if d < 0 { d += 360 }
        return d > 180 ? d - 360 : d
    }

    var aligned: Bool { abs(offNorth) <= InsidTheme.northToleranceDeg }

    var body: some View {
        VStack(spacing: 8) {
            ZStack {
                Circle()
                    .stroke(InsidTheme.lineStrong, lineWidth: 2)
                    .frame(width: 200, height: 200)
                // Fixed N marker at top
                Text("N")
                    .font(InsidFont.display(18, weight: .bold))
                    .foregroundStyle(aligned ? InsidTheme.cyan : InsidTheme.amber)
                    .offset(y: -108)

                // Rotating needle — rotate opposite of heading so when facing north needle points up
                Capsule()
                    .fill(aligned ? InsidTheme.cyan : InsidTheme.paper)
                    .frame(width: 4, height: 70)
                    .offset(y: -35)
                    .rotationEffect(.degrees(-headingDeg))

                Circle()
                    .fill(InsidTheme.surfaceHi)
                    .frame(width: 14, height: 14)
                    .overlay(Circle().stroke(InsidTheme.cyanLine, lineWidth: 1))
            }
            .frame(height: 230)

            Text(String(format: "%.0f°", headingDeg))
                .font(InsidFont.display(28, weight: .bold))
                .foregroundStyle(InsidTheme.paper)

            Text(aligned
                  ? "Lined up — confirm when ready"
                  : String(format: "Turn %.0f° %@", abs(offNorth), offNorth > 0 ? "left (CCW)" : "right (CW)"))
                .font(InsidFont.ui(13))
                .foregroundStyle(aligned ? InsidTheme.cyan : InsidTheme.fog)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
    }
}
