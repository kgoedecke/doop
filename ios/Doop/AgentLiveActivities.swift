import ActivityKit
import UIKit

@MainActor
final class AgentLiveActivities {
    static let shared = AgentLiveActivities()
    private struct Update { let canvasID: String; let state: AgentActivityState; let client: DoopClient }
    private var pending: [String: Update] = [:]
    private var workers: [String: Task<Void, Never>] = [:]
    private var tokenObservers: [String: Task<Void, Never>] = [:]
    private var stateObservers: [String: Task<Void, Never>] = [:]
    private var pushSupport: [String: Bool] = [:]
    private var dismissed: [String: Double] = [:]
    private var systemObservers: [String: Task<Void, Never>] = [:]
    private var startTokens: [String: String] = [:]
    private var registeredStartTokens: [String: String] = [:]

    func observe(canvas: CanvasDocument?, tasks: [CanvasTask], client: DoopClient) {
        guard let canvas, let state = AgentActivityState.summarize(canvasName: canvas.name, tasks: tasks) else { return }
        let key = client.server.origin.absoluteString + "/" + canvas.id
        pending[key] = Update(canvasID: canvas.id, state: state, client: client)
        guard workers[key] == nil else { return }
        workers[key] = Task {
            while let update = pending.removeValue(forKey: key) { await apply(update, key: key) }
            workers[key] = nil
        }
    }

    private func apply(_ update: Update, key: String) async {
        guard #available(iOS 16.2, *) else { return }
        let origin = update.client.server.origin.absoluteString
        var activity = Activity<AgentActivityAttributes>.activities.first {
            $0.attributes.canvasID == update.canvasID && $0.attributes.serverOrigin == origin
                && ($0.activityState == .active || $0.activityState == .stale)
        }
        let content = ActivityContent(state: update.state, staleDate: Date().addingTimeInterval(120))
        if activity == nil {
            guard update.state.isActive, dismissed[key] != update.state.startedAt,
                  ActivityAuthorizationInfo().areActivitiesEnabled, UIApplication.shared.applicationState == .active else { return }
            if pushSupport[origin] == nil {
                struct Config: Decodable { let enabled: Bool }
                let config: Config? = try? await update.client.get("/api/live-activities/config")
                pushSupport[origin] = config?.enabled ?? false
            }
            guard !Task.isCancelled, UIApplication.shared.applicationState == .active else { return }
            let attributes = AgentActivityAttributes(canvasID: update.canvasID, serverOrigin: origin)
            do {
                activity = try Activity.request(attributes: attributes, content: content, pushType: pushSupport[origin] == true ? .token : nil)
            } catch {
                // Unsigned development builds may lack push entitlement; local Live Activities still work.
                activity = try? Activity.request(attributes: attributes, content: content, pushType: nil)
            }
        }
        guard let activity, !Task.isCancelled else { return }
        if update.state.isActive {
            await activity.update(content)
            observeToken(activity, client: update.client)
            if stateObservers[activity.id] == nil {
                stateObservers[activity.id] = Task {
                    for await state in activity.activityStateUpdates {
                        if state == .dismissed || state == .ended {
                            if state == .dismissed { dismissed[key] = activity.content.state.startedAt }
                            tokenObservers.removeValue(forKey: activity.id)?.cancel()
                            _ = try? await update.client.data("/api/live-activities/\(activity.id)", method: "DELETE")
                            break
                        }
                    }
                    stateObservers[activity.id] = nil
                }
            }
        } else {
            await activity.end(content, dismissalPolicy: .after(Date().addingTimeInterval(60)))
            tokenObservers.removeValue(forKey: activity.id)?.cancel()
            _ = try? await update.client.data("/api/live-activities/\(activity.id)", method: "DELETE")
        }
    }

    @available(iOS 16.2, *)
    private func observeToken(_ activity: Activity<AgentActivityAttributes>, client: DoopClient) {
        guard tokenObservers[activity.id] == nil else { return }
        tokenObservers[activity.id] = Task {
            if let token = activity.pushToken { await register(token, activity: activity, client: client) }
            for await token in activity.pushTokenUpdates {
                if Task.isCancelled { break }
                await register(token, activity: activity, client: client)
            }
            tokenObservers[activity.id] = nil
        }
    }

    /// "sandbox" when the app is signed with a development profile (Xcode runs, ad hoc
    /// installs), "production" for TestFlight and App Store builds. The build configuration
    /// cannot tell: a Release build installed from Xcode still gets sandbox tokens.
    static let apnsEnvironment: String = {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url) else { return "production" }
        let profile = String(decoding: data, as: UTF8.self)
        let pattern = #"<key>aps-environment</key>\s*<string>(\w+)</string>"#
        guard let match = profile.range(of: pattern, options: .regularExpression) else { return "production" }
        return profile[match].contains("development") ? "sandbox" : "production"
    }()

    @available(iOS 16.2, *)
    private func register(_ token: Data, activity: Activity<AgentActivityAttributes>, client: DoopClient) async {
        let environment = Self.apnsEnvironment
        for attempt in 0..<4 {
            if Task.isCancelled { return }
            do {
                _ = try await client.data("/api/live-activities/\(activity.id)", method: "PUT", body: [
                    "canvasId": activity.attributes.canvasID,
                    "token": token.map { String(format: "%02x", $0) }.joined(), "environment": environment,
                ])
                return
            } catch {
                if let error = error as? APIError, (400..<500).contains(error.status) { return }
                try? await Task.sleep(nanoseconds: UInt64(2 << attempt) * 1_000_000_000)
            }
        }
    }

    // MARK: Activities the server starts (iOS 17.2 push-to-start)

    /// Follow activities the system opens for this server, whether the app or a
    /// server push started them, and keep the device's push-to-start token
    /// registered so an agent task on any canvas the user belongs to opens one.
    /// Safe to call repeatedly; also runs when iOS launches the app in the
    /// background to hand over a new activity's update token.
    func observeSystem(client: DoopClient) {
        guard #available(iOS 17.2, *) else { return }
        let origin = client.server.origin.absoluteString
        if systemObservers[origin] == nil {
            systemObservers[origin] = Task { [weak self] in
                for activity in Activity<AgentActivityAttributes>.activities where activity.attributes.serverOrigin == origin {
                    await self?.adopt(activity, client: client)
                }
                let tokens = Task { [weak self] in
                    if let token = Activity<AgentActivityAttributes>.pushToStartToken {
                        await self?.syncStartToken(token, client: client)
                    }
                    for await token in Activity<AgentActivityAttributes>.pushToStartTokenUpdates {
                        if Task.isCancelled { break }
                        await self?.syncStartToken(token, client: client)
                    }
                }
                for await activity in Activity<AgentActivityAttributes>.activityUpdates
                where activity.attributes.serverOrigin == origin {
                    if Task.isCancelled { break }
                    await self?.adopt(activity, client: client)
                }
                tokens.cancel()
            }
        } else if let token = startTokens[origin], registeredStartTokens[origin] != token, let data = Data(hex: token) {
            // Signed in after the token arrived (or an earlier registration failed): try again.
            Task { await syncStartToken(data, client: client) }
        }
    }

    /// Track a server-started activity like one the app created: register its
    /// update token and drop it if the canvas already has one.
    @available(iOS 16.2, *)
    private func adopt(_ activity: Activity<AgentActivityAttributes>, client: DoopClient) async {
        guard activity.activityState == .active || activity.activityState == .stale else { return }
        let twin = Activity<AgentActivityAttributes>.activities.first {
            $0.id != activity.id && $0.attributes.canvasID == activity.attributes.canvasID
                && $0.attributes.serverOrigin == activity.attributes.serverOrigin
                && ($0.activityState == .active || $0.activityState == .stale)
        }
        if let twin, twin.id < activity.id {
            await activity.end(nil, dismissalPolicy: .immediate)
            return
        }
        observeToken(activity, client: client)
        guard stateObservers[activity.id] == nil else { return }
        let key = client.server.origin.absoluteString + "/" + activity.attributes.canvasID
        stateObservers[activity.id] = Task { [weak self] in
            for await state in activity.activityStateUpdates where state == .dismissed || state == .ended {
                if state == .dismissed { self?.dismissed[key] = activity.content.state.startedAt }
                self?.tokenObservers.removeValue(forKey: activity.id)?.cancel()
                _ = try? await client.data("/api/live-activities/\(activity.id)", method: "DELETE")
                break
            }
            self?.stateObservers[activity.id] = nil
        }
    }

    @available(iOS 17.2, *)
    private func syncStartToken(_ token: Data, client: DoopClient) async {
        let origin = client.server.origin.absoluteString
        let hex = token.map { String(format: "%02x", $0) }.joined()
        guard !hex.isEmpty else { return }
        startTokens[origin] = hex
        let environment = Self.apnsEnvironment
        do {
            _ = try await client.data("/api/live-activities/push-to-start", method: "PUT", body: ["token": hex, "environment": environment, "origin": origin])
            registeredStartTokens[origin] = hex
        } catch {
            // Not signed in yet, or the server has no APNs key: `observeSystem` retries after sign-in.
        }
    }

    /// Stop following this server and retire its push-to-start token (sign-out, server change).
    func stopSystem(client: DoopClient) async {
        let origin = client.server.origin.absoluteString
        systemObservers.removeValue(forKey: origin)?.cancel()
        if let token = registeredStartTokens.removeValue(forKey: origin) {
            _ = try? await client.data("/api/live-activities/push-to-start/\(token)", method: "DELETE")
        }
        startTokens[origin] = nil
    }

    /// The activities open for this server right now. A caller about to fetch the
    /// task lists takes this first and hands it to `reconcile`, so an activity that
    /// opens while the request is in flight (a task that began after the server
    /// built its answer) is not mistaken for one the server reported idle.
    func openActivityIDs(client: DoopClient) -> Set<String> {
        guard #available(iOS 16.2, *) else { return [] }
        let origin = client.server.origin.absoluteString
        return Set(Activity<AgentActivityAttributes>.activities.filter { $0.attributes.serverOrigin == origin }.map(\.id))
    }

    /// Fresh task lists for the user's canvases: close any activity whose canvas has
    /// no running task left. The server sends the end event too, but only once the
    /// agent's silence timeout has passed; the app knows sooner and can say so.
    /// End the activities of canvases the server just reported idle. The caller
    /// fetched `canvases` a moment ago, so an activity still narrating a task on
    /// one of them missed its end event (the phone slept, the push was dropped).
    /// Only activities in `openBefore` (taken before the fetch) qualify, and one
    /// whose content changed since the snapshot received a fresh push and is left
    /// to the server. Server-side cleanup runs detached so a slow request never
    /// holds up the refresh.
    func reconcile(canvases: [CanvasSummary], openBefore: Set<String>, client: DoopClient) async {
        guard #available(iOS 16.2, *) else { return }
        // An older server omits activeTasks; that must not read as "everything idle".
        guard !canvases.isEmpty, canvases.allSatisfy({ $0.activeTasks != nil }) else { return }
        let origin = client.server.origin.absoluteString
        let idle = Set(canvases.filter { $0.activeTasks?.isEmpty ?? false }.map(\.id))
        let stale = Activity<AgentActivityAttributes>.activities
            .filter { openBefore.contains($0.id) }
            .filter { $0.attributes.serverOrigin == origin && idle.contains($0.attributes.canvasID) }
            .filter { $0.activityState == .active || $0.activityState == .stale }
            .map { (activity: $0, seen: $0.content.state) }
            .filter { $0.seen.isActive }
        var ended: [String] = []
        for (activity, seen) in stale {
            guard activity.content.state == seen else { continue }
            var state = seen
            state.phase = "finished"
            state.status = "Finished"
            state.activeCount = 0
            let key = origin + "/" + activity.attributes.canvasID
            workers.removeValue(forKey: key)?.cancel(); pending[key] = nil
            tokenObservers.removeValue(forKey: activity.id)?.cancel()
            await activity.end(ActivityContent(state: state, staleDate: nil), dismissalPolicy: .after(Date().addingTimeInterval(60)))
            ended.append(activity.id)
        }
        guard !ended.isEmpty else { return }
        Task {
            for id in ended { _ = try? await client.data("/api/live-activities/\(id)", method: "DELETE") }
        }
    }

    func endAll(client: DoopClient) async {
        let origin = client.server.origin.absoluteString
        for key in workers.keys.filter({ $0.hasPrefix(origin + "/") }) {
            workers.removeValue(forKey: key)?.cancel(); pending[key] = nil
        }
        guard #available(iOS 16.2, *) else { return }
        for activity in Activity<AgentActivityAttributes>.activities where activity.attributes.serverOrigin == origin {
            tokenObservers.removeValue(forKey: activity.id)?.cancel()
            stateObservers.removeValue(forKey: activity.id)?.cancel()
            _ = try? await client.data("/api/live-activities/\(activity.id)", method: "DELETE")
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        pushSupport[origin] = nil
    }

    func endCanvas(id: String, client: DoopClient) async {
        let key = client.server.origin.absoluteString + "/" + id
        workers.removeValue(forKey: key)?.cancel()
        pending[key] = nil
        guard #available(iOS 16.2, *) else { return }
        for activity in Activity<AgentActivityAttributes>.activities where activity.attributes.canvasID == id && activity.attributes.serverOrigin == client.server.origin.absoluteString {
            tokenObservers.removeValue(forKey: activity.id)?.cancel()
            _ = try? await client.data("/api/live-activities/\(activity.id)", method: "DELETE")
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }
}

private extension Data {
    init?(hex: String) {
        guard hex.count % 2 == 0 else { return nil }
        var bytes: [UInt8] = []
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
            bytes.append(byte)
            index = next
        }
        self.init(bytes)
    }
}
