import CoreGraphics
import Foundation

@MainActor
final class CanvasModel: ObservableObject {
    let id: String
    let client: DoopClient
    @Published var canvas: CanvasDocument? { didSet { pruneSelection() } }
    @Published var tasks: [CanvasTask] = []
    @Published var comments: [CanvasComment] = []
    @Published var presences: [CanvasPresence] = []
    @Published var selectedID: String?
    @Published var connected = false
    @Published var error: String?
    @Published var deleted = false
    /// When on, taps inside the selected frame pick elements instead of frames.
    @Published var inspecting = false
    @Published var selectedElement: SelectedElement?
    @Published var viewportCommand = 0
    private var connection: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?
    private let clientID = "ios-" + UUID().uuidString

    init(id: String, client: DoopClient) { self.id = id; self.client = client }
    var selected: DesignFrame? { canvas?.frames.first { $0.id == selectedID } }

    func start() {
        guard connection == nil else { return }
        #if DEBUG
        startFakeCollaborators()
        #endif
        connection = Task {
            do { canvas = try await client.get("/api/canvases/\(id)") }
            catch { self.error = error.localizedDescription }
            while !Task.isCancelled {
                do {
                    var request = try client.request("/ws")
                    var url = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
                    url.scheme = "wss"
                    // Resolve cookies against HTTPS; cookie stores do not all recognize wss.
                    let cookies = HTTPCookieStorage.shared.cookies(for: client.server.home) ?? []
                    request.setValue(HTTPCookie.requestHeaderFields(with: cookies)["Cookie"], forHTTPHeaderField: "Cookie")
                    request.url = url.url
                    let ws = client.session.webSocketTask(with: request)
                    socket = ws
                    ws.resume()
                    let join: [String: Any] = ["type": "join", "canvasId": id, "clientId": clientID, "name": "iOS", "kind": "user"]
                    try await send(join)
                    while !Task.isCancelled {
                        let message = try await ws.receive()
                        let data: Data
                        switch message {
                        case .data(let value): data = value
                        case .string(let value): data = Data(value.utf8)
                        @unknown default: continue
                        }
                        apply(try JSONDecoder().decode(CanvasEvent.self, from: data))
                    }
                } catch {
                    connected = false
                    if Task.isCancelled { break }
                    let code = socket?.closeCode.rawValue
                    if code == 4401 || code == 4403 {
                        await AgentLiveActivities.shared.endCanvas(id: id, client: client)
                        self.error = code == 4401 ? "Your session expired. Return to the library and sign in again." : "You no longer have access to this canvas."
                        break
                    }
                    self.error = "Connection interrupted. Reconnecting…"
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                }
            }
        }
    }

    func stop() {
        connection?.cancel()
        connection = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        connected = false
    }

    private func send(_ payload: [String: Any]) async throws {
        guard let socket else { return }
        let data = try JSONSerialization.data(withJSONObject: payload)
        try await socket.send(.string(String(decoding: data, as: UTF8.self)))
    }

    func select(_ id: String?) {
        if id != selectedID { selectedElement = nil }
        selectedID = id
        Task { try? await send(["type": "editing", "frameId": id as Any? ?? NSNull()]) }
    }

    func apply(_ event: CanvasEvent) {
        switch event.type {
        case "init":
            canvas = event.canvas
            tasks = event.tasks ?? []
            comments = event.comments ?? []
            presences = event.presences ?? []
            connected = true
            error = nil
        case "frame:created", "frame:updated":
            if let frame = event.frame, canvas != nil { upsert(frame, into: &canvas!.frames) }
        case "frame:deleted":
            canvas?.frames.removeAll { $0.id == event.frameId }
            if selectedID == event.frameId { selectedID = nil; selectedElement = nil }
        case "frame:drag":
            if let index = canvas?.frames.firstIndex(where: { $0.id == event.frameId }) {
                if let x = event.x { canvas?.frames[index].x = x }
                if let y = event.y { canvas?.frames[index].y = y }
                if let width = event.width { canvas?.frames[index].width = width }
                if let height = event.height { canvas?.frames[index].height = height }
            }
        case "canvas:renamed": if let name = event.name { canvas?.name = name }
        case "canvas:deleted":
            deleted = true; stop()
            Task { await AgentLiveActivities.shared.endCanvas(id: id, client: client) }
        case "task": if let task = event.task { upsert(task, into: &tasks) }
        case "comment": if let comment = event.comment { upsert(comment, into: &comments) }
        case "presence:join": if let person = event.presence { upsert(person, into: &presences) }
        case "presence:leave": presences.removeAll { $0.clientId == event.clientId }
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
        do {
            let right = canvas?.frames.map { $0.x + $0.width }.max() ?? -80
            let data = try await client.data("/api/canvases/\(id)/frames", method: "POST", body: [
                "name": "Untitled frame", "x": right + 80, "y": 0, "width": 390, "height": 844,
                "html": "<!doctype html><html><body style='margin:0;background:#fff;display:grid;place-items:center;height:100vh;font-family:system-ui;color:#777'><p>What will you make?</p></body></html>"
            ])
            let frame = try JSONDecoder().decode(DesignFrame.self, from: data)
            if canvas != nil { upsert(frame, into: &canvas!.frames) }
            select(frame.id)
            viewportCommand += 1
        } catch { self.error = error.localizedDescription }
    }

    func patchFrame(_ frameID: String, patch: [String: Any]) async throws {
        let data = try await client.data("/api/frames/\(frameID)", method: "PATCH", body: patch)
        let frame = try JSONDecoder().decode(DesignFrame.self, from: data)
        if canvas != nil { upsert(frame, into: &canvas!.frames) }
    }

    func moveFrame(_ frameID: String, x: Double, y: Double) async {
        guard x.isFinite, y.isFinite, abs(x) < 1_000_000, abs(y) < 1_000_000,
              canvas?.frames.contains(where: { $0.id == frameID }) == true else { return }
        do { try await patchFrame(frameID, patch: ["x": x, "y": y]) }
        catch { self.error = error.localizedDescription; canvas = try? await client.get("/api/canvases/\(id)") }
    }

    func queue(_ prompt: String) async throws {
        _ = try await client.data("/api/canvases/\(id)/cards", method: "POST", body: ["title": prompt])
    }

    /// A comment pinned to an element when one is selected, else to the frame body.
    /// A picked element is only as good as the HTML it was picked in: its selector
    /// path can point elsewhere once that HTML changes, whichever way the change
    /// arrived (a frame event, a reconnect resync, a reload). Drop it then.
    private func pruneSelection() {
        guard let element = selectedElement else { return }
        let frame = canvas?.frames.first { $0.id == element.frameID }
        if frame == nil || frame?.html.hashValue != element.htmlHash { selectedElement = nil }
    }

    func comment(_ text: String, frameID: String) async throws {
        pruneSelection()
        let element = selectedElement?.frameID == frameID ? selectedElement : nil
        _ = try await client.data("/api/frames/\(frameID)/comments", method: "POST", body: [
            "text": text, "selector": element?.selector ?? "body", "snippet": element?.text ?? "",
        ])
    }

    func deleteFrame(_ frameID: String) async throws {
        _ = try await client.data("/api/frames/\(frameID)", method: "DELETE")
        canvas?.frames.removeAll { $0.id == frameID }
        select(nil)
    }
}

/// An element picked inside a frame by the Blitz hit test.
struct SelectedElement: Equatable {
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
        guard UserDefaults.standard.bool(forKey: "fakeCursors") else { return }
        let people = [("fake-kevin", "Kevin", "user", "#E8432E"), ("fake-claude", "Claude", "agent", "#D97757"), ("fake-codex", "Codex", "agent", "#2743EE")]
        var t = 0.0
        Timer.scheduledTimer(withTimeInterval: 1.0 / 20, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, let frame = self.canvas?.frames.first else { return }
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
}
#endif

private func upsert<T: Identifiable>(_ item: T, into collection: inout [T]) {
    if let index = collection.firstIndex(where: { $0.id == item.id }) { collection[index] = item }
    else { collection.append(item) }
}
