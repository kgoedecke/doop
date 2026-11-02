import Foundation

public enum CanvasSocket {
    // The server sends all frame HTML, comments and history in a single `init`.
    // Foundation's 1 MiB default disconnects otherwise healthy large canvases.
    public static let maximumMessageSize = 64 * 1024 * 1024

    public static func task(session: URLSession, request: URLRequest) -> URLSessionWebSocketTask {
        let task = session.webSocketTask(with: request)
        task.maximumMessageSize = maximumMessageSize
        return task
    }

    public enum Failure: Equatable {
        case interrupted, sessionExpired, accessDenied, notFound, messageTooLarge, invalidData

        public var message: String {
            switch self {
            case .interrupted: return "Connection interrupted. Reconnecting…"
            case .sessionExpired: return "Your session expired. Return to the library and sign in again."
            case .accessDenied: return "You no longer have access to this canvas."
            case .notFound: return "This canvas no longer exists."
            case .messageTooLarge: return "This canvas is too large to load live on iOS. Open it in the web app."
            case .invalidData: return "This canvas update could not be read. Update the app or reopen the canvas to try again."
            }
        }

        public var shouldRetry: Bool { self == .interrupted }
    }

    public static func failure(for error: Error, closeCode: Int) -> Failure {
        switch closeCode {
        case 4401: return .sessionExpired
        case 4403: return .accessDenied
        case 4404: return .notFound
        case URLSessionWebSocketTask.CloseCode.messageTooBig.rawValue: return .messageTooLarge
        default: break
        }
        let nsError = error as NSError
        if nsError.domain == NSPOSIXErrorDomain && nsError.code == Int(POSIXErrorCode.EMSGSIZE.rawValue) {
            return .messageTooLarge
        }
        if error is DecodingError { return .invalidData }
        return .interrupted
    }
}
