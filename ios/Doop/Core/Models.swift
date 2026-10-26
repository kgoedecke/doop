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
    public var pages: [CanvasPage]?

    /// Older canvases and frames belong to the first page, matching shared/pages.ts.
    public var effectivePages: [CanvasPage] {
        if let pages, !pages.isEmpty { return pages }
        return [CanvasPage(id: "\(id):page1", name: "Page 1")]
    }

    public func pageID(for frame: DesignFrame) -> String { frame.pageId ?? effectivePages[0].id }
}

public struct CanvasPage: Codable, Identifiable {
    public var id: String
    public var name: String
}

public struct DesignFrame: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var canvasId: String
    public var name: String
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double
    public var html: String
    public var pageId: String?
    public var hidden: Bool?
    public var locked: Bool?
}

/// What a prompt is about: the frame the person had selected when they asked, and
/// the element inside it when one was picked. The agent edits that in place.
/// Mirrors `CardScope` in `shared/types.ts`.
public struct CardScope: Codable, Equatable {
    public var frameId: String
    /// Element selector inside the frame; absent means the whole frame.
    public var selector: String?

    public init(frameId: String, selector: String? = nil) {
        self.frameId = frameId
        self.selector = selector
    }

    /// The `scope` field of a `POST /api/canvases/:id/cards` body.
    public var body: [String: Any] {
        var body: [String: Any] = ["frameId": frameId]
        if let selector { body["selector"] = selector }
        return body
    }
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
    /// Canvas-pinned comments (and their replies) have no frame ID.
    public var frameId: String?
    public var pageId: String?
    public var x: Double?
    public var y: Double?
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
    public var viewport: CanvasViewport?
    public var id: String { clientId }
}

public struct CanvasViewport: Codable {
    public var pageId: String?
    public var x: Double
    public var y: Double
    public var zoom: Double
    public var width: Double
    public var height: Double
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
    public var pages: [CanvasPage]?
    public var task: CanvasTask?
    public var tasks: [CanvasTask]?
    public var comment: CanvasComment?
    public var comments: [CanvasComment]?
    public var presences: [CanvasPresence]?
    public var presence: CanvasPresence?
    public var viewport: CanvasViewport?
    public var clientId: String?
    public var x: Double?
    public var y: Double?
    public var width: Double?
    public var height: Double?
}

public struct WorkspaceList: Decodable {
    public var workspaces: [WorkspaceSummary]
}
