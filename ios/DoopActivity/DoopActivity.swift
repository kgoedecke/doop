import ActivityKit
import SwiftUI
import WidgetKit

@main
struct DoopActivityBundle: WidgetBundle {
    var body: some Widget { AgentLiveActivity() }
}

struct AgentLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AgentActivityAttributes.self) { context in
            AgentStatusCard(state: context.state, stale: context.isStale)
                .activityBackgroundTint(Color(red: 0.075, green: 0.075, blue: 0.09))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label("doop", systemImage: "sparkles").font(.headline).foregroundStyle(.indigo)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(context.isStale ? "Updating…" : title(context.state)).font(.caption.bold())
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 7) {
                        Text(context.state.canvasName).font(.headline).lineLimit(1)
                        Text(context.isStale ? "Open Doop for the latest status" : context.state.status)
                            .font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.bottom, 6)
                }
            } compactLeading: {
                Image(systemName: "sparkles").foregroundStyle(.indigo)
            } compactTrailing: {
                Image(systemName: context.isStale ? "clock" : symbol(context.state)).foregroundStyle(.indigo)
            } minimal: {
                Image(systemName: context.isStale ? "clock" : symbol(context.state)).foregroundStyle(.indigo)
            }
        }
    }
}

private struct AgentStatusCard: View {
    let state: AgentActivityState
    let stale: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "sparkles").foregroundStyle(Color(red: 0.48, green: 0.55, blue: 1))
                Text("doop").fontWeight(.bold)
                Spacer()
                if state.activeCount > 1 { Text("\(state.activeCount) agents").foregroundStyle(.white.opacity(0.65)) }
                if state.isActive && !stale {
                    Text(Date(timeIntervalSince1970: state.startedAt), style: .timer).monospacedDigit()
                        .multilineTextAlignment(.trailing).frame(maxWidth: 80)
                }
            }.font(.caption)
            VStack(alignment: .leading, spacing: 4) {
                Text(state.canvasName).font(.subheadline).foregroundStyle(.white.opacity(0.7)).lineLimit(1)
                Label(stale ? "Status needs updating" : title(state), systemImage: stale ? "clock" : symbol(state))
                    .font(.title2.bold())
            }
            if let stage = state.stage, let count = state.stageCount, count > 1, state.isActive, !stale {
                ProgressView(value: Double(stage - 1), total: Double(count))
                    .tint(Color(red: 0.38, green: 0.48, blue: 1))
                Text("Stage \(stage) of \(count) · \(state.agentName)").font(.caption).foregroundStyle(.white.opacity(0.65))
            }
            Text(stale ? "Open Doop for the latest agent status." : state.status)
                .font(.subheadline).foregroundStyle(.white.opacity(0.85)).lineLimit(2)
        }.padding(18).foregroundStyle(.white)
    }
}

private func title(_ state: AgentActivityState) -> String {
    switch state.phase {
    case "working": "Working"
    case "queued": "Waiting for an agent"
    case "failed": "Needs attention"
    default: "Finished"
    }
}

private func symbol(_ state: AgentActivityState) -> String {
    switch state.phase {
    case "working": "sparkles"
    case "queued": "clock"
    case "failed": "exclamationmark.circle"
    default: "checkmark.circle.fill"
    }
}
