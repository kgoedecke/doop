import AuthenticationServices
import UIKit

/// The person closed the browser sheet before finishing; not an error to show.
struct SignInCancelled: Error {}

/// Runs a provider sign-in (`ProviderSignIn`) in the system browser sheet and
/// returns the `doop://auth` callback it ends on. The sheet shares Safari's
/// cookies, so a Google or Microsoft account already signed in there is one
/// tap away, and a browser that already holds a doop session skips the
/// provider entirely.
@MainActor
final class WebSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
    func run(_ url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: ProviderSignIn.callbackScheme) { callback, error in
                if let callback { continuation.resume(returning: callback); return }
                if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                    continuation.resume(throwing: SignInCancelled())
                } else {
                    continuation.resume(throwing: error ?? APIError(status: 0, message: "Could not open the sign-in page."))
                }
            }
            session.presentationContextProvider = self
            if !session.start() { continuation.resume(throwing: APIError(status: 0, message: "Could not open the sign-in page.")) }
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let windows = scenes.flatMap(\.windows)
        return windows.first { $0.isKeyWindow } ?? windows.first ?? ASPresentationAnchor()
    }
}
