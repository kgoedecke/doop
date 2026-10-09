import Foundation

/// Only whole HTTPS origins are accepted; credentials and path prefixes are never persisted.
public struct ServerAddress: Equatable {
    public let origin: URL

    public init?(_ value: String) {
        guard var parts = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
              parts.scheme?.lowercased() == "https", let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/",
              parts.port.map({ (1...65535).contains($0) }) ?? true else { return nil }
        parts.scheme = "https"
        parts.host = host.lowercased()
        parts.path = ""
        guard let url = parts.url else { return nil }
        origin = url
    }

    public static let hosted = ServerAddress("https://doop.design")!
    public var home: URL { origin.appendingPathComponent("auth") }

    public func contains(_ url: URL) -> Bool {
        url.scheme?.lowercased() == origin.scheme &&
        url.host?.lowercased() == origin.host &&
        (url.port ?? 443) == (origin.port ?? 443) &&
        url.user == nil && url.password == nil
    }
}
