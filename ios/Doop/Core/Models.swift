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

public struct AgentModelOption: Decodable, Identifiable {
    public let id: String
    public let name: String
    public let blurb: String?
}

/// Uses the same server-owned menu and account preference as desktop.
public struct AgentModelAccount: Decodable {
    public let connected: Bool
    public let kind: String?
    public let model: String?
    public let menus: [String: [AgentModelOption]]?

    public var options: [AgentModelOption] {
        guard connected, let kind else { return [] }
        return menus?[kind] ?? []
    }
    public var label: String {
        guard connected else { return "Auto" }
        return options.first { $0.id == model }?.name ?? model ?? "Auto"
    }
}

/// References are included as text because the cards API supports a single edit
/// scope, not structured person mentions. They never notify collaborators.
public struct PromptContextReference: Identifiable, Equatable {
    public enum Kind: String, CaseIterable {
        case person, frame
        public var sectionTitle: String {
            switch self {
            case .person: return "People"
            case .frame: return "Frames"
            }
        }
    }
    public let kind: Kind
    public let sourceID: String
    public let name: String
    public var id: String { "\(kind.rawValue):\(sourceID)" }
    public var symbol: String {
        switch kind {
        case .person: return "person.crop.circle"
        case .frame: return "rectangle"
        }
    }

    public init(kind: Kind, sourceID: String, name: String) {
        self.kind = kind; self.sourceID = sourceID; self.name = name
    }

    public static func people(currentUser: DoopUser?, presences: [CanvasPresence]) -> [Self] {
        var people: [Self] = []
        if let user = currentUser {
            people.append(Self(kind: .person, sourceID: user.id, name: user.name))
        }
        var seen = Set(people.map(\.sourceID))
        for person in presences where person.kind == "user" {
            // Older servers expose only connection IDs. Keep those distinct
            // rather than guessing identity from a potentially shared name.
            let id = person.userId ?? "client:\(person.clientId)"
            if seen.insert(id).inserted {
                people.append(Self(kind: .person, sourceID: id, name: person.name))
            }
        }
        return people
    }

    /// The multiline text field completes the trailing @ query; email addresses
    /// and @ characters in the middle of words do not open the picker.
    private static func mentionRange(in text: String) -> Range<String.Index>? {
        guard let at = text.lastIndex(of: "@"),
              at == text.startIndex || text[text.index(before: at)].isWhitespace else { return nil }
        let suffix = text[text.index(after: at)...]
        guard !suffix.contains(where: { $0.isNewline }) else { return nil }
        return at..<text.endIndex
    }

    public static func mentionQuery(in text: String) -> String? {
        guard let range = mentionRange(in: text) else { return nil }
        return String(text[text.index(after: range.lowerBound)...])
    }

    public static func removingMentionQuery(from text: String) -> String {
        guard let range = mentionRange(in: text) else { return text }
        return String(text[..<range.lowerBound])
    }

    public static func taskTitle(_ prompt: String, references: [Self]) -> String {
        guard !references.isEmpty else { return prompt }
        // JSON quoting keeps names containing quotes or line breaks unambiguous.
        func quoted(_ value: String) -> String {
            String(decoding: try! JSONEncoder().encode(value), as: UTF8.self)
        }
        let lines = references.map {
            "- \($0.kind.rawValue): \(quoted($0.name)) (id: \(quoted($0.sourceID)))"
        }
        return prompt + "\n\nReferenced canvas context:\n" + lines.joined(separator: "\n")
    }
}

public enum SpecialistAgent: String, CaseIterable, Identifiable, Hashable {
    case ux
    case copy
    case brand
    case a11y
    case polish

    public var id: String { rawValue }

    public var name: String {
        switch self {
        case .ux: return "UX Lead"
        case .copy: return "Copywriter"
        case .brand: return "Brand Compliance"
        case .a11y: return "Accessibility"
        case .polish: return "Visual Polish"
        }
    }

    public var symbol: String {
        switch self {
        case .ux: return "square.grid.2x2"
        case .copy: return "text.quote"
        case .brand: return "paintpalette"
        case .a11y: return "accessibility"
        case .polish: return "sparkles"
        }
    }
}

/// Assignment is local to the composer. Auto omits `agents` so the server
/// keeps its existing default pipeline; a specialist sends one role id.
public enum AgentAssignment: Hashable {
    case automatic
    case specialist(SpecialistAgent)

    public var label: String {
        switch self {
        case .automatic: return "Auto"
        case .specialist(let agent): return agent.name
        }
    }

    public var symbol: String {
        switch self {
        case .automatic: return "sparkles"
        case .specialist(let agent): return agent.symbol
        }
    }

    public var agentIDs: [String]? {
        guard case .specialist(let agent) = self else { return nil }
        return [agent.id]
    }
}

/// The exact request body accepted by `POST /api/canvases/:id/cards`.
public struct CardQueueRequest {
    public var title: String
    public var scope: CardScope?
    public var assignment: AgentAssignment

    public init(title: String, scope: CardScope?, assignment: AgentAssignment = .automatic) {
        self.title = title
        self.scope = scope
        self.assignment = assignment
    }

    public var body: [String: Any] {
        var body: [String: Any] = ["title": title]
        if let scope { body["scope"] = scope.body }
        if let agentIDs = assignment.agentIDs { body["agents"] = agentIDs }
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
    public var userId: String? = nil
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
