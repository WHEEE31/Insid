import SwiftUI

// Prototype design tokens from web/prototype.html — one source of truth shared
// with the Insid marketing site (ink/paper/cyan/amber).

enum InsidTheme {
    static let ink = Color(red: 0.027, green: 0.043, blue: 0.063)       // #070b10
    static let panel = Color(red: 0.055, green: 0.090, blue: 0.125)     // #0e1720
    static let surface = Color(red: 0.075, green: 0.118, blue: 0.161)   // #131e29
    static let surfaceHi = Color(red: 0.102, green: 0.153, blue: 0.204) // #1a2734
    static let paper = Color(red: 0.914, green: 0.945, blue: 0.957)     // #e9f1f4
    static let fog = Color(red: 0.914, green: 0.945, blue: 0.957).opacity(0.62)
    static let fogDim = Color(red: 0.914, green: 0.945, blue: 0.957).opacity(0.40)
    static let line = Color(red: 0.914, green: 0.945, blue: 0.957).opacity(0.10)
    static let lineStrong = Color(red: 0.914, green: 0.945, blue: 0.957).opacity(0.18)
    static let cyan = Color(red: 0.184, green: 0.886, blue: 0.800)      // #2fe2cc
    static let cyanSoft = Color(red: 0.184, green: 0.886, blue: 0.800).opacity(0.12)
    static let cyanLine = Color(red: 0.184, green: 0.886, blue: 0.800).opacity(0.35)
    static let amber = Color(red: 0.961, green: 0.663, blue: 0.231)     // #f5a93b
    static let amberSoft = Color(red: 0.961, green: 0.663, blue: 0.231).opacity(0.12)
    static let rose = Color(red: 0.949, green: 0.388, blue: 0.353)      // #f2635a
    static let roseSoft = Color(red: 0.949, green: 0.388, blue: 0.353).opacity(0.12)

    static let gpsGoodM: Double = 8
    static let gpsFairM: Double = 15
    static let northToleranceDeg: Double = 12
}

// Legacy aliases so unused Variant-C views (NodePicker3D) still compile.
extension Color {
    static let holoCyan = InsidTheme.cyan
    static let holoCyanDim = InsidTheme.cyan.opacity(0.85)
    static let holoBg = InsidTheme.ink
    static let holoBg2 = InsidTheme.panel
    static let holoText = InsidTheme.paper
    static let holoSub = InsidTheme.fog
    static let holoAmber = InsidTheme.amber
}

enum InsidFont {
    // Prefer branded faces when bundled; fall back to SF with clear role separation.
    static func display(_ size: CGFloat, weight: Font.Weight = .bold) -> Font {
        if UIFont(name: "Rajdhani-Bold", size: size) != nil {
            return .custom("Rajdhani-Bold", size: size)
        }
        return .system(size: size, weight: weight, design: .rounded)
    }

    static func ui(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        let name = weight == .semibold || weight == .bold ? "IBMPlexSans-SemiBold" : "IBMPlexSans-Regular"
        if UIFont(name: name, size: size) != nil {
            return .custom(name, size: size)
        }
        return .system(size: size, weight: weight, design: .default)
    }

    static func mono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        if UIFont(name: "IBMPlexMono-Regular", size: size) != nil {
            return .custom("IBMPlexMono-Regular", size: size)
        }
        return .system(size: size, weight: weight, design: .monospaced)
    }
}

struct InsidBackground: View {
    var body: some View {
        InsidTheme.panel.ignoresSafeArea()
    }
}

// MARK: - Logo mark (web/logo.svg)

struct InsidLogoMark: View {
    var size: CGFloat = 56
    var color: Color = InsidTheme.cyan

    var body: some View {
        Canvas { ctx, sz in
            let s = min(sz.width, sz.height)
            let scale = s / 24
            var circle = Path(ellipseIn: CGRect(x: 2 * scale, y: 2 * scale, width: 20 * scale, height: 20 * scale))
            ctx.stroke(circle, with: .color(color.opacity(0.5)), style: StrokeStyle(lineWidth: scale, dash: [2 * scale, 3 * scale]))

            var shaft = Path()
            shaft.move(to: CGPoint(x: 6 * scale, y: 12 * scale))
            shaft.addLine(to: CGPoint(x: 17 * scale, y: 12 * scale))
            ctx.stroke(shaft, with: .color(color), style: StrokeStyle(lineWidth: 2 * scale, lineCap: .round))

            var head = Path()
            head.move(to: CGPoint(x: 17 * scale, y: 12 * scale))
            head.addLine(to: CGPoint(x: 12 * scale, y: 7 * scale))
            head.move(to: CGPoint(x: 17 * scale, y: 12 * scale))
            head.addLine(to: CGPoint(x: 12 * scale, y: 17 * scale))
            ctx.stroke(head, with: .color(color), style: StrokeStyle(lineWidth: 2 * scale, lineCap: .round, lineJoin: .round))
        }
        .frame(width: size, height: size)
    }
}

// MARK: - Screen chrome (nav / body / actions)

struct ScreenChrome<Body: View, Actions: View>: View {
    var title: String
    var backLabel: String? = nil
    var onBack: (() -> Void)? = nil
    var scrollable: Bool = true
    @ViewBuilder var bodyContent: () -> Body
    @ViewBuilder var actions: () -> Actions

    var body: some View {
        VStack(spacing: 0) {
            if let onBack {
                HStack(spacing: 8) {
                    Button(action: onBack) {
                        HStack(spacing: 4) {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 12, weight: .semibold))
                            if let backLabel {
                                Text(backLabel)
                                    .font(InsidFont.mono(10, weight: .medium))
                                    .tracking(1.6)
                                    .textCase(.uppercase)
                            }
                        }
                        .foregroundStyle(InsidTheme.fog)
                    }
                    .buttonStyle(.plain)
                    Spacer()
                    Text(title)
                        .font(InsidFont.mono(10, weight: .medium))
                        .tracking(1.6)
                        .textCase(.uppercase)
                        .foregroundStyle(InsidTheme.fogDim)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            } else if !title.isEmpty {
                Text(title)
                    .font(InsidFont.mono(10, weight: .medium))
                    .tracking(1.6)
                    .textCase(.uppercase)
                    .foregroundStyle(InsidTheme.fogDim)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
            }

            if scrollable {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        bodyContent()
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    bodyContent()
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 12)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }

            VStack(spacing: 8) {
                actions()
            }
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 16)
            .background(InsidTheme.panel)
            .overlay(alignment: .top) {
                Rectangle().fill(InsidTheme.line).frame(height: 1)
            }
        }
    }
}

// MARK: - Buttons

enum InsidButtonKind { case primary, secondary, quiet, danger }

struct InsidButton: View {
    let title: String
    var kind: InsidButtonKind = .primary
    var enabled: Bool = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(InsidFont.ui(15, weight: .semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .foregroundStyle(foreground)
                .background(background)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .stroke(stroke, lineWidth: 1)
                )
                .opacity(enabled ? 1 : 0.4)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }

    private var foreground: Color {
        switch kind {
        case .primary: return InsidTheme.ink
        case .danger: return InsidTheme.paper
        case .secondary, .quiet: return InsidTheme.paper
        }
    }

    private var background: Color {
        switch kind {
        case .primary: return InsidTheme.cyan
        case .danger: return InsidTheme.rose
        case .secondary: return InsidTheme.surfaceHi
        case .quiet: return .clear
        }
    }

    private var stroke: Color {
        switch kind {
        case .primary: return .clear
        case .danger: return InsidTheme.rose.opacity(0.38)
        case .secondary: return InsidTheme.lineStrong
        case .quiet: return InsidTheme.line
        }
    }
}

struct ChoiceButton: View {
    let title: String
    let subtitle: String
    var quiet: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(InsidFont.ui(16, weight: .semibold))
                        .foregroundStyle(InsidTheme.paper)
                    Text(subtitle)
                        .font(InsidFont.ui(13))
                        .foregroundStyle(InsidTheme.fog)
                }
                Spacer(minLength: 8)
                Text("→")
                    .font(InsidFont.display(22, weight: .bold))
                    .foregroundStyle(quiet ? InsidTheme.fog : InsidTheme.cyan)
            }
            .padding(16)
            .background(quiet ? InsidTheme.surface : InsidTheme.cyanSoft)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(quiet ? InsidTheme.line : InsidTheme.cyanLine, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Pills, stats, notes

struct InsidPill: View {
    enum Kind { case plain, cyan, amber, rec }
    let text: String
    var kind: Kind = .plain

    var body: some View {
        HStack(spacing: 6) {
            if kind == .rec {
                Circle().fill(InsidTheme.paper).frame(width: 7, height: 7)
            }
            Text(text)
                .font(InsidFont.mono(11, weight: .medium))
        }
        .foregroundStyle(fg)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(bg)
        .clipShape(Capsule())
        .overlay(Capsule().stroke(stroke, lineWidth: 1))
    }

    private var fg: Color {
        switch kind {
        case .plain: return InsidTheme.fog
        case .cyan: return InsidTheme.cyan
        case .amber: return InsidTheme.amber
        case .rec: return InsidTheme.paper
        }
    }

    private var bg: Color {
        switch kind {
        case .plain: return InsidTheme.surface
        case .cyan: return InsidTheme.cyanSoft
        case .amber: return InsidTheme.amberSoft
        case .rec: return InsidTheme.rose.opacity(0.92)
        }
    }

    private var stroke: Color {
        switch kind {
        case .plain: return InsidTheme.line
        case .cyan: return InsidTheme.cyanLine
        case .amber: return InsidTheme.amber.opacity(0.32)
        case .rec: return InsidTheme.rose.opacity(0.38)
        }
    }
}

struct StatGrid: View {
    struct Item: Identifiable {
        let id = UUID()
        let value: String
        let label: String
    }
    let items: [Item]

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.offset) { i, item in
                VStack(spacing: 2) {
                    Text(item.value)
                        .font(InsidFont.display(22, weight: .bold))
                        .foregroundStyle(InsidTheme.paper)
                    Text(item.label)
                        .font(InsidFont.mono(10))
                        .foregroundStyle(InsidTheme.fogDim)
                        .textCase(.uppercase)
                        .tracking(0.8)
                }
                .frame(maxWidth: .infinity)
                if i < items.count - 1 {
                    Rectangle().fill(InsidTheme.line).frame(width: 1, height: 36)
                }
            }
        }
        .padding(.vertical, 12)
        .background(InsidTheme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(InsidTheme.line, lineWidth: 1)
        )
    }
}

struct SummaryRow: View {
    let label: String
    let value: String
    var tone: Tone = .normal
    enum Tone { case normal, ok, warn, bad }

    var body: some View {
        HStack {
            Text(label)
                .font(InsidFont.ui(13))
                .foregroundStyle(InsidTheme.fog)
            Spacer()
            Text(value)
                .font(InsidFont.ui(13, weight: .semibold))
                .foregroundStyle(valueColor)
        }
        .padding(.vertical, 10)
        .overlay(alignment: .bottom) {
            Rectangle().fill(InsidTheme.line).frame(height: 1)
        }
    }

    private var valueColor: Color {
        switch tone {
        case .normal: return InsidTheme.paper
        case .ok: return InsidTheme.cyan
        case .warn: return InsidTheme.amber
        case .bad: return InsidTheme.rose
        }
    }
}

struct InsidNote: View {
    let text: String
    var warn: Bool = false

    var body: some View {
        Text(AttributedString(text))
            .font(InsidFont.ui(13.5))
            .foregroundStyle(InsidTheme.fog)
            .padding(.leading, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .leading) {
                Rectangle()
                    .fill(warn ? InsidTheme.amber : InsidTheme.cyan)
                    .frame(width: 3)
            }
    }
}

struct FloorStepper: View {
    @Binding var floor: Int

    var body: some View {
        HStack(spacing: 12) {
            Button { floor -= 1 } label: {
                Image(systemName: "minus")
                    .frame(width: 40, height: 40)
                    .foregroundStyle(InsidTheme.paper)
                    .background(InsidTheme.surfaceHi)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            }
            .buttonStyle(.plain)

            Text("Floor \(floor)")
                .font(InsidFont.display(20, weight: .bold))
                .foregroundStyle(InsidTheme.amber)
                .frame(maxWidth: .infinity)

            Button { floor += 1 } label: {
                Image(systemName: "plus")
                    .frame(width: 40, height: 40)
                    .foregroundStyle(InsidTheme.paper)
                    .background(InsidTheme.surfaceHi)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            }
            .buttonStyle(.plain)
        }
    }
}

struct InsidTextField: View {
    let placeholder: String
    @Binding var text: String

    var body: some View {
        TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(InsidTheme.fogDim))
            .font(InsidFont.ui(15))
            .foregroundStyle(InsidTheme.paper)
            .padding(12)
            .background(InsidTheme.surface)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(InsidTheme.line, lineWidth: 1)
            )
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
    }
}

struct ToastBanner: View {
    let message: String

    var body: some View {
        Text(message)
            .font(InsidFont.ui(13, weight: .medium))
            .foregroundStyle(InsidTheme.ink)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(InsidTheme.cyan)
            .clipShape(Capsule())
            .shadow(color: .black.opacity(0.35), radius: 12, y: 4)
            .transition(.move(edge: .top).combined(with: .opacity))
    }
}

struct GPSSignalRing: View {
    let accuracyM: Double

    private var quality: String {
        if accuracyM < 0 { return "none" }
        if accuracyM <= InsidTheme.gpsGoodM { return "good" }
        if accuracyM <= InsidTheme.gpsFairM { return "fair" }
        return "poor"
    }

    private var color: Color {
        switch quality {
        case "good": return InsidTheme.cyan
        case "fair": return InsidTheme.amber
        default: return InsidTheme.rose
        }
    }

    var body: some View {
        VStack(spacing: 10) {
            ZStack {
                Circle()
                    .stroke(color.opacity(0.2), lineWidth: 10)
                    .frame(width: 120, height: 120)
                Circle()
                    .trim(from: 0, to: progress)
                    .stroke(color, style: StrokeStyle(lineWidth: 10, lineCap: .round))
                    .frame(width: 120, height: 120)
                    .rotationEffect(.degrees(-90))
                VStack(spacing: 2) {
                    Text(accuracyM < 0 ? "—" : String(format: "±%.0f m", accuracyM))
                        .font(InsidFont.display(22, weight: .bold))
                        .foregroundStyle(InsidTheme.paper)
                    Text(quality.uppercased())
                        .font(InsidFont.mono(10, weight: .medium))
                        .foregroundStyle(color)
                        .tracking(1.2)
                }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
    }

    private var progress: CGFloat {
        guard accuracyM >= 0 else { return 0.08 }
        let clamped = min(max(accuracyM, 3), 40)
        return CGFloat(1.0 - (clamped - 3) / 37)
    }
}

struct SharePayload: Identifiable {
    let id = UUID()
    let urls: [URL]
}

struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}

func timeString(_ seconds: Double) -> String {
    let s = Int(seconds)
    return String(format: "%02d:%02d", s / 60, s % 60)
}
