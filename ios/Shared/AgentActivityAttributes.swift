import ActivityKit
import Foundation

@available(iOS 16.1, *)
struct AgentActivityAttributes: ActivityAttributes {
    typealias ContentState = AgentActivityState
    let canvasID: String
    let serverOrigin: String
}

/// The link a Live Activity opens: `doop://canvas/<id>?server=<origin>`.
/// ContentView answers it by opening that canvas when the app is signed in
/// to the same server.
enum CanvasLink {
    static func url(canvasID: String, serverOrigin: String) -> URL? {
        var components = URLComponents()
        components.scheme = "doop"
        components.host = "canvas"
        components.path = "/" + canvasID
        components.queryItems = [URLQueryItem(name: "server", value: serverOrigin)]
        return components.url
    }

    static func parse(_ url: URL) -> (canvasID: String, serverOrigin: String)? {
        guard url.scheme == "doop", url.host == "canvas",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let server = components.queryItems?.first(where: { $0.name == "server" })?.value else { return nil }
        let id = String(url.path.dropFirst())
        return id.isEmpty ? nil : (id, server)
    }
}
