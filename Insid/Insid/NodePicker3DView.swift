import SwiftUI
import SceneKit
import UIKit
import simd

// Rotatable / zoomable 3D node PICKER — replaces the old 2D top-down map
// (NodeMapPickerScreen). Renders every NodeStore node as a glowing, floor-tinted
// sphere at its (x, y, z) in a holographic scene (matching LiveMapView's look),
// lets the user orbit + pinch-zoom with SceneKit's built-in camera controls, and
// tap a node to select it. Reused for BOTH mapper steps via `startNodeId`:
//   • step 1 (startNodeId == nil): "tap the node you're standing on" → sets start
//   • step 2 (startNodeId != nil): "tap the node you're facing" → sets orient,
//     with the already-picked start node drawn distinctly (green + "START",
//     non-selectable) and a line drawn from START → the current pick.
//
// SceneKit y-up matches ARKit, so node positions map straight through. All scene
// mutation happens in makeUIView / updateUIView (SwiftUI's main thread) and in
// the tap handler (a main-thread gesture callback) — never off-main.

// MARK: - SceneKit view

struct NodePicker3DView: UIViewRepresentable {
    let nodes: [Node]
    let startNodeId: String?
    @Binding var selectedId: String?

    func makeCoordinator() -> Coordinator { Coordinator(selectedId: $selectedId) }

    func makeUIView(context: Context) -> SCNView {
        let view = SCNView()
        view.backgroundColor = UIColor(red: 0.02, green: 0.03, blue: 0.05, alpha: 1)
        view.antialiasingMode = .multisampling2X
        view.allowsCameraControl = true          // built-in orbit + pinch-zoom
        view.autoenablesDefaultLighting = true
        view.isUserInteractionEnabled = true
        view.defaultCameraController.interactionMode = .orbitTurntable
        view.defaultCameraController.inertiaEnabled = true

        let scene = SCNScene()
        view.scene = scene
        context.coordinator.setup(view: view, scene: scene)

        let tap = UITapGestureRecognizer(target: context.coordinator,
                                         action: #selector(Coordinator.handleTap(_:)))
        view.addGestureRecognizer(tap)

        context.coordinator.rebuild(nodes: nodes, startNodeId: startNodeId)
        context.coordinator.applySelection(selectedId)
        return view
    }

    func updateUIView(_ uiView: SCNView, context: Context) {
        // Rebuild only when the node set / start node actually changed (adding a
        // "New node here" reframes); selection highlight is cheap and always applied.
        context.coordinator.rebuild(nodes: nodes, startNodeId: startNodeId)
        context.coordinator.applySelection(selectedId)
    }

    // MARK: - Coordinator (owns the scene graph)
    final class Coordinator: NSObject {
        private let selectedId: Binding<String?>
        private weak var scnView: SCNView?
        private weak var scene: SCNScene?

        private let contentRoot = SCNNode()   // holds all node-groups
        private let cameraNode = SCNNode()
        private var connectorNode: SCNNode?

        private var groupsById: [String: SCNNode] = [:]   // container per node id
        private var positionsById: [String: SIMD3<Float>] = [:]
        private var validIds: Set<String> = []
        private var startNodeId: String?

        private var lastSignature = ""
        private var lastAppliedSelection: String?? = .some(nil) // force first apply

        private static let cyan  = UIColor(red: 0.13, green: 0.83, blue: 0.93, alpha: 1)
        private static let green = UIColor(red: 0.20, green: 0.85, blue: 0.45, alpha: 1)
        private static let amber = UIColor(red: 0.98, green: 0.75, blue: 0.14, alpha: 1)

        init(selectedId: Binding<String?>) {
            self.selectedId = selectedId
            super.init()
        }

        // MARK: setup
        func setup(view: SCNView, scene: SCNScene) {
            self.scnView = view
            self.scene = scene

            let cam = SCNCamera()
            cam.fieldOfView = 55
            cam.zNear = 0.05
            cam.zFar = 4000
            cameraNode.camera = cam
            cameraNode.simdTransform = Self.lookAt(eye: SIMD3<Float>(8, 8, 14),
                                                   center: SIMD3<Float>(0, 0, 0),
                                                   up: SIMD3<Float>(0, 1, 0))
            scene.rootNode.addChildNode(cameraNode)
            view.pointOfView = cameraNode

            addLighting(to: scene)
            scene.rootNode.addChildNode(makeGrid())
            scene.rootNode.addChildNode(contentRoot)
        }

        // MARK: build node spheres from the store
        func rebuild(nodes: [Node], startNodeId: String?) {
            let signature = nodes
                .map { "\($0.id):\($0.x),\($0.y),\($0.z):\($0.floor)" }
                .joined(separator: "|") + "#\(startNodeId ?? "")"
            guard signature != lastSignature else { return }
            lastSignature = signature
            self.startNodeId = startNodeId

            // wipe + rebuild
            contentRoot.childNodes.forEach { $0.removeFromParentNode() }
            connectorNode?.removeFromParentNode()
            connectorNode = nil
            groupsById.removeAll()
            positionsById.removeAll()
            validIds.removeAll()

            for node in nodes {
                let pos = SIMD3<Float>(Float(node.x), Float(node.y), Float(node.z))
                let isStart = (node.id == startNodeId)
                let group = makeNodeGroup(node: node, pos: pos, isStart: isStart)
                group.position = SCNVector3(pos.x, pos.y, pos.z)
                contentRoot.addChildNode(group)
                groupsById[node.id] = group
                positionsById[node.id] = pos
                validIds.insert(node.id)
            }

            frameCamera(around: Array(positionsById.values))
            // force selection re-apply after a rebuild
            lastAppliedSelection = .some(nil)
        }

        // A node "group": visible glowing sphere + big invisible hit-sphere +
        // billboarded text label + a (hidden until selected/start) halo ring. Every
        // geometry node carries the node id in `.name` so hitTest maps back cleanly.
        private func makeNodeGroup(node: Node, pos: SIMD3<Float>, isStart: Bool) -> SCNNode {
            let container = SCNNode()
            container.name = node.id
            let base = isStart ? Self.green : Self.color(forFloor: node.floor)

            // visible sphere
            let sphere = SCNSphere(radius: 0.26)
            let mat = SCNMaterial()
            mat.lightingModel = .constant
            mat.diffuse.contents = base
            mat.emission.contents = base
            sphere.materials = [mat]
            let sphereNode = SCNNode(geometry: sphere)
            sphereNode.name = node.id
            container.addChildNode(sphereNode)

            // generous invisible hit target so tapping is forgiving
            let hit = SCNSphere(radius: 0.7)
            let hmat = SCNMaterial()
            hmat.diffuse.contents = UIColor.clear
            hmat.transparency = 0.0
            hit.materials = [hmat]
            let hitNode = SCNNode(geometry: hit)
            hitNode.name = node.id
            hitNode.opacity = 0.0
            container.addChildNode(hitNode)

            // billboarded selection ring (hidden by default; shown for sel/start)
            let ring = makeRing(color: base)
            ring.name = "ring:\(node.id)"
            ring.isHidden = !isStart
            container.addChildNode(ring)

            // floating text label facing the camera
            let label = makeLabel(text: isStart ? "\(node.name) · START" : node.name,
                                  color: base)
            container.addChildNode(label)

            if isStart { container.scale = SCNVector3(1.2, 1.2, 1.2) }
            return container
        }

        private func makeRing(color: UIColor) -> SCNNode {
            let holder = SCNNode()
            holder.constraints = [SCNBillboardConstraint()]   // face the camera
            let torus = SCNTorus(ringRadius: 0.46, pipeRadius: 0.03)
            let mat = SCNMaterial()
            mat.lightingModel = .constant
            mat.diffuse.contents = color
            mat.emission.contents = color
            torus.materials = [mat]
            let t = SCNNode(geometry: torus)
            t.eulerAngles = SCNVector3(Float.pi / 2, 0, 0) // stand the ring up, facing +Z
            holder.addChildNode(t)
            return holder
        }

        private func makeLabel(text: String, color: UIColor) -> SCNNode {
            let txt = SCNText(string: text, extrusionDepth: 0)
            txt.font = UIFont.systemFont(ofSize: 8, weight: .semibold)
            txt.flatness = 0.4
            let mat = SCNMaterial()
            mat.lightingModel = .constant
            mat.diffuse.contents = color
            mat.emission.contents = color
            mat.isDoubleSided = true
            txt.materials = [mat]

            let node = SCNNode(geometry: txt)
            let (minB, maxB) = txt.boundingBox
            node.pivot = SCNMatrix4MakeTranslation((minB.x + maxB.x) / 2,
                                                   (minB.y + maxB.y) / 2, 0)
            node.scale = SCNVector3(0.035, 0.035, 0.035)
            node.position = SCNVector3(0, 0.62, 0)
            node.constraints = [SCNBillboardConstraint()]
            return node
        }

        // MARK: selection highlight + start→pick connector
        func applySelection(_ id: String?) {
            // ignore the start node as a selection target
            let effective = (id == startNodeId) ? nil : id
            if case let .some(prev) = lastAppliedSelection, prev == effective { return }
            lastAppliedSelection = .some(effective)

            for (nodeId, group) in groupsById {
                let isStart = (nodeId == startNodeId)
                let isSel = (nodeId == effective)
                let ring = group.childNode(withName: "ring:\(nodeId)", recursively: false)
                ring?.isHidden = !(isSel || isStart)
                let scale: Float = isStart ? 1.2 : (isSel ? 1.45 : 1.0)
                group.scale = SCNVector3(scale, scale, scale)
                // brighten emission of the visible sphere when selected
                if let sphere = group.childNodes.first(where: { $0.geometry is SCNSphere && $0.opacity > 0 }),
                   let mat = sphere.geometry?.firstMaterial {
                    let base = isStart ? Self.green : Self.color(forFloor: floor(forId: nodeId))
                    mat.emission.contents = isSel ? UIColor.white : base
                    mat.diffuse.contents = base
                }
            }
            rebuildConnector(to: effective)
        }

        // dashed-look amber line from the START node to the current pick.
        private func rebuildConnector(to id: String?) {
            connectorNode?.removeFromParentNode()
            connectorNode = nil
            guard let startNodeId,
                  let a = positionsById[startNodeId],
                  let id, id != startNodeId,
                  let b = positionsById[id] else { return }
            let verts = [SCNVector3(a.x, a.y, a.z), SCNVector3(b.x, b.y, b.z)]
            let src = SCNGeometrySource(vertices: verts)
            let elem = SCNGeometryElement(indices: [Int32(0), Int32(1)], primitiveType: .line)
            let geo = SCNGeometry(sources: [src], elements: [elem])
            let mat = SCNMaterial()
            mat.lightingModel = .constant
            mat.diffuse.contents = Self.amber
            mat.emission.contents = Self.amber
            geo.materials = [mat]
            let line = SCNNode(geometry: geo)
            scene?.rootNode.addChildNode(line)
            connectorNode = line
        }

        private func floor(forId id: String) -> Int {
            // cheap: recover a floor bucket from the stored y (matches NodeStore)
            let y = positionsById[id]?.y ?? 0
            return max(0, Int((Double(y) / 3.5).rounded()))
        }

        // MARK: tap → hitTest → node id
        @objc func handleTap(_ gesture: UITapGestureRecognizer) {
            guard let view = scnView else { return }
            let p = gesture.location(in: view)
            let opts: [SCNHitTestOption: Any] = [
                .searchMode: SCNHitTestSearchMode.all.rawValue,
                .ignoreHiddenNodes: false
            ]
            let hits = view.hitTest(p, options: opts)
            // hits are sorted nearest-first; take the closest that maps to a real,
            // selectable node (skip the non-selectable START node).
            for hit in hits {
                if let id = nodeId(for: hit.node), validIds.contains(id), id != startNodeId {
                    selectedId.wrappedValue = id
                    applySelection(id)
                    return
                }
            }
        }

        // walk up the node's ancestry until we find a name that's a known node id
        private func nodeId(for node: SCNNode) -> String? {
            var cur: SCNNode? = node
            while let n = cur {
                if let name = n.name, validIds.contains(name) { return name }
                cur = n.parent
            }
            return nil
        }

        // MARK: camera framing
        private func frameCamera(around positions: [SIMD3<Float>]) {
            guard !positions.isEmpty else { return }
            var minV = positions[0], maxV = positions[0]
            for pos in positions {
                minV = simd_min(minV, pos)
                maxV = simd_max(maxV, pos)
            }
            let center = (minV + maxV) * 0.5
            var radius: Float = 0
            for pos in positions { radius = max(radius, simd_distance(pos, center)) }
            radius = max(radius, 1.5)

            let fov = Float(55) * .pi / 180
            let dist = radius / tanf(fov / 2) * 1.5 + 2.5
            let dir = simd_normalize(SIMD3<Float>(0.55, 0.7, 1.0))
            let eye = center + dir * dist

            cameraNode.simdTransform = Self.lookAt(eye: eye, center: center,
                                                   up: SIMD3<Float>(0, 1, 0))
            // orbit around the node cloud's center
            scnView?.defaultCameraController.target = SCNVector3(center.x, center.y, center.z)
        }

        // node model transform whose −Z points from eye toward center
        private static func lookAt(eye: SIMD3<Float>, center: SIMD3<Float>,
                                   up: SIMD3<Float>) -> simd_float4x4 {
            let f = simd_normalize(center - eye)
            var upv = up
            if abs(simd_dot(f, upv)) > 0.999 { upv = SIMD3<Float>(0, 0, 1) }
            let s = simd_normalize(simd_cross(f, upv))
            let u = simd_cross(s, f)
            return simd_float4x4(
                SIMD4<Float>(s.x, s.y, s.z, 0),
                SIMD4<Float>(u.x, u.y, u.z, 0),
                SIMD4<Float>(-f.x, -f.y, -f.z, 0),
                SIMD4<Float>(eye.x, eye.y, eye.z, 1)
            )
        }

        // MARK: scene dressing (mirrors LiveMapView)
        private func addLighting(to scene: SCNScene) {
            let ambient = SCNNode()
            ambient.light = SCNLight()
            ambient.light?.type = .ambient
            ambient.light?.color = UIColor(red: 0.35, green: 0.55, blue: 0.65, alpha: 1)
            scene.rootNode.addChildNode(ambient)
        }

        private func makeGrid(extent: Float = 40, step: Float = 2) -> SCNNode {
            var verts: [SCNVector3] = []
            var i = -extent
            while i <= extent + 0.001 {
                verts.append(SCNVector3(i, 0, -extent))
                verts.append(SCNVector3(i, 0,  extent))
                verts.append(SCNVector3(-extent, 0, i))
                verts.append(SCNVector3( extent, 0, i))
                i += step
            }
            let indices = (0..<Int32(verts.count)).map { $0 }
            let src = SCNGeometrySource(vertices: verts)
            let elem = SCNGeometryElement(indices: indices, primitiveType: .line)
            let geo = SCNGeometry(sources: [src], elements: [elem])
            let mat = SCNMaterial()
            mat.lightingModel = .constant
            mat.diffuse.contents = Self.cyan.withAlphaComponent(0.16)
            mat.emission.contents = Self.cyan.withAlphaComponent(0.16)
            mat.isDoubleSided = true
            geo.materials = [mat]
            return SCNNode(geometry: geo)
        }

        // Floor-tinted palette (cycles for higher floors).
        private static func color(forFloor floor: Int) -> UIColor {
            let palette: [UIColor] = [
                cyan,
                UIColor(red: 1.00, green: 0.45, blue: 0.85, alpha: 1), // magenta
                amber,
                UIColor(red: 0.55, green: 0.65, blue: 1.00, alpha: 1), // periwinkle
                UIColor(red: 0.45, green: 0.95, blue: 0.75, alpha: 1)  // mint
            ]
            let idx = ((floor % palette.count) + palette.count) % palette.count
            return palette[idx]
        }
    }
}

// MARK: - SwiftUI screen (drop-in replacement for NodeMapPickerScreen)

struct NodePicker3DScreen: View {
    let prompt: String
    let confirmLabel: String
    let context: (label: String, value: String)?   // e.g. "Standing on" · "Lobby Door"
    @ObservedObject var nodes: NodeStore
    let currentPos: () -> SIMD3<Float>?
    let startNodeId: String?                         // non-nil in the orient step
    let onBack: () -> Void
    let onConfirm: (Node) -> Void

    @State private var selectedId: String?
    @State private var showNewNode = false
    @State private var newNodeName = ""

    private var selectedNode: Node? { nodes.nodes.first { $0.id == selectedId } }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header

            if nodes.nodes.isEmpty {
                emptyState
            } else {
                scenePanel
                newNodeButton
                confirmButton
            }
        }
        .padding(20)
        .alert("New node here", isPresented: $showNewNode) {
            TextField("Node name", text: $newNodeName)
            Button("Cancel", role: .cancel) {}
            Button("Create") {
                let node = nodes.addNode(name: newNodeName, position: currentPos() ?? .init(0, 0, 0))
                selectedId = node.id
            }
        } message: {
            Text("Creates a node at your current position.")
        }
    }

    // MARK: header (prompt + INTERNAL badge + optional start-node context)
    private var header: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Button(action: onBack) {
                    Image(systemName: "chevron.left").font(.headline).foregroundStyle(Color.holoCyan)
                }
                Spacer()
            }
            Text(prompt)
                .font(.system(size: 22, weight: .bold))
                .foregroundStyle(Color.holoText)

            HStack(spacing: 7) {
                Circle().fill(Color.holoAmber).frame(width: 8, height: 8)
                    .shadow(color: Color.holoAmber.opacity(0.9), radius: 4)
                Text("INTERNAL · data-collection only")
                    .font(.system(size: 11, weight: .bold)).tracking(0.6)
                    .foregroundStyle(Color.holoAmber)
            }
            .padding(.horizontal, 12).padding(.vertical, 6)
            .overlay(Capsule().stroke(style: StrokeStyle(lineWidth: 1, dash: [4]))
                .foregroundStyle(Color.holoAmber.opacity(0.6)))

            if let context {
                HStack {
                    Text(context.label).foregroundStyle(Color.holoSub)
                    Spacer()
                    Text(context.value).fontWeight(.semibold).foregroundStyle(Color.holoCyanDim)
                }
                .font(.subheadline)
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(0.05)))
            }
        }
    }

    // MARK: the rotatable 3D scene + a hint + selected-node readout overlay
    private var scenePanel: some View {
        ZStack(alignment: .bottom) {
            NodePicker3DView(nodes: nodes.nodes, startNodeId: startNodeId, selectedId: $selectedId)
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            VStack(spacing: 6) {
                if let selectedNode {
                    Text("Selected · \(selectedNode.name)")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(Color.holoText)
                        .padding(.horizontal, 12).padding(.vertical, 6)
                        .background(Capsule().fill(Color.holoBg.opacity(0.8)))
                        .overlay(Capsule().stroke(Color.holoCyan.opacity(0.5), lineWidth: 1))
                } else {
                    Text("Drag to orbit · pinch to zoom · tap a node")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Color.holoSub)
                        .padding(.horizontal, 12).padding(.vertical, 6)
                        .background(Capsule().fill(Color.holoBg.opacity(0.7)))
                }
            }
            .padding(.bottom, 10)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(RoundedRectangle(cornerRadius: 16).fill(Color.holoBg.opacity(0.6)))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color.holoCyan.opacity(0.25), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }

    private var newNodeButton: some View {
        Button {
            newNodeName = ""
            showNewNode = true
        } label: {
            Label("New node here", systemImage: "plus.circle")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.holoCyan)
                .frame(maxWidth: .infinity).padding(.vertical, 10)
                .overlay(Capsule().stroke(Color.holoCyan.opacity(0.4), lineWidth: 1))
        }
    }

    private var confirmButton: some View {
        Button {
            if let node = selectedNode { onConfirm(node) }
        } label: {
            Text(confirmLabel)
                .font(.headline)
                .foregroundStyle(Color(red: 0.02, green: 0.08, blue: 0.10))
                .frame(maxWidth: .infinity).padding(.vertical, 14)
                .background(Capsule().fill(selectedId == nil ? Color.holoCyan.opacity(0.3) : Color.holoCyan))
                .shadow(color: Color.holoCyan.opacity(selectedId == nil ? 0 : 0.5), radius: 16)
        }
        .disabled(selectedId == nil)
    }

    // MARK: empty state (no nodes yet — still let the user proceed)
    private var emptyState: some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "mappin.slash")
                .font(.system(size: 40))
                .foregroundStyle(Color.holoSub)
            Text("No nodes yet")
                .font(.headline).foregroundStyle(Color.holoText)
            Text("Drop a node at your current position to anchor this walk.")
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundStyle(Color.holoSub)
                .padding(.horizontal, 24)
            newNodeButton.padding(.horizontal, 24)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
