import CoreGraphics
import Combine
import Foundation
import os

@MainActor
final class CanvasModel: ObservableObject {
    let id: String
    let client: DoopClient
    @Published var canvas: CanvasDocument? {
        didSet {
            // Full frame events and reconnect snapshots can still contain the
            // pre-drop position. Overlay pending moves at every model entry.
            if var document = canvas, pendingMoves.apply(to: &document.frames) { canvas = document }
            if !pages.contains(where: { $0.id == activePageID }) { selectPage(pages[0].id) }
            pruneSelection()
        }
    }
    @Published var tasks: [CanvasTask] = [] {
        didSet { scheduleStartingExpiry() }
    }
    @Published var comments: [CanvasComment] = []
    @Published var presences: [CanvasPresence] = []
    /// Frames an agent is streaming a design into right now, by frame id.
    @Published var streams: [String: FrameStream] = [:]
    @Published var selectedID: String?
    @Published private(set) var activePageID: String
    @Published var connected = false
    @Published var connecting = false
    @Published var connectionError: String?
    @Published var error: String?
    @Published var deleted = false
    @Published var selectedElement: SelectedElement?
    /// A thread whose pin was tapped on the canvas: the comments panel opens on it.
    @Published var focusedCommentID: String?
    /// A comment being written at a spot the person long-pressed, shown as a draft pin.
    @Published var commentDraft: CommentDraft?
    /// A frame the canvas should glide to and fit; the canvas clears it once there.
    @Published var flyToFrameID: String?
    /// A thread picked in the Comments list: the canvas moves to its pin, then clears this.
    @Published var flyToCommentID: String?
    @Published var viewportCommand = 0
    /// Measured composer height, used when fitting frames above the floating controls.
    var composerHeight: CGFloat = 160
    @Published private var undoStack: [UndoEntry] = []
    @Published private var pendingEdits = 0
    @Published private var undoing = false
    private var moveOrigins: [String: DesignFrame] = [:]
    private struct UndoEntry {
        enum Kind { case update, create, delete }
        var kind: Kind
        var frameID: String
        var body: [String: Any]
    }
    private var connection: Task<Void, Never>?
    /// Wakes the canvas when a "Starting…" pill's window ends (`WorkingAgents.startingExpiry`).
    private var startingExpiry: Task<Void, Never>?
    /// Bumped by that wake-up: a change the pills redraw on, since time passing is none.
    @Published private var startingTick = 0
    private var connectionID: UUID?
    private var socket: URLSessionWebSocketTask?
    private let clientID = "ios-" + UUID().uuidString
    private var pendingMoves = PendingFrameMoves()
    private let connectionLog = Logger(subsystem: "design.doop.ios", category: "canvas.connection")

    init(id: String, client: DoopClient) {
        self.id = id; self.client = client; self.activePageID = "\(id):page1"
    }
    var pages: [CanvasPage] { canvas?.effectivePages ?? [CanvasPage(id: "\(id):page1", name: "Page 1")] }
    var activePage: CanvasPage { pages.first { $0.id == activePageID } ?? pages[0] }
    var pageFrames: [DesignFrame] {
        guard let canvas else { return [] }
        return canvas.frames.filter { canvas.pageID(for: $0) == activePageID }
    }
    var pageComments: [CanvasComment] {
        let frameIDs = Set(pageFrames.map(\.id))
        let roots = Set(comments.filter {
            $0.parentId == nil && ($0.frameId.map { frameIDs.contains($0) } ?? ($0.pageId == activePageID))
        }.map(\.id))
        return comments.filter { roots.contains($0.parentId ?? $0.id) }
    }
    var pagePresences: [CanvasPresence] {
        presences.filter { $0.viewport?.pageId == nil || $0.viewport?.pageId == activePageID }
    }
    /// The agents at work on each frame of the active page, as its title shows them.
    var frameWorkers: [String: [FrameWorker]] {
        FrameWorkers.byFrame(streams: streams, presences: presences)
    }
    /// The agents at work on the canvas, for the pills at its top.
    var workingAgents: [WorkingAgent] {
        WorkingAgents.list(presences: presences, tasks: tasks, now: Date().timeIntervalSince1970 * 1000)
    }
    /// Redraw the pills when the waiting card they show stops counting as starting, and
    /// again for the next one.
    private func scheduleStartingExpiry() {
        startingExpiry?.cancel()
        let now = Date().timeIntervalSince1970 * 1000
        guard let expiry = WorkingAgents.startingExpiry(tasks: tasks, now: now) else { return }
        let delay = UInt64(max(0, expiry - now) * 1_000_000)
        startingExpiry = Task { [weak self] in
            try? await Task.sleep(nanoseconds: delay)
            guard !Task.isCancelled, let self else { return }
            self.startingTick += 1
            self.scheduleStartingExpiry()
        }
    }
    var selected: DesignFrame? { pageFrames.first { $0.id == selectedID } }

    /// The frame an agent is at work on, as the web follows an agent (`agentFollowFrame`):
    /// the frame this agent's own presence has open, else the newest frame streamed under
    /// its name. Names are not unique (two people's "Claude"), so the presence comes first.
    func workingFrame(of agent: WorkingAgent) -> String? {
        let frames = Set((canvas?.frames ?? []).map(\.id))
        if let id = presences.first(where: { $0.clientId == agent.id })?.activeFrameId, frames.contains(id) {
            return id
        }
        return streams.filter { $0.value.name == agent.name && frames.contains($0.key) }
            .max { $0.value.since < $1.value.since }?.key
    }

    /// Show the frame an agent works on, switching to its page first. False when
    /// the agent has no frame yet (a card nobody has picked up).
    @discardableResult func goToWork(of agent: WorkingAgent) -> Bool {
        guard let id = workingFrame(of: agent) else { return false }
        // Selecting reveals the frame's page, the default one for a frame with no page.
        select(id)
        commentDraft = nil
        focusedCommentID = nil
        flyToFrameID = id
        return true
    }
    var canEdit: Bool { connected && pendingEdits == 0 && !undoing }
    var canUndo: Bool { canEdit && !undoStack.isEmpty }

    func start() {
        guard connection == nil else { return }
        let generation = UUID()
        connectionID = generation
        connecting = true
        connectionError = nil
        // stop() cancelled the wake-up: the cards still shown need theirs before the room answers.
        scheduleStartingExpiry()
        #if DEBUG
        startFakeCollaborators()
        #endif
        connection = Task {
            defer {
                if connectionID == generation {
                    socket?.cancel(with: .goingAway, reason: nil)
                    socket = nil
                    connection = nil
                    connectionID = nil
                    connecting = false
                }
            }
            // `init` already contains the full canvas. Open the socket directly
            // instead of downloading every frame twice on each foreground visit.
            while connectionID == generation && !Task.isCancelled {
                var attempt: URLSessionWebSocketTask?
                do {
                    var request = try client.request("/ws")
                    var url = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
                    url.scheme = "wss"
                    // Resolve cookies against HTTPS; cookie stores do not all recognize wss.
                    let cookies = HTTPCookieStorage.shared.cookies(for: client.server.home) ?? []
                    request.setValue(HTTPCookie.requestHeaderFields(with: cookies)["Cookie"], forHTTPHeaderField: "Cookie")
                    request.url = url.url
                    let ws = CanvasSocket.task(session: client.session, request: request)
                    attempt = ws
                    socket = ws
                    ws.resume()
                    let join: [String: Any] = ["type": "join", "canvasId": id, "clientId": clientID, "name": "iOS", "kind": "user"]
                    let joinData = try JSONSerialization.data(withJSONObject: join)
                    try await ws.send(.string(String(decoding: joinData, as: UTF8.self)))
                    while connectionID == generation && !Task.isCancelled {
                        let message = try await ws.receive()
                        // A suspended receive may finish after stop/start has
                        // installed a new socket. It no longer owns this model.
                        guard connectionID == generation, !Task.isCancelled else { return }
                        let data: Data
                        switch message {
                        case .data(let value): data = value
                        case .string(let value): data = Data(value.utf8)
                        @unknown default: continue
                        }
                        apply(try JSONDecoder().decode(CanvasEvent.self, from: data))
                    }
                } catch {
                    let code = attempt?.closeCode.rawValue ?? 0
                    attempt?.cancel(with: .goingAway, reason: nil)
                    guard connectionID == generation, !Task.isCancelled else { return }
                    socket = nil
                    connected = false
                    let failure = CanvasSocket.failure(for: error, closeCode: code)
                    connecting = failure.shouldRetry
                    let nsError = error as NSError
                    // Keep payloads, URLs and cookies out of diagnostics.
                    connectionLog.error("Canvas socket failed: \(nsError.domain, privacy: .public) code \(nsError.code) close \(code)")
                    connectionError = failure.message
                    if failure == .sessionExpired || failure == .accessDenied {
                        await AgentLiveActivities.shared.endCanvas(id: id, client: client)
                        return
                    }
                    if failure == .notFound { deleted = true }
                    guard failure.shouldRetry else { return }
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                }
            }
        }
    }

    func stop() {
        // Revoke ownership before cancellation wakes the old task's catch.
        connectionID = nil
        connection?.cancel()
        connection = nil
        startingExpiry?.cancel()
        startingExpiry = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        connected = false
        connecting = false
        connectionError = nil
    }

    private func send(_ payload: [String: Any]) async throws {
        guard let socket else { return }
        let data = try JSONSerialization.data(withJSONObject: payload)
        try await socket.send(.string(String(decoding: data, as: UTF8.self)))
    }

    func select(_ id: String?) {
        // Explicit selections (including Undo) reveal the frame's page. Remote
        // frame updates instead clear an out-of-page selection in pruneSelection.
        if let id, let canvas, let frame = canvas.frames.first(where: { $0.id == id }) {
            selectPage(canvas.pageID(for: frame))
        }
        // Choosing a frame explicitly (including the current row in Frames)
        // switches actions from its picked element to the whole frame.
        selectedElement = nil
        selectedID = id
        Task { try? await send(["type": "editing", "frameId": id as Any? ?? NSNull()]) }
    }

    func selectPage(_ pageID: String) {
        guard pages.contains(where: { $0.id == pageID }), pageID != activePageID else { return }
        activePageID = pageID
        select(nil)
        selectedElement = nil
        viewportCommand += 1
    }

    func apply(_ event: CanvasEvent) {
        switch event.type {
        case "init":
            canvas = event.canvas
            tasks = event.tasks ?? []
            comments = event.comments ?? []
            presences = event.presences ?? []
            // A stream that ended while we were away sent its end to nobody.
            streams = [:]
            connected = true
            connecting = false
            connectionError = nil
        case "frame:created", "frame:updated":
            if let frame = event.frame, canvas != nil { upsert(frame, into: &canvas!.frames) }
        case "frame:deleted":
            canvas?.frames.removeAll { $0.id == event.frameId }
            if let frameID = event.frameId { streams[frameID] = nil }
            if selectedID == event.frameId { selectedID = nil; selectedElement = nil }
        case "frame:drag":
            if let index = canvas?.frames.firstIndex(where: { $0.id == event.frameId }) {
                if let x = event.x { canvas?.frames[index].x = x }
                if let y = event.y { canvas?.frames[index].y = y }
                if let width = event.width { canvas?.frames[index].width = width }
                if let height = event.height { canvas?.frames[index].height = height }
            }
        case "canvas:renamed": if let name = event.name { canvas?.name = name }
        case "canvas:pages":
            if let pages = event.pages, var document = canvas {
                // Reordering pages must not move legacy frames to the new first page.
                let firstPageID = document.effectivePages[0].id
                for index in document.frames.indices where document.frames[index].pageId == nil {
                    document.frames[index].pageId = firstPageID
                }
                document.pages = pages
                canvas = document
            }
        case "canvas:deleted":
            deleted = true; stop()
            Task { await AgentLiveActivities.shared.endCanvas(id: id, client: client) }
        case "task": if let task = event.task { upsert(task, into: &tasks) }
        case "comment": if let comment = event.comment { upsert(comment, into: &comments) }
        case "presence:join": if let person = event.presence { upsert(person, into: &presences) }
        case "presence:leave": presences.removeAll { $0.clientId == event.clientId }
        case "editing":
            if let index = presences.firstIndex(where: { $0.clientId == event.clientId }) {
                presences[index].activeFrameId = event.frameId
            }
        case "frame:streaming":
            guard let frameID = event.frameId else { break }
            if event.active == true, let actor = event.actor {
                streams[frameID] = FrameStream(name: actor.name, color: actor.color, since: Date().timeIntervalSince1970 * 1000)
            } else {
                streams[frameID] = nil
            }
        case "status":
            if let index = presences.firstIndex(where: { $0.clientId == event.clientId }) {
                presences[index].status = event.status
            }
        case "viewport":
            if let index = presences.firstIndex(where: { $0.clientId == event.clientId }), let viewport = event.viewport {
                presences[index].viewport = viewport
            }
        case "cursor":
            if let index = presences.firstIndex(where: { $0.clientId == event.clientId }), let x = event.x, let y = event.y {
                presences[index].cursor = CanvasPoint(x: x, y: y)
            }
        default: break
        }
        if ["init", "task", "canvas:renamed"].contains(event.type) {
            AgentLiveActivities.shared.observe(canvas: canvas, tasks: tasks, client: client)
        }
    }

    func addFrame() async {
        guard canEdit else { return }
        pendingEdits += 1
        defer { pendingEdits -= 1 }
        let pageID = activePageID
        do {
            let right = pageFrames.map { $0.x + $0.width }.max() ?? -80
            var body: [String: Any] = [
                "name": "Untitled frame", "x": right + 80, "y": 0, "width": 390, "height": 844,
                "html": "<!doctype html><html><body style='margin:0;background:#fff;display:grid;place-items:center;height:100vh;font-family:system-ui;color:#777'><p>What will you make?</p></body></html>"
            ]
            if canvas?.pages?.isEmpty == false { body["pageId"] = pageID }
            let data = try await client.data("/api/canvases/\(id)/frames", method: "POST", body: body)
            let frame = try JSONDecoder().decode(DesignFrame.self, from: data)
            if canvas != nil { upsert(frame, into: &canvas!.frames) }
            record(UndoEntry(kind: .create, frameID: frame.id, body: [:]))
            if activePageID == pageID { select(frame.id); viewportCommand += 1 }
        } catch { self.error = error.localizedDescription }
    }

    func patchFrame(_ frameID: String, patch: [String: Any]) async throws {
        guard canEdit else { throw CanvasEditError.busy }
        let before = canvas?.frames.first { $0.id == frameID }
        pendingEdits += 1
        defer { pendingEdits -= 1 }
        let data = try await client.data("/api/frames/\(frameID)", method: "PATCH", body: patch)
        let frame = try JSONDecoder().decode(DesignFrame.self, from: data)
        if canvas != nil { upsert(frame, into: &canvas!.frames) }
        if let before { recordUpdate(before: before, after: frame, keys: Array(patch.keys)) }
    }

    func pasteFrame(_ source: DesignFrame) async throws {
        guard canEdit else { throw CanvasEditError.busy }
        pendingEdits += 1
        defer { pendingEdits -= 1 }
        let pageID = activePageID
        let right = pageFrames.map { $0.x + $0.width }.max() ?? -80
        var body: [String: Any] = ["name": source.name + " copy", "html": source.html,
                                   "x": right + 80, "y": selected?.y ?? 0,
                                   "width": source.width, "height": source.height]
        if canvas?.pages?.isEmpty == false { body["pageId"] = pageID }
        let data = try await client.data("/api/canvases/\(id)/frames", method: "POST", body: body)
        let frame = try JSONDecoder().decode(DesignFrame.self, from: data)
        if canvas != nil { upsert(frame, into: &canvas!.frames) }
        record(UndoEntry(kind: .create, frameID: frame.id, body: [:]))
        if activePageID == pageID { select(frame.id); viewportCommand += 1 }
    }

    func moveFrame(_ frameID: String, x: Double, y: Double) async {
        guard connected, !undoing, x.isFinite, y.isFinite, abs(x) < 1_000_000, abs(y) < 1_000_000,
              let before = pageFrames.first(where: { $0.id == frameID }) else { return }
        if moveOrigins[frameID] == nil { moveOrigins[frameID] = before }
        pendingEdits += 1
        defer { pendingEdits -= 1 }
        let token = pendingMoves.begin(frameID: frameID, x: x, y: y)
        // Keep the dropped preview in place while the save is in flight, even
        // when cursor/presence events cause the canvas layers to sync.
        if let index = canvas?.frames.firstIndex(where: { $0.id == frameID }) {
            canvas?.frames[index].x = x
            canvas?.frames[index].y = y
        }
        do {
            let data = try await client.data("/api/frames/\(frameID)", method: "PATCH", body: ["x": x, "y": y])
            let frame = try JSONDecoder().decode(DesignFrame.self, from: data)
            guard pendingMoves.finish(frameID: frameID, token: token) else { return }
            if let origin = moveOrigins.removeValue(forKey: frameID) {
                recordUpdate(before: origin, after: frame, keys: ["x", "y"])
            }
            // A deletion received during the save must not resurrect the frame.
            if canvas?.frames.contains(where: { $0.id == frameID }) == true { upsert(frame, into: &canvas!.frames) }
        } catch {
            guard pendingMoves.finish(frameID: frameID, token: token) else { return }
            moveOrigins.removeValue(forKey: frameID)
            self.error = error.localizedDescription
            canvas = try? await client.get("/api/canvases/\(id)")
        }
    }

    /// The selection as the next prompt's scope: the picked element when it still
    /// matches the frame's HTML, else the selected frame, else nothing.
    var promptScope: PromptScope? {
        guard let frame = selected else { return nil }
        if let element = selectedElement, element.frameID == frame.id, element.htmlHash == frame.html.hashValue {
            return PromptScope(scope: CardScope(frameId: frame.id, selector: element.selector), label: element.label, frameName: frame.name)
        }
        return PromptScope(scope: CardScope(frameId: frame.id), label: frame.name, frameName: frame.name)
    }

    func queue(_ prompt: String, scope: CardScope? = nil, assignment: AgentAssignment = .automatic, runner: RunnerPick? = nil) async throws {
        let request = CardQueueRequest(title: prompt, scope: scope, assignment: assignment, runner: runner)
        let data = try await client.data("/api/canvases/\(id)/cards", method: "POST", body: request.body)
        // The answer is the queued card: show it at once, before the room's `task` echo.
        // The room's `task` may already be here, and further along (claimed, finished): keep it.
        if let card = try? JSONDecoder().decode(CanvasTask.self, from: data), !tasks.contains(where: { $0.id == card.id }) {
            tasks.append(card)
        }
    }

    /// A picked element is only as good as the HTML it was picked in: its selector
    /// path can point elsewhere once that HTML changes, whichever way the change
    /// arrived (a frame event, a reconnect resync, a reload). Drop it then.
    private func pruneSelection() {
        if let selectedID, !pageFrames.contains(where: { $0.id == selectedID }) { select(nil) }
        guard let element = selectedElement else { return }
        let frame = pageFrames.first { $0.id == element.frameID }
        if frame == nil || frame?.html.hashValue != element.htmlHash { selectedElement = nil }
    }

    /// The selection bar's Comment: a draft on the picked element, else just inside
    /// the selected frame's top-left, as the web pins a comment made from a frame's name.
    func startCommentOnSelection() {
        pruneSelection()
        guard let frame = selected else { return }
        let origin = CGPoint(x: frame.x, y: frame.y)
        if let element = selectedElement, element.frameID == frame.id {
            let point = element.rect.origin
            commentDraft = CommentDraft(
                target: .element(frameID: frame.id, selector: element.selector, snippet: String(element.text.prefix(400)),
                                 point: point, origin: element.rect.origin),
                world: CGPoint(x: origin.x + point.x, y: origin.y + point.y), label: "\(frame.name) · \(element.label)")
        } else {
            let point = CGPoint(x: 8, y: 8)
            commentDraft = CommentDraft(target: .frame(frameID: frame.id, point: point),
                                        world: CGPoint(x: origin.x + point.x, y: origin.y + point.y), label: frame.name)
        }
        focusedCommentID = nil
    }

    func reply(_ text: String, to rootID: String) async throws {
        let data = try await client.data("/api/comments/\(rootID)/replies", method: "POST", body: ["text": text])
        let comment = try JSONDecoder().decode(CanvasComment.self, from: data)
        upsert(comment, into: &comments)
    }

    /// Post the draft placed by a long-press, anchored the way the web's Comment tool anchors.
    func postDraft(_ text: String) async throws {
        guard let draft = commentDraft else { return }
        let data: Data
        switch draft.target {
        case let .element(frameID, selector, snippet, point, origin):
            data = try await client.data("/api/frames/\(frameID)/comments", method: "POST", body: [
                "text": text, "selector": selector, "snippet": snippet, "x": point.x, "y": point.y,
                "elementOrigin": ["x": origin.x, "y": origin.y],
            ])
        case let .frame(frameID, point):
            data = try await client.data("/api/frames/\(frameID)/comments", method: "POST", body: [
                "text": text, "selector": "body", "x": point.x, "y": point.y,
            ])
        case let .canvas(pageID, point):
            data = try await client.data("/api/canvases/\(id)/comments", method: "POST", body: [
                "text": text, "pageId": pageID, "x": point.x, "y": point.y,
            ])
        }
        let comment = try JSONDecoder().decode(CanvasComment.self, from: data)
        upsert(comment, into: &comments)
        if commentDraft == draft { commentDraft = nil }
    }

    func deleteFrame(_ frameID: String) async throws {
        guard canEdit else { throw CanvasEditError.busy }
        let before = canvas?.frames.first { $0.id == frameID }
        pendingEdits += 1
        defer { pendingEdits -= 1 }
        _ = try await client.data("/api/frames/\(frameID)", method: "DELETE")
        if let before { record(UndoEntry(kind: .delete, frameID: frameID, body: frameBody(before))) }
        canvas?.frames.removeAll { $0.id == frameID }
        select(nil)
    }

    /// Undo only this client's saved frame changes, through the same API used
    /// by editing so collaborators receive the inverse live as well.
    func undo() async {
        guard canUndo else { return }
        undoing = true
        defer { undoing = false }
        while let entry = undoStack.last {
            do {
                switch entry.kind {
                case .update:
                    let data = try await client.data("/api/frames/\(entry.frameID)", method: "PATCH", body: entry.body)
                    let frame = try JSONDecoder().decode(DesignFrame.self, from: data)
                    if canvas != nil { upsert(frame, into: &canvas!.frames) }
                    select(frame.id)
                case .create:
                    _ = try await client.data("/api/frames/\(entry.frameID)", method: "DELETE")
                    canvas?.frames.removeAll { $0.id == entry.frameID }
                    if selectedID == entry.frameID { select(nil) }
                case .delete:
                    let frame = try await restoreFrame(entry.body)
                    if canvas != nil { upsert(frame, into: &canvas!.frames) }
                    // Recreating a deleted frame gives it a new server ID. Older
                    // edits and its original creation must follow the restored copy.
                    for index in undoStack.indices where undoStack[index].frameID == entry.frameID {
                        undoStack[index].frameID = frame.id
                    }
                    select(frame.id)
                    viewportCommand += 1
                }
                undoStack.removeLast()
                return
            } catch let error as APIError where error.status == 404 && entry.kind != .delete {
                // A collaborator deleted this frame. Discard its obsolete edits
                // and continue to the next undoable change in this same tap.
                undoStack.removeAll { $0.frameID == entry.frameID && $0.kind != .delete }
                canvas?.frames.removeAll { $0.id == entry.frameID }
                if selectedID == entry.frameID { select(nil) }
            } catch {
                // Temporary failures (including failed restores) remain retryable.
                self.error = error.localizedDescription
                return
            }
        }
    }

    private func restoreFrame(_ savedBody: [String: Any]) async throws -> DesignFrame {
        var body = savedBody
        if let pages = canvas?.pages, !pages.contains(where: { $0.id == body["pageId"] as? String }) {
            body["pageId"] = pages.first?.id
        }
        let path = "/api/canvases/\(id)/frames"
        let data: Data
        do {
            data = try await client.data(path, method: "POST", body: body)
        } catch let error as APIError where error.status == 400 && error.message == "page not found" && body["pageId"] != nil {
            // Page events can lag behind this request. The rejected POST created
            // nothing; omitting pageId lets the server choose its current first page.
            body.removeValue(forKey: "pageId")
            data = try await client.data(path, method: "POST", body: body)
        }
        return try JSONDecoder().decode(DesignFrame.self, from: data)
    }

    private func frameBody(_ frame: DesignFrame) -> [String: Any] {
        var body: [String: Any] = ["name": frame.name, "html": frame.html, "x": frame.x, "y": frame.y,
                                   "width": frame.width, "height": frame.height]
        if let pageID = frame.pageId { body["pageId"] = pageID }
        if let hidden = frame.hidden { body["hidden"] = hidden }
        if let locked = frame.locked { body["locked"] = locked }
        return body
    }

    private func recordUpdate(before: DesignFrame, after: DesignFrame, keys: [String]) {
        let old = frameBody(before), new = frameBody(after)
        var inverse: [String: Any] = [:]
        for key in keys {
            if let value = old[key] as? NSObject, !value.isEqual(new[key]) { inverse[key] = value }
        }
        if !inverse.isEmpty { record(UndoEntry(kind: .update, frameID: after.id, body: inverse)) }
    }

    private func record(_ entry: UndoEntry) {
        undoStack.append(entry)
        if undoStack.count > 100 { undoStack.removeFirst() }
    }
}

private enum CanvasEditError: LocalizedError {
    case busy
    var errorDescription: String? { "Connect to the canvas and wait for the current edit to finish, then try again." }
}

/// The selection a prompt is scoped to, as the prompt bar's chip shows it.
struct PromptScope: Equatable {
    var scope: CardScope
    /// What the chip reads: an element's `tag#id.class`, a frame's name.
    var label: String
    var frameName: String
    var isElement: Bool { scope.selector != nil }
    /// "frame:selector" for an element, the frame id alone for a frame — the key a
    /// dismissal is remembered by, so a new selection brings the chip back.
    var key: String { scope.selector.map { "\(scope.frameId):\($0)" } ?? scope.frameId }
}

/// Where a long-press asked for a new comment.
struct CommentDraft: Equatable {
    enum Target: Equatable {
        /// An element: the point pressed and the element's top-left, both in frame px.
        case element(frameID: String, selector: String, snippet: String, point: CGPoint, origin: CGPoint)
        /// A frame's background, at a point in frame px.
        case frame(frameID: String, point: CGPoint)
        /// Empty canvas, at a world point on a page.
        case canvas(pageID: String, point: CGPoint)
    }
    var target: Target
    /// Where the draft pin sits in the world.
    var world: CGPoint
    /// What the composer says the comment is on.
    var label: String
}

/// An element picked inside a frame by the Blitz hit test.
struct SelectedElement: Equatable, Sendable {
    var frameID: String
    var nodeID: UInt64
    /// A CSS path that doop's comment anchors and agents resolve.
    var selector: String
    /// `tag#id.class` for the chip.
    var label: String
    var text: String
    /// Border box in the frame's CSS pixels.
    var rect: CGRect
    /// Hash of the frame HTML the element was picked in; the selection is dropped once it changes.
    var htmlHash: Int
}

#if DEBUG
extension CanvasModel {
    /// `-fakeCursors 1`: three collaborators (a person and two agents) wander
    /// over the first frame, for checking the cursor chrome without a second client.
    fileprivate func startFakeCollaborators() {
        startFakeWork()
        guard UserDefaults.standard.bool(forKey: "fakeCursors") else { return }
        let people = [("fake-kevin", "Kevin", "user", "#E8432E"), ("fake-claude", "Claude", "agent", "#D97757"), ("fake-codex", "Codex", "agent", "#2743EE")]
        var t = 0.0
        Timer.scheduledTimer(withTimeInterval: 1.0 / 20, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, let frame = self.pageFrames.first else { return }
                t += 0.05
                for (index, person) in people.enumerated() {
                    let phase = Double(index) * 2.1
                    let x = frame.x + frame.width * (0.3 + 0.2 * Double(index)) + sin(t + phase) * 60
                    let y = frame.y + frame.height * (0.25 + 0.2 * Double(index)) + cos(t * 0.7 + phase) * 40
                    upsert(CanvasPresence(clientId: person.0, name: person.1, color: person.3, kind: person.2, cursor: CanvasPoint(x: x, y: y)), into: &self.presences)
                }
            }
        }
    }

    /// `-fakeWorking 1`: a task queued from the phone shows as "Starting…", then Claude
    /// picks it up and posts statuses while it streams, for checking the working pills.
    /// `-fakeWorking 2` adds Codex at work beside it.
    fileprivate func startFakeWork() {
        let level = UserDefaults.standard.integer(forKey: "fakeWorking")
        guard level > 0 else { return }
        let card = CanvasTask(id: "fake-card", agentName: "", status: "Design a pricing page", startedAt: Date().timeIntervalSince1970 * 1000)
        let steps = ["Reading the canvas", "Laying out the pricing tiers", "Styling the plan cards", "Checking the screenshot"]
        Task { @MainActor [weak self] in
            // After the room's `init`, which replaces the task list.
            // Holds no strong reference across a sleep, so closing the canvas releases it.
            while !Task.isCancelled {
                guard let ready = self.map({ $0.connected && $0.canvas != nil }) else { return }
                if ready { break }
                try? await Task.sleep(nanoseconds: 300_000_000)
            }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            guard let model = self else { return }
            upsert(card, into: &model.tasks)
            for (index, step) in steps.enumerated() {
                try? await Task.sleep(nanoseconds: index == 0 ? 6_000_000_000 : 5_000_000_000)
                guard let model = self else { return }
                model.tasks.removeAll { $0.id == card.id }
                upsert(CanvasPresence(clientId: "fake-claude-work", name: "Claude", color: "#D97757", kind: "agent", status: step), into: &model.presences)
                if index == 1, let frame = model.pageFrames.first { model.streams[frame.id] = FrameStream(name: "Claude", color: "#D97757") }
                if level >= 2, index == 1 {
                    upsert(CanvasPresence(clientId: "fake-codex-work", name: "Codex", color: "#2743EE", kind: "agent", status: "Writing the FAQ copy"), into: &model.presences)
                }
            }
        }
    }
}
#endif

private func upsert<T: Identifiable>(_ item: T, into collection: inout [T]) {
    if let index = collection.firstIndex(where: { $0.id == item.id }) { collection[index] = item }
    else { collection.append(item) }
}

/// Up to two initials of a name, as pins and comment rows show it.
func commentInitials(_ name: String) -> String {
    name.split(separator: " ").prefix(2).compactMap { $0.first.map(String.init) }.joined().uppercased()
}
