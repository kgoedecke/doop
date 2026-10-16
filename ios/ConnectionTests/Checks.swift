import Foundation

/// Test-only collaborators for the production CanvasModel. The socket and
/// receive/retry loop are real; no live account or server is involved.
@MainActor
final class DoopClient {
    let server: ServerAddress
    let session: URLSession

    init(port: Int) {
        server = ServerAddress("https://127.0.0.1:\(port)")!
        session = URLSession(configuration: .ephemeral, delegate: LoopbackTrust(), delegateQueue: nil)
    }

    func request(_ path: String) throws -> URLRequest {
        URLRequest(url: URL(string: path, relativeTo: server.origin)!.absoluteURL)
    }

    func data(_ path: String, method: String, body: [String: Any]? = nil) async throws -> Data {
        throw URLError(.unsupportedURL)
    }

    func get<T: Decodable>(_ path: String) async throws -> T {
        preconditionFailure("Opening a canvas must not issue a redundant REST download")
    }
}

private final class LoopbackTrust: NSObject, URLSessionDelegate {
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if challenge.protectionSpace.host == "127.0.0.1", let trust = challenge.protectionSpace.serverTrust {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }
}

@MainActor
final class AgentLiveActivities {
    static let shared = AgentLiveActivities()
    func observe(canvas: CanvasDocument?, tasks: [CanvasTask], client: DoopClient) {}
    func endCanvas(id: String, client: DoopClient) async {}
}

@main
struct ConnectionChecks {
    @MainActor static func main() async throws {
        let client = DoopClient(port: Int(CommandLine.arguments[1])!)
        defer { client.session.invalidateAndCancel() }
        let large = CanvasModel(id: "large", client: client)
        large.error = "Keep this unrelated save error"
        large.start()
        try await wait { large.connected }
        precondition(large.canvas!.frames[0].html.utf8.count > 1024 * 1024)
        precondition(large.connectionError == nil && large.error == "Keep this unrelated save error")
        // Cancel and immediately replace a receive; its catch must not alter
        // the replacement's connection status or leave a cancellation banner.
        for _ in 0..<20 {
            large.stop()
            large.start()
            try await wait { large.connected }
            try await Task.sleep(nanoseconds: 20_000_000)
            precondition(large.connected && large.connectionError == nil)
        }
        large.stop()
        try await Task.sleep(nanoseconds: 100_000_000)
        precondition(!large.connected && !large.connecting && large.connectionError == nil)

        let retry = CanvasModel(id: "retry", client: client)
        retry.start()
        try await wait { retry.connectionError != nil }
        try await wait { retry.connected }
        precondition(retry.canvas?.name == "Attempt 2" && retry.connectionError == nil)
        retry.stop()

        let malformed = CanvasModel(id: "malformed", client: client)
        malformed.start()
        try await wait { malformed.connectionError == CanvasSocket.Failure.invalidData.message }
        // A terminated run must release its task so an explicit restart works.
        malformed.connectionError = nil
        malformed.start()
        try await wait { malformed.connectionError == CanvasSocket.Failure.invalidData.message }
        precondition(!malformed.connected && !malformed.connecting)
        malformed.stop()

        let oversized = CanvasModel(id: "oversized", client: client)
        oversized.start()
        try await wait { oversized.connectionError == CanvasSocket.Failure.messageTooLarge.message }
        precondition(!oversized.connected && !oversized.connecting)
        // Wait past the transport retry delay and ask the fixture how many
        // joins it received: the permanent receive error must not reconnect.
        try await Task.sleep(nanoseconds: 2_500_000_000)
        let (attemptData, _) = try await client.session.data(for: client.request("/attempts/oversized"))
        let attempts = try JSONDecoder().decode(Int.self, from: attemptData)
        precondition(attempts == 1 && !oversized.connecting && !oversized.connected)
        oversized.stop()

        let missing = CanvasModel(id: "missing", client: client)
        missing.start()
        try await wait { missing.deleted }
        precondition(missing.connectionError == CanvasSocket.Failure.notFound.message)
        missing.stop()
        print("Canvas connection integration checks passed (large init, 20 restarts, retry, invalid data, oversized receive, deleted canvas).")
    }

    @MainActor private static func wait(_ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(10)
        while !condition() {
            precondition(Date() < deadline, "Timed out waiting for canvas connection")
            try await Task.sleep(nanoseconds: 10_000_000)
        }
    }
}
