import Foundation

public struct DoopUser: Codable, Equatable {
    public var id: String
    public var name: String
    public var email: String
}

public struct CanvasSummary: Codable, Identifiable, Hashable {
    public var id: String
    public var name: String
    public var ownerId: String?
    public var shared: Bool?
    public var workspaceId: String?
    public var updatedAt: Double
    public var frameCount: Int
    public var previewFrameId: String?
    public var activeTasks: [CanvasTask]?
}

public struct CanvasDocument: Codable, Identifiable {
    public var id: String
    public var name: String
    public var ownerId: String?
    public var frames: [DesignFrame]
}

public struct DesignFrame: Codable, Identifiable, Equatable {
    public var id: String
    public var canvasId: String
    public var name: String
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double
    public var html: String
    public var updatedAt: Double?
}

public struct CanvasTask: Codable, Identifiable, Hashable {
    public var id: String
    public var agentName: String
    public var owner: String?
    public var status: String
    public var startedAt: Double
    public var endedAt: Double?
    public var runStartedAt: Double?
    public var failedAt: Double?
    public var failureReason: String?
    public var queuedBy: String?
    public var pipeline: [String]?
    public var stage: Int?
}

public struct CanvasComment: Codable, Identifiable {
    public var id: String
    public var frameId: String
    public var from: String
    public var text: String
    public var at: Double
    public var resolvedAt: Double?
    public var parentId: String?
}

public struct CanvasPresence: Codable, Identifiable {
    public var clientId: String
    public var name: String
    public var color: String
    public var kind: String
    public var cursor: CanvasPoint?
    public var id: String { clientId }
}

public struct CanvasPoint: Codable {
    public var x: Double
    public var y: Double
}

public struct WorkspaceSummary: Codable, Identifiable {
    public var id: String
    public var name: String
    public var active: Bool
}

/// Unknown protocol fields remain forward-compatible with newer servers.
public struct CanvasEvent: Decodable {
    public var type: String
    public var canvas: CanvasDocument?
    public var frame: DesignFrame?
    public var frameId: String?
    public var name: String?
    public var task: CanvasTask?
    public var tasks: [CanvasTask]?
    public var comment: CanvasComment?
    public var comments: [CanvasComment]?
    public var presences: [CanvasPresence]?
    public var presence: CanvasPresence?
    public var clientId: String?
    public var x: Double?
    public var y: Double?
    public var width: Double?
    public var height: Double?
}

public struct WorkspaceList: Decodable {
    public var workspaces: [WorkspaceSummary]
}

public struct FrameDrag: Decodable {
    public var frameId: String
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double
    public var updatedAt: Double

    public func applying(to frame: DesignFrame) -> DesignFrame? {
        guard frame.id == frameId, frame.updatedAt == updatedAt else { return nil }
        var preview = frame
        preview.x = x
        preview.y = y
        preview.width = width
        preview.height = height
        return preview
    }
}

/// Actor snapshots arrive directly; committed changes are wrapped by the runtime.
public struct FrameActorEvent: Decodable {
    public var type: String
    public var revision: Int?
    public var frame: DesignFrame?
    public var frameIds: [String]?
    public var deleted: Bool?
    public var drag: FrameDrag?

    private enum CodingKeys: String, CodingKey {
        case type, revision, frame, frameIds, deleted, changes, committed
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        type = try values.decode(String.self, forKey: .type)
        if type == "state_update" {
            let changes = try values.nestedContainer(keyedBy: CodingKeys.self, forKey: .changes)
            if let committed = try changes.decodeIfPresent(Self.self, forKey: .committed) { self = committed }
        } else if type == "drag" {
            drag = try FrameDrag(from: decoder)
        } else {
            revision = try values.decodeIfPresent(Int.self, forKey: .revision)
            frame = try values.decodeIfPresent(DesignFrame.self, forKey: .frame)
            frameIds = try values.decodeIfPresent([String].self, forKey: .frameIds)
            deleted = try values.decodeIfPresent(Bool.self, forKey: .deleted)
        }
    }
}
