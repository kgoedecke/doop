import ActivityKit
import SwiftUI
import WidgetKit

@main
struct DoopActivityBundle: WidgetBundle {
    var body: some Widget { AgentLiveActivity() }
}

private let brand = Color(red: 0.898, green: 0.325, blue: 0.235)
private let card = Color(red: 0.11, green: 0.11, blue: 0.125)

struct AgentLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AgentActivityAttributes.self) { context in
            AgentStatusCard(state: context.state, stale: context.isStale)
                .padding(18)
                .activityBackgroundTint(card)
                .widgetURL(CanvasLink.url(canvasID: context.attributes.canvasID, serverOrigin: context.attributes.serverOrigin))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    BrandRow(agentName: context.state.agentName).padding(.leading, 6)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    ElapsedTime(state: context.state, stale: context.isStale).padding(.trailing, 6)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    AgentStatusBody(state: context.state, stale: context.isStale, recentSteps: 1).padding(.horizontal, 6)
                }
            } compactLeading: {
                DoopLogo().frame(width: 14, height: 16)
            } compactTrailing: {
                Image(systemName: context.isStale ? "clock" : symbol(context.state)).foregroundStyle(brand)
            } minimal: {
                DoopLogo().frame(width: 14, height: 16)
            }
            .keylineTint(brand)
            .widgetURL(CanvasLink.url(canvasID: context.attributes.canvasID, serverOrigin: context.attributes.serverOrigin))
        }
    }
}

/// The lock screen card: logo and agent badge, then the canvas, phase and progress.
private struct AgentStatusCard: View {
    let state: AgentActivityState
    let stale: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                BrandRow(agentName: state.agentName)
                Spacer()
                ElapsedTime(state: state, stale: stale)
            }
            AgentStatusBody(state: state, stale: stale, recentSteps: 2)
        }.foregroundStyle(.white)
    }
}

/// Canvas name, a large phase title, then the agent's recent steps while it
/// works, or a call to action once it is done. The Dynamic Island has room
/// for one finished step, the lock screen for two.
private struct AgentStatusBody: View {
    let state: AgentActivityState
    let stale: Bool
    let recentSteps: Int
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(state.canvasName).font(.subheadline).foregroundStyle(.white.opacity(0.75)).lineLimit(1)
                Text(stale ? "Status needs updating" : title(state)).font(.title2.weight(.semibold)).lineLimit(1)
            }
            if stale {
                Caption(text: "Open Doop for the latest agent status.")
            } else if state.phase == "working" {
                StepLog(steps: (state.steps ?? []).suffix(recentSteps), current: state.status)
            } else if state.isActive {
                Caption(text: state.status)
            } else {
                if state.phase == "failed" { Caption(text: state.status) }
                Text(state.phase == "failed" ? "Open Canvas" : "View Canvas")
                    .font(.subheadline.weight(.medium))
                    .frame(maxWidth: .infinity).padding(.vertical, 9)
                    .background(brand, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
        }.foregroundStyle(.white)
    }
}

/// The Doop logo and a badge for the agent at work, like a tiny avatar row.
private struct BrandRow: View {
    let agentName: String
    var body: some View {
        HStack(spacing: 6) {
            DoopLogo().frame(width: 15, height: 18)
            ZStack {
                Circle().fill(.white.opacity(0.16))
                if AgentMark.brand(for: agentName) == "doop" {
                    Image(systemName: "person.fill").font(.system(size: 10)).foregroundStyle(.white.opacity(0.7))
                } else {
                    MarkShape(AgentMark.path(for: agentName)).fill(.white.opacity(0.85)).padding(5)
                }
            }.frame(width: 20, height: 20)
        }
    }
}

private struct ElapsedTime: View {
    let state: AgentActivityState
    let stale: Bool
    var body: some View {
        HStack(spacing: 6) {
            if state.activeCount > 1 { Text("\(state.activeCount) agents") }
            if state.isActive && !stale {
                Text(Date(timeIntervalSince1970: state.startedAt), style: .timer).monospacedDigit()
                    .multilineTextAlignment(.trailing).frame(maxWidth: 64, alignment: .trailing)
            }
        }.font(.caption).foregroundStyle(.white.opacity(0.6))
    }
}

/// The current step with up to two finished ones above it: a new status
/// checks off the one before, so the list builds up as the agent works.
private struct StepLog: View {
    let steps: ArraySlice<String>
    let current: String
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                HStack(spacing: 9) {
                    Image(systemName: "checkmark").font(.system(size: 8, weight: .heavy)).foregroundStyle(brand)
                        .frame(width: 16, height: 16).background(brand.opacity(0.18), in: Circle())
                    Text(step).foregroundStyle(.white.opacity(0.5))
                }
            }
            HStack(spacing: 9) {
                Circle().fill(.white).frame(width: 6, height: 6)
                    .frame(width: 16, height: 16).background(brand, in: Circle())
                    .background(brand.opacity(0.25), in: Circle().inset(by: -3))
                Text(current).fontWeight(.medium)
            }
        }.font(.footnote).lineLimit(1)
    }
}

private struct Caption: View {
    let text: String
    var body: some View {
        Text(text).font(.footnote).foregroundStyle(.white.opacity(0.8)).lineLimit(1)
            .frame(maxWidth: .infinity)
    }
}

private struct DoopLogo: View {
    var body: some View { MarkShape(AgentMark.doopMark()).fill(brand) }
}

/// Fits a mark into the view's bounds, keeping its aspect ratio.
private struct MarkShape: Shape {
    let mark: Path
    init(_ cgPath: CGPath) { mark = Path(cgPath) }
    func path(in rect: CGRect) -> Path {
        let box = mark.boundingRect
        guard box.width > 0, box.height > 0 else { return Path() }
        let scale = min(rect.width / box.width, rect.height / box.height)
        let transform = CGAffineTransform(translationX: rect.midX - box.midX * scale, y: rect.midY - box.midY * scale)
            .scaledBy(x: scale, y: scale)
        return mark.applying(transform)
    }
}

private func title(_ state: AgentActivityState) -> String {
    switch state.phase {
    case "working": "Working"
    case "queued": "Waiting for an agent"
    case "failed": "Needs attention"
    default: "Design ready"
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
