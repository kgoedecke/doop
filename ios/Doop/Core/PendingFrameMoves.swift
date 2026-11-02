import Foundation

/// Local drop positions take precedence over server geometry while saves are
/// pending. Other frame fields (HTML, name and size) continue to synchronize.
public struct PendingFrameMoves {
    private struct Move {
        var token: UUID
        var x: Double
        var y: Double
    }
    private var moves: [String: Move] = [:]

    public init() {}

    public mutating func begin(frameID: String, x: Double, y: Double) -> UUID {
        let token = UUID()
        moves[frameID] = Move(token: token, x: x, y: y)
        return token
    }

    /// An earlier response must not clear a newer drop's preview or apply its
    /// stale geometry. Returns true only for the latest save of this frame.
    public mutating func finish(frameID: String, token: UUID) -> Bool {
        guard moves[frameID]?.token == token else { return false }
        moves[frameID] = nil
        return true
    }

    @discardableResult
    public func apply(to frames: inout [DesignFrame]) -> Bool {
        var changed = false
        for index in frames.indices {
            guard let move = moves[frames[index].id],
                  frames[index].x != move.x || frames[index].y != move.y else { continue }
            frames[index].x = move.x
            frames[index].y = move.y
            changed = true
        }
        return changed
    }
}
