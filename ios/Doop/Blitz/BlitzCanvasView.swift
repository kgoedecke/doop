import SwiftUI
import UIKit

/// The native canvas: every frame is rendered by the Blitz engine into a
/// bitmap on its own Core Animation layer. No WebKit is involved, so a board
/// with many frames costs one small bitmap per frame instead of one web
/// document per frame.
struct BlitzCanvasSurface: UIViewRepresentable {
    @ObservedObject var model: CanvasModel

    func makeUIView(context: Context) -> CanvasView { CanvasView(model: model) }
    func updateUIView(_ view: CanvasView, context: Context) { view.sync() }
    static func dismantleUIView(_ view: CanvasView, coordinator: ()) { view.tearDown() }
}

@MainActor
final class CanvasView: UIView, UIGestureRecognizerDelegate {
    private let model: CanvasModel
    private let world = CALayer()
    private let chrome = CALayer()
    private let selectionOutline = CAShapeLayer()
    private let elementOutline = CAShapeLayer()
    private var frames: [String: FrameLayer] = [:]
    private var labels: [String: CATextLayer] = [:]
    private var cursors: [String: CursorLayer] = [:]
    private var zoom: CGFloat = 1
    private var offset = CGPoint(x: 40, y: 80)
    private var fitted = false
    private var fitCommand = 0
    private var drag: (id: String, origin: CGPoint)?
    private var pinchAnchor = CGPoint.zero
    private var relayout: DispatchWorkItem?
    private var pendingWakes = Set<Int>()
    private var animationLink: CADisplayLink?
    private let animationEpoch = CACurrentMediaTime()
    private var gestureActive = false
    /// Frames on screen at least this wide (points) play their CSS animations.
    private static let animateMinWidth: CGFloat = 100
    private static let animateMaxFrames = 2
    #if DEBUG
    private let monitor = FrameTimeMonitor()
    private var stress: StressDriver?
    private var heldCamera = false
    #endif

    private static let minZoom: CGFloat = 0.03
    private static let maxZoom: CGFloat = 4

    init(model: CanvasModel) {
        self.model = model
        super.init(frame: .zero)
        backgroundColor = UIColor(named: "CanvasPaper") ?? .systemGroupedBackground
        isMultipleTouchEnabled = true
        world.anchorPoint = .zero
        layer.addSublayer(world)
        layer.addSublayer(chrome)
        for outline in [selectionOutline, elementOutline] {
            outline.fillColor = nil
            outline.lineJoin = .round
            outline.isHidden = true
            chrome.addSublayer(outline)
        }
        selectionOutline.strokeColor = UIColor.tintColor.cgColor
        elementOutline.strokeColor = UIColor(red: 0.90, green: 0.33, blue: 0.24, alpha: 1).cgColor
        elementOutline.fillColor = UIColor(red: 0.90, green: 0.33, blue: 0.24, alpha: 0.08).cgColor

        let pan = UIPanGestureRecognizer(target: self, action: #selector(panned))
        pan.maximumNumberOfTouches = 1
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(pinched))
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped))
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(doubleTapped))
        doubleTap.numberOfTapsRequired = 2
        tap.require(toFail: doubleTap)
        for gesture in [pan, pinch, tap, doubleTap] {
            gesture.delegate = self
            addGestureRecognizer(gesture)
        }
        BlitzDocument.onWake = { [weak self] docID in
            guard let self else { return }
            if let frame = self.frames.values.first(where: { $0.documentID == docID }) {
                frame.scheduleRender()
            } else {
                // A cached font or image can land before the frame has registered its
                // new document id; replay the wake-up once it does.
                self.pendingWakes.insert(docID)
            }
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    func tearDown() {
        animationLink?.invalidate()
        animationLink = nil
        BlitzDocument.onWake = nil
        frames.values.forEach { $0.cancel() }
        frames.removeAll()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // Never set `frame` on the transformed world layer: CA would derive a new
        // position from the transformed bounding box and undo the camera.
        world.bounds = CGRect(origin: .zero, size: bounds.size)
        world.position = .zero
        chrome.frame = bounds
        if !fitted, let canvas = model.canvas, !canvas.frames.isEmpty {
            fit(canvas.frames)
            rerenderVisible()
        }
        applyTransform()
    }

    func gestureRecognizer(_ a: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith b: UIGestureRecognizer) -> Bool {
        a is UIPinchGestureRecognizer || b is UIPinchGestureRecognizer
    }

    // MARK: - Model sync

    /// Reconcile layers with the model. Called by SwiftUI on every change.
    func sync() {
        let current = model.canvas?.frames ?? []
        let ids = Set(current.map(\.id))
        for (id, frame) in frames where !ids.contains(id) {
            frame.cancel()
            frame.layer.removeFromSuperlayer()
            labels[id]?.removeFromSuperlayer()
            labels[id] = nil
            frames[id] = nil
        }
        // Fit before creating layers so the first bitmaps are requested at the
        // fitted density, not at 1:1 for every frame on the board.
        if !fitted, !current.isEmpty, bounds.width > 0 { fit(current) }
        var added = false
        for frame in current {
            if let existing = frames[frame.id] {
                existing.update(frame)
            } else {
                let layer = FrameLayer(frame: frame, baseURL: model.client.server.origin)
                layer.onDocumentRegistered = { [weak self] docID in
                    guard let self, self.pendingWakes.remove(docID) != nil else { return false }
                    return true
                }
                layer.onAnimating = { [weak self] in self?.ensureAnimationLoop() }
                world.addSublayer(layer.layer)
                frames[frame.id] = layer
                let label = CATextLayer()
                label.contentsScale = UIScreen.main.scale
                label.fontSize = 12
                label.font = UIFont.systemFont(ofSize: 12, weight: .medium)
                label.truncationMode = .end
                label.alignmentMode = .left
                chrome.insertSublayer(label, at: 0)
                labels[frame.id] = label
                added = true
            }
        }
        if added { rerenderVisible() }
        // A collaborator can move or resize an animating frame into view: restart the loop.
        let viewport = toWorldRect(bounds)
        if frames.values.contains(where: { $0.animating && $0.rect.intersects(viewport) }) { ensureAnimationLoop() }
        #if DEBUG
        if StressDriver.enabled, stress == nil, !current.isEmpty, fitted {
            stress = StressDriver(canvas: self)
            stress?.start()
        }
        // -holdCamera "x,y,zoom" puts world point (x, y) at the view's top-left (simulator automation).
        if !heldCamera, fitted, !current.isEmpty, let spec = UserDefaults.standard.string(forKey: "holdCamera") {
            let parts = spec.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
            if parts.count == 3 {
                heldCamera = true
                // -holdDelay <seconds>: sit on the fitted board first (document sleep, idle) and move the camera later.
                let delay = UserDefaults.standard.double(forKey: "holdDelay")
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                    guard let self else { return }
                    self.setCamera(zoom: parts[2], offset: CGPoint(x: -parts[0] * parts[2], y: -parts[1] * parts[2]))
                    self.scheduleRelayout()
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + delay + 3) { [weak self] in
                    guard let self else { return }
                    let held = self.frames.values.first { $0.rect.contains(CGPoint(x: parts[0] + 1, y: parts[1] + 1)) }
                    canvasLog.info("held camera: \(self.describe(held?.rect ?? .zero), privacy: .public)")
                    // -pickElement "x,y": select the held frame, turn on Inspect and pick the element at
                    // frame-local CSS px (x, y), exactly as a tap inside the frame would.
                    if let held, let pick = UserDefaults.standard.string(forKey: "pickElement") {
                        let p = pick.split(separator: ",").compactMap { Double($0) }
                        guard p.count == 2 else { return }
                        self.model.select(held.id)
                        self.model.inspecting = true
                        held.pickElement(at: CGPoint(x: p[0], y: p[1])) { [weak self] info, htmlHash in
                            guard let self, htmlHash == held.html.hashValue else { return }
                            if let info, let rect = info.frameRect {
                                self.model.selectedElement = SelectedElement(frameID: held.id, nodeID: info.id, selector: info.selector, label: info.label, text: info.text, rect: rect, htmlHash: htmlHash)
                                canvasLog.info("picked \(info.label, privacy: .public) selector \(info.selector, privacy: .public) rect \(NSCoder.string(for: rect), privacy: .public) text \(info.text.prefix(60), privacy: .public)")
                            } else {
                                canvasLog.error("pick found nothing at \(pick, privacy: .public)")
                            }
                            self.drawChrome()
                        }
                    }
                }
            }
        }
        #endif
        if fitCommand != model.viewportCommand {
            fitCommand = model.viewportCommand
            fit(current)
            scheduleRelayout()
        }
        for frame in frames.values { frame.selected = frame.id == model.selectedID }
        syncCursors()
        drawChrome()
    }

    private func syncCursors() {
        let people = model.presences.filter { $0.cursor != nil }
        let ids = Set(people.map(\.clientId))
        for (id, cursor) in cursors where !ids.contains(id) {
            cursor.layer.removeFromSuperlayer()
            cursors[id] = nil
        }
        for person in people {
            let cursor = cursors[person.clientId] ?? {
                let cursor = CursorLayer()
                chrome.addSublayer(cursor.layer)
                cursors[person.clientId] = cursor
                return cursor
            }()
            cursor.update(name: person.name, color: person.color, kind: person.kind)
        }
    }

    // MARK: - Viewport

    /// Screen density for the current zoom, in screen pixels per CSS pixel. Base
    /// bitmaps cap this; tiles use it as is.
    private var lod: CGFloat { zoom * UIScreen.main.scale }

    private func applyTransform() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        world.transform = CATransform3DConcat(CATransform3DMakeScale(zoom, zoom, 1), CATransform3DMakeTranslation(offset.x, offset.y, 0))
        drawChrome()
        CATransaction.commit()
    }

    /// Current camera: world → screen is `point * zoom + offset`.
    var camera: (zoom: CGFloat, offset: CGPoint) { (zoom, offset) }
    var frameCount: Int { frames.count }
    var frameRects: [CGRect] { frames.values.map(\.rect) }
    var boardBounds: CGRect { frames.values.map(\.rect).reduce(CGRect.null) { $0.union($1) } }
    var allFramesPainted: Bool { !frames.isEmpty && frames.values.allSatisfy { $0.layer.contents != nil } }
    var renderCount: Int { frames.values.reduce(0) { $0 + $1.renders } }
    var liveDocumentCount: Int { frames.values.filter(\.hasDocument).count }
    func frameName(at rect: CGRect) -> String? { frames.values.first { $0.rect == rect }?.name }
    /// Geometry dump for the stress log: the camera, the world layer's actual transform and where a frame lands on screen.
    func describe(_ rect: CGRect) -> String {
        let m = world.transform
        let frame = frames.values.first { $0.rect == rect }
        let contents = (frame?.layer.contents as! CGImage?).map { "\($0.width)x\($0.height)" } ?? "none"
        let screen = CGRect(origin: toScreen(rect.origin), size: CGSize(width: rect.width * zoom, height: rect.height * zoom))
        return String(format: "zoom %.3f offset (%.0f, %.0f) world m11 %.3f m41 %.0f m42 %.0f bounds %.0fx%.0f target on screen (%.0f, %.0f, %.0f, %.0f) bitmap %@ layerFrame (%.0f, %.0f, %.0f, %.0f)",
                      zoom, offset.x, offset.y, m.m11, m.m41, m.m42, bounds.width, bounds.height, screen.minX, screen.minY, screen.width, screen.height, contents,
                      frame?.layer.frame.minX ?? -1, frame?.layer.frame.minY ?? -1, frame?.layer.frame.width ?? -1, frame?.layer.frame.height ?? -1)
    }

    /// Move the camera as a gesture would (no re-render until `settle()`).
    func setCamera(zoom newZoom: CGFloat, offset newOffset: CGPoint) {
        zoom = max(Self.minZoom, min(Self.maxZoom, newZoom))
        offset = newOffset
        applyTransform()
    }

    /// What a finger lifting does: re-render visible frames at the new density.
    func settle() { scheduleRelayout() }

    // MARK: - CSS animation playback

    /// Run the playback loop while some visible frame is animating. Paints are
    /// self-paced on the engine queue; the link only asks idle frames to step.
    private func ensureAnimationLoop() {
        guard animationLink == nil else { return }
        let link = CADisplayLink(target: self, selector: #selector(animationTick))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 10, maximum: 60, preferred: 60)
        link.add(to: .main, forMode: .common)
        animationLink = link
    }

    @objc private func animationTick(_ link: CADisplayLink) {
        guard window != nil, !gestureActive else { return }
        let viewport = toWorldRect(bounds)
        let playing = frames.values
            .filter { $0.animating && $0.rect.intersects(viewport) && $0.rect.width * zoom >= Self.animateMinWidth }
            .sorted { $0.rect.width * $1.rect.height > $1.rect.width * $0.rect.height }
            .prefix(Self.animateMaxFrames)
        if playing.isEmpty {
            // Nothing on screen can play; the relayout after the next camera move restarts the loop.
            link.invalidate()
            animationLink = nil
            return
        }
        let time = CACurrentMediaTime() - animationEpoch
        for frame in playing {
            let inView = frame.rect.intersection(viewport).offsetBy(dx: -frame.rect.minX, dy: -frame.rect.minY)
            frame.tickAnimation(time: time, viewportInFrame: inView, lod: lod)
        }
    }

    private func toScreen(_ point: CGPoint) -> CGPoint { CGPoint(x: point.x * zoom + offset.x, y: point.y * zoom + offset.y) }
    private func toWorld(_ point: CGPoint) -> CGPoint { CGPoint(x: (point.x - offset.x) / zoom, y: (point.y - offset.y) / zoom) }

    private func fit(_ frames: [DesignFrame]) {
        guard bounds.width > 0 else { return }
        fitted = true
        guard !frames.isEmpty else { zoom = 1; offset = CGPoint(x: 40, y: 80); applyTransform(); return }
        let minX = frames.map(\.x).min()!, minY = frames.map(\.y).min()!
        let maxX = frames.map { $0.x + $0.width }.max()!, maxY = frames.map { $0.y + $0.height }.max()!
        // Keep fitted frames above the floating prompt and dock.
        let available = CGSize(width: bounds.width - 48, height: max(120, bounds.height - 200))
        zoom = max(Self.minZoom, min(1, available.width / CGFloat(maxX - minX), available.height / CGFloat(maxY - minY)))
        offset = CGPoint(x: (bounds.width - CGFloat(maxX - minX) * zoom) / 2 - CGFloat(minX) * zoom,
                         y: 24 + (available.height - CGFloat(maxY - minY) * zoom) / 2 - CGFloat(minY) * zoom)
        applyTransform()
    }

    /// After a zoom change settles, re-render visible frames at the new density.
    private func scheduleRelayout() {
        relayout?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            // Rest on whole device pixels so bitmaps are never resampled by a fraction.
            let s = UIScreen.main.scale
            self.offset = CGPoint(x: (self.offset.x * s).rounded() / s, y: (self.offset.y * s).rounded() / s)
            self.applyTransform()
            self.rerenderVisible()
        }
        relayout = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: work)
    }

    /// Visible frames get a bitmap at the current density; frames beyond a
    /// half-screen margin keep only a small one; frames that are tiny on
    /// screen and idle release their engine document until needed again.
    private func rerenderVisible() {
        let visible = toWorldRect(bounds.insetBy(dx: -bounds.width / 2, dy: -bounds.height / 2))
        let viewport = toWorldRect(bounds)
        #if DEBUG
        if StressDriver.enabled {
            let names = frames.values.filter { $0.rect.intersects(visible) }.map(\.name).sorted().joined(separator: ", ")
            canvasLog.info("relayout zoom \(String(format: "%.2f", self.zoom), privacy: .public) lod \(String(format: "%.2f", self.lod), privacy: .public) visible: \(names, privacy: .public)")
        }
        #endif
        // Visible frames first: the engine queue is serial, and a parked
        // re-render must never delay the frame under the finger.
        for frame in frames.values.sorted(by: { $0.rect.intersects(visible) && !$1.rect.intersects(visible) }) {
            let onScreen = frame.rect.intersects(visible)
            let inView = frame.rect.intersection(viewport)
            frame.setLOD(lod, visible: onScreen, screenWidth: frame.rect.width * zoom,
                         viewportInFrame: inView.isNull ? nil : inView.offsetBy(dx: -frame.rect.minX, dy: -frame.rect.minY))
        }
        if frames.values.contains(where: { $0.animating && $0.rect.intersects(viewport) }) { ensureAnimationLoop() }
    }

    private func toWorldRect(_ rect: CGRect) -> CGRect {
        let origin = toWorld(rect.origin)
        return CGRect(x: origin.x, y: origin.y, width: rect.width / zoom, height: rect.height / zoom)
    }

    // MARK: - Chrome (labels, selection, cursors) in screen space

    private func drawChrome() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for (id, label) in labels {
            guard let frame = frames[id] else { continue }
            let origin = toScreen(frame.rect.origin)
            let width = frame.rect.width * zoom
            // Like Figma, titles disappear when a frame is too small to read.
            label.isHidden = width < 44
            guard !label.isHidden else { continue }
            let selected = id == model.selectedID
            label.string = frame.name
            label.foregroundColor = (selected ? UIColor.tintColor : UIColor.secondaryLabel).cgColor
            label.frame = CGRect(x: origin.x, y: origin.y - 20, width: width, height: 16)
        }
        if let id = model.selectedID, let frame = frames[id] {
            let rect = CGRect(origin: toScreen(frame.rect.origin), size: CGSize(width: frame.rect.width * zoom, height: frame.rect.height * zoom)).insetBy(dx: -1.5, dy: -1.5)
            selectionOutline.path = UIBezierPath(rect: rect).cgPath
            selectionOutline.lineWidth = 2
            selectionOutline.isHidden = false
            if let element = model.selectedElement, element.frameID == id {
                let r = element.rect
                let screen = CGRect(origin: toScreen(CGPoint(x: frame.rect.minX + r.minX, y: frame.rect.minY + r.minY)),
                                    size: CGSize(width: r.width * zoom, height: r.height * zoom))
                elementOutline.path = UIBezierPath(rect: screen).cgPath
                elementOutline.lineWidth = 1.5
                elementOutline.isHidden = false
            } else { elementOutline.isHidden = true }
        } else {
            selectionOutline.isHidden = true
            elementOutline.isHidden = true
        }
        for person in model.presences {
            guard let cursor = cursors[person.clientId], let point = person.cursor else { continue }
            let world = CGPoint(x: point.x, y: point.y)
            cursor.move(to: toScreen(world), world: world)
        }
        CATransaction.commit()
    }

    // MARK: - Gestures

    private func frame(at screenPoint: CGPoint) -> FrameLayer? {
        let point = toWorld(screenPoint)
        // Topmost frame wins: later frames are drawn above earlier ones.
        return (model.canvas?.frames ?? []).reversed().lazy.compactMap { self.frames[$0.id] }.first { $0.rect.contains(point) }
    }

    private func label(at screenPoint: CGPoint) -> String? {
        labels.first { !$0.value.isHidden && $0.value.frame.insetBy(dx: 0, dy: -6).contains(screenPoint) }?.key
    }

    @objc private func tapped(_ gesture: UITapGestureRecognizer) {
        let point = gesture.location(in: self)
        if model.inspecting, let id = model.selectedID, let frame = frames[id], frame.rect.contains(toWorld(point)) {
            let local = toWorld(point)
            let inFrame = CGPoint(x: local.x - frame.rect.minX, y: local.y - frame.rect.minY)
            frame.pickElement(at: inFrame) { [weak self] info, htmlHash in
                // The HTML moved on while the hit test ran: this result describes an element
                // that may no longer exist, so it is not selected.
                guard let self, let info, let rect = info.frameRect, htmlHash == frame.html.hashValue else { return }
                self.model.selectedElement = SelectedElement(frameID: id, nodeID: info.id, selector: info.selector, label: info.label, text: info.text, rect: rect, htmlHash: htmlHash)
                self.drawChrome()
            }
            return
        }
        let hit = frame(at: point)?.id ?? label(at: point)
        model.selectedElement = nil
        model.select(hit)
        drawChrome()
    }

    @objc private func doubleTapped(_ gesture: UITapGestureRecognizer) {
        let point = gesture.location(in: self)
        if let frame = frame(at: point) {
            let padded = frame.rect.insetBy(dx: -frame.rect.width * 0.05, dy: -frame.rect.height * 0.05)
            zoom = max(Self.minZoom, min(Self.maxZoom, min(bounds.width / padded.width, (bounds.height - 200) / padded.height)))
            offset = CGPoint(x: (bounds.width - padded.width * zoom) / 2 - padded.minX * zoom,
                             y: 24 + ((bounds.height - 200) - padded.height * zoom) / 2 - padded.minY * zoom)
            model.select(frame.id)
        } else {
            fit(model.canvas?.frames ?? [])
        }
        applyTransform()
        scheduleRelayout()
    }

    @objc private func panned(_ gesture: UIPanGestureRecognizer) {
        let translation = gesture.translation(in: self)
        switch gesture.state {
        case .began:
            gestureActive = true
            #if DEBUG
            monitor.begin("pan")
            #endif
            let start = gesture.location(in: self)
            if let id = label(at: CGPoint(x: start.x - translation.x, y: start.y - translation.y)), let frame = frames[id] {
                drag = (id, frame.rect.origin)
                model.select(id)
            } else {
                drag = nil
            }
        case .changed:
            if let drag, let frame = frames[drag.id] {
                frame.move(to: CGPoint(x: drag.origin.x + translation.x / zoom, y: drag.origin.y + translation.y / zoom))
                drawChrome()
            } else {
                offset.x += translation.x
                offset.y += translation.y
                gesture.setTranslation(.zero, in: self)
                applyTransform()
            }
        case .ended, .cancelled:
            gestureActive = false
            #if DEBUG
            monitor.end()
            #endif
            if let drag, let frame = frames[drag.id] {
                let target = frame.rect.origin
                self.drag = nil
                if gesture.state == .ended, hypot(translation.x, translation.y) > 3 {
                    Task { await model.moveFrame(drag.id, x: target.x, y: target.y) }
                } else {
                    frame.move(to: drag.origin)
                    drawChrome()
                }
            } else {
                scheduleRelayout()
            }
        default: break
        }
    }

    @objc private func pinched(_ gesture: UIPinchGestureRecognizer) {
        let center = gesture.location(in: self)
        switch gesture.state {
        case .began:
            gestureActive = true
            #if DEBUG
            monitor.begin("pinch")
            #endif
            pinchAnchor = toWorld(center)
        case .changed:
            zoom = max(Self.minZoom, min(Self.maxZoom, zoom * gesture.scale))
            gesture.scale = 1
            offset = CGPoint(x: center.x - pinchAnchor.x * zoom, y: center.y - pinchAnchor.y * zoom)
            applyTransform()
        case .ended, .cancelled:
            gestureActive = false
            #if DEBUG
            monitor.end()
            #endif
            scheduleRelayout()
        default: break
        }
    }
}

/// A frame's bitmap layer plus the Blitz document that paints it.
///
/// Memory policy: a bitmap is never larger than about two screens of pixels;
/// off-screen frames keep a small "parked" bitmap, and after a while release
/// their engine document (the parsed DOM and its decoded images), re-parsing
/// on demand when they scroll back into view.
@MainActor
private final class FrameLayer {
    let id: String
    let layer = CALayer()
    private(set) var rect: CGRect
    private(set) var name: String
    var selected = false
    private(set) var html: String
    private var document: BlitzDocument?
    private var documentIDValue = 0
    /// Bitmap pixels per CSS pixel of the last requested render.
    private var currentScale: CGFloat = 0
    private var targetScale: CGFloat
    private var generation = 0
    private var creating = false
    private var rendering = false
    private var dirty = true
    private var pending: DispatchWorkItem?
    private var sleepTimer: DispatchWorkItem?
    private var lastChange = CACurrentMediaTime()
    private let baseURL: URL
    private(set) var renders = 0
    /// Asked when a document id becomes known; returns true if a wake-up was waiting for it.
    var onDocumentRegistered: ((Int) -> Bool)?
    /// True after a paint reported running CSS animations or transitions.
    private(set) var animating = false
    /// Fired when a frame starts animating, so the canvas can run the playback loop.
    var onAnimating: (() -> Void)?
    private var lastAnimationStep: Double = -1
    /// Animation clock of the last paint, so a static re-paint keeps the pose.
    private var animationTime: Double = 0
    private let tile = CALayer()
    private var tileRegion: CGRect?
    private var tileDensity: CGFloat = 0
    private var tileRendering = false
    private var tileDirty = false
    private var tilePending: (CGRect, CGFloat)?
    /// Bumped by `clearTile()`: a tile painted for an older request is dropped.
    private var tileVersion = 0
    /// Tiles cover about a screen, so density can go well past the base cap.
    private static let maxTileDensity: CGFloat = 8
    /// Playback repaints only the on-screen part of the frame. Steps are self-paced
    /// by the paint; the density is chosen so one step stays near `playbackPixels`
    /// (about 16 ms on Skia), which keeps motion smooth at any zoom.
    private static let animationInterval: Double = 1.0 / 60
    private static let playbackPixels: CGFloat = 550_000
    /// The last camera handed to `setLOD`, so a tile can be refreshed when playback ends.
    private var lastView: CGRect?
    private var lastLOD: CGFloat = 0

    /// Density kept for frames outside the viewport margin.
    private static let parkedScale: CGFloat = 0.2
    /// Longest bitmap side, and the pixel budget per bitmap (two screens).
    private static let maxSide: CGFloat = 4096
    private static let pixelBudget: CGFloat = {
        let screen = UIScreen.main.nativeBounds
        return screen.width * screen.height * 2
    }()
    /// How long a frame stays off screen before it releases its document.
    private static let sleepDelay: TimeInterval = 8

    var documentID: Int { documentIDValue }
    var hasDocument: Bool { document != nil }

    init(frame: DesignFrame, baseURL: URL) {
        id = frame.id
        rect = CGRect(x: frame.x, y: frame.y, width: frame.width, height: frame.height)
        name = frame.name
        html = frame.html
        targetScale = Self.parkedScale
        self.baseURL = baseURL
        layer.anchorPoint = .zero
        layer.frame = rect
        layer.backgroundColor = UIColor.white.cgColor
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.12
        layer.shadowRadius = 6
        layer.shadowOffset = CGSize(width: 0, height: 2)
        layer.contentsGravity = .resize
        layer.magnificationFilter = .linear
        layer.minificationFilter = .trilinear
        tile.anchorPoint = .zero
        tile.contentsGravity = .resize
        tile.magnificationFilter = .linear
        tile.minificationFilter = .trilinear
        tile.isHidden = true
    }

    func cancel() { generation += 1; pending?.cancel(); sleepTimer?.cancel(); document = nil; animating = false }

    /// Parse the document on the engine queue if we do not have one. A parse
    /// already in flight is left alone; the latest density is applied when it lands.
    private func ensureDocument() {
        guard document == nil, !creating else { return }
        creating = true
        let size = rect.size, html = html, scale = Float(clamp(targetScale)), baseURL = baseURL
        generation += 1
        let expected = generation
        BlitzDocument.queue.async { [weak self] in
            let document = BlitzDocument(html: html, baseURL: baseURL, width: size.width, height: size.height, scale: scale)
            DispatchQueue.main.async {
                guard let self else { return }
                self.creating = false
                guard expected == self.generation else { return }
                self.document = document
                self.documentIDValue = document.id
                self.currentScale = CGFloat(scale)
                if self.html != html {
                    // HTML streamed in while the parse was in flight: apply it before the first paint.
                    let latest = self.html
                    BlitzDocument.queue.async { [weak self] in
                        document.setHTML(latest)
                        let id = document.id
                        DispatchQueue.main.async { self?.documentIDValue = id; _ = self?.onDocumentRegistered?(id) }
                    }
                }
                let wanted = self.clamp(self.targetScale)
                if abs(wanted - self.currentScale) > 0.01 {
                    let size = self.rect.size
                    BlitzDocument.queue.async { document.setViewport(width: size.width, height: size.height, scale: Float(wanted)) }
                    self.currentScale = wanted
                }
                self.dirty = true
                self.scheduleRender()
                _ = self.onDocumentRegistered?(document.id)
                // Resources that completed during parsing are ingested by the next
                // resolve; paint once more so a cached image never stays missing.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.scheduleRender() }
            }
        }
    }

    /// Apply a model change: geometry is immediate, HTML re-parses in the engine.
    func update(_ frame: DesignFrame) {
        let newRect = CGRect(x: frame.x, y: frame.y, width: frame.width, height: frame.height)
        name = frame.name
        if newRect != rect {
            let resized = newRect.size != rect.size
            rect = newRect
            CATransaction.begin(); CATransaction.setDisableActions(true)
            layer.frame = rect
            CATransaction.commit()
            if resized {
                lastChange = CACurrentMediaTime()
                let size = rect.size, scale = Float(clamp(targetScale))
                BlitzDocument.queue.async { [document] in document?.setViewport(width: size.width, height: size.height, scale: scale) }
                dirty = true
                scheduleRender()
            }
        }
        if frame.html != html {
            html = frame.html
            lastChange = CACurrentMediaTime()
            tileDirty = true
            if let region = tileRegion { let density = tileDensity; DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in guard let self else { return }; self.requestTile(region: region, density: density, time: self.animationTime) } }
            if let document {
                let value = html
                BlitzDocument.queue.async { [weak self] in
                    document.setHTML(value)
                    let id = document.id
                    DispatchQueue.main.async {
                        self?.documentIDValue = id
                        if self?.onDocumentRegistered?(id) == true { self?.scheduleRender() }
                    }
                }
            }
            dirty = true
            scheduleRender()
        }
    }

    /// Local drag preview; the model is updated when the drag ends.
    func move(to origin: CGPoint) {
        rect.origin = origin
        CATransaction.begin(); CATransaction.setDisableActions(true)
        layer.frame = rect
        CATransaction.commit()
    }

    /// Choose the bitmap density for the current camera and start a render
    /// if it changed. Also decides whether the engine document stays alive.
    func setLOD(_ lod: CGFloat, visible: Bool, screenWidth: CGFloat, viewportInFrame: CGRect? = nil) {
        targetScale = visible ? clamp(lod) : min(currentScale == 0 ? Self.parkedScale : currentScale, Self.parkedScale)
        lastView = visible ? viewportInFrame : nil
        lastLOD = lod
        refreshTile()
        #if DEBUG
        if StressDriver.enabled, visible {
            canvasLog.info("  \(self.name, privacy: .public): target \(String(format: "%.2f", self.targetScale), privacy: .public) current \(String(format: "%.2f", self.currentScale), privacy: .public) doc \(self.document != nil) dirty \(self.dirty) rendering \(self.rendering)")
        }
        #endif
        sleepTimer?.cancel()
        _ = screenWidth
        if !visible, !selected, layer.contents != nil, abs(targetScale - currentScale) < 0.01, !dirty {
            // Tiny or off screen with a good enough bitmap: let the document go after a while.
            let work = DispatchWorkItem { [weak self] in self?.sleepIfIdle() }
            sleepTimer = work
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.sleepDelay, execute: work)
            return
        }
        guard abs(targetScale - currentScale) > 0.01 || dirty || document == nil else { return }
        guard let document else { ensureDocument(); return }
        let size = rect.size, scale = Float(targetScale)
        BlitzDocument.queue.async { document.setViewport(width: size.width, height: size.height, scale: scale) }
        currentScale = targetScale
        dirty = true
        scheduleRender()
    }

    private func sleepIfIdle() {
        guard let document, !selected, !rendering, !dirty, CACurrentMediaTime() - lastChange > Self.sleepDelay else { return }
        self.document = nil
        documentIDValue = 0
        animating = false // a new document reports its animations again on its first paint
        BlitzDocument.queue.async { _ = document } // released on the engine queue
    }

    /// Coalesce bursts (streamed chunks, font arrivals) into one paint.
    func scheduleRender() {
        dirty = true
        pending?.cancel()
        let work = DispatchWorkItem { [weak self] in guard let self else { return }; self.renderNow(time: self.animationTime) }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.04, execute: work)
    }

    /// Paint one animation step at `time` seconds: only the on-screen part of the
    /// frame, as a tile at the current density, so a step costs about a screen of
    /// pixels however large the frame is.
    func tickAnimation(time: Double, viewportInFrame: CGRect, lod: CGFloat) {
        guard animating, document != nil, !tileRendering, time - lastAnimationStep >= Self.animationInterval else { return }
        lastAnimationStep = time
        let area = viewportInFrame.width * viewportInFrame.height * 1.21
        let density = max(0.25, min(lod, (Self.playbackPixels / max(1, area)).squareRoot()))
        requestTile(region: tileRegion(around: viewportInFrame, margin: 0.1, density: density), density: density, time: time, force: true)
    }

    // MARK: Tiles

    /// Deep zoom: the base bitmap cannot reach screen density, so paint just the
    /// part on screen as a tile over it, at (close to) screen density.
    private func refreshTile() {
        if let view = lastView, lastLOD > targetScale + 0.05 {
            let density = min(lastLOD, Self.maxTileDensity)
            requestTile(region: tileRegion(around: view, margin: 0.3, density: density), density: density, time: animationTime)
        } else if !animating {
            clearTile()
        }
    }

    /// A tile region around `view` (frame CSS px), expanded by `margin`, clipped to
    /// the frame and snapped to the device-pixel grid at `density` so the bitmap
    /// lands on whole pixels when composited.
    private func tileRegion(around view: CGRect, margin: CGFloat, density: CGFloat) -> CGRect {
        let expanded = view.insetBy(dx: -view.width * margin, dy: -view.height * margin).intersection(CGRect(origin: .zero, size: rect.size))
        let x0 = floor(expanded.minX * density) / density, y0 = floor(expanded.minY * density) / density
        let x1 = ceil(expanded.maxX * density) / density, y1 = ceil(expanded.maxY * density) / density
        return CGRect(x: x0, y: y0, width: max(0, x1 - x0), height: max(0, y1 - y0))
    }

    private func requestTile(region: CGRect, density: CGFloat, time: Double, force: Bool = false) {
        guard region.width > 1, region.height > 1, let document else { return }
        if !force, let current = tileRegion, !tileDirty, current == region, abs(tileDensity - density) < 0.01 { return }
        if tileRendering { if !force { tilePending = (region, density) }; return }
        tileRendering = true
        tileDirty = false
        animationTime = time
        let expected = generation, version = tileVersion
        BlitzDocument.queue.async { [weak self] in
            let started = CACurrentMediaTime()
            let image = document.render(region: region, density: density, time: time)
            let stillAnimating = document.isAnimating
            #if DEBUG
            if StressDriver.enabled || UserDefaults.standard.string(forKey: "holdCamera") != nil {
                let ms = (CACurrentMediaTime() - started) * 1000
                canvasLog.info("tile \(Int(region.width * density))x\(Int(region.height * density)) @\(String(format: "%.2f", density), privacy: .public) t=\(String(format: "%.2f", time), privacy: .public): \(String(format: "%.1f", ms), privacy: .public) ms")
            }
            #endif
            DispatchQueue.main.async {
                guard let self else { return }
                self.tileRendering = false
                guard expected == self.generation else { return }
                if let image, version == self.tileVersion {
                    let tile = self.tile
                    if tile.superlayer == nil { self.layer.addSublayer(tile) }
                    CATransaction.begin(); CATransaction.setDisableActions(true)
                    tile.frame = region
                    tile.contents = image
                    tile.isHidden = false
                    CATransaction.commit()
                    self.tileRegion = region
                    self.tileDensity = density
                }
                if self.animating, !stillAnimating {
                    // The animation ran out: paint the base at its final pose; that
                    // render then refreshes or drops the tile, so nothing jumps back.
                    self.animating = false
                    self.dirty = true
                    self.scheduleRender()
                }
                if let next = self.tilePending {
                    self.tilePending = nil
                    self.requestTile(region: next.0, density: next.1, time: self.animationTime)
                }
            }
        }
    }

    private func clearTile() {
        tilePending = nil
        tileVersion += 1 // a paint still in flight must not resurface the tile
        guard tileRegion != nil else { return }
        tileRegion = nil
        CATransaction.begin(); CATransaction.setDisableActions(true)
        tile.isHidden = true
        tile.contents = nil
        CATransaction.commit()
    }

    private func renderNow(time: Double = 0) {
        guard !rendering, dirty else { return }
        guard let document else { ensureDocument(); return }
        rendering = true
        dirty = false
        let expected = generation
        let size = rect.size, baseScale = Float(currentScale)
        BlitzDocument.queue.async { [weak self] in
            // A tile may have moved the document to screen density; base bitmaps use their own.
            document.setViewport(width: size.width, height: size.height, scale: baseScale)
            let image = document.render(time: time)
            let stillLoading = document.isLoading
            let animating = document.isAnimating
            DispatchQueue.main.async {
                guard let self else { return }
                self.rendering = false
                guard expected == self.generation else { return }
                self.animating = animating
                // Idempotent: the canvas only starts a loop when none is running, and a
                // frame that was already animating may have become playable (moved, resized).
                if animating { self.onAnimating?() }
                if let image {
                    self.renders += 1
                    #if DEBUG
                    if StressDriver.enabled || UserDefaults.standard.string(forKey: "holdCamera") != nil {
                        canvasLog.info("render \(self.name, privacy: .public) scale \(String(format: "%.2f", self.currentScale), privacy: .public) -> \(image.width)x\(image.height) loading=\(stillLoading)")
                        if self.name == UserDefaults.standard.string(forKey: "dumpFrame"), let data = UIImage(cgImage: image).pngData() {
                            let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("render-\(self.renders)-\(image.width)x\(image.height).png")
                            try? data.write(to: url)
                        }
                    }
                    #endif
                    CATransaction.begin(); CATransaction.setDisableActions(true)
                    self.layer.contents = image
                    CATransaction.commit()
                }
                // The tile over this bitmap was painted from an older document state
                // (fonts, images, layout, animation pose): repaint it, or drop it when
                // the camera no longer needs one.
                if self.tileRegion != nil { self.tileDirty = true }
                self.refreshTile()
                // Fonts and images arrive after the first paint; the wake callback
                // repaints, and this covers resources that landed mid-paint.
                if stillLoading || self.dirty { self.scheduleRender() }
            }
        }
    }

    /// Hit-test the frame at a CSS point. The result comes with the hash of the
    /// HTML the engine held when the test was queued; the queue is serial, so any
    /// HTML that arrives later is applied after the test. Callers drop a result
    /// whose hash no longer matches the frame.
    func pickElement(at point: CGPoint, completion: @escaping (BlitzDocument.ElementInfo?, Int) -> Void) {
        guard let document else {
            ensureDocument()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in self?.pickElement(at: point, completion: completion) }
            return
        }
        let htmlHash = html.hashValue
        BlitzDocument.queue.async {
            let info = document.element(at: point).flatMap { document.info(for: $0) }
            DispatchQueue.main.async { completion(info, htmlHash) }
        }
    }

    /// Keep bitmaps within the side and pixel budgets.
    private func clamp(_ scale: CGFloat) -> CGFloat {
        let size = rect.size
        let sideCap = Self.maxSide / max(size.width, size.height, 1)
        let areaCap = sqrt(Self.pixelBudget / max(size.width * size.height, 1))
        return max(0.05, min(scale, 3, sideCap, areaCap))
    }
}

/// A collaborator's cursor: a dot and a name tag in screen space.
/// A collaborator's cursor, drawn like the web app's: an arrow with a white
/// edge and a name pill hanging off its tip, with a brand mark for agents.
/// Lives in the screen-space chrome layer, so it never scales with the canvas.
private final class CursorLayer {
    let layer = CALayer()
    private let arrow = CAShapeLayer()
    private let pill = CAShapeLayer()
    private let icon = CAShapeLayer()
    private let tag = CATextLayer()
    private var lastPoint: CGPoint?
    private static let font = UIFont.systemFont(ofSize: 11, weight: .bold)
    private static let pillHeight: CGFloat = 20
    private static let iconSize: CGFloat = 9

    init() {
        // Same arrow as the web (an 18×20 viewBox): tip at the origin.
        let path = UIBezierPath()
        path.move(to: CGPoint(x: 1, y: 1))
        path.addLine(to: CGPoint(x: 16, y: 8.5))
        path.addLine(to: CGPoint(x: 9, y: 10.5))
        path.addLine(to: CGPoint(x: 6.5, y: 18))
        path.close()
        arrow.path = path.cgPath
        arrow.strokeColor = UIColor.white.cgColor
        arrow.lineWidth = 1.4
        arrow.lineJoin = .round
        arrow.shadowColor = UIColor.black.cgColor
        arrow.shadowOpacity = 0.18
        arrow.shadowRadius = 1.5
        arrow.shadowOffset = CGSize(width: 0, height: 1)
        tag.font = Self.font
        tag.fontSize = Self.font.pointSize
        tag.contentsScale = UIScreen.main.scale
        tag.foregroundColor = UIColor.white.cgColor
        tag.truncationMode = .end
        icon.fillColor = UIColor.white.cgColor
        layer.addSublayer(arrow)
        layer.addSublayer(pill)
        pill.addSublayer(icon)
        pill.addSublayer(tag)
    }

    func update(name: String, color: String, kind: String) {
        let fill = UIColor(hex: color) ?? .systemBlue
        arrow.fillColor = fill.cgColor
        pill.fillColor = fill.cgColor
        let mark = kind == "agent" ? AgentMark.path(for: name) : nil
        let textWidth = ceil((name as NSString).size(withAttributes: [.font: Self.font]).width)
        let iconWidth: CGFloat = mark == nil ? 0 : Self.iconSize + 3
        let width = 8 + iconWidth + textWidth + 8
        // Pill: fully round except the corner under the arrow tip, like the web's 999/4 radii.
        pill.path = Self.pillPath(width: width, height: Self.pillHeight, tipRadius: 4)
        pill.frame = CGRect(x: 14, y: 16, width: width, height: Self.pillHeight)
        if let mark {
            icon.path = mark
            icon.isHidden = false
            let bounds = mark.boundingBoxOfPath
            let s = Self.iconSize / max(bounds.width, bounds.height)
            icon.setAffineTransform(CGAffineTransform(translationX: 8 + (Self.iconSize - bounds.width * s) / 2 - bounds.minX * s,
                                                      y: (Self.pillHeight - bounds.height * s) / 2 - bounds.minY * s).scaledBy(x: s, y: s))
        } else {
            icon.isHidden = true
        }
        tag.string = name
        tag.frame = CGRect(x: 8 + iconWidth, y: (Self.pillHeight - 14) / 2, width: textWidth + 2, height: 14)
    }

    /// Move to a screen point. A new cursor position glides over 60 ms as on the
    /// web; a camera move keeps the cursor pinned to its canvas point instantly.
    func move(to screen: CGPoint, world: CGPoint) {
        let moved = lastPoint.map { $0 != world } ?? false
        lastPoint = world
        CATransaction.begin()
        if moved {
            CATransaction.setAnimationDuration(0.06)
            CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(name: .linear))
        } else {
            CATransaction.setDisableActions(true)
        }
        layer.position = screen
        CATransaction.commit()
    }

    private static func pillPath(width: CGFloat, height: CGFloat, tipRadius: CGFloat) -> CGPath {
        let r = height / 2
        let path = UIBezierPath()
        path.move(to: CGPoint(x: tipRadius, y: 0))
        path.addLine(to: CGPoint(x: width - r, y: 0))
        path.addArc(withCenter: CGPoint(x: width - r, y: r), radius: r, startAngle: -.pi / 2, endAngle: .pi / 2, clockwise: true)
        path.addLine(to: CGPoint(x: r, y: height))
        path.addArc(withCenter: CGPoint(x: r, y: r), radius: r, startAngle: .pi / 2, endAngle: .pi, clockwise: true)
        path.addLine(to: CGPoint(x: 0, y: tipRadius))
        path.addArc(withCenter: CGPoint(x: tipRadius, y: tipRadius), radius: tipRadius, startAngle: .pi, endAngle: 3 * .pi / 2, clockwise: true)
        path.close()
        return path.cgPath
    }
}

private extension UIColor {
    convenience init?(hex: String) {
        var value = hex.trimmingCharacters(in: .whitespaces)
        if value.hasPrefix("#") { value.removeFirst() }
        guard value.count == 6, let rgb = UInt32(value, radix: 16) else { return nil }
        self.init(red: CGFloat((rgb >> 16) & 0xff) / 255, green: CGFloat((rgb >> 8) & 0xff) / 255, blue: CGFloat(rgb & 0xff) / 255, alpha: 1)
    }
}
