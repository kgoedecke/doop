import CoreGraphics
import DoopCore

enum FrameSnappingChecks {
    static func run() {
        let neighbour = CGRect(x: 500, y: 800, width: 260, height: 210)
        // Every leading edge, center and trailing edge can align to each of the
        // neighbour's three anchors, independently on each axis.
        for own in [CGFloat(0), 50, 100] {
            for target in [CGFloat(500), 630, 760] {
                let raw = CGRect(x: target - own + 6, y: 0, width: 100, height: 80)
                let result = FrameSnapping.move(raw, among: [neighbour], zoom: 1)
                expect(result.rect.minX + own == target, "horizontal anchor alignment")
                expect(result.rect.minY == raw.minY && result.rect.size == raw.size, "only the matching axis moves")
                expect(result.guides.count == 1 && result.guides[0].axis == .vertical, "vertical guide")
                expect(result.guides[0].at == target, "guide is on the aligned anchor")
            }
        }
        for own in [CGFloat(0), 40, 80] {
            for target in [CGFloat(800), 905, 1010] {
                let raw = CGRect(x: 0, y: target - own - 6, width: 100, height: 80)
                let result = FrameSnapping.move(raw, among: [neighbour], zoom: 1)
                expect(result.rect.minY + own == target, "vertical anchor alignment")
                expect(result.rect.minX == raw.minX && result.rect.size == raw.size, "only the matching axis moves")
                expect(result.guides.count == 1 && result.guides[0].axis == .horizontal, "horizontal guide")
            }
        }

        for zoom in [CGFloat(0.25), 1, 4] {
            let other = CGRect(x: 1000, y: 2000, width: 600, height: 600)
            let boundary = CGRect(x: 1000 + 8 / zoom, y: 0, width: 400, height: 400)
            let hit = FrameSnapping.move(boundary, among: [other], zoom: zoom)
            expect(hit.rect.minX == 1000 && hit.guides.count == 1, "eight screen points snaps at every zoom")
            let beyond = boundary.offsetBy(dx: 0.01, dy: 0)
            let miss = FrameSnapping.move(beyond, among: [other], zoom: zoom)
            expect(miss.rect == beyond && miss.guides.isEmpty, "moving past the threshold releases the snap")
        }

        let raw = CGRect(x: 96, y: 96, width: 100, height: 80)
        let fractional = CGRect(x: 502.4, y: 0, width: 100, height: 80)
        let outside = FrameSnapping.move(fractional, among: [neighbour], zoom: 4)
        expect(outside.rect == fractional && outside.guides.isEmpty, "9.6 screen points must not round into the snap threshold")
        let both = FrameSnapping.move(raw, among: [
            CGRect(x: 100, y: 300, width: 200, height: 160),
            CGRect(x: 500, y: 100, width: 200, height: 160)
        ], zoom: 1)
        expect(both.rect.origin == CGPoint(x: 100, y: 100), "axes can align to different neighbours")
        expect(both.guides.count == 2, "both alignment guides are visible")
        expect(both.guides[0].at == 100 && both.guides[0].from == 100 && both.guides[0].to == 460,
               "vertical guide spans both frames using the snapped y")
        expect(both.guides[1].at == 100 && both.guides[1].from == 100 && both.guides[1].to == 700,
               "horizontal guide spans both frames using the snapped x")

        let moving = CGRect(x: 100, y: 0, width: 40, height: 40)
        let left = CGRect(x: 92, y: 800, width: 200, height: 160)
        let right = CGRect(x: 108, y: 1000, width: 200, height: 160)
        expect(FrameSnapping.move(moving, among: [left, right], zoom: 1).rect.minX == 92, "ties keep canvas order")
        expect(FrameSnapping.move(moving, among: [right, left], zoom: 1).rect.minX == 108, "ties keep reversed canvas order")
        let closer = CGRect(x: 103, y: 1200, width: 200, height: 160)
        expect(FrameSnapping.move(moving, among: [left, closer], zoom: 1).rect.minX == 103, "nearest anchor wins")

        let negative = FrameSnapping.move(CGRect(x: -504, y: -804, width: 100, height: 80), among: [
            CGRect(x: -500, y: -800, width: 200, height: 160)
        ], zoom: 1)
        expect(negative.rect.origin == CGPoint(x: -500, y: -800), "negative canvas coordinates")
        let empty = FrameSnapping.move(raw, among: [], zoom: 1)
        expect(empty.rect == raw && empty.guides.isEmpty, "no neighbours leaves a free drag")
        let exact = FrameSnapping.move(neighbour, among: [neighbour], zoom: 1)
        expect(exact.rect == neighbour && exact.guides.count == 2, "exact alignment still shows guides")
        for zoom in [CGFloat(0), -1, .infinity, .nan] {
            let result = FrameSnapping.move(raw, among: [neighbour], zoom: zoom)
            expect(result.rect == raw && result.guides.isEmpty, "invalid zoom does not corrupt geometry")
        }
        print("Frame snapping checks passed.")
    }

    private static func expect(_ condition: Bool, _ message: String) { precondition(condition, message) }
}
