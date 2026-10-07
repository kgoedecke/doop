import Foundation

public struct AgentActivityState: Codable, Hashable {
    public var canvasName: String
    public var agentName: String
    public var status: String
    public var phase: String
    public var activeCount: Int
    public var startedAt: Double
    public var stage: Int?
    public var stageCount: Int?

    public var isActive: Bool { phase == "working" || phase == "queued" }

    public static func summarize(canvasName: String, tasks: [CanvasTask]) -> Self? {
        let sorted = tasks.sorted { $0.startedAt > $1.startedAt }
        let unfinished = sorted.filter { $0.endedAt == nil && $0.failedAt == nil }
        let running = unfinished.filter { !$0.agentName.isEmpty }
        guard let task = running.first ?? unfinished.first ?? sorted.first else { return nil }
        let phase = !running.isEmpty ? "working" : !unfinished.isEmpty ? "queued" : task.failedAt != nil ? "failed" : "finished"
        let count = task.pipeline?.count ?? 0
        let step = task.stage ?? 0
        return Self(
            canvasName: String(canvasName.prefix(80)),
            agentName: String((task.agentName.isEmpty ? "Doop" : task.agentName).prefix(60)),
            status: String((phase == "failed" ? task.failureReason ?? task.status : task.status).prefix(200)),
            phase: phase,
            activeCount: running.count,
            startedAt: task.startedAt / 1000,
            stage: count > 0 && step >= 0 && step < count ? step + 1 : nil,
            stageCount: count > 0 && step >= 0 && step < count ? count : nil
        )
    }
}
