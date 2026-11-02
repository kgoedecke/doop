import Foundation
import DoopCore

enum CanvasSocketChecks {
    static func run() throws {
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let task = CanvasSocket.task(session: session, request: URLRequest(url: URL(string: "wss://doop.design/ws")!))
        defer { task.cancel(with: .goingAway, reason: nil) }
        // A canvas can contain many megabytes of HTML. Check the actual socket
        // factory and decode an init larger than the old limit without dialing.
        let html = "<p>" + String(repeating: "x", count: 2 * 1024 * 1024) + "</p>"
        let data = try JSONSerialization.data(withJSONObject: [
            "type": "init", "canvas": ["id": "c", "name": "Large canvas", "frames": [
                ["id": "f", "canvasId": "c", "name": "Frame", "x": 0, "y": 0, "width": 390, "height": 844, "html": html]
            ]], "presences": [], "tasks": [], "comments": []
        ])
        precondition(data.count > 1024 * 1024 && data.count < task.maximumMessageSize)
        let event = try JSONDecoder().decode(CanvasEvent.self, from: data)
        precondition(event.canvas?.frames.first?.html == html)

        let lost = URLError(.networkConnectionLost)
        precondition(CanvasSocket.failure(for: lost, closeCode: 0).shouldRetry)
        precondition(CanvasSocket.failure(for: URLError(.notConnectedToInternet), closeCode: 0) == .interrupted)
        precondition(CanvasSocket.failure(for: lost, closeCode: 4401) == .sessionExpired)
        precondition(CanvasSocket.failure(for: lost, closeCode: 4403) == .accessDenied)
        precondition(CanvasSocket.failure(for: lost, closeCode: 4404) == .notFound)
        precondition(CanvasSocket.failure(for: lost, closeCode: 1009) == .messageTooLarge)
        let oversized = NSError(domain: NSPOSIXErrorDomain, code: Int(POSIXErrorCode.EMSGSIZE.rawValue))
        precondition(CanvasSocket.failure(for: oversized, closeCode: 0) == .messageTooLarge)
        let malformed = DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "fixture"))
        precondition(CanvasSocket.failure(for: malformed, closeCode: 0) == .invalidData)
        for failure: CanvasSocket.Failure in [.sessionExpired, .accessDenied, .notFound, .messageTooLarge, .invalidData] {
            precondition(!failure.shouldRetry, "Permanent failures must not enter a reconnect loop")
            precondition(!failure.message.contains("Reconnecting"))
        }
        print("Canvas socket checks passed.")
    }
}
