import SwiftUI
import UniformTypeIdentifiers
import WebKit

/// Capture the target before any asynchronous work; a later tap must never retarget an edit.
struct CanvasSelection: Sendable {
    let frame: DesignFrame
    let element: SelectedElement?
    var name: String { element?.label ?? frame.name }

    func link(origin: URL) -> URL {
        var url = URLComponents(url: origin.appendingPathComponent("c/\(frame.canvasId)"), resolvingAgainstBaseURL: false)!
        url.queryItems = [URLQueryItem(name: "frame", value: frame.id)]
        if let element { url.queryItems?.append(URLQueryItem(name: "selector", value: element.selector)) }
        return url.url!
    }
}

struct CanvasClipboard: Codable {
    static let type = "design.doop.canvas-selection"
    let frame: DesignFrame
    /// nil means a complete frame; otherwise this is the selected element's markup.
    let markup: String?

    @MainActor static var isAvailable: Bool { UIPasteboard.general.contains(pasteboardTypes: [type]) }

    @MainActor func write() throws {
        UIPasteboard.general.setItems([[
            Self.type: try JSONEncoder().encode(self),
            UTType.html.identifier: Data((markup ?? frame.html).utf8),
            UTType.utf8PlainText.identifier: markup ?? frame.html,
        ]])
    }

    @MainActor static func read() throws -> Self {
        guard let data = UIPasteboard.general.data(forPasteboardType: type),
              let value = try? JSONDecoder().decode(Self.self, from: data),
              value.frame.width.isFinite, value.frame.height.isFinite,
              (1...10000).contains(value.frame.width), (1...10000).contains(value.frame.height) else {
            throw SelectionError.message("Copy an element or frame in Doop first.")
        }
        return value
    }
}

enum SelectionError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}

/// WebKit supplies a standards-compliant HTML parser only. Rendering stays in Blitz.
@MainActor
final class SelectionDOM {
    static func apply(_ action: String, to selection: CanvasSelection, markup: String = "") async throws -> String {
        guard let source = Bundle.main.url(forResource: "SelectionDOM", withExtension: "js") else {
            throw SelectionError.message("The selection editor is unavailable.")
        }
        let script = try String(contentsOf: source, encoding: .utf8)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        // DOMParser is inert, and this also prevents its images/iframes from making requests.
        let rules = try await WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: "DoopSelectionEditor",
            encodedContentRuleList: #"[{"trigger":{"url-filter":".*"},"action":{"type":"block"}}]"#)
        if let rules { configuration.userContentController.add(rules) }
        let web = WKWebView(frame: .zero, configuration: configuration)
        let result: Any?
        do {
            result = try await web.callAsyncJavaScript(
                script + "\nreturn globalThis.doopEditSelection(html, selector, action, markup);",
                arguments: ["html": selection.frame.html, "selector": selection.element?.selector ?? "", "action": action, "markup": markup],
                in: nil, contentWorld: .defaultClient)
        } catch {
            if let message = (error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String {
                throw SelectionError.message(message)
            }
            throw error
        }
        guard let html = result as? String else { throw SelectionError.message("Couldn’t edit this selection.") }
        return html
    }
}

/// Render a fresh, full-resolution selection, independent of the canvas camera and overlays.
enum SelectionImageExport {
    @MainActor static func png(_ selection: CanvasSelection, origin: URL) async throws -> URL {
        // The engine's selector may use a non-unique ID in malformed source HTML.
        // Reject that target before a fresh document can resolve it to another node.
        if selection.element != nil { _ = try await SelectionDOM.apply("copy", to: selection) }
        return try await withCheckedThrowingContinuation { continuation in
            BlitzDocument.queue.async {
                let frame = selection.frame
                let bounds = CGRect(x: 0, y: 0, width: frame.width, height: frame.height)
                var region = (selection.element?.rect ?? bounds).intersection(bounds)
                guard !region.isNull, region.width > 0, region.height > 0 else {
                    continuation.resume(throwing: SelectionError.message("This selection has no visible image area.")); return
                }
                // Bound memory for large designs while giving typical phone frames a crisp 2× image.
                func density(for region: CGRect) -> CGFloat {
                    min(2, 4096 / max(region.width, region.height), sqrt(8_000_000 / (region.width * region.height)))
                }
                let document = BlitzDocument(html: frame.html, baseURL: origin, width: frame.width, height: frame.height, scale: 1)
                func paint(attempt: Int) {
                    _ = document.render(region: region, density: density(for: region))
                    if document.isLoading {
                        guard attempt < 100 else {
                            continuation.resume(throwing: SelectionError.message("Images or fonts are still loading. Try exporting again.")); return
                        }
                        BlitzDocument.queue.asyncAfter(deadline: .now() + 0.1) { paint(attempt: attempt + 1) }
                        return
                    }
                    do {
                        // A resource may finish between the paint and isLoading.
                        // Paint once more to ingest every completed font/image.
                        var image = document.render(region: region, density: density(for: region))
                        // Fonts and images can move the element during this fresh layout.
                        if let element = selection.element {
                            guard let node = document.element(matching: element.selector),
                                  let rect = document.info(for: node)?.frameRect else {
                                throw SelectionError.message("Couldn’t find this element in the exported design.")
                            }
                            region = rect.intersection(bounds)
                            guard !region.isNull, region.width > 0, region.height > 0 else {
                                throw SelectionError.message("This selection has no visible image area.")
                            }
                            image = document.render(region: region, density: density(for: region))
                        }
                        guard let image, let data = UIImage(cgImage: image).pngData() else {
                            throw SelectionError.message("Couldn’t render this selection as an image.")
                        }
                        let url = try ExportDirectory().destination(suggestedFilename: String(selection.name.prefix(100)) + ".png")
                        try data.write(to: url, options: .atomic)
                        continuation.resume(returning: url)
                    } catch { continuation.resume(throwing: error) }
                }
                paint(attempt: 0)
            }
        }
    }
}

struct SelectionExportPanel: View {
    let selection: CanvasSelection
    let origin: URL
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false
    @State private var error: String?
    @State private var copied = false
    @State private var share: ExportShare?
    @State private var files: [URL] = []

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button { export(image: true) } label: { Label("Share as image", systemImage: "photo") }
                        .accessibilityIdentifier("canvas.exportImage")
                    Button { export(image: false) } label: { Label("Export HTML", systemImage: "doc.text") }
                        .accessibilityIdentifier("canvas.exportHTML")
                } footer: {
                    Text("Share a PNG to your apps, or save it to Photos or Files.")
                }.disabled(busy)
                Section {
                    Button {
                        UIPasteboard.general.url = selection.link(origin: origin)
                        copied = true
                    } label: { Label(copied ? "Link copied" : "Copy link", systemImage: copied ? "checkmark" : "link") }
                        .accessibilityIdentifier("canvas.copyLink")
                    ShareLink(item: selection.link(origin: origin)) { Label("Share link", systemImage: "square.and.arrow.up") }
                }
                if busy { HStack { ProgressView(); Text("Preparing export…") } }
                if let error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle("Export selection").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.disabled(busy) } }
            .sheet(item: $share) { item in NativeExportShare(url: item.url) }
        }
        .interactiveDismissDisabled(busy)
        .onDisappear { for file in files { try? ExportDirectory().remove(file) } }
    }

    private func export(image: Bool) {
        busy = true; error = nil
        Task {
            do {
                let url: URL
                if image { url = try await SelectionImageExport.png(selection, origin: origin) }
                else {
                    let html = selection.element == nil ? selection.frame.html : try await SelectionDOM.apply("copy", to: selection)
                    url = try ExportDirectory().destination(suggestedFilename: String(selection.name.prefix(100)) + ".html")
                    try Data(html.utf8).write(to: url, options: .atomic)
                }
                files.append(url)
                share = ExportShare(url: url)
            } catch { self.error = error.localizedDescription }
            busy = false
        }
    }
}

private struct ExportShare: Identifiable {
    let id = UUID()
    let url: URL
}

/// A file URL exposes PNG to installed image-sharing extensions, including social apps.
private struct NativeExportShare: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

@MainActor
extension CanvasModel {
    var selection: CanvasSelection? {
        guard let frame = selected else { return nil }
        return CanvasSelection(frame: frame, element: selectedElement)
    }
    func copySelection(_ selection: CanvasSelection) async throws {
        try validateSelection(selection)
        let markup = selection.element == nil ? nil : try await SelectionDOM.apply("copy", to: selection)
        try CanvasClipboard(frame: selection.frame, markup: markup).write()
    }

    func duplicateSelection(_ selection: CanvasSelection) async throws {
        if selection.element != nil { try await editSelection(selection, action: "duplicate") }
        else {
            try validateSelection(selection, editing: true)
            try await pasteFrame(selection.frame)
        }
    }

    func deleteSelection(_ selection: CanvasSelection) async throws {
        if selection.element != nil { try await editSelection(selection, action: "delete") }
        else {
            try validateSelection(selection, editing: true)
            try await deleteFrame(selection.frame.id)
        }
    }

    func pasteSelection(_ selection: CanvasSelection?) async throws {
        let clipboard = try CanvasClipboard.read()
        if let markup = clipboard.markup {
            guard let selection else { throw SelectionError.message("Select a frame to paste this element into.") }
            try await editSelection(selection, action: "paste", markup: markup)
        } else { try await pasteFrame(clipboard.frame) }
    }

    private func validateSelection(_ selection: CanvasSelection, editing: Bool = false) throws {
        guard let current = canvas?.frames.first(where: { $0.id == selection.frame.id }),
              current.html == selection.frame.html,
              selection.element.map({ $0.frameID == current.id && $0.htmlHash == current.html.hashValue }) ?? true else {
            throw SelectionError.message("This selection changed. Select it again before continuing.")
        }
        if editing && current.locked == true { throw SelectionError.message("Unlock this frame before editing it.") }
    }

    private func editSelection(_ selection: CanvasSelection, action: String, markup: String = "") async throws {
        guard canEdit else { throw SelectionError.message("Connect to the canvas and wait for the current edit to finish, then try again.") }
        try validateSelection(selection, editing: true)
        let html = try await SelectionDOM.apply(action, to: selection, markup: markup)
        // Parsing yields to the run loop. Never overwrite a collaborator's newer HTML.
        try validateSelection(selection, editing: true)
        try await patchFrame(selection.frame.id, patch: ["html": html])
    }

}
