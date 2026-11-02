import Foundation
import WebKit

struct APIError: LocalizedError {
    let status: Int
    let message: String
    var errorDescription: String? { message }
}

@MainActor
final class DoopClient {
    let server: ServerAddress
    let session: URLSession

    init(server: ServerAddress) {
        self.server = server
        let configuration = URLSessionConfiguration.default
        configuration.httpCookieStorage = .shared
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 30
        session = URLSession(configuration: configuration)
    }

    func request(_ path: String, method: String = "GET", body: [String: Any]? = nil) throws -> URLRequest {
        guard path.hasPrefix("/"), let url = URL(string: path, relativeTo: server.origin)?.absoluteURL,
              server.contains(url) else { throw APIError(status: 0, message: "Invalid server URL.") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(server.origin.absoluteString, forHTTPHeaderField: "Origin")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return request
    }

    func data(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> Data {
        let (data, response) = try await session.data(for: request(path, method: method, body: body))
        guard let http = response as? HTTPURLResponse, let url = http.url, server.contains(url) else {
            throw APIError(status: 0, message: "The server returned an unexpected response.")
        }
        guard (200..<300).contains(http.statusCode) else {
            let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let detail = payload?["message"] as? String ?? payload?["error"] as? String
            let message = detail == "resident_limit" ? "Your agent allowance is used up. Connect a model account in Doop’s account settings." : detail
            throw APIError(status: http.statusCode, message: message ?? "Request failed (\(http.statusCode)).")
        }
        return data
    }

    func get<T: Decodable>(_ path: String) async throws -> T {
        try JSONDecoder().decode(T.self, from: await data(path))
    }

    /// Migrate an existing wrapper login; never move cookies to a different host.
    func importWebSession() async {
        guard (HTTPCookieStorage.shared.cookies(for: server.home) ?? []).isEmpty else { return }
        let cookies = await WKWebsiteDataStore.default().httpCookieStore.allCookies()
        for cookie in cookies where matches(cookie) { HTTPCookieStorage.shared.setCookie(cookie) }
    }

    func persistWebSession() async {
        for cookie in HTTPCookieStorage.shared.cookies(for: server.home) ?? [] {
            await WKWebsiteDataStore.default().httpCookieStore.setCookie(cookie)
        }
    }

    func clearCookies() async {
        for cookie in HTTPCookieStorage.shared.cookies ?? [] where matches(cookie) {
            HTTPCookieStorage.shared.deleteCookie(cookie)
        }
        let store = WKWebsiteDataStore.default().httpCookieStore
        for cookie in await store.allCookies() where matches(cookie) { await store.deleteCookie(cookie) }
    }

    private func matches(_ cookie: HTTPCookie) -> Bool {
        let domain = cookie.domain.hasPrefix(".") ? String(cookie.domain.dropFirst()) : cookie.domain
        guard let host = server.origin.host else { return false }
        return host == domain || host.hasSuffix("." + domain)
    }
}

@MainActor
final class AppModel: ObservableObject {
    @Published var user: DoopUser?
    @Published var canvases: [CanvasSummary] = []
    @Published var workspaces: [WorkspaceSummary] = []
    @Published var loading = true
    @Published var error: String?
    /// Provider buttons the sign-in screen offers for the current server.
    @Published var providers = LoginProviders.none
    @Published var client: DoopClient

    init() {
        let address = UserDefaults.standard.string(forKey: "serverOrigin").flatMap(ServerAddress.init) ?? .hosted
        client = DoopClient(server: address)
        // Start following Live Activities at once: iOS may have launched the app in
        // the background only to hand over a server-started activity's push token.
        let client = self.client
        Task { await client.importWebSession(); AgentLiveActivities.shared.observeSystem(client: client) }
    }

    func restore() async {
        let client = self.client
        loading = true
        error = nil
        /* the provider buttons are optional and public, fetched signed in or
           out (so the sign-in screen after a sign-out knows them) but never
           in the way of opening a workspace that is already signed in */
        Task {
            let providers: LoginProviders = (try? await client.get("/api/oidc-config")) ?? .none
            guard self.client === client else { return }
            self.providers = providers
        }
        do {
            await client.importWebSession()
            struct Session: Decodable { var user: DoopUser }
            var session: Session? = try await client.get("/api/auth/get-session")
            #if DEBUG
            // Simulator automation against a local server: -testEmail / -testPassword launch arguments.
            if session == nil, client.server.origin.host == "localhost",
               let email = UserDefaults.standard.string(forKey: "testEmail"),
               let password = UserDefaults.standard.string(forKey: "testPassword") {
                _ = try await client.data("/api/auth/sign-in/email", method: "POST", body: ["email": email, "password": password])
                await client.persistWebSession()
                session = try await client.get("/api/auth/get-session")
                canvasLog.info("test sign-in: \(session == nil ? "no session" : "signed in", privacy: .public)")
            }
            #endif
            guard self.client === client else { return }
            user = session?.user
            #if DEBUG
            // -exportCanvas <id>: write the canvas JSON the app can read to its tmp dir (simulator automation).
            if user != nil, let id = UserDefaults.standard.string(forKey: "exportCanvas") {
                let data = try await client.data(id == "list" ? "/api/canvases" : "/api/canvases/\(id)")
                let url = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("canvas-\(id).json")
                try data.write(to: url)
                canvasLog.info("exported canvas \(id, privacy: .public): \(data.count) bytes")
            }
            #endif
            if user != nil {
                AgentLiveActivities.shared.observeSystem(client: client)
                await reload()
            }
        } catch { if self.client === client { self.error = error.localizedDescription } }
        guard self.client === client else { return }
        loading = false
    }

    func signIn(email: String, password: String, name: String? = nil) async throws {
        var body = ["email": email.trimmingCharacters(in: .whitespacesAndNewlines), "password": password]
        if let name { body["name"] = name }
        let path = name == nil ? "/api/auth/sign-in/email" : "/api/auth/sign-up/email"
        _ = try await client.data(path, method: "POST", body: body)
        await client.persistWebSession()
        await restore()
        if user == nil { throw APIError(status: 0, message: "Check your email to verify your account, then sign in.") }
    }

    /// Google / Microsoft / SSO: the provider round trip runs in a browser sheet
    /// (`WebSignIn`), which hands back a one-time token the app redeems for the
    /// session cookie. See `ProviderSignIn` for the flow and its challenge check.
    func signIn(with provider: SignInProvider) async throws {
        let client = self.client
        let attempt = ProviderSignIn(provider: provider)
        let callback = try await WebSignIn().run(attempt.startURL(on: client.server))
        guard let token = attempt.token(from: callback) else {
            throw APIError(status: 0, message: "The sign-in did not answer this app's request. Try again.")
        }
        guard self.client === client else { return }
        _ = try await client.data("/api/auth/one-time-token/verify", method: "POST", body: ["token": token])
        await client.persistWebSession()
        await restore()
        if user == nil { throw APIError(status: 0, message: "Signed in, but no session came back. Try again.") }
    }

    func reload() async {
        let client = self.client
        let openBefore = await AgentLiveActivities.shared.openActivityIDs(client: client)
        do {
            async let library: [CanvasSummary] = client.get("/api/canvases")
            async let spaces: WorkspaceList = client.get("/api/workspaces")
            let (items, groups) = try await (library, spaces)
            guard self.client === client else { return }
            canvases = items.sorted { $0.updatedAt > $1.updatedAt }
            workspaces = groups.workspaces
            error = nil
            await AgentLiveActivities.shared.reconcile(canvases: items, openBefore: openBefore, client: client)
        } catch {
            guard self.client === client else { return }
            if (error as? APIError)?.status == 401 { user = nil; canvases = []; workspaces = [] }
            self.error = error.localizedDescription
        }
    }

    func createCanvas(name: String, workspaceId: String?) async throws -> CanvasSummary {
        var body: [String: Any] = ["name": name]
        if let workspaceId { body["workspaceId"] = workspaceId }
        let document = try JSONDecoder().decode(CanvasDocument.self, from: await client.data("/api/canvases", method: "POST", body: body))
        await reload()
        guard let summary = canvases.first(where: { $0.id == document.id }) else {
            throw APIError(status: 0, message: "Canvas created. Refresh your library to open it.")
        }
        return summary
    }

    func signOut() async throws {
        await AgentLiveActivities.shared.stopSystem(client: client)
        await AgentLiveActivities.shared.endAll(client: client)
        _ = try await client.data("/api/auth/sign-out", method: "POST", body: [:])
        await client.clearCookies()
        user = nil
        canvases = []
        workspaces = []
    }

    /// Native Sign in with Apple: the sheet's identity token, the raw nonce the
    /// request hashed, and on a first authorization the name Apple hands over.
    /// The server verifies the token against Apple's keys for this bundle id
    /// and answers with the session cookie.
    func signIn(appleIdentityToken token: String, nonce: String, givenName: String?, familyName: String?) async throws {
        let client = self.client
        let body = AppleSignIn.body(identityToken: token, nonce: nonce, givenName: givenName, familyName: familyName)
        _ = try await client.data("/api/auth/sign-in/social", method: "POST", body: body)
        guard self.client === client else { return }
        await client.persistWebSession()
        await restore()
        if user == nil { throw APIError(status: 0, message: "Signed in, but no session came back. Try again.") }
    }

    /// Whether this account can prove itself with a password: an account that
    /// only ever signed in through Google / Microsoft / SSO has none. Throws
    /// rather than guessing: a lookup that failed must not drop the password.
    func hasPassword() async throws -> Bool {
        struct Account: Decodable { var providerId: String }
        let accounts: [Account] = try await client.get("/api/auth/list-accounts")
        return accounts.contains { $0.providerId == "credential" }
    }

    /// Permanently delete the signed-in account on this server (App Store rule 5.1.1(v)).
    /// Without a password (a provider-only account) better-auth accepts a fresh
    /// session instead, one younger than its `freshAge` (a day by default).
    func deleteAccount(password: String?) async throws {
        await AgentLiveActivities.shared.stopSystem(client: client)
        await AgentLiveActivities.shared.endAll(client: client)
        do {
            _ = try await client.data("/api/auth/delete-user", method: "POST", body: password.map { ["password": $0] } ?? [:])
        } catch let error as APIError where password == nil && error.status == 400 {
            throw APIError(status: error.status, message: "Sign out, sign in again, and then delete your account.")
        }
        await client.clearCookies()
        user = nil
        canvases = []
        workspaces = []
    }

    func changeServer(_ server: ServerAddress) async {
        await AgentLiveActivities.shared.stopSystem(client: client)
        await AgentLiveActivities.shared.endAll(client: client)
        client = DoopClient(server: server)
        UserDefaults.standard.set(server.origin.absoluteString, forKey: "serverOrigin")
        user = nil
        canvases = []
        workspaces = []
        /* the old server's buttons must not survive into the new server's
           sign-in screen: restore() fetches the new ones without waiting */
        providers = .none
        await restore()
    }
}
