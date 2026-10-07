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
}

public struct CanvasTask: Codable, Identifiable, Hashable {
    public var id: String
    public var agentName: String
    public var status: String
    public var startedAt: Double
    public var endedAt: Double?
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
