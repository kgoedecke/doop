import Foundation

/// An identity provider the server may offer besides email/password: the Google
/// and Microsoft social providers, and `oidc` for the generic OIDC SSO plugin.
public enum SignInProvider: String, CaseIterable, Equatable {
    case google, microsoft, oidc
}

/// `GET /api/oidc-config`: which provider buttons the sign-in screen should show.
/// Never carries a secret; a server without any provider answers all-false.
public struct LoginProviders: Decodable, Equatable {
    /// OIDC SSO is configured.
    public var enabled: Bool
    /// What the SSO button should call the provider ("Okta", "Acme SSO").
    public var displayName: String?
    public var google: Bool
    public var microsoft: Bool
    /// The browser "Sign in with Apple" (a Services ID); the web page's button, not this app's.
    public var apple: Bool
    /// The server verifies identity tokens from this app's native Sign in with Apple sheet.
    public var appleNative: Bool

    public init(enabled: Bool = false, displayName: String? = nil, google: Bool = false, microsoft: Bool = false,
                apple: Bool = false, appleNative: Bool = false) {
        self.enabled = enabled
        self.displayName = displayName
        self.google = google
        self.microsoft = microsoft
        self.apple = apple
        self.appleNative = appleNative
    }

    private enum CodingKeys: String, CodingKey { case enabled, displayName, google, microsoft, apple, appleNative }

    /// Every flag is optional on the wire: a server older than a flag answers without it, and must read as off.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(enabled: try container.decodeIfPresent(Bool.self, forKey: .enabled) ?? false,
                  displayName: try container.decodeIfPresent(String.self, forKey: .displayName),
                  google: try container.decodeIfPresent(Bool.self, forKey: .google) ?? false,
                  microsoft: try container.decodeIfPresent(Bool.self, forKey: .microsoft) ?? false,
                  apple: try container.decodeIfPresent(Bool.self, forKey: .apple) ?? false,
                  appleNative: try container.decodeIfPresent(Bool.self, forKey: .appleNative) ?? false)
    }

    public static let none = LoginProviders()

    /// Providers to offer through the browser handoff, in the order the web
    /// sign-in page shows them. Apple is not among them: this app signs in
    /// with Apple natively (`appleNative`, `AppleSignIn`).
    public var available: [SignInProvider] {
        var providers: [SignInProvider] = []
        if google { providers.append(.google) }
        if microsoft { providers.append(.microsoft) }
        if enabled { providers.append(.oidc) }
        return providers
    }

    public func label(for provider: SignInProvider) -> String {
        switch provider {
        case .google: return "Google"
        case .microsoft: return "Microsoft"
        case .oidc:
            let name = displayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return name.isEmpty ? "SSO" : name
        }
    }
}

/// One attempt to sign in through an identity provider.
///
/// Identity providers refuse embedded web views, so the provider round trip runs
/// in the system browser (an `ASWebAuthenticationSession`) and the resulting
/// session is handed back over a `doop://` URL: the same flow the desktop app
/// uses (`src/lib/desktopAuth.ts`), which is why the server pages still carry
/// `desktop` in their paths.
///
/// 1. The app opens `startURL(on:)`: `/desktop/signin` begins the provider
///    sign-in from inside the browser, so better-auth's state cookie and the
///    provider's callback share a cookie jar.
/// 2. The browser lands on `/desktop/handoff` signed in, mints a one-time
///    token from that session and navigates to `doop://auth?token=…&challenge=…`.
/// 3. The authentication session intercepts that URL; `token(from:)` releases
///    the token only if the challenge answers this attempt, so a link minted
///    from someone else's browser session can't sign the app into their account.
///    The app then redeems it (`POST /api/auth/one-time-token/verify`) and the
///    server answers with the session cookie.
public struct ProviderSignIn: Equatable {
    public let provider: SignInProvider
    /// Random per-attempt value, 32 lowercase hex digits, compared on the way back.
    public let challenge: String

    /// The custom scheme the handoff page returns on.
    public static let callbackScheme = "doop"

    public init(provider: SignInProvider, challenge: String = ProviderSignIn.newChallenge()) {
        self.provider = provider
        self.challenge = challenge
    }

    /// 128 random bits, URL-safe. `SystemRandomNumberGenerator` is cryptographically secure on Apple platforms.
    public static func newChallenge() -> String {
        (0..<16).map { _ in String(format: "%02x", UInt8.random(in: .min ... .max)) }.joined()
    }

    /// The browser-side page that begins this provider's sign-in; always on the chosen server.
    public func startURL(on server: ServerAddress) -> URL {
        var parts = URLComponents(url: server.origin, resolvingAgainstBaseURL: false)!
        parts.path = "/desktop/signin"
        parts.queryItems = [URLQueryItem(name: "provider", value: provider.rawValue), URLQueryItem(name: "challenge", value: challenge)]
        return parts.url!
    }

    /// The one-time token carried by `callback`, or nil unless it is a well-formed
    /// `doop://auth` link answering this attempt's challenge.
    public func token(from callback: URL) -> String? {
        guard let parts = URLComponents(url: callback, resolvingAgainstBaseURL: false),
              parts.scheme?.lowercased() == Self.callbackScheme, parts.host?.lowercased() == "auth" else { return nil }
        let query = Dictionary((parts.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { first, _ in first })
        guard query["challenge"] == challenge, let token = query["token"], !token.isEmpty else { return nil }
        return token
    }
}
