import Foundation

struct APIError: LocalizedError {
    let status: Int
    let message: String
    var errorDescription: String? { message }
}

/// Test-only collaborators for the production CanvasModel. The socket and
/// receive/retry loop are real; no live account or server is involved.
@MainActor
final class DoopClient {
    let server: ServerAddress
    let session: URLSession
    var dataHandler: ((String, String, [String: Any]?) async throws -> Data)?

    init(port: Int) {
        server = ServerAddress("https://127.0.0.1:\(port)")!
        session = URLSession(configuration: .ephemeral, delegate: LoopbackTrust(), delegateQueue: nil)
    }

    func request(_ path: String) throws -> URLRequest {
        URLRequest(url: URL(string: path, relativeTo: server.origin)!.absoluteURL)
    }

    func data(_ path: String, method: String, body: [String: Any]? = nil) async throws -> Data {
        guard let dataHandler else { throw URLError(.unsupportedURL) }
        return try await dataHandler(path, method, body)
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
        let comments = CanvasModel(id: "comments", client: client)
        comments.start()
        try await wait { comments.comments.count == 3 && comments.canvas?.name == "Still live" }
        precondition(comments.connected && comments.connectionError == nil)
        precondition(comments.comments.first { $0.id == "canvas-comment" }?.frameId == nil)
        precondition(comments.comments.first { $0.id == "reply" }?.parentId == "canvas-comment")
        precondition(comments.comments.first { $0.id == "canvas-comment" }?.resolvedAt == 20)
        comments.stop()
        try await checkEdits(client)
        try await checkPages(client)
        print("Canvas connection integration checks passed (large init, 20 restarts, retry, invalid data, oversized receive, deleted canvas, live canvas comments and replies).")
    }

    @MainActor private static func checkEdits(_ client: DoopClient) async throws {
        let model = CanvasModel(id: "edits", client: client)
        model.canvas = try JSONDecoder().decode(CanvasDocument.self, from: Data(#"{"id":"edits","name":"Edits","frames":[],"pages":[{"id":"first-page","name":"First"},{"id":"design-page","name":"Design"}]}"#.utf8))
        model.connected = true
        var frames: [String: [String: Any]] = [:]
        var pages = model.canvas!.pages!
        var sequence = 0
        var failNext = false
        var apiFailure: APIError?
        var createBodies: [[String: Any]] = []
        var missingRequests = 0
        defer { client.dataHandler = nil }
        client.dataHandler = { path, method, body in
            // Undo cannot overtake a request that has not finished saving.
            precondition(!model.canUndo)
            try await Task.sleep(nanoseconds: 10_000_000)
            if failNext { failNext = false; throw URLError(.notConnectedToInternet) }
            if let failure = apiFailure { apiFailure = nil; throw failure }
            if path.hasSuffix("/comments") {
                return Data(#"{"id":"posted","frameId":"f1","from":"Tester","text":"Saved without a socket echo","at":30}"#.utf8)
            }
            let frameID = String(path.split(separator: "/").last!)
            var result: [String: Any] = [:]
            if method == "POST" {
                createBodies.append(body ?? [:])
                if let pageID = body?["pageId"] as? String, !pages.contains(where: { $0.id == pageID }) {
                    throw APIError(status: 400, message: "page not found")
                }
                sequence += 1
                result = body ?? [:]
                result["id"] = "f\(sequence)"; result["canvasId"] = "edits"
                result["pageId"] = body?["pageId"] ?? pages[0].id
                frames["f\(sequence)"] = result
            } else if method == "PATCH" {
                guard frames[frameID] != nil else {
                    missingRequests += 1
                    throw APIError(status: 404, message: "frame not found")
                }
                frames[frameID]!.merge(body ?? [:]) { _, new in new }
                result = frames[frameID]!
            } else if method == "DELETE" {
                guard frames.removeValue(forKey: frameID) != nil else {
                    missingRequests += 1
                    throw APIError(status: 404, message: "frame not found")
                }
            }
            return try JSONSerialization.data(withJSONObject: result)
        }
        await model.addFrame()
        precondition(model.canUndo && model.canvas?.frames.count == 1)
        let original = model.selected!
        try await model.patchFrame(original.id, patch: ["name": "Renamed"])
        // A collaborator changes an unrelated field: undo the local name only.
        frames[original.id]!["html"] = "<p>Collaborator edit</p>"
        let remote = try JSONSerialization.data(withJSONObject: ["type": "frame:updated", "frame": frames[original.id]!])
        model.apply(try JSONDecoder().decode(CanvasEvent.self, from: remote))
        failNext = true
        await model.undo()
        precondition(model.canUndo && model.selected?.name == "Renamed")
        await model.undo()
        precondition(model.selected?.name == original.name && model.selected?.html == "<p>Collaborator edit</p>")
        // A no-op save must not consume a later undo step.
        try await model.patchFrame(original.id, patch: ["name": original.name])
        failNext = true
        do {
            try await model.patchFrame(original.id, patch: ["name": "Must not be recorded"])
            preconditionFailure("Expected save failure")
        } catch {}
        await model.moveFrame(original.id, x: 120, y: 80)
        precondition(model.selected?.x == 120)
        await model.undo()
        precondition(model.selected?.x == original.x && model.selected?.y == original.y)
        frames[original.id]!["pageId"] = "design-page"
        frames[original.id]!["hidden"] = true
        frames[original.id]!["locked"] = true
        try await model.patchFrame(original.id, patch: ["name": "Before deleting"])
        try await model.deleteFrame(original.id)
        precondition(model.canvas?.frames.isEmpty == true)
        await model.undo()
        precondition(model.selected?.id == "f2" && model.selected?.name == "Before deleting")
        precondition(model.selected?.pageId == "design-page" && model.selected?.hidden == true && model.selected?.locked == true)
        await model.undo()
        precondition(model.selected?.name == original.name)
        await model.undo()
        precondition(model.canvas?.frames.isEmpty == true && !model.canUndo)
        await model.addFrame()
        await model.undo()
        failNext = true
        await model.addFrame()
        precondition(!model.canUndo, "A failed edit must not create undo history")
        // Clipboard frame copies belong to the destination page and undo as one creation.
        var copiedSource = original
        copiedSource.locked = true; copiedSource.hidden = true
        model.selectPage("design-page")
        try await model.pasteFrame(copiedSource)
        precondition(model.selected?.id != original.id && model.selected?.pageId == "design-page")
        precondition(model.selected?.html == original.html && model.selected?.width == original.width)
        precondition(model.selected?.name == original.name + " copy")
        precondition(model.selected?.hidden != true && model.selected?.locked != true)
        await model.undo()
        precondition(!model.canUndo && model.canvas?.frames.isEmpty == true)
        failNext = true
        do { try await model.pasteFrame(original); preconditionFailure("Expected paste failure") } catch {}
        precondition(!model.canUndo && model.canvas?.frames.isEmpty == true)
        try await model.comment("Saved without a socket echo", frameID: "f1")
        precondition(model.comments.count == 1)
        let echo = try JSONSerialization.data(withJSONObject: ["type": "comment", "comment": ["id": "posted", "frameId": "f1", "from": "Tester", "text": "Saved without a socket echo", "at": 30]])
        model.apply(try JSONDecoder().decode(CanvasEvent.self, from: echo))
        precondition(model.comments.count == 1)

        // A missing frame must not hide older edits, whether its deletion event
        // has already arrived or the REST response is the first confirmation.
        for receivedDelete in [false, true] {
            await model.addFrame()
            let older = model.selected!
            try await model.patchFrame(older.id, patch: ["name": "Older edit"])
            await model.addFrame()
            let missingID = model.selected!.id
            try await model.patchFrame(missingID, patch: ["name": "First edit"])
            try await model.patchFrame(missingID, patch: ["name": "Second edit"])
            frames.removeValue(forKey: missingID)
            if receivedDelete {
                try apply(["type": "frame:deleted", "frameId": missingID], to: model)
            }
            model.error = nil
            let beforeRequests = missingRequests
            await model.undo()
            precondition(model.selected?.id == older.id && model.selected?.name == older.name)
            precondition(model.error == nil && model.canvas?.frames.count == 1)
            await model.undo()
            precondition(!model.canUndo && frames.isEmpty && model.canvas?.frames.isEmpty == true)
            precondition(missingRequests == beforeRequests + 1, "Discard all obsolete edits for the missing frame")
        }
        // Undoing a creation that a collaborator already deleted is also done.
        await model.addFrame()
        frames.removeValue(forKey: model.selected!.id)
        await model.undo()
        precondition(!model.canUndo && model.selectedID == nil && model.canvas?.frames.isEmpty == true)

        await model.addFrame()
        let retryFrame = model.selected!
        try await model.patchFrame(retryFrame.id, patch: ["name": "Retry this edit"])
        for status in [401, 403, 500, 503] {
            apiFailure = APIError(status: status, message: "Retry after access or server recovery")
            await model.undo()
            precondition(model.canUndo && model.selected?.name == "Retry this edit")
        }
        await model.undo()
        precondition(model.selected?.name == retryFrame.name)
        await model.undo()
        precondition(!model.canUndo && frames.isEmpty)

        // Restore after the web client removes the original page. Cover both
        // the live page event and a delayed event that races with the POST.
        let originalPages = pages
        for receivedPages in [true, false] {
            pages = originalPages
            try apply(["type": "canvas:pages", "pages": pages.map { ["id": $0.id, "name": $0.name] }], to: model)
            await model.addFrame()
            let deletedID = model.selected!.id
            frames[deletedID]!["pageId"] = "design-page"
            try await model.patchFrame(deletedID, patch: ["name": "Restore this frame"])
            try await model.deleteFrame(deletedID)
            pages.removeAll { $0.id == "design-page" }
            if receivedPages {
                try apply(["type": "canvas:pages", "pages": pages.map { ["id": $0.id, "name": $0.name] }], to: model)
                precondition(model.canvas?.pages?.map(\.id) == ["first-page"])
            }
            model.error = nil
            let beforeCreates = createBodies.count
            await model.undo()
            precondition(model.selected?.name == "Restore this frame" && model.selected?.pageId == "first-page")
            precondition(model.error == nil && frames.count == 1)
            if receivedPages {
                precondition(createBodies.count == beforeCreates + 1)
                precondition(createBodies.last?["pageId"] as? String == "first-page")
            } else {
                precondition(createBodies.count == beforeCreates + 2)
                precondition(createBodies.last?["pageId"] == nil, "Let the server choose an existing page after a stale-page rejection")
            }
            await model.undo()
            precondition(model.selected?.name == "Untitled frame", "Older edits must follow the restored frame on its new page")
            await model.undo()
            precondition(!model.canUndo && frames.isEmpty)
        }
        // A 404 while restoring refers to the canvas, not an obsolete frame edit.
        await model.addFrame()
        try await model.deleteFrame(model.selected!.id)
        apiFailure = APIError(status: 404, message: "not found")
        await model.undo()
        precondition(model.canUndo && frames.isEmpty)
        await model.undo()
        precondition(model.canvas?.frames.count == 1)
        await model.undo()
        precondition(!model.canUndo && frames.isEmpty)
        print("Canvas edit checks passed (undo create/edit/move/delete, ID remapping, failed saves, retry, collaborator fields, comment post/echo).")
        print("Collaborative undo checks passed (deleted frames, deleted pages, delayed page events, access/server failure retry, failed restoration).")
    }

    @MainActor private static func apply(_ event: [String: Any], to model: CanvasModel) throws {
        let data = try JSONSerialization.data(withJSONObject: event)
        model.apply(try JSONDecoder().decode(CanvasEvent.self, from: data))
    }

    @MainActor private static func checkPages(_ client: DoopClient) async throws {
        let model = CanvasModel(id: "pages", client: client)
        func frame(_ id: String, page: String? = nil, x: Double = 0) -> [String: Any] {
            var result: [String: Any] = ["id": id, "canvasId": "pages", "name": id, "x": x, "y": 0,
                                         "width": 100, "height": 100, "html": "<p>\(id)</p>"]
            if let page { result["pageId"] = page }
            return result
        }
        let pages = [["id": "a", "name": "First"], ["id": "b", "name": "Second"], ["id": "empty", "name": "Empty"]]
        let originals = [frame("a1", page: "a", x: 10_000), frame("b1", page: "b"), frame("legacy")]
        func snapshot(_ pages: [[String: String]], frames: [[String: Any]]) throws {
            try apply(["type": "init", "canvas": ["id": "pages", "name": "Pages", "pages": pages, "frames": frames]], to: model)
        }
        try snapshot(pages, frames: originals)
        precondition(model.activePageID == "a" && model.pageFrames.map(\.id) == ["a1", "legacy"])
        model.select("a1")
        model.selectedElement = SelectedElement(frameID: "a1", nodeID: 1, selector: "p", label: "p", text: "a1", rect: .zero, htmlHash: model.selected!.html.hashValue)
        let pickedElement = model.selectedElement
        model.select("a1")
        precondition(model.selectedID == "a1" && model.selectedElement == nil && model.promptScope?.isElement == false,
                     "Choosing the current frame clears the element scope for whole-frame actions")
        model.selectedElement = pickedElement
        let fit = model.viewportCommand
        model.selectPage("b")
        precondition(model.pageFrames.map(\.id) == ["b1"] && model.selectedID == nil && model.selectedElement == nil && model.promptScope == nil)
        precondition(model.viewportCommand > fit)
        model.selectPage("not-a-page")
        precondition(model.activePageID == "b")
        try snapshot(pages, frames: originals)
        precondition(model.activePageID == "b", "Reconnection keeps a page that still exists")

        func comment(_ id: String, frameID: String? = nil, page: String? = nil, parent: String? = nil) -> [String: Any] {
            var result: [String: Any] = ["id": id, "from": "Web", "text": id, "at": 1]
            if let frameID { result["frameId"] = frameID }
            if let page { result["pageId"] = page }
            if let parent { result["parentId"] = parent }
            return result
        }
        for value in [comment("on-a", frameID: "a1"), comment("on-b", frameID: "b1"),
                      comment("pin-b", page: "b"), comment("reply-b", parent: "pin-b"),
                      comment("orphan", page: "b", parent: "missing"), comment("deleted", frameID: "missing")] {
            try apply(["type": "comment", "comment": value], to: model)
        }
        precondition(Set(model.pageComments.map(\.id)) == ["on-b", "pin-b", "reply-b"])
        model.selectPage("a")
        precondition(model.pageComments.map(\.id) == ["on-a"])
        try apply(["type": "frame:updated", "frame": frame("b1", page: "a")], to: model)
        precondition(Set(model.pageComments.map(\.id)) == ["on-a", "on-b"], "Frame comments follow the frame's page")

        func viewport(_ page: String) -> [String: Any] {
            ["pageId": page, "x": 0, "y": 0, "zoom": 1, "width": 390, "height": 844]
        }
        try apply(["type": "presence:join", "presence": ["clientId": "web", "name": "Web", "kind": "user", "color": "#fff", "cursor": ["x": 20, "y": 20], "viewport": viewport("b")]], to: model)
        precondition(model.pagePresences.isEmpty)
        try apply(["type": "viewport", "clientId": "web", "viewport": viewport("a")], to: model)
        precondition(model.pagePresences.map(\.clientId) == ["web"])

        model.select("a1")
        let beforeRemote = model.viewportCommand
        try apply(["type": "frame:created", "frame": frame("remote", page: "b")], to: model)
        precondition(!model.pageFrames.contains { $0.id == "remote" } && model.selectedID == "a1" && model.viewportCommand == beforeRemote)
        try apply(["type": "frame:updated", "frame": frame("a1", page: "b")], to: model)
        precondition(model.activePageID == "a" && model.selectedID == nil, "A remote move clears selection without changing pages")
        try apply(["type": "canvas:pages", "pages": [pages[1], ["id": "a", "name": "Renamed"], pages[2]]], to: model)
        precondition(model.activePage.name == "Renamed" && model.pageFrames.contains { $0.id == "legacy" })
        precondition(model.canvas?.frames.first { $0.id == "legacy" }?.pageId == "a", "Reordering must preserve the old first page of legacy frames")
        model.selectPage("empty")
        precondition(model.pageFrames.isEmpty && model.pageComments.isEmpty)
        try apply(["type": "canvas:pages", "pages": [pages[1], pages[0]]], to: model)
        precondition(model.activePageID == "b", "Removing the active page falls back to the current first page")
        try snapshot([pages[0]], frames: [originals[0]])
        precondition(model.activePageID == "a", "Reconnect also recovers from a removed page")

        try snapshot(pages, frames: originals)
        var savedFrames = Dictionary(uniqueKeysWithValues: originals.map { ($0["id"] as! String, $0) })
        var requests: [[String: Any]] = []
        var switchDuringSave = false
        var sequence = 0
        defer { client.dataHandler = nil }
        client.dataHandler = { path, method, body in
            let id = String(path.split(separator: "/").last!)
            var result: [String: Any] = [:]
            if method == "POST" {
                requests.append(body ?? [:])
                sequence += 1
                result = body ?? [:]
                result["id"] = "new-\(sequence)"; result["canvasId"] = "pages"
                savedFrames["new-\(sequence)"] = result
                if switchDuringSave { model.selectPage("a") }
            } else if method == "PATCH" {
                savedFrames[id]!.merge(body ?? [:]) { _, new in new }
                result = savedFrames[id]!
            } else if method == "DELETE" { savedFrames.removeValue(forKey: id) }
            return try JSONSerialization.data(withJSONObject: result)
        }
        model.selectPage("b")
        await model.addFrame()
        precondition(requests.last?["pageId"] as? String == "b" && requests.last?["x"] as? Double == 180)
        precondition(model.selected?.pageId == "b" && model.pageFrames.count == 2)
        await model.undo()
        model.selectPage("empty")
        await model.addFrame()
        precondition(requests.last?["pageId"] as? String == "empty" && requests.last?["x"] as? Double == 0)
        await model.undo()
        precondition(model.pageFrames.isEmpty)
        model.selectPage("b")
        switchDuringSave = true
        await model.addFrame()
        precondition(model.activePageID == "a" && model.selectedID == nil && !model.pageFrames.contains { $0.id == "new-3" })
        precondition(savedFrames["new-3"]?["pageId"] as? String == "b", "A pending add stays on the page where it started")
        await model.undo()
        switchDuringSave = false
        try await model.patchFrame("a1", patch: ["name": "Edited first page"])
        model.selectPage("b")
        await model.undo()
        precondition(model.activePageID == "a" && model.selected?.name == "a1", "Undo reveals the affected frame's page")
        try await model.deleteFrame("a1")
        model.selectPage("b")
        await model.undo()
        precondition(model.activePageID == "a" && model.selected?.pageId == "a", "Restoring a frame reveals its page")

        for pageList: [[String: String]]? in [nil, []] {
            var document: [String: Any] = ["id": "pages", "name": "Legacy", "frames": [frame("legacy")]]
            if let pageList { document["pages"] = pageList }
            try apply(["type": "init", "canvas": document], to: model)
            precondition(model.activePageID == "pages:page1" && model.activePage.name == "Page 1" && model.pageFrames.count == 1)
        }
        print("Canvas page checks passed (isolated frames/comments/cursors, switching, selection, live updates, reconnect, legacy frames, page-local creation and cross-page undo).")
    }

    @MainActor private static func wait(_ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(10)
        while !condition() {
            precondition(Date() < deadline, "Timed out waiting for canvas connection")
            try await Task.sleep(nanoseconds: 10_000_000)
        }
    }
}
