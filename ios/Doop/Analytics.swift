import Foundation
import PostHog
import SwiftUI

/// Product analytics for the iOS app, the native counterpart of the web's
/// `src/lib/posthog.ts`. The server the app talks to decides: it hands out its
/// public PostHog token on `/api/analytics-config` and the events go through its
/// same-origin `/relay`, so a self-hosted server without a token gets nothing
/// and doop.design's events never leave for a third-party host. Events carry
/// PostHog's own `$lib = posthog-ios` and `$os = iOS`, plus `ios_app`, so they
/// split from mobile Safari in the same project as the web and desktop apps.
@MainActor
final class Analytics {
    static let shared = Analytics()

    /// The server whose token the SDK is running with, or is fetching.
    private var server: ServerAddress?
    private var running = false
    /// The signed-in person, kept so an identify that lands before setup finishes is not lost.
    private var user: DoopUser?
    /// The screen on view while the token was still on its way (the first one at launch).
    private var pendingScreen: (name: String, properties: [String: Any]?)?

    /// A token request for `server` is under way (including its retry waits).
    private var fetching = false
    /// `server` answered that it has analytics off (no token, or no such endpoint).
    private var off = false

    private init() {}

    /// Start (or move) analytics to `server`. Called at launch, on every server change and
    /// on every return to the foreground, which resumes a setup whose retries ran out.
    func start(server: ServerAddress) {
        if server == self.server, running || fetching || off { return }
        if server != self.server {
            stop()
            self.server = server
            pendingScreen = nil
            off = false
        }
        fetching = true
        Task { await fetchToken(for: server) }
    }

    private enum TokenAnswer { case token(String), off, unavailable }

    /// Asks for the token, retrying a failure that may pass (offline, a timeout, a 5xx)
    /// with backoff for about two minutes; a definite answer without one ends it.
    private func fetchToken(for server: ServerAddress) async {
        defer { if self.server == server { fetching = false } }
        for attempt in 0..<6 {
            guard self.server == server else { return }
            switch await Self.token(at: server) {
            case .token(let key):
                guard self.server == server else { return }
                setUp(key: key, host: server.origin.appendingPathComponent("relay").absoluteString)
                return
            case .off:
                if self.server == server { off = true }
                return
            case .unavailable:
                try? await Task.sleep(nanoseconds: UInt64(2 << attempt) * 1_000_000_000)
            }
        }
    }

    private static func token(at server: ServerAddress) async -> TokenAnswer {
        struct Config: Decodable { var posthogKey: String? }
        guard let url = URL(string: "/api/analytics-config", relativeTo: server.origin),
              let (data, response) = try? await URLSession.shared.data(from: url),
              let status = (response as? HTTPURLResponse)?.statusCode else { return .unavailable }
        if status >= 500 || status == 429 { return .unavailable }
        guard status == 200, let key = (try? JSONDecoder().decode(Config.self, from: data))?.posthogKey,
              !key.isEmpty else { return .off }
        return .token(key)
    }

    private func setUp(key: String, host: String) {
        let config = PostHogConfig(projectToken: key, host: host)
        /* SwiftUI screens are hosting controllers with generated names: screens are named by `screen(_:)` */
        config.captureScreenViews = false
        /* the app owns its APNs token (Live Activities); PostHog sends no pushes here */
        config.capturePushNotificationSubscriptions = false
        config.capturePushNotificationOpened = false
        config.preloadFeatureFlags = false
        PostHogSDK.shared.setup(config)
        PostHogSDK.shared.register(["ios_app": true])
        running = true
        if let user { identify(user) }
        if let pendingScreen { screen(pendingScreen.name, properties: pendingScreen.properties) }
        pendingScreen = nil
    }

    private func stop() {
        guard running else { return }
        PostHogSDK.shared.reset()
        PostHogSDK.shared.close()
        running = false
    }

    /// The same distinct id and person properties the web client identifies with (`src/App.tsx`).
    func identify(_ user: DoopUser) {
        self.user = user
        guard running else { return }
        PostHogSDK.shared.identify(user.id, userProperties: ["email": user.email, "name": user.name])
    }

    /// Signed out or deleted: later events belong to a new anonymous person.
    func reset() {
        user = nil
        guard running else { return }
        PostHogSDK.shared.reset()
    }

    func screen(_ name: String, properties: [String: Any]? = nil) {
        guard running else {
            if server != nil { pendingScreen = (name, properties) }
            return
        }
        PostHogSDK.shared.screen(name, properties: properties)
    }
}

extension View {
    /// Captures a `$screen` named `name` each time this view appears.
    func analyticsScreen(_ name: String, properties: [String: Any]? = nil) -> some View {
        onAppear { Analytics.shared.screen(name, properties: properties) }
    }
}
