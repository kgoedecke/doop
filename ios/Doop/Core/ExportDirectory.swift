import Foundation

/// Give each download its own directory so equal names never overwrite each other.
public struct ExportDirectory {
    public let root: URL

    public init(root: URL = FileManager.default.temporaryDirectory.appendingPathComponent("DoopExports", isDirectory: true)) {
        self.root = root
    }

    public func destination(suggestedFilename: String) throws -> URL {
        let directory = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let name = (suggestedFilename as NSString).lastPathComponent
            .components(separatedBy: .controlCharacters).joined()
        let safeName = name.isEmpty || name == "." || name == ".." ? "Doop export" : String(name.prefix(120))
        return directory.appendingPathComponent(safeName, isDirectory: false)
    }

    public func remove(_ file: URL) throws {
        let directory = file.deletingLastPathComponent().standardizedFileURL
        guard directory.deletingLastPathComponent() == root.standardizedFileURL,
              UUID(uuidString: directory.lastPathComponent) != nil else { return }
        try FileManager.default.removeItem(at: directory)
    }
}
