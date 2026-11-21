import Foundation

/// One pill at the top of the canvas: an agent and what it is working on, as the
/// web's `WorkingNow` shows it.
public struct WorkingAgent: Equatable, Identifiable {
    public var id: String
    public var name: String
    public var color: String
    public var status: String

    public init(id: String, name: String, color: String, status: String) {
        self.id = id
        self.name = name
        self.color = color
        self.status = status
    }
}

public enum WorkingAgents {
    /// How long a card nobody has claimed still reads as "Starting…". The server never
    /// closes an unclaimed card (no model connected, out of credits, waiting for an MCP
    /// agent), so an older one is a card left waiting, not work about to begin.
    public static let startingWindowMS: Double = 10 * 60 * 1000

    /// The built-in roles of `shared/agents.ts`, for a card waiting on one of them.
    private static let roles: [String: (name: String, color: String)] = [
        "doop": ("Doop", "#E8432E"),
        "ux": ("UX Lead", "#2743EE"),
        "copy": ("Copywriter", "#8B5CF6"),
        "brand": ("Brand Compliance", "#D98E04"),
        "a11y": ("Accessibility", "#0E8FA0"),
        "polish": ("Visual Polish", "#0E9F6E"),
    ]

    /// Who is working on the canvas right now, oldest first:
    /// every agent whose presence carries a status (set_status, the resident's
    /// task summaries), then each unfinished task whose agent has no such
    /// presence. A card queued in the last ten minutes that nobody has picked up
    /// yet becomes one "Starting…" pill, so a prompt sent from the phone shows at
    /// once, before the agent speaks.
    public static func list(presences: [CanvasPresence], tasks: [CanvasTask], now: Double) -> [WorkingAgent] {
        var result: [WorkingAgent] = presences.compactMap { presence in
            guard presence.kind == "agent", let status = presence.status?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !status.isEmpty else { return nil }
            return WorkingAgent(id: presence.clientId, name: presence.name, color: presence.color, status: status)
        }
        let unfinished = tasks.filter { $0.endedAt == nil && $0.failedAt == nil }.sorted { $0.startedAt < $1.startedAt }
        for task in unfinished where !task.agentName.isEmpty {
            guard !result.contains(where: { $0.name == task.agentName }) else { continue }
            result.append(WorkingAgent(id: "task:" + task.id, name: task.agentName,
                                       color: presences.first { $0.name == task.agentName }?.color ?? roles["doop"]!.color,
                                       status: task.status))
        }
        if result.isEmpty, let waiting = unfinished.last(where: { $0.agentName.isEmpty && now - $0.startedAt < startingWindowMS }) {
            let role = waitingRole(waiting)
            result.append(WorkingAgent(id: "task:" + waiting.id, name: role.name, color: role.color, status: "Starting…"))
        }
        return result
    }

    /// The role a waiting card is addressed to: its pipeline's current stage, else Doop.
    /// A custom agent's id is its handle, shown as it is typed in an @mention.
    private static func waitingRole(_ task: CanvasTask) -> (name: String, color: String) {
        let stage = task.stage ?? 0
        guard let pipeline = task.pipeline, stage >= 0, stage < pipeline.count else { return roles["doop"]! }
        let id = pipeline[stage]
        return roles[id] ?? ("@" + id, roles["doop"]!.color)
    }
}
