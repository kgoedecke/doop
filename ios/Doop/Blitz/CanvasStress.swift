import Foundation
import QuartzCore
import UIKit
import os

#if DEBUG
/// Debug-only instrumentation for the native canvas.
///
/// `FrameTimeMonitor` samples the display link while a gesture (or the scripted
/// run) is active and logs per-phase frame statistics. `StressDriver` runs a
/// scripted camera over a loaded board when the app is launched with
/// `-stressTest 1`, printing a JSON summary the simulator console captures:
///
///   xcrun simctl launch --console booted design.doop.ios -serverOrigin https://localhost:18443 \
///     -testEmail … -testPassword … -openCanvas <id> -stressTest 1
let canvasLog = Logger(subsystem: "design.doop.ios", category: "canvas.perf")

struct PhaseStats: Encodable {
    var phase: String
    var frames: Int
    var seconds: Double
    var fps: Double
    var avgMs: Double
    var p95Ms: Double
    var maxMs: Double
    /// Frames that took longer than 25 ms (a dropped frame at 60 Hz, three at 120 Hz).
    var hitches: Int
    var residentMB: Double

    init(phase: String, intervals: [Double], residentMB: Double) {
        self.phase = phase
        frames = intervals.count
        seconds = intervals.reduce(0, +)
        fps = seconds > 0 ? Double(frames) / seconds : 0
        let sorted = intervals.sorted()
        avgMs = frames > 0 ? seconds / Double(frames) * 1000 : 0
        p95Ms = frames > 0 ? sorted[min(frames - 1, Int(Double(frames) * 0.95))] * 1000 : 0
        maxMs = (sorted.last ?? 0) * 1000
        hitches = intervals.filter { $0 > 0.025 }.count
        self.residentMB = residentMB
    }
}

@MainActor
final class FrameTimeMonitor {
    private var link: CADisplayLink?
    private var last: CFTimeInterval = 0
    private var intervals: [Double] = []
    private var phase: String?
    private(set) var results: [PhaseStats] = []

    func begin(_ name: String) {
        end()
        phase = name
        intervals = []
        last = 0
        link = CADisplayLink(target: self, selector: #selector(tick))
        link?.preferredFrameRateRange = CAFrameRateRange(minimum: 80, maximum: 120, preferred: 120)
        link?.add(to: .main, forMode: .common)
    }

    @discardableResult
    func end() -> PhaseStats? {
        guard let phase else { return nil }
        link?.invalidate()
        link = nil
        self.phase = nil
        let stats = PhaseStats(phase: phase, intervals: intervals, residentMB: residentMemoryMB())
        results.append(stats)
        canvasLog.info("\(phase, privacy: .public): \(stats.frames) frames, \(String(format: "%.1f", stats.fps), privacy: .public) fps, avg \(String(format: "%.2f", stats.avgMs), privacy: .public) ms, p95 \(String(format: "%.2f", stats.p95Ms), privacy: .public) ms, max \(String(format: "%.1f", stats.maxMs), privacy: .public) ms, hitches \(stats.hitches), rss \(String(format: "%.0f", stats.residentMB), privacy: .public) MB")
        return stats
    }

    @objc private func tick(_ link: CADisplayLink) {
        if last > 0 { intervals.append(link.timestamp - last) }
        last = link.timestamp
    }
}

func residentMemoryMB() -> Double {
    var info = mach_task_basic_info()
    var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<natural_t>.size)
    let result = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
            task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
        }
    }
    return result == KERN_SUCCESS ? Double(info.resident_size) / 1_048_576 : 0
}

/// Scripted camera: sweep the whole board at fit zoom, zoom into a frame,
/// pan around at 1:1, zoom back out. Each phase is measured separately.
@MainActor
final class StressDriver {
    private weak var canvas: CanvasView?
    private let monitor = FrameTimeMonitor()
    private var link: CADisplayLink?
    private var phaseStart: CFTimeInterval = 0
    private var steps: [(name: String, seconds: Double, update: (Double) -> Void)] = []
    private var step = 0
    private var lastSettle: CFTimeInterval = 0
    private let started = CACurrentMediaTime()
    private var firstPaint: Double?
    private var finished = false
    private var targetRect = CGRect.zero

    init(canvas: CanvasView) { self.canvas = canvas }

    static var enabled: Bool { UserDefaults.standard.bool(forKey: "stressTest") }

    /// Called by the canvas once frames exist; waits for every bitmap, then runs.
    func start() {
        guard link == nil, let canvas else { return }
        canvasLog.info("stress: waiting for first paint of \(canvas.frameCount) frames")
        link = CADisplayLink(target: self, selector: #selector(tick))
        link?.add(to: .main, forMode: .common)
    }

    private func plan() {
        guard let canvas else { return }
        let board = canvas.boardBounds
        let fit = canvas.camera
        let center = CGPoint(x: board.midX, y: board.midY)
        // A frame near the middle of the board to zoom into.
        let target = canvas.frameRects.min { hypot($0.midX - center.x, $0.midY - center.y) < hypot($1.midX - center.x, $1.midY - center.y) } ?? board
        let view = canvas.bounds.size
        func camera(zoom: CGFloat, centeredOn p: CGPoint) -> (CGFloat, CGPoint) {
            (zoom, CGPoint(x: view.width / 2 - p.x * zoom, y: view.height / 2 - p.y * zoom))
        }
        let sweepZoom = max(fit.zoom, 0.12)
        targetRect = target
        canvasLog.info("stress target: \(canvas.frameName(at: target) ?? "?", privacy: .public) at \(NSCoder.string(for: target), privacy: .public), fit zoom \(String(format: "%.3f", fit.zoom), privacy: .public)")
        steps = [
            ("sweep-fit", 5, { t in
                // Figure-eight across the board at a readable zoom.
                let p = CGPoint(x: board.midX + board.width * 0.45 * sin(t * 2 * .pi), y: board.midY + board.height * 0.35 * sin(t * 4 * .pi))
                let (z, o) = camera(zoom: sweepZoom, centeredOn: p)
                canvas.setCamera(zoom: z, offset: o)
            }),
            ("zoom-in", 2, { t in
                let e = t * t * (3 - 2 * t)
                let z = sweepZoom + (1 - sweepZoom) * e
                let p = CGPoint(x: target.midX, y: target.minY + target.height * 0.3)
                let (zz, o) = camera(zoom: z, centeredOn: p)
                canvas.setCamera(zoom: zz, offset: o)
            }),
            ("pan-1x", 4, { t in
                let p = CGPoint(x: target.midX + target.width * 0.3 * sin(t * 2 * .pi), y: target.minY + target.height * (0.3 + 0.4 * t))
                let (z, o) = camera(zoom: 1, centeredOn: p)
                canvas.setCamera(zoom: z, offset: o)
            }),
            ("pinch-2x", 3, { t in
                let z = 1 + sin(t * .pi) * 1.0
                let (zz, o) = camera(zoom: z, centeredOn: CGPoint(x: target.midX, y: target.midY))
                canvas.setCamera(zoom: zz, offset: o)
            }),
            ("zoom-out", 2, { t in
                let e = t * t * (3 - 2 * t)
                let z = 1 + (fit.zoom - 1) * e
                let p = CGPoint(x: target.midX + (center.x - target.midX) * e, y: target.midY + (center.y - target.midY) * e)
                let (zz, o) = camera(zoom: z, centeredOn: p)
                canvas.setCamera(zoom: zz, offset: o)
            }),
            ("idle-fit", 6, { _ in }),
        ]
    }

    @objc private func tick(_ link: CADisplayLink) {
        guard let canvas, !finished else { return }
        if firstPaint == nil {
            guard canvas.allFramesPainted else { return }
            firstPaint = CACurrentMediaTime() - started
            canvasLog.info("stress: all \(canvas.frameCount) frames painted after \(String(format: "%.2f", self.firstPaint ?? 0), privacy: .public) s, rss \(String(format: "%.0f", residentMemoryMB()), privacy: .public) MB")
            plan()
            phaseStart = link.timestamp
            monitor.begin(steps[0].name)
            return
        }
        let current = steps[step]
        let t = min(1, (link.timestamp - phaseStart) / current.seconds)
        let before = canvas.camera
        current.update(t)
        let moved = before.zoom != canvas.camera.zoom || before.offset != canvas.camera.offset
        // A finger lifts every half second or so: trigger the LOD re-render the way a gesture end does.
        if moved, link.timestamp - lastSettle > 0.5 { lastSettle = link.timestamp; canvas.settle() }
        if t >= 1 {
            canvasLog.info("end of \(current.name, privacy: .public): \(canvas.describe(self.targetRect), privacy: .public)")
            monitor.end()
            step += 1
            if step < steps.count {
                phaseStart = link.timestamp
                monitor.begin(steps[step].name)
            } else {
                finish()
            }
        }
    }

    private func finish() {
        finished = true
        link?.invalidate()
        link = nil
        guard let canvas else { return }
        struct Summary: Encodable {
            var frames: Int
            var firstPaintSeconds: Double
            var renders: Int
            var liveDocuments: Int
            var residentMB: Double
            var phases: [PhaseStats]
        }
        let summary = Summary(frames: canvas.frameCount, firstPaintSeconds: firstPaint ?? 0, renders: canvas.renderCount, liveDocuments: canvas.liveDocumentCount, residentMB: residentMemoryMB(), phases: monitor.results)
        if let data = try? JSONEncoder().encode(summary), let json = String(data: data, encoding: .utf8) {
            print("STRESS_RESULT \(json)")
            canvasLog.info("STRESS_RESULT \(json, privacy: .public)")
        }
    }
}
#endif
