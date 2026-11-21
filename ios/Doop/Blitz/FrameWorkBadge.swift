import UIKit

/// Shows agents at work on a frame, as the web's frame does: a chip per agent in
/// the title row ("Claude is designing…" while it streams, its name while it has
/// the frame open) and a ring around the frame in the agent's colour, dashed and
/// pulsing during a stream, solid otherwise. Lives in the screen-space chrome
/// layer, so its sizes stay the same at every zoom.
@MainActor
final class FrameWorkBadge {
    let ring = CAShapeLayer()
    let chips = CALayer()
    private(set) var workers: [FrameWorker] = []
    /// How much a chip says, from most to least: what the agent is doing, its
    /// name, its mark. The widest that fits the frame's on-screen width wins.
    enum Detail: CaseIterable { case full, name, mark }
    private var detail = Detail.full
    private var chipsWidth: CGFloat = 0
    /// The chips' width at each detail, to pick the one that fits.
    private var widths: [Detail: CGFloat] = [:]

    static let chipHeight: CGFloat = 18
    /// What a chip row stacked above a frame's title adds above the frame.
    static let rowHeight = chipHeight + 3
    private static let font = UIFont.systemFont(ofSize: 10, weight: .bold)
    private static let iconSize: CGFloat = 9
    private static let pulseKey = "stream-pulse"

    init() {
        ring.fillColor = nil
        ring.lineWidth = 2
        ring.lineJoin = .miter
    }

    func remove() {
        ring.removeFromSuperlayer()
        chips.removeFromSuperlayer()
    }

    func update(_ workers: [FrameWorker]) {
        guard workers != self.workers else { return }
        self.workers = workers
        let gaps = CGFloat(max(workers.count - 1, 0)) * 4
        for detail in Detail.allCases {
            widths[detail] = workers.map { Self.chip(for: $0, detail: detail).frame.width }.reduce(0, +) + gaps
        }
        rebuildChips()
        guard let lead = workers.first else { return }
        ring.strokeColor = (UIColor(hex: lead.color) ?? .tintColor).cgColor
        if lead.streaming {
            ring.lineDashPattern = [6, 4]
            if ring.animation(forKey: Self.pulseKey) == nil {
                // The web's `stream-pulse`: full, then 35%, then full, every 1.1 s.
                let pulse = CABasicAnimation(keyPath: "opacity")
                pulse.fromValue = 1
                pulse.toValue = 0.35
                pulse.duration = 0.55
                pulse.autoreverses = true
                pulse.repeatCount = .infinity
                pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                ring.add(pulse, forKey: Self.pulseKey)
            }
        } else {
            ring.lineDashPattern = nil
            ring.removeAnimation(forKey: Self.pulseKey)
        }
    }

    /// Places the ring around `rect` (the frame on screen) and the chips over its
    /// top-right corner: beside the title when both fit, else on a row of their
    /// own above it, so a phone-sized frame still names its agent. Chips wider
    /// than the frame say less (`Detail`). Returns the room
    /// the chips take from the title row (0 when they sit above it).
    @discardableResult
    func layout(around rect: CGRect, titleRow: CGFloat, minTitle: CGFloat) -> CGFloat {
        let fitting = Detail.allCases.first { (widths[$0] ?? 0) <= rect.width } ?? .mark
        if fitting != detail {
            detail = fitting
            rebuildChips()
        }
        // A stream's dashed ring stands just outside the frame, the web's 3px;
        // an open frame's solid ring straddles its edge like the selection.
        let streaming = workers.first?.streaming == true
        ring.path = UIBezierPath(rect: rect.insetBy(dx: streaming ? -3 : -1, dy: streaming ? -3 : -1)).cgPath
        let beside = rect.width - chipsWidth - 6 >= minTitle
        let y = beside ? rect.minY - Self.chipHeight - 3 : rect.minY - titleRow - Self.rowHeight
        // Right-aligned; a frame narrower than its chips starts them at its left edge.
        let x = max(rect.minX, rect.maxX - chipsWidth)
        chips.frame = CGRect(x: x, y: y, width: chipsWidth, height: Self.chipHeight)
        return beside ? chipsWidth + 6 : 0
    }

    private func rebuildChips() {
        chips.sublayers?.forEach { $0.removeFromSuperlayer() }
        var x: CGFloat = 0
        for worker in workers {
            let chip = Self.chip(for: worker, detail: detail)
            chip.frame.origin = CGPoint(x: x, y: 0)
            chips.addSublayer(chip)
            x += chip.frame.width + 4
        }
        chipsWidth = max(0, x - 4)
    }

    private static func chip(for worker: FrameWorker, detail: Detail) -> CALayer {
        let color = UIColor(hex: worker.color) ?? .tintColor
        let compact = detail == .mark
        let said = detail == .full ? worker.title : worker.name
        let words = worker.streaming ? said + "…" : said
        let padding: CGFloat = compact ? 4.5 : 7
        let textWidth = compact ? 0 : ceil((words as NSString).size(withAttributes: [.font: font]).width)
        let width = padding + iconSize + (compact ? 0 : 4 + textWidth) + padding
        let chip = CALayer()
        chip.frame = CGRect(x: 0, y: 0, width: width, height: chipHeight)
        chip.backgroundColor = color.cgColor
        chip.cornerRadius = chipHeight / 2

        let mark = AgentMark.path(for: worker.name)
        let icon = CAShapeLayer()
        icon.path = mark
        icon.fillColor = UIColor.white.cgColor
        let bounds = mark.boundingBoxOfPath
        let scale = iconSize / max(bounds.width, bounds.height)
        icon.setAffineTransform(
            CGAffineTransform(translationX: padding + (iconSize - bounds.width * scale) / 2 - bounds.minX * scale,
                              y: (chipHeight - bounds.height * scale) / 2 - bounds.minY * scale)
                .scaledBy(x: scale, y: scale))
        chip.addSublayer(icon)

        if !compact {
            let text = CATextLayer()
            text.string = words
            text.font = font
            text.fontSize = font.pointSize
            text.foregroundColor = UIColor.white.cgColor
            text.contentsScale = UIScreen.main.scale
            text.frame = CGRect(x: padding + iconSize + 4, y: (chipHeight - 13) / 2, width: textWidth + 1, height: 13)
            chip.addSublayer(text)
        }
        chip.accessibilityLabel = worker.title
        return chip
    }
}
