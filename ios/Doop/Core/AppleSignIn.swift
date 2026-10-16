import CryptoKit
import Foundation

/// The native Sign in with Apple exchange (`ASAuthorizationAppleIDRequest` on the
/// way out, `POST /api/auth/sign-in/social` on the way back), kept pure so the
/// checks can cover it. The server verifies the identity token against Apple's
/// keys for the app's bundle id (`APPLE_APP_BUNDLE_IDENTIFIER`).
public enum AppleSignIn {
    /// What the request carries: Apple embeds the SHA-256 of the nonce in the
    /// identity token, and the server compares it with the raw nonce we post,
    /// so a token captured elsewhere cannot be replayed into this sign-in.
    public static func hashedNonce(_ nonce: String) -> String {
        SHA256.hash(data: Data(nonce.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// The sign-in body. Apple hands the person's name to the app only on
    /// their first authorization, so it rides along whenever it is present.
    public static func body(identityToken: String, nonce: String, givenName: String?, familyName: String?) -> [String: Any] {
        var idToken: [String: Any] = ["token": identityToken, "nonce": nonce]
        var name: [String: String] = [:]
        if let givenName, !givenName.isEmpty { name["firstName"] = givenName }
        if let familyName, !familyName.isEmpty { name["lastName"] = familyName }
        if !name.isEmpty { idToken["user"] = ["name": name] }
        return ["provider": "apple", "idToken": idToken]
    }
}
