import SwiftUI
import SceneKit
import Combine
import simd

// Real-time, on-device 3D map of the walk as it's recorded — an abstract
// holographic view (NOT the AR camera feed). Renders:
//   • a dark scene with a subtle cyan grid floor,
//   • a glowing cyan polyline of the path so far,
//   • a pulsing "you are here" node at the current end,
//   • a green origin/start marker,
//   • glowing markers at dropped landmark nodes,
// and slowly orbits an auto-framed camera to keep the whole path in view.
//
// Data flow: Recorder publishes `livePath: [SIMD3<Float>]` and
// `liveLandmarks: [LiveLandmark]` (appended at ~10 Hz on the AR session queue).
// The Coordinator subscribes via Combine with `.receive(on: .main)`, so every
// SceneKit mutation happens on the main thread. Geometry is rebuilt from the
// arrays on each tick (a few hundred points at 10 Hz is comfortably cheap).
struct LiveMapView: UIViewRepresentable {
    @ObservedObject var recorder: Recorder

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> SCNView {
        let view = SCNView()
        view.backgroundColor = UIColor(red: 0.02, green: 0.03, blue: 0.05, alpha: 1)
        view.antialiasingMode = .multisampling2X
        view.allowsCameraControl = false      // we drive an auto-framing orbit
        view.rendersContinuously = true        // keep the pulse/orbit animating
        view.isUserInteractionEnabled = true

        let scene = SCNScene()
        view.scene = scene
        context.coordinator.setup(view: view, scene: scene)
        context.coordinator.bind(to: recorder)
        return view
    }

    func updateUIView(_ uiView: SCNView, context: Context) {
        // Rebind if the recorder instance changed (defensive; usually a no-op).
        context.coordinator.bind(to: recorder)
    }

    static func dismantleUIView(_ uiView: SCNView, coordinator: Coordinator) {
        coordinator.teardown()
    }

    // MARK: - Coordinator (owns the scene graph + subscriptions)
    final class Coordinator {
        private weak var scene: SCNScene?
        private let rig = SCNNode()          // orbits around the path centroid
        private let cameraNode = SCNNode()
        private let landmarkRoot = SCNNode()
        private var pathNode: SCNNode?
        private var headNode: SCNNode?

        private var cancellables = Set<AnyCancellable>()
        private weak var boundRecorder: Recorder?
        private var addedLandmarkIDs = Set<UUID>()

        private static let cyan = UIColor(red: 0.13, green: 0.83, blue: 0.93, alpha: 1)

        func setup(view: SCNView, scene: SCNScene) {
            self.scene = scene

            // Camera on an orbiting rig that looks at the rig's own origin
            // (which we park at the path centroid). Slow continuous spin.
            let cam = SCNCamera()
            cam.fieldOfView = 55
            cam.zNear = 0.05
            cam.zFar = 4000
            cam.wantsHDR = false
            cameraNode.camera = cam
            cameraNode.position = SCNVector3(0, 8, 14)
            let look = SCNLookAtConstraint(target: rig)
            look.isGimbalLockEnabled = true
            cameraNode.constraints = [look]
            rig.addChildNode(cameraNode)
            rig.position = SCNVector3(0, 0.5, 0)
            scene.rootNode.addChildNode(rig)
            rig.runAction(.repeatForever(.rotateBy(x: 0, y: .pi * 2, z: 0, duration: 44)))

            addLighting(to: scene)
            scene.rootNode.addChildNode(makeGrid())
            scene.rootNode.addChildNode(makeOriginMarker())
            scene.rootNode.addChildNode(landmarkRoot)
            addHead(to: scene)
        }

        func bind(to recorder: Recorder) {
            guard boundRecorder !== recorder else { return }
            cancellables.removeAll()
            boundRecorder = recorder

            recorder.$livePath
                .receive(on: DispatchQueue.main)
                .sink { [weak self] pts in self?.updatePath(pts) }
                .store(in: &cancellables)

            recorder.$liveLandmarks
                .receive(on: DispatchQueue.main)
                .sink { [weak self] lms in self?.updateLandmarks(lms) }
                .store(in: &cancellables)
        }

        func teardown() {
            cancellables.removeAll()
        }

        // MARK: scene building
        private func addLighting(to scene: SCNScene) {
            let ambient = SCNNode()
            ambient.light = SCNLight()
            ambient.light?.type = .ambient
            ambient.light?.color = UIColor(red: 0.35, green: 0.55, blue: 0.65, alpha: 1)
            scene.rootNode.addChildNode(ambient)

            let key = SCNNode()
            key.light = SCNLight()
            key.light?.type = .directional
            key.light?.color = UIColor(white: 0.7, alpha: 1)
            key.position = SCNVector3(10, 20, 10)
            key.eulerAngles = SCNVector3(-Float.pi / 3, Float.pi / 5, 0)
            scene.rootNode.addChildNode(key)
        }

        // Subtle cyan grid on the XZ plane (y = 0), plus a very dim floor plane.
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

        private func makeOriginMarker() -> SCNNode {
            let s = SCNSphere(radius: 0.28)
            let mat = SCNMaterial()
            mat.lightingModel = .constant
            let green = UIColor(red: 0.20, green: 0.85, blue: 0.45, alpha: 1)
            mat.diffuse.contents = green
            mat.emission.contents = green
            s.materials = [mat]
            let node = SCNNode(geometry: s)
            node.position = SCNVector3(0, 0, 0)
            return node
        }

        private func addHead(to scene: SCNScene) {
            let s = SCNSphere(radius: 0.32)
            let mat = SCNMaterial()
            mat.lightingModel = .constant
            mat.diffuse.contents = UIColor.white
            mat.emission.contents = Self.cyan
            s.materials = [mat]
            let node = SCNNode(geometry: s)
            node.isHidden = true

            // pulsing halo ring around the head
            let halo = SCNTorus(ringRadius: 0.55, pipeRadius: 0.04)
            let hmat = SCNMaterial()
            hmat.lightingModel = .constant
            hmat.diffuse.contents = Self.cyan.withAlphaComponent(0.9)
            hmat.emission.contents = Self.cyan
            halo.materials = [hmat]
            let haloNode = SCNNode(geometry: halo)
            haloNode.eulerAngles = SCNVector3(Float.pi / 2, 0, 0)
            let pulse = SCNAction.sequence([
                .group([.scale(to: 1.8, duration: 0.9), .fadeOpacity(to: 0.05, duration: 0.9)]),
                .group([.scale(to: 1.0, duration: 0.0), .fadeOpacity(to: 0.9, duration: 0.0)])
            ])
            haloNode.runAction(.repeatForever(pulse))
            node.addChildNode(haloNode)

            scene.rootNode.addChildNode(node)
            headNode = node
        }

        // MARK: live updates (always on main thread — see bind(to:))
        private func updatePath(_ pts: [SIMD3<Float>]) {
            guard let scene else { return }

            // head + hide when there's no path yet
            if let last = pts.last {
                headNode?.isHidden = false
                headNode?.position = SCNVector3(last.x, last.y, last.z)
            } else {
                headNode?.isHidden = true
            }

            // rebuild the polyline
            pathNode?.removeFromParentNode()
            pathNode = nil
            if pts.count >= 2, let line = makeLineNode(pts) {
                scene.rootNode.addChildNode(line)
                pathNode = line
            }

            frameCamera(around: pts)
        }

        private func updateLandmarks(_ lms: [LiveLandmark]) {
            for lm in lms where !addedLandmarkIDs.contains(lm.id) {
                addedLandmarkIDs.insert(lm.id)
                landmarkRoot.addChildNode(makeLandmarkNode(at: lm.pos))
            }
        }

        private func makeLineNode(_ pts: [SIMD3<Float>]) -> SCNNode? {
            guard pts.count >= 2 else { return nil }
            let verts = pts.map { SCNVector3($0.x, $0.y, $0.z) }
            var indices: [Int32] = []
            indices.reserveCapacity((pts.count - 1) * 2)
            for i in 0..<(pts.count - 1) {
                indices.append(Int32(i))
                indices.append(Int32(i + 1))
            }
            let src = SCNGeometrySource(vertices: verts)
            let elem = SCNGeometryElement(indices: indices, primitiveType: .line)
            let geo = SCNGeometry(sources: [src], elements: [elem])
            let mat = SCNMaterial()
            mat.lightingModel = .constant
            mat.diffuse.contents = Self.cyan
            mat.emission.contents = Self.cyan
            mat.isDoubleSided = true
            geo.materials = [mat]
            return SCNNode(geometry: geo)
        }

        private func makeLandmarkNode(at pos: SIMD3<Float>) -> SCNNode {
            let container = SCNNode()
            container.position = SCNVector3(pos.x, pos.y, pos.z)

            let marker = SCNSphere(radius: 0.22)
            let mat = SCNMaterial()
            mat.lightingModel = .constant
            let magenta = UIColor(red: 1.0, green: 0.45, blue: 0.85, alpha: 1)
            mat.diffuse.contents = magenta
            mat.emission.contents = magenta
            marker.materials = [mat]
            container.addChildNode(SCNNode(geometry: marker))

            // a thin stem down to the floor so the drop reads in 3D
            let height = max(0.05, abs(pos.y))
            let stem = SCNCylinder(radius: 0.015, height: CGFloat(height))
            let smat = SCNMaterial()
            smat.lightingModel = .constant
            smat.diffuse.contents = magenta.withAlphaComponent(0.4)
            smat.emission.contents = magenta.withAlphaComponent(0.4)
            stem.materials = [smat]
            let stemNode = SCNNode(geometry: stem)
            stemNode.position = SCNVector3(0, -height / 2, 0)
            container.addChildNode(stemNode)
            return container
        }

        // Park the orbit rig at the path centroid and pull the camera back far
        // enough to keep the whole path framed.
        private func frameCamera(around pts: [SIMD3<Float>]) {
            guard !pts.isEmpty else { return }
            var minV = pts[0], maxV = pts[0]
            for p in pts {
                minV = simd_min(minV, p)
                maxV = simd_max(maxV, p)
            }
            let center = (minV + maxV) * 0.5
            rig.position = SCNVector3(center.x, center.y, center.z)

            let spanX = maxV.x - minV.x
            let spanZ = maxV.z - minV.z
            let radius = max(3.0, 0.5 * Float(sqrtf(spanX * spanX + spanZ * spanZ)))
            let dist = radius * 1.9 + 6
            let height = radius * 0.9 + 5
            // animate to avoid jumpy reframing as the path grows
            let move = SCNAction.move(to: SCNVector3(0, height, dist), duration: 0.4)
            move.timingMode = .easeInEaseOut
            cameraNode.runAction(move)
        }
    }
}
