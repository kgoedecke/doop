import Foundation

/// An agent streaming HTML into a frame (`frame:streaming` with `active: true`).
public struct FrameStream: Equatable {
    public var name: String
    public var color: String

    public init(name: String, color: String) {
        self.name = name
        self.color = color
    }
}

/// An agent shown at work on a frame: its name and colour, and whether it is
/// streaming a design into the frame right now or has the frame open.
public struct FrameWorker: Equatable {
    public var name: String
    public var color: String
    public var streaming: Bool

    public init(name: String, color: String, streaming: Bool) {
        self.name = name
        self.color = color
        self.streaming = streaming
    }

    /// The chip's words, as on the web: "Claude is designing" while it streams.
    public var title: String { streaming ? "\(name) is designing" : name }
}

public enum FrameWorkers {
    /// Who is at work on each frame, by frame id, the way the web's frame title
    /// shows it: the agent streaming into the frame first, then every other
    /// agent whose presence has the frame open (`editing`). People are left
    /// out; their selection is not work in progress.
    public static func byFrame(streams: [String: FrameStream], presences: [CanvasPresence]) -> [String: [FrameWorker]] {
        var result: [String: [FrameWorker]] = [:]
        for (frameID, stream) in streams {
            result[frameID] = [FrameWorker(name: stream.name, color: stream.color, streaming: true)]
        }
        for presence in presences where presence.kind == "agent" {
            guard let frameID = presence.activeFrameId else { continue }
            if result[frameID]?.contains(where: { $0.name == presence.name }) == true { continue }
            result[frameID, default: []].append(FrameWorker(name: presence.name, color: presence.color, streaming: false))
        }
        return result
    }
}
