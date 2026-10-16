import Foundation
import DoopCore

enum AppleSignInChecks {
    static func run() {
        // SHA-256 of "abc", the standard test vector, as lowercase hex.
        expect(AppleSignIn.hashedNonce("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "nonce hashing")
        expect(AppleSignIn.hashedNonce("abc") != AppleSignIn.hashedNonce("abd"), "hash differs per nonce")

        let first = AppleSignIn.body(identityToken: "jwt", nonce: "raw", givenName: "Ada", familyName: "Lovelace")
        expect(first["provider"] as? String == "apple", "provider")
        let idToken = first["idToken"] as? [String: Any]
        expect(idToken?["token"] as? String == "jwt" && idToken?["nonce"] as? String == "raw", "token and raw nonce")
        let name = (idToken?["user"] as? [String: Any])?["name"] as? [String: String]
        expect(name == ["firstName": "Ada", "lastName": "Lovelace"], "first sign-in carries the name")

        // Later sign-ins: Apple sends no name, and the body must not invent an empty one.
        let later = AppleSignIn.body(identityToken: "jwt", nonce: "raw", givenName: nil, familyName: "")
        expect(((later["idToken"] as? [String: Any])?["user"]) == nil, "no name, no user object")
        expect(JSONSerialization.isValidJSONObject(first) && JSONSerialization.isValidJSONObject(later), "bodies serialise")
    }

    private static func expect(_ condition: Bool, _ message: String) { precondition(condition, message) }
}
