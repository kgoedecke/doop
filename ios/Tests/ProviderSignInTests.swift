import Foundation
import DoopCore

enum ProviderSignInChecks {
    static func run() throws {
        let server = ServerAddress("https://doop.design")!
        let attempt = ProviderSignIn(provider: .google, challenge: "0123456789abcdef0123456789abcdef")

        // The start page always sits on the chosen server and names the attempt.
        let start = attempt.startURL(on: server)
        expect(start.absoluteString == "https://doop.design/desktop/signin?provider=google&challenge=0123456789abcdef0123456789abcdef", "start URL")
        expect(server.contains(start), "start URL stays on the server")
        let selfHosted = ServerAddress("https://doop.example.com:8443")!
        expect(ProviderSignIn(provider: .oidc, challenge: attempt.challenge).startURL(on: selfHosted).absoluteString
                == "https://doop.example.com:8443/desktop/signin?provider=oidc&challenge=0123456789abcdef0123456789abcdef", "self-hosted start URL")

        // Only a doop://auth link answering this attempt's challenge releases its token.
        let token = attempt.token(from: URL(string: "doop://auth?token=tok-1&challenge=0123456789abcdef0123456789abcdef&to=%2F")!)
        expect(token == "tok-1", "matching challenge releases the token")
        expect(attempt.token(from: URL(string: "DOOP://AUTH?challenge=0123456789abcdef0123456789abcdef&token=tok-2")!) == "tok-2", "scheme and host are case-insensitive")
        for link in ["doop://auth?token=tok&challenge=ffffffffffffffffffffffffffffffff",
                     "doop://auth?token=tok",
                     "doop://auth?token=&challenge=0123456789abcdef0123456789abcdef",
                     "doop://other?token=tok&challenge=0123456789abcdef0123456789abcdef",
                     "https://doop.design/auth?token=tok&challenge=0123456789abcdef0123456789abcdef",
                     "doop://auth"] {
            expect(attempt.token(from: URL(string: link)!) == nil, "rejects \(link)")
        }
        // A duplicated challenge parameter cannot smuggle a foreign one in behind the real one.
        expect(attempt.token(from: URL(string: "doop://auth?token=tok&challenge=ffffffffffffffffffffffffffffffff&challenge=0123456789abcdef0123456789abcdef")!) == nil,
               "first challenge wins")

        // Fresh challenges: 32 hex digits, different every time.
        let challenges = (0..<20).map { _ in ProviderSignIn.newChallenge() }
        for challenge in challenges {
            expect(challenge.count == 32 && challenge.allSatisfy { "0123456789abcdef".contains($0) }, "challenge shape \(challenge)")
        }
        expect(Set(challenges).count == challenges.count, "challenges are unique")

        // The provider list follows the server's public config, in the web page's order.
        let decoder = JSONDecoder()
        let all = try decoder.decode(LoginProviders.self, from: Data(#"{"enabled":true,"displayName":"Acme SSO","google":true,"microsoft":true}"#.utf8))
        expect(all.available == [.google, .microsoft, .oidc], "provider order")
        expect(all.label(for: .oidc) == "Acme SSO" && all.label(for: .google) == "Google" && all.label(for: .microsoft) == "Microsoft", "labels")
        let bare = try decoder.decode(LoginProviders.self, from: Data(#"{"enabled":true,"google":false,"microsoft":false}"#.utf8))
        expect(bare.available == [.oidc] && bare.label(for: .oidc) == "SSO", "SSO without a display name")
        let none = try decoder.decode(LoginProviders.self, from: Data(#"{"enabled":false,"google":false,"microsoft":false}"#.utf8))
        expect(none.available.isEmpty && none == LoginProviders.none, "no providers")
        // An older server that predates the Apple flags still decodes; a newer one's flags are read.
        expect(!none.appleNative, "missing Apple flags read as off")
        let apple = try decoder.decode(LoginProviders.self, from: Data(#"{"enabled":false,"google":false,"microsoft":false,"apple":true,"appleNative":true}"#.utf8))
        expect(apple.appleNative && apple.available.isEmpty, "native Apple is not a browser provider")
        let empty = try decoder.decode(LoginProviders.self, from: Data("{}".utf8))
        expect(empty == LoginProviders.none, "an empty object is no providers")
    }

    private static func expect(_ condition: Bool, _ message: String) { precondition(condition, message) }
}
