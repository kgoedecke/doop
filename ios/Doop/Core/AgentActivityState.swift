import Foundation

public struct AgentActivityState: Codable, Hashable {
    public var canvasName: String
    public var agentName: String
    public var status: String
    public var phase: String
    public var activeCount: Int
    public var startedAt: Double
    /// Earlier statuses of the same run, oldest first, shown as checked steps.
    public var steps: [String]?
    public var stage: Int?
    public var stageCount: Int?

    public var isActive: Bool { phase == "working" || phase == "queued" }

    public static func summarize(canvasName: String, tasks: [CanvasTask]) -> Self? {
        let sorted = tasks.sorted { $0.startedAt > $1.startedAt }
        let unfinished = sorted.filter { $0.endedAt == nil && $0.failedAt == nil }
        let running = unfinished.filter { !$0.agentName.isEmpty }
        guard let task = running.first ?? unfinished.first ?? sorted.first else { return nil }
        let run = run(of: task, in: sorted)
        let phase = !running.isEmpty ? "working" : !unfinished.isEmpty ? "queued" : task.failedAt != nil ? "failed" : "finished"
        let count = task.pipeline?.count ?? 0
        let step = task.stage ?? 0
        return Self(
            canvasName: String(canvasName.prefix(80)),
            agentName: String((task.agentName.isEmpty ? "Doop" : task.agentName).prefix(60)),
            status: String((phase == "failed" ? task.failureReason ?? task.status : task.status).prefix(200)),
            phase: phase,
            activeCount: running.count,
            startedAt: (task.runStartedAt ?? run[run.count - 1].startedAt) / 1000,
            steps: run.dropFirst().prefix(recentSteps).reversed().map { String($0.status.prefix(80)) },
            stage: count > 0 && step >= 0 && step < count ? step + 1 : nil,
            stageCount: count > 0 && step >= 0 && step < count ? count : nil
        )
    }

    /// Finished steps kept above the current one; mirrors shared/agentActivity.ts.
    private static let recentSteps = 2
    private static let handoffMS: Double = 5_000

    /// The task and the statuses the same agent posted right before it, newest
    /// first: each set_status closes the previous task as it opens the next.
    private static func run(of task: CanvasTask, in sorted: [CanvasTask]) -> [CanvasTask] {
        var run = [task]
        guard let index = sorted.firstIndex(of: task) else { return run }
        for earlier in sorted[(index + 1)...] {
            guard earlier.agentName == task.agentName, earlier.owner == task.owner else { continue }
            guard earlier.queuedBy == nil, earlier.failedAt == nil, let ended = earlier.endedAt,
                  abs(run[run.count - 1].startedAt - ended) <= handoffMS else { break }
            run.append(earlier)
        }
        return run
    }
}
