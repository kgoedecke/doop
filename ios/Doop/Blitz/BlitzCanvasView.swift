import SwiftUI
import UIKit
import UIKit.UIGestureRecognizerSubclass

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
    private let snapGuideLayer = CAShapeLayer()
    /// A hairline on every design-px boundary once zoomed in close, as on the web.
    private let pixelGrid = CAShapeLayer()
    private var snapGuides: [SnapGuide] = []
    private var frames: [String: FrameLayer] = [:]
    private var labels: [String: CATextLayer] = [:]
    private var cursors: [String: CursorLayer] = [:]
    private var workBadges: [String: FrameWorkBadge] = [:]
    private var commentPins: [String: CommentPin] = [:]
    /// The pin of a comment being written, at the spot that was long-pressed.
    private let draftPin = CommentPin()
    /// Where element comments' elements sit in each frame (frame-relative design
    /// px), for the HTML they were found in; nil marks an element not found.
    private var elementOrigins: [String: (html: Int, origins: [String: CGPoint?])] = [:]
    private var locating = Set<String>()
    private var zoom: CGFloat = 1
    private var offset = CGPoint(x: 40, y: 80)
    private var fitted = false
    private var displayedPageID: String?
    private var fitCommand = 0
    private var drag: (id: String, origin: CGPoint, proposedOrigin: CGPoint)?
    private var pinchAnchor = CGPoint.zero
    /// Fingers in the pinch at the last update; the centroid jumps when one lifts.
    private var pinchTouches = 0
    /// Double-tap-and-drag: the world point held still, the zoom at touch-down,
    /// where the finger landed, and whether it has moved far enough to be a zoom.
    private var oneFingerZoom: (anchor: CGPoint, zoom: CGFloat, start: CGPoint)?
    /// A camera move animating to its target (double tap, two-finger tap, fit).
    private var cameraAnimation: CameraAnimation?
    private var cameraLink: CADisplayLink?
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
    /// 1600%, the web canvas's deepest zoom (`MAX_ZOOM`).
    static let maxZoom: CGFloat = 16
    /// The pixel grid fades in from 300% and is fully shown from 500% (`pixelGridOpacity` on the web).
    private static let pixelGridFrom: CGFloat = 3
    private static let pixelGridFull: CGFloat = 5
    /// Points a double-tap-and-drag travels to double (or halve) the zoom.
    private static let oneFingerZoomPoints: CGFloat = 200

    init(model: CanvasModel) {
        self.model = model
        super.init(frame: .zero)
        backgroundColor = UIColor(named: "CanvasPaper") ?? .systemGroupedBackground
        // World and chrome are transformed CALayers: without a native mask
        // they draw over the navigation/status bars even outside this view.
        clipsToBounds = true
        isMultipleTouchEnabled = true
        world.anchorPoint = .zero
        layer.addSublayer(world)
        pixelGrid.fillColor = nil
        pixelGrid.strokeColor = UIColor(white: 0.5, alpha: 0.16).cgColor
        pixelGrid.lineWidth = 1 / UIScreen.main.scale
        pixelGrid.isHidden = true
        layer.addSublayer(pixelGrid)
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
        snapGuideLayer.fillColor = nil
        snapGuideLayer.strokeColor = UIColor.tintColor.cgColor
        snapGuideLayer.lineWidth = 1
        chrome.addSublayer(snapGuideLayer)

        let pan = UIPanGestureRecognizer(target: self, action: #selector(panned))
        pan.maximumNumberOfTouches = 1
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(pinched))
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped))
        // As in Maps: a second tap that lifts zooms in, one that drags zooms
        // with one finger (down zooms in).
        let doubleTapDrag = DoubleTapDragGesture(target: self, action: #selector(doubleTapDragged))
        tap.require(toFail: doubleTapDrag)
        pan.require(toFail: doubleTapDrag)
        // Two fingers tapping zooms out, as in Maps.
        let twoFingerTap = UITapGestureRecognizer(target: self, action: #selector(twoFingerTapped))
        twoFingerTap.numberOfTouchesRequired = 2
        // Press and hold to comment on that spot, as the web's Comment tool does.
        let longPress = UILongPressGestureRecognizer(target: self, action: #selector(longPressed))
        longPress.minimumPressDuration = 0.45
        // A second press held still is the start of a Maps zoom, not a comment.
        longPress.require(toFail: doubleTapDrag)
        draftPin.layer.isHidden = true
        draftPin.update(author: "+", replies: 0)
        chrome.insertSublayer(draftPin.layer, below: selectionOutline)
        for gesture in [pan, pinch, tap, doubleTapDrag, twoFingerTap, longPress] {
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
        drag = nil
        snapGuides = []
        snapGuideLayer.path = nil
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
        if !fitted, !model.pageFrames.isEmpty {
            fit(model.pageFrames)
            rerenderVisible()
        }
        applyTransform()
    }

    func gestureRecognizer(_ a: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith b: UIGestureRecognizer) -> Bool {
        a is UIPinchGestureRecognizer || b is UIPinchGestureRecognizer
    }

    override func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
        // A held frame title is about to be dragged and a held pin is a thread: neither starts a comment.
        if gesture is UILongPressGestureRecognizer {
            let point = gesture.location(in: self)
            if label(at: point) != nil || commentPin(at: point) != nil { return false }
        }
        // The finger of a double-tap-and-drag zooms; it never also pans.
        if gesture is UIPanGestureRecognizer, oneFingerZoom != nil { return false }
        // A finger landing stops a camera animation where it is, as in Maps.
        if gesture is UIPanGestureRecognizer || gesture is UIPinchGestureRecognizer || gesture is DoubleTapDragGesture {
            stopCameraAnimation()
        }
        return super.gestureRecognizerShouldBegin(gesture)
    }

    // MARK: - Model sync

    /// Reconcile layers with the model. Called by SwiftUI on every change.
    func sync() {
        let current = model.pageFrames
        if displayedPageID != model.activePageID {
            displayedPageID = model.activePageID
            // A page change can arrive while dragging or while a render is queued.
            // End the old interaction before fitting or hit-testing the new page.
            drag = nil
            snapGuides = []
            gestureActive = false
            for recognizer in gestureRecognizers ?? [] {
                recognizer.isEnabled = false
                recognizer.isEnabled = true
            }
            relayout?.cancel()
            pendingWakes.removeAll()
            locating.removeAll()
            elementOrigins.removeAll()
            // A draft or open thread belongs to the page it was made on.
            if model.commentDraft != nil || model.focusedCommentID != nil {
                DispatchQueue.main.async { [model] in model.commentDraft = nil; model.focusedCommentID = nil }
            }
            fitted = false
            zoom = 1
            offset = CGPoint(x: 40, y: 80)
            applyTransform()
        }
        let ids = Set(current.map(\.id))
        for (id, frame) in frames where !ids.contains(id) {
            frame.cancel()
            frame.layer.removeFromSuperlayer()
            labels[id]?.removeFromSuperlayer()
            labels[id] = nil
            workBadges[id]?.remove()
            workBadges[id] = nil
            locating = locating.filter { !$0.hasPrefix(id + ":") }
            elementOrigins[id] = nil
            frames[id] = nil
        }
        // Fit before creating layers so the first bitmaps are requested at the
        // fitted density, not at 1:1 for every frame on the board.
        if (!fitted || frames.isEmpty), !current.isEmpty, bounds.width > 0 { fitOrLand(current) }
        var added = false
        for frame in current {
            if let existing = frames[frame.id] {
                existing.update(frame, preservingOrigin: drag?.id == frame.id)
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
        snapDraggedFrame()
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
                    // -pickElement "x,y": select the held frame and pick the element at
                    // frame-local CSS px (x, y), exactly as a tap inside the frame would.
                    if let held, let pick = UserDefaults.standard.string(forKey: "pickElement") {
                        let p = pick.split(separator: ",").compactMap { Double($0) }
                        guard p.count == 2 else { return }
                        self.model.select(held.id)
                        held.pickElement(at: CGPoint(x: p[0], y: p[1])) { [weak self] info, htmlHash in
                            guard let self, htmlHash == held.htmlHash else { return }
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
            fitOrLand(current)
            scheduleRelayout()
        }
        for frame in frames.values { frame.selected = frame.id == model.selectedID }
        syncCursors()
        syncWorkBadges()
        syncCommentPins()
        flyToRequestedComment()
        flyToRequestedFrame()
        drawChrome()
    }

    /// Open threads on this page, as the web shows them: one pin per root comment.
    private var pinnedThreads: [CanvasComment] {
        model.pageComments.filter { $0.parentId == nil && $0.resolvedAt == nil }
    }

    /// Bring a thread picked in the list into view, above the card that shows it.
    private func flyToRequestedComment() {
        guard let id = model.flyToCommentID else { return }
        DispatchQueue.main.async { [weak self] in self?.model.flyToCommentID = nil }
        guard let comment = model.comments.first(where: { $0.id == id }), let world = pinPoint(comment) else { return }
        let target = CGPoint(x: bounds.midX, y: bounds.height * 0.35)
        let newZoom = max(zoom, 0.5)
        animateCamera(zoom: newZoom, offset: CGPoint(x: target.x - world.x * newZoom, y: target.y - world.y * newZoom), pivot: target)
    }

    private func syncCommentPins() {
        let roots = pinnedThreads
        let ids = Set(roots.map(\.id))
        for (id, pin) in commentPins where !ids.contains(id) {
            pin.layer.removeFromSuperlayer()
            commentPins[id] = nil
        }
        let replies = Dictionary(grouping: model.pageComments.compactMap(\.parentId), by: { $0 }).mapValues(\.count)
        for root in roots {
            let pin = commentPins[root.id] ?? {
                let pin = CommentPin()
                // Under the selection outlines and cursors, over the frames' titles.
                chrome.insertSublayer(pin.layer, below: selectionOutline)
                commentPins[root.id] = pin
                return pin
            }()
            pin.update(author: root.from, replies: replies[root.id] ?? 0, color: commentAuthorColor(root.from))
        }
        locateCommentedElements(roots)
    }

    /// Ask each frame where its commented elements are, once per version of its HTML.
    private func locateCommentedElements(_ roots: [CanvasComment]) {
        let viewArea = toWorldRect(bounds.insetBy(dx: -bounds.width / 2, dy: -bounds.height / 2))
        let byFrame = Dictionary(grouping: roots.filter { $0.elementId != nil && $0.frameId != nil }, by: { $0.frameId! })
        for (frameID, comments) in byFrame {
            // Off-screen frames wait: their pins are hidden by the viewport anyway, and
            // a document is built for a frame only once it is drawn.
            guard let frame = frames[frameID], frame.hasDocument, frame.rect.intersects(viewArea) else { continue }
            let hash = frame.htmlHash
            let wanted = Set(comments.compactMap(\.elementId))
            let known = elementOrigins[frameID]
            if let known, known.html == hash, wanted.isSubset(of: known.origins.keys) { continue }
            let key = "\(frameID):\(hash):\(wanted.sorted().joined(separator: ","))"
            guard !locating.contains(key) else { continue }
            locating.insert(key)
            frame.locateElements(Array(wanted)) { [weak self] origins, htmlHash in
                guard let self else { return }
                self.locating.remove(key)
                guard htmlHash == self.frames[frameID]?.htmlHash else { return }
                self.elementOrigins[frameID] = (htmlHash, origins)
                self.drawChrome()
            }
        }
    }

    /// Where a thread's pin sits in the world, or nil when its anchor is gone.
    private func pinPoint(_ comment: CanvasComment) -> CGPoint? {
        guard let frameID = comment.frameId else {
            guard let x = comment.x, let y = comment.y else { return nil }
            return CGPoint(x: x, y: y)
        }
        guard let frame = frames[frameID] else { return nil }
        let local: CGPoint
        if let elementID = comment.elementId {
            // As the web's `elementCommentPosition`: the point tapped while the element
            // has not moved, else its top-left; a missing element hides the pin.
            let located = elementOrigins[frameID].flatMap { $0.html == frame.htmlHash ? $0.origins[elementID] : nil }
            if let found = located {
                guard let origin = found else { return nil }
                if let x = comment.x, let y = comment.y, let then = comment.elementOrigin,
                   abs(origin.x - then.x) < 0.5, abs(origin.y - then.y) < 0.5 {
                    local = CGPoint(x: x, y: y)
                } else {
                    local = origin
                }
            } else if let x = comment.x, let y = comment.y {
                local = CGPoint(x: x, y: y) // until the frame answers
            } else { return nil }
        } else {
            guard let x = comment.x, let y = comment.y else { return nil }
            local = CGPoint(x: x, y: y)
        }
        return CGPoint(x: frame.rect.minX + local.x, y: frame.rect.minY + local.y)
    }

    private func commentPin(at screenPoint: CGPoint) -> String? {
        pinnedThreads.reversed().first { commentPins[$0.id].map { !$0.layer.isHidden && $0.hitFrame.contains(screenPoint) } ?? false }?.id
    }

    /// One badge per frame on this page with an agent at work on it.
    private func syncWorkBadges() {
        // New chips appear where they belong, not faded or slid in by implicit actions.
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        let workers = model.frameWorkers.filter { frames[$0.key] != nil && !$0.value.isEmpty }
        for (id, badge) in workBadges where workers[id] == nil {
            badge.remove()
            workBadges[id] = nil
        }
        for (id, list) in workers {
            let badge = workBadges[id] ?? {
                let badge = FrameWorkBadge()
                // Under the selection outline and cursors, over the titles.
                chrome.insertSublayer(badge.ring, below: selectionOutline)
                chrome.insertSublayer(badge.chips, below: selectionOutline)
                workBadges[id] = badge
                return badge
            }()
            badge.update(list)
        }
    }

    private func syncCursors() {
        let people = model.pagePresences.filter { $0.cursor != nil }
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
        drawPixelGrid()
        drawChrome()
        CATransaction.commit()
    }

    /// One hairline per design px across the view, faded in with the zoom the way
    /// the web canvas does it, each line resting on a device pixel so it stays crisp.
    private func drawPixelGrid() {
        let opacity = max(0, min(1, (zoom - Self.pixelGridFrom) / (Self.pixelGridFull - Self.pixelGridFrom)))
        pixelGrid.isHidden = opacity == 0
        guard opacity > 0 else { pixelGrid.path = nil; return }
        pixelGrid.frame = bounds
        pixelGrid.opacity = Float(opacity)
        let s = UIScreen.main.scale
        func line(_ v: CGFloat) -> CGFloat { ((v * s).rounded(.down) + 0.5) / s }
        let path = CGMutablePath()
        let world = toWorldRect(bounds)
        var x = world.minX.rounded(.down)
        while x <= world.maxX {
            let sx = line(x * zoom + offset.x)
            path.move(to: CGPoint(x: sx, y: 0))
            path.addLine(to: CGPoint(x: sx, y: bounds.height))
            x += 1
        }
        var y = world.minY.rounded(.down)
        while y <= world.maxY {
            let sy = line(y * zoom + offset.y)
            path.move(to: CGPoint(x: 0, y: sy))
            path.addLine(to: CGPoint(x: bounds.width, y: sy))
            y += 1
        }
        pixelGrid.path = path
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
        let viewport = unobscuredViewport
        let available = viewport.size
        zoom = max(Self.minZoom, min(1, available.width / CGFloat(maxX - minX), available.height / CGFloat(maxY - minY)))
        offset = CGPoint(x: viewport.midX - CGFloat(maxX + minX) * zoom / 2,
                         y: viewport.midY - CGFloat(maxY + minY) * zoom / 2)
        restOnPixels()
        applyTransform()
    }

    /// Rest the camera offset on whole device pixels; with each frame layer snapped
    /// at the same density, bitmaps are never resampled by a fraction of a pixel.
    private func restOnPixels() {
        let s = UIScreen.main.scale
        offset = CGPoint(x: (offset.x * s).rounded() / s, y: (offset.y * s).rounded() / s)
    }

    /// Keep fitted designs clear of the right rail and bottom prompt, with room
    /// at the top for a title and an agent chip row stacked above it.
    private var unobscuredViewport: CGRect {
        let top = 24 + FrameWorkBadge.rowHeight
        return CGRect(x: 24, y: top, width: max(1, bounds.width - 100),
                      height: max(1, bounds.height - safeAreaInsets.bottom - model.composerHeight - 76 - top))
    }

    /// After a zoom change settles, re-render visible frames at the new density.
    private func scheduleRelayout() {
        relayout?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.restOnPixels()
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
        // Frames that came into view (or got their document) can now place their pins.
        locateCommentedElements(pinnedThreads)
    }

    private func toWorldRect(_ rect: CGRect) -> CGRect {
        let origin = toWorld(rect.origin)
        return CGRect(x: origin.x, y: origin.y, width: rect.width / zoom, height: rect.height / zoom)
    }

    // MARK: - Chrome (labels, selection, guides, cursors) in screen space

    private func drawChrome() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for (id, label) in labels {
            guard let frame = frames[id] else { continue }
            let origin = toScreen(frame.rect.origin)
            let width = frame.rect.width * zoom
            // Agents at work take the right end of the title row.
            let screenRect = CGRect(origin: origin, size: CGSize(width: width, height: frame.rect.height * zoom))
            let chipsWidth = workBadges[id]?.layout(around: screenRect, titleRow: 20, minTitle: 44) ?? 0
            // Like Figma, titles disappear when a frame is too small to read.
            label.isHidden = width - chipsWidth < 44
            guard !label.isHidden else { continue }
            let selected = id == model.selectedID
            label.string = frame.name
            label.foregroundColor = (selected ? UIColor.tintColor : UIColor.secondaryLabel).cgColor
            label.frame = CGRect(x: origin.x, y: origin.y - 20, width: width - chipsWidth, height: 16)
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
        let guidePath = UIBezierPath()
        for guide in snapGuides {
            let start = guide.axis == .vertical ? CGPoint(x: guide.at, y: guide.from) : CGPoint(x: guide.from, y: guide.at)
            let end = guide.axis == .vertical ? CGPoint(x: guide.at, y: guide.to) : CGPoint(x: guide.to, y: guide.at)
            guidePath.move(to: toScreen(start))
            guidePath.addLine(to: toScreen(end))
        }
        snapGuideLayer.path = snapGuides.isEmpty ? nil : guidePath.cgPath
        if let draft = model.commentDraft {
            draftPin.layer.isHidden = false
            draftPin.place(at: toScreen(draft.world))
        } else {
            draftPin.layer.isHidden = true
        }
        for root in pinnedThreads {
            guard let pin = commentPins[root.id] else { continue }
            if let point = pinPoint(root) {
                pin.layer.isHidden = false
                pin.place(at: toScreen(point))
            } else {
                pin.layer.isHidden = true
            }
        }
        for person in model.pagePresences {
            guard let cursor = cursors[person.clientId], let point = person.cursor else { continue }
            let world = CGPoint(x: point.x, y: point.y)
            cursor.move(to: toScreen(world), world: world)
        }
        CATransaction.commit()
    }

    // MARK: - Gestures

    private func snapDraggedFrame() {
        guard let drag, let frame = frames[drag.id] else { snapGuides = []; return }
        // Use the unsnapped finger position on every update so an existing snap
        // never accumulates into the next movement. Model order breaks ties.
        let others = model.pageFrames.compactMap { $0.id == drag.id ? nil : frames[$0.id]?.rect }
        let raw = CGRect(origin: drag.proposedOrigin, size: frame.rect.size)
        let snapped = FrameSnapping.move(raw, among: others, zoom: zoom)
        frame.move(to: snapped.rect.origin)
        snapGuides = snapped.guides
    }

    private func frame(at screenPoint: CGPoint) -> FrameLayer? {
        let point = toWorld(screenPoint)
        // Topmost frame wins: later frames are drawn above earlier ones.
        return model.pageFrames.reversed().lazy.compactMap { self.frames[$0.id] }.first { $0.rect.contains(point) }
    }

    private func label(at screenPoint: CGPoint) -> String? {
        labels.first { !$0.value.isHidden && $0.value.frame.insetBy(dx: 0, dy: -6).contains(screenPoint) }?.key
    }

    @objc private func longPressed(_ gesture: UILongPressGestureRecognizer) {
        guard gesture.state == .began else { return }
        let point = gesture.location(in: self)
        model.focusedCommentID = nil
        let world = toWorld(point)
        window?.endEditing(true)
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        guard let frame = frame(at: point) else {
            model.commentDraft = CommentDraft(target: .canvas(pageID: model.activePageID, point: world), world: world, label: "Canvas")
            revealDraft(at: point)
            return
        }
        revealDraft(at: point)
        let id = frame.id
        let name = frame.name
        let inFrame = CGPoint(x: world.x - frame.rect.minX, y: world.y - frame.rect.minY)
        // Shown at once on the frame; narrowed to the element once the hit test answers.
        let draft = CommentDraft(target: .frame(frameID: id, point: inFrame), world: world, label: name)
        model.commentDraft = draft
        frame.pickElement(at: inFrame) { [weak self] info, htmlHash in
            guard let self, self.model.commentDraft == draft, htmlHash == frame.htmlHash,
                  let info, let rect = info.frameRect, !["html", "body"].contains(info.tag.lowercased()) else { return }
            self.model.commentDraft = CommentDraft(
                target: .element(frameID: id, selector: info.selector, snippet: String(info.text.prefix(400)), point: inFrame, origin: rect.origin),
                world: world, label: "\(name) · \(info.label)")
        }
    }

    /// Slide a draft pin pressed low on the screen up, so the composer and keyboard leave it in view.
    private func revealDraft(at point: CGPoint) {
        let target = bounds.height * 0.32
        guard point.y > target else { return }
        animateCamera(zoom: zoom, offset: CGPoint(x: offset.x, y: offset.y - (point.y - target)), pivot: point)
    }

    @objc private func tapped(_ gesture: UITapGestureRecognizer) {
        let point = gesture.location(in: self)
        // The prompt is a SwiftUI sibling, not a child of this UIView.
        // End editing in the window without adding a competing tap gesture.
        window?.endEditing(true)
        if let thread = commentPin(at: point) {
            model.commentDraft = nil
            model.focusedCommentID = thread
            return
        }
        model.focusedCommentID = nil
        model.selectedElement = nil
        if let frame = frame(at: point) {
            let id = frame.id
            model.select(id)
            drawChrome()
            let local = toWorld(point)
            let inFrame = CGPoint(x: local.x - frame.rect.minX, y: local.y - frame.rect.minY)
            frame.pickElement(at: inFrame) { [weak self] info, htmlHash in
                // The HTML moved on while the hit test ran: this result describes an element
                // that may no longer exist, so it is not selected.
                guard let self, self.model.selectedID == id, let info, let rect = info.frameRect,
                      htmlHash == frame.htmlHash else { return }
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

    @objc private func doubleTapDragged(_ gesture: DoubleTapDragGesture) {
        let point = gesture.location(in: self)
        switch gesture.state {
        case .began:
            window?.endEditing(true)
            gestureActive = true
            #if DEBUG
            monitor.begin("one-finger zoom")
            #endif
            let start = gesture.start
            oneFingerZoom = (toWorld(start), zoom, start)
        case .changed:
            guard let held = oneFingerZoom else { return }
            // Exponential, so equal travel is an equal ratio whatever the zoom.
            let dy = point.y - held.start.y
            zoom = max(Self.minZoom, min(Self.maxZoom, held.zoom * pow(2, dy / Self.oneFingerZoomPoints)))
            // The world point under the second tap stays where the finger landed.
            offset = CGPoint(x: held.start.x - held.anchor.x * zoom, y: held.start.y - held.anchor.y * zoom)
            applyTransform()
        case .ended where gesture.wasTap:
            doubleTapped(at: gesture.start)
        case .ended, .cancelled, .failed:
            guard oneFingerZoom != nil else { return }
            oneFingerZoom = nil
            gestureActive = false
            #if DEBUG
            monitor.end()
            #endif
            scheduleRelayout()
        default: break
        }
    }

    @objc private func twoFingerTapped(_ gesture: UITapGestureRecognizer) {
        zoomCamera(by: 0.5, at: gesture.location(in: self))
    }

    /// As in Maps: a double tap zooms in 2x about the finger. On a frame's title
    /// it fits that frame instead, a way back to the whole design.
    private func doubleTapped(at point: CGPoint) {
        window?.endEditing(true)
        if let id = label(at: point), frames[id] != nil {
            glide(toFrame: id)
            return
        }
        zoomCamera(by: 2, at: point)
    }

    /// The camera that fills the open part of the screen with a frame and a little margin.
    private func camera(fitting rect: CGRect) -> (zoom: CGFloat, offset: CGPoint) {
        let padded = rect.insetBy(dx: -rect.width * 0.05, dy: -rect.height * 0.05)
        let viewport = unobscuredViewport
        let fitZoom = max(Self.minZoom, min(Self.maxZoom, min(viewport.width / padded.width, viewport.height / padded.height)))
        return (fitZoom, CGPoint(x: viewport.midX - padded.midX * fitZoom, y: viewport.midY - padded.midY * fitZoom))
    }

    /// Select a frame and glide until it fills the open part of the screen.
    private func glide(toFrame id: String) {
        guard let frame = frames[id] else { return }
        let target = camera(fitting: frame.rect)
        model.select(id)
        let viewport = unobscuredViewport
        animateCamera(zoom: target.zoom, offset: target.offset, pivot: CGPoint(x: viewport.midX, y: viewport.midY))
    }

    /// A page shown fresh: land on the frame an agent's pill asked for, else fit the page.
    /// Landing directly avoids a fit of the whole page followed by a glide to the frame.
    private func fitOrLand(_ current: [DesignFrame]) {
        guard let id = model.flyToFrameID, let frame = current.first(where: { $0.id == id }), bounds.width > 0 else {
            fit(current)
            return
        }
        fitted = true
        (zoom, offset) = camera(fitting: CGRect(x: frame.x, y: frame.y, width: frame.width, height: frame.height))
        restOnPixels()
        applyTransform()
        DispatchQueue.main.async { [weak self] in
            if self?.model.flyToFrameID == id { self?.model.flyToFrameID = nil }
        }
    }

    /// Go to a frame asked for from outside the canvas (an agent's pill). A frame that is
    /// gone, or not on the page shown, drops the request rather than taking the camera later.
    private func flyToRequestedFrame() {
        guard let id = model.flyToFrameID, bounds.width > 0 else { return }
        let onPage = model.pageFrames.contains { $0.id == id }
        guard onPage else {
            DispatchQueue.main.async { [weak self] in
                if self?.model.flyToFrameID == id { self?.model.flyToFrameID = nil }
            }
            return
        }
        guard frames[id] != nil else { return } // its layer arrives in this sync
        DispatchQueue.main.async { [weak self] in
            guard let self, self.model.flyToFrameID == id else { return }
            self.model.flyToFrameID = nil
            self.glide(toFrame: id)
        }
    }

    /// Zoom by `factor` keeping the world point under `point` still, animated.
    private func zoomCamera(by factor: CGFloat, at point: CGPoint) {
        let base: (zoom: CGFloat, offset: CGPoint) = cameraAnimation?.to ?? (zoom, offset)
        let anchor = CGPoint(x: (point.x - base.offset.x) / base.zoom, y: (point.y - base.offset.y) / base.zoom)
        let target = max(Self.minZoom, min(Self.maxZoom, base.zoom * factor))
        guard abs(target - base.zoom) > 0.0001 else { return }
        animateCamera(zoom: target, offset: CGPoint(x: point.x - anchor.x * target, y: point.y - anchor.y * target), pivot: point)
    }

    // MARK: - Camera animation

    private struct CameraAnimation {
        let from: (zoom: CGFloat, offset: CGPoint)
        let to: (zoom: CGFloat, offset: CGPoint)
        /// The screen point whose world point moves in a straight line (the finger, or the viewport's centre).
        let pivot: CGPoint
        let start: CFTimeInterval
        static let duration: CFTimeInterval = 0.3
    }

    /// Glide to a camera: zoom moves geometrically and the world point under `pivot`
    /// linearly, so a zoom about the finger keeps that point under it all the way.
    private func animateCamera(zoom newZoom: CGFloat, offset newOffset: CGPoint, pivot: CGPoint) {
        stopCameraAnimation()
        cameraAnimation = CameraAnimation(from: (zoom, offset), to: (newZoom, newOffset), pivot: pivot, start: CACurrentMediaTime())
        gestureActive = true
        let link = CADisplayLink(target: self, selector: #selector(cameraTick))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
        link.add(to: .main, forMode: .common)
        cameraLink = link
    }

    @objc private func cameraTick(_ link: CADisplayLink) {
        guard let animation = cameraAnimation else { stopCameraAnimation(); return }
        let t = min(1, (CACurrentMediaTime() - animation.start) / CameraAnimation.duration)
        let eased = 1 - pow(1 - t, 3)
        let p = animation.pivot
        let w0 = CGPoint(x: (p.x - animation.from.offset.x) / animation.from.zoom, y: (p.y - animation.from.offset.y) / animation.from.zoom)
        let w1 = CGPoint(x: (p.x - animation.to.offset.x) / animation.to.zoom, y: (p.y - animation.to.offset.y) / animation.to.zoom)
        zoom = animation.from.zoom * pow(animation.to.zoom / animation.from.zoom, eased)
        let w = CGPoint(x: w0.x + (w1.x - w0.x) * eased, y: w0.y + (w1.y - w0.y) * eased)
        offset = CGPoint(x: p.x - w.x * zoom, y: p.y - w.y * zoom)
        applyTransform()
        if t >= 1 { stopCameraAnimation() }
    }

    /// Stop where the camera is now, and render it at its new density.
    private func stopCameraAnimation() {
        guard cameraLink != nil else { return }
        cameraLink?.invalidate()
        cameraLink = nil
        cameraAnimation = nil
        gestureActive = false
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
            if model.canEdit, let id = label(at: CGPoint(x: start.x - translation.x, y: start.y - translation.y)), let frame = frames[id] {
                drag = (id, frame.rect.origin, frame.rect.origin)
                model.select(id)
            } else {
                drag = nil
            }
            snapGuides = []
        case .changed:
            if let drag {
                self.drag?.proposedOrigin = CGPoint(x: drag.origin.x + translation.x / zoom,
                                                   y: drag.origin.y + translation.y / zoom)
                snapDraggedFrame()
                drawChrome()
            } else {
                offset.x += translation.x
                offset.y += translation.y
                gesture.setTranslation(.zero, in: self)
                applyTransform()
            }
        case .ended, .cancelled, .failed:
            gestureActive = false
            #if DEBUG
            monitor.end()
            #endif
            if let drag, let frame = frames[drag.id] {
                let target = frame.rect.origin
                if gesture.state == .ended, hypot(translation.x, translation.y) > 3 {
                    Task { await model.moveFrame(drag.id, x: target.x, y: target.y) }
                } else {
                    frame.move(to: drag.origin)
                }
            } else {
                scheduleRelayout()
            }
            self.drag = nil
            snapGuides = []
            drawChrome()
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
            pinchTouches = gesture.numberOfTouches
        case .changed:
            // The centroid moves to the remaining finger when one lifts (or to the
            // midpoint when one lands): anchor the world point now under it so the
            // view holds still instead of jumping to the new centre.
            if gesture.numberOfTouches != pinchTouches {
                pinchTouches = gesture.numberOfTouches
                pinchAnchor = toWorld(center)
            }
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
    private(set) var html: String {
        didSet { htmlHash = html.hashValue }
    }
    /// The hash of `html`, worked out once per change: pins compare it on every camera move.
    private(set) var htmlHash: Int
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
    /// Tiles cover about a screen, so density can go well past the base cap: up to
    /// screen density at the canvas's deepest zoom, so a tile is never stretched.
    private static let maxTileDensity: CGFloat = CanvasView.maxZoom * UIScreen.main.scale
    /// Playback repaints only the on-screen part of the frame. Steps are self-paced
    /// by the paint. The budget is one screen of device pixels plus the step's 10%
    /// margin, so a frame playing on screen paints at screen density (the static
    /// tile's density): a lower playback density rounded the layout to a coarser grid
    /// and blurred it, and alternating the two made the frame jump by a pixel or two.
    private static let animationInterval: Double = 1.0 / 60
    private static let playbackPixels: CGFloat = {
        let screen = UIScreen.main.nativeBounds
        return screen.width * screen.height * 1.25
    }()
    /// When this frame last painted a playback step; a static tile stays out of its way.
    private var lastPlaybackAt: CFTimeInterval = 0
    private var playing: Bool { animating && CACurrentMediaTime() - lastPlaybackAt < 0.5 }
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
        htmlHash = frame.html.hashValue
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
    func update(_ frame: DesignFrame, preservingOrigin: Bool = false) {
        let newRect = CGRect(x: preservingOrigin ? rect.minX : frame.x,
                             y: preservingOrigin ? rect.minY : frame.y, width: frame.width, height: frame.height)
        name = frame.name
        if newRect != rect {
            let resized = newRect.size != rect.size
            rect = newRect
            placeLayer()
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
        placeLayer()
    }

    /// Screen pixels per CSS pixel at the last settled camera; 0 before the first.
    private var pixelDensity: CGFloat = 0

    /// Put the layer at `rect`, its origin snapped to the device-pixel grid at the
    /// settled camera's density. The camera offset rests on whole device pixels too,
    /// so the bitmap's pixels (and a tile's, painted at that density) land one on one
    /// on screen pixels; otherwise the linear filter blurs every glyph by up to half a pixel.
    /// The size is snapped too, to the whole pixels the engine rounds the bitmap to
    /// (a 401 px frame at density 1.5 is a 602 px bitmap), so it is not squeezed into
    /// 601.5 screen pixels; the frame's own geometry stays `rect`.
    private func placeLayer() {
        var frame = rect
        if pixelDensity > 0 {
            let snap = { (v: CGFloat) in (v * self.pixelDensity).rounded() / self.pixelDensity }
            frame = CGRect(x: snap(rect.minX), y: snap(rect.minY),
                           width: max(1, (rect.width * pixelDensity).rounded()) / pixelDensity,
                           height: max(1, (rect.height * pixelDensity).rounded()) / pixelDensity)
        }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        layer.frame = frame
        CATransaction.commit()
    }

    /// Choose the bitmap density for the current camera and start a render
    /// if it changed. Also decides whether the engine document stays alive.
    func setLOD(_ lod: CGFloat, visible: Bool, screenWidth: CGFloat, viewportInFrame: CGRect? = nil) {
        targetScale = visible ? clamp(lod) : min(currentScale == 0 ? Self.parkedScale : currentScale, Self.parkedScale)
        lastView = visible ? viewportInFrame : nil
        lastLOD = lod
        pixelDensity = lod
        placeLayer()
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
        lastPlaybackAt = CACurrentMediaTime()
        let area = viewportInFrame.width * viewportInFrame.height * 1.21 * lod * lod
        let density = max(0.25, min(lod, Self.maxTileDensity, lod * (Self.playbackPixels / max(1, area)).squareRoot()))
        requestTile(region: tileRegion(around: viewportInFrame, margin: 0.1, density: density), density: density, time: time, force: true)
    }

    // MARK: Tiles

    /// Deep zoom: the base bitmap cannot reach screen density, so paint just the
    /// part on screen as a tile over it, at (close to) screen density.
    private func refreshTile() {
        // A playing frame's tile belongs to the playback loop: a static tile painted
        // between its steps, at another density and an older pose, made it jump.
        guard !playing else { return }
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
                // Only a playback step (painted at the current time) can tell that the
                // animation ran out; a static tile is painted at an older pose.
                if force, self.animating, !stillAnimating {
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
        let htmlHash = self.htmlHash
        BlitzDocument.queue.async {
            let info = document.pickableElement(at: point).flatMap { document.info(for: $0) }
            DispatchQueue.main.async { completion(info, htmlHash) }
        }
    }

    /// The top-left of each element carrying one of these `data-doop-id`s, in the
    /// frame's design px (nil for one not in the document), with the HTML hash read.
    /// Asked only of a frame that has its document: locating never builds one.
    func locateElements(_ ids: [String], completion: @escaping ([String: CGPoint?], Int) -> Void) {
        guard let document else { return }
        let htmlHash = self.htmlHash
        BlitzDocument.queue.async {
            var origins: [String: CGPoint?] = [:]
            for id in ids {
                let escaped = id.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
                let rect = document.element(matching: "[data-doop-id=\"\(escaped)\"]").flatMap { document.info(for: $0)?.frameRect }
                origins[id] = rect?.origin
            }
            DispatchQueue.main.async { completion(origins, htmlHash) }
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

extension UIColor {
    convenience init?(hex: String) {
        var value = hex.trimmingCharacters(in: .whitespaces)
        if value.hasPrefix("#") { value.removeFirst() }
        guard value.count == 6, let rgb = UInt32(value, radix: 16) else { return nil }
        self.init(red: CGFloat((rgb >> 16) & 0xff) / 255, green: CGFloat((rgb >> 8) & 0xff) / 255, blue: CGFloat(rgb & 0xff) / 255, alpha: 1)
    }
}

/// Maps' double tap: two quick taps in one place. A second tap that lifts ends
/// the gesture as a tap (`wasTap`); one that drags makes it a continuous gesture
/// whose `start` is where the second finger landed. Any other touch fails it at
/// once, so pans and single taps are never held up longer than a double tap's wait.
final class DoubleTapDragGesture: UIGestureRecognizer {
    private enum Phase { case idle, firstDown, waiting, secondDown }
    private var phase = Phase.idle
    private var firstAt = CGPoint.zero
    private var downTime: TimeInterval = 0
    private var timer: DispatchWorkItem?
    private(set) var start = CGPoint.zero
    private(set) var wasTap = false
    private static let maxGap: TimeInterval = 0.3
    private static let maxPress: TimeInterval = 0.35
    private static let slop: CGFloat = 10
    private static let maxDistance: CGFloat = 44

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        guard touches.count == 1, (event.touches(for: self)?.count ?? 1) == 1, let touch = touches.first else {
            fail(); return
        }
        let point = touch.location(in: view)
        switch phase {
        case .idle:
            phase = .firstDown
            firstAt = point
            downTime = touch.timestamp
        case .waiting where hypot(point.x - firstAt.x, point.y - firstAt.y) <= Self.maxDistance:
            timer?.cancel()
            phase = .secondDown
            start = point
            downTime = touch.timestamp
        default:
            fail()
        }
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let touch = touches.first else { return }
        let point = touch.location(in: view)
        switch phase {
        case .firstDown:
            if hypot(point.x - firstAt.x, point.y - firstAt.y) > Self.slop { fail() }
        case .secondDown:
            if state == .possible, hypot(point.x - start.x, point.y - start.y) > Self.slop {
                state = .began
            } else if state == .began || state == .changed {
                state = .changed
            }
        default: break
        }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let touch = touches.first else { return }
        switch phase {
        case .firstDown:
            guard touch.timestamp - downTime <= Self.maxPress else { fail(); return }
            phase = .waiting
            let work = DispatchWorkItem { [weak self] in self?.fail() }
            timer = work
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.maxGap, execute: work)
        case .secondDown:
            if state == .possible {
                wasTap = touch.timestamp - downTime <= Self.maxPress
                state = wasTap ? .ended : .failed
            } else {
                state = .ended
            }
        default:
            fail()
        }
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        state = state == .possible ? .failed : .cancelled
    }

    private func fail() {
        timer?.cancel()
        if state == .possible { state = .failed }
    }

    override func reset() {
        super.reset()
        timer?.cancel()
        timer = nil
        phase = .idle
        wasTap = false
    }
}

/// A comment thread's pin, drawn like the web's: a disc with the author's
/// initials whose bottom-left corner is the point commented on, and a count
/// of replies. Screen space, so it keeps its size at every zoom.
private final class CommentPin {
    let layer = CALayer()
    private let bubble = CAShapeLayer()
    private let initials = CATextLayer()
    private let badge = CAShapeLayer()
    private let count = CATextLayer()
    private static let size: CGFloat = 28
    private static let font = UIFont.systemFont(ofSize: 11, weight: .semibold)
    private static let badgeFont = UIFont.systemFont(ofSize: 9, weight: .bold)

    /// Tap target: the bubble plus a margin, since a pin is small under a finger.
    var hitFrame: CGRect { layer.frame.insetBy(dx: -8, dy: -8) }

    init() {
        layer.anchorPoint = CGPoint(x: 0, y: 1)
        layer.bounds = CGRect(x: 0, y: 0, width: Self.size, height: Self.size)
        let s = Self.size
        // Rounded everywhere but the bottom-left, which points at the spot.
        let path = UIBezierPath()
        path.move(to: CGPoint(x: 0, y: s))
        path.addLine(to: CGPoint(x: 0, y: s / 2))
        path.addArc(withCenter: CGPoint(x: s / 2, y: s / 2), radius: s / 2, startAngle: .pi, endAngle: .pi / 2, clockwise: true)
        path.close()
        bubble.path = path.cgPath
        bubble.fillColor = UIColor.tintColor.cgColor
        bubble.strokeColor = UIColor.white.cgColor
        bubble.lineWidth = 2
        bubble.shadowColor = UIColor.black.cgColor
        bubble.shadowOpacity = 0.2
        bubble.shadowRadius = 3
        bubble.shadowOffset = CGSize(width: 0, height: 1)
        for text in [initials, count] {
            text.contentsScale = UIScreen.main.scale
            text.alignmentMode = .center
        }
        initials.font = Self.font
        initials.fontSize = Self.font.pointSize
        initials.foregroundColor = UIColor.white.cgColor
        initials.frame = CGRect(x: 0, y: (s - 14) / 2, width: s, height: 14)
        badge.fillColor = UIColor.label.cgColor
        badge.strokeColor = UIColor.white.cgColor
        badge.lineWidth = 1.5
        count.font = Self.badgeFont
        count.fontSize = Self.badgeFont.pointSize
        count.foregroundColor = UIColor.systemBackground.cgColor
        layer.addSublayer(bubble)
        layer.addSublayer(initials)
        layer.addSublayer(badge)
        badge.addSublayer(count)
    }

    func update(author: String, replies: Int, color: UIColor = .tintColor) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        bubble.fillColor = color.cgColor
        initials.string = commentInitials(author)
        badge.isHidden = replies == 0
        if replies > 0 {
            // Every message in the thread, as the web's pin counts it.
            let total = replies + 1
            let label = total > 99 ? "99+" : "\(total)"
            let width = max(16, (label as NSString).size(withAttributes: [.font: Self.badgeFont]).width + 8)
            badge.frame = CGRect(x: Self.size - width + 6, y: -6, width: width, height: 16)
            badge.path = UIBezierPath(roundedRect: badge.bounds, cornerRadius: 8).cgPath
            count.string = label
            count.frame = CGRect(x: 0, y: 2, width: width, height: 12)
        }
        CATransaction.commit()
    }

    func place(at point: CGPoint) {
        let s = UIScreen.main.scale
        layer.position = CGPoint(x: (point.x * s).rounded() / s, y: (point.y * s).rounded() / s)
    }
}

/// A person's colour by name, as the web's `colorFor` (shared/types.ts) picks it from `CURSOR_PALETTE`.
func commentAuthorColor(_ name: String) -> UIColor {
    let palette: [UInt32] = [0x2743EE, 0x0E9F6E, 0x8B5CF6, 0xD0341F, 0xC77800, 0xD62A7E, 0x0E8A8A, 0x8E2E5C]
    var h: UInt32 = 0
    for unit in name.utf16 { h = h &* 31 &+ UInt32(unit) }
    let rgb = palette[Int(h % UInt32(palette.count))]
    return UIColor(red: CGFloat((rgb >> 16) & 0xff) / 255, green: CGFloat((rgb >> 8) & 0xff) / 255, blue: CGFloat(rgb & 0xff) / 255, alpha: 1)
}
