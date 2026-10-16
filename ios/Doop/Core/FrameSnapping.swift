import CoreGraphics

/// Alignment guides in canvas coordinates, matching the web's `src/lib/snap.ts`.
public struct SnapGuide: Equatable {
    public enum Axis { case vertical, horizontal }
    public var axis: Axis
    public var at: CGFloat
    public var from: CGFloat
    public var to: CGFloat
}

public enum FrameSnapping {
    /// Snap a moving frame's edges and centers to its neighbours. The caller
    /// excludes the moving frame and keeps neighbours in canvas order for ties.
    public static func move(_ rect: CGRect, among others: [CGRect], zoom: CGFloat) -> (rect: CGRect, guides: [SnapGuide]) {
        guard zoom.isFinite, zoom > 0 else { return (rect, []) }
        let tolerance = 8 / zoom
        let x = closest(offsets: lines(0, rect.width), base: rect.minX, others: others, vertical: true, tolerance: tolerance)
        let y = closest(offsets: lines(0, rect.height), base: rect.minY, others: others, vertical: false, tolerance: tolerance)
        let snapped = rect.offsetBy(dx: x?.delta ?? 0, dy: y?.delta ?? 0)
        var guides: [SnapGuide] = []
        if let x {
            guides.append(SnapGuide(axis: .vertical, at: x.at,
                                    from: min(snapped.minY, x.other.minY), to: max(snapped.maxY, x.other.maxY)))
        }
        if let y {
            guides.append(SnapGuide(axis: .horizontal, at: y.at,
                                    from: min(snapped.minX, y.other.minX), to: max(snapped.maxX, y.other.maxX)))
        }
        return (snapped, guides)
    }

    private static func lines(_ position: CGFloat, _ size: CGFloat) -> [CGFloat] {
        [position, position + size / 2, position + size]
    }

    private static func closest(offsets: [CGFloat], base: CGFloat, others: [CGRect], vertical: Bool, tolerance: CGFloat) -> (delta: CGFloat, at: CGFloat, other: CGRect)? {
        var hit: (delta: CGFloat, at: CGFloat, other: CGRect)?
        for other in others {
            for at in lines(vertical ? other.minX : other.minY, vertical ? other.width : other.height) {
                for offset in offsets {
                    let delta = at - (base + offset)
                    if abs(delta) <= tolerance && (hit == nil || abs(delta) < abs(hit!.delta)) {
                        hit = (delta, at, other)
                    }
                }
            }
        }
        return hit
    }
}
