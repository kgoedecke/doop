import ActivityKit
import Foundation

@available(iOS 16.1, *)
struct AgentActivityAttributes: ActivityAttributes {
    typealias ContentState = AgentActivityState
    let canvasID: String
    let serverOrigin: String
}

/// The link a Live Activity or Safari banner opens: `doop://canvas/<id>?server=<origin>`.
/// ContentView answers it by opening that canvas when the app is signed in
/// to the same server.
struct CanvasLink: Equatable {
    let canvasID: String
    let serverOrigin: String

    static func url(canvasID: String, serverOrigin: String) -> URL? {
        var components = URLComponents()
        components.scheme = "doop"
        components.host = "canvas"
        components.path = "/" + canvasID
        components.queryItems = [URLQueryItem(name: "server", value: serverOrigin)]
        return components.url
    }

    static func parse(_ url: URL) -> CanvasLink? {
        guard url.scheme == "doop", url.host == "canvas",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let server = components.queryItems?.first(where: { $0.name == "server" })?.value else { return nil }
        let id = String(url.path.dropFirst())
        // Canvas IDs are a single URL path segment, including when used for a REST lookup.
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.~")
        guard !id.isEmpty, id != ".", id != "..", id.unicodeScalars.allSatisfy(allowed.contains) else { return nil }
        return CanvasLink(canvasID: id, serverOrigin: server)
    }
}
