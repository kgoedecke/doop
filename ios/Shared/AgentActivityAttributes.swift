import ActivityKit

@available(iOS 16.1, *)
struct AgentActivityAttributes: ActivityAttributes {
    typealias ContentState = AgentActivityState
    let canvasID: String
    let serverOrigin: String
}
