import Foundation
import DoopCore

@main
struct ServerAddressChecks {
    static func main() throws {
        let checks = ServerAddressChecks()
        checks.testNormalizesOriginAndStartsAtAuthentication()
        checks.testRejectsUnsafeOrUnsupportedServerAddresses()
        checks.testNavigationUsesExactOrigin()
        checks.testSelfHostedPortIsPreserved()
        try checks.testExportDestinations()
        try checks.testServerResponseContracts()
        checks.testCardScopeBody()
        checks.testCardAgentAssignmentBody()
        checks.testPromptContext()
        try checks.testContextPeople()
        try checks.testAgentModelMenu()
        try checks.testAgentActivityStates()
        FrameSnappingChecks.run()
        try PendingFrameMoveChecks.run()
        try ProviderSignInChecks.run()
        AppleSignInChecks.run()
        try CanvasSocketChecks.run()
        print("All core checks passed.")
    }
    func testNormalizesOriginAndStartsAtAuthentication() {
        let server = ServerAddress("  https://DOOP.design/ \n")!
        checkEqual(server.origin.absoluteString, "https://doop.design")
        checkEqual(server.home.absoluteString, "https://doop.design/auth")
    }

    func testRejectsUnsafeOrUnsupportedServerAddresses() {
        for value in ["", "doop.design", "http://doop.design", "javascript:alert(1)",
                      "https://user:secret@doop.design", "https://doop.design/path",
                      "https://doop.design?token=secret", "https://doop.design#fragment",
                      "https://doop.design:0", "https://doop.design:65536"] {
            checkNil(ServerAddress(value), value)
        }
    }

    func testNavigationUsesExactOrigin() {
        let server = ServerAddress.hosted
        checkTrue(server.contains(URL(string: "https://doop.design/c/abc?tab=board")!))
        checkTrue(server.contains(URL(string: "https://doop.design:443/auth")!))
        for value in ["https://doop.design.evil.test", "https://evil.test/doop.design",
                      "https://doop.design:444/c/abc", "http://doop.design",
                      "https://user@doop.design", "file:///tmp/doop.design"] {
            checkFalse(server.contains(URL(string: value)!), value)
        }
    }

    func testExportDestinations() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let storage = ExportDirectory(root: root)
        let first = try storage.destination(suggestedFilename: "../../design.html")
        let second = try storage.destination(suggestedFilename: "design.html")
        checkFalse(first == second)
        checkEqual(first.lastPathComponent, "design.html")
        checkEqual(first.deletingLastPathComponent().deletingLastPathComponent(), root)
        checkFalse(FileManager.default.fileExists(atPath: first.path))
        try Data("export".utf8).write(to: first)
        try storage.remove(first)
        checkFalse(FileManager.default.fileExists(atPath: first.path))
        checkTrue(FileManager.default.fileExists(atPath: second.deletingLastPathComponent().path))
        for name in ["", ".", "..", "\n"] {
            let url = try storage.destination(suggestedFilename: name)
            checkEqual(url.lastPathComponent, "Doop export")
        }
        let outside = root.appendingPathComponent("keep.txt")
        try Data("keep".utf8).write(to: outside)
        try storage.remove(outside)
        checkTrue(FileManager.default.fileExists(atPath: outside.path))
    }

    func testServerResponseContracts() throws {
        let library = try JSONDecoder().decode([CanvasSummary].self, from: Data(#"[{"id":"c","name":"Canvas","updatedAt":1000,"frameCount":0,"activeTasks":[{"id":"t","agentName":"Builder","status":"Designing","startedAt":1000}]}]"#.utf8))
        checkEqual(library.first?.activeTasks?.first?.agentName, "Builder")
        // /api/workspaces returns an envelope, unlike /api/canvases.
        let spaces = try JSONDecoder().decode(WorkspaceList.self, from: Data(#"{"workspaces":[],"billing":{"enabled":false}}"#.utf8))
        checkTrue(spaces.workspaces.isEmpty)
        let event = try JSONDecoder().decode(CanvasEvent.self, from: Data(#"{"type":"init","canvas":{"id":"qa","name":"Test","frames":[]},"presences":[],"comments":[],"tasks":[],"serverBuild":"dev","futureField":true}"#.utf8))
        checkEqual(event.canvas?.name, "Test")
        checkEqual(event.canvas?.frames.count, 0)
        let update = try JSONDecoder().decode(CanvasEvent.self, from: Data(#"{"type":"frame:updated","frame":{"id":"f","canvasId":"qa","name":"Frame","x":1.5,"y":-10,"width":390,"height":844,"html":"<h1>Hello</h1>","updatedBy":"agent"}}"#.utf8))
        checkEqual(update.frame?.html, "<h1>Hello</h1>")
        checkEqual(update.frame?.x, 1.5)
        let deletion = try JSONDecoder().decode(CanvasEvent.self, from: Data(#"{"type":"frame:deleted","frameId":"f"}"#.utf8))
        checkEqual(deletion.frameId, "f")
    }

    /// The prompt's scope posts the shape `shared/types.ts` calls CardScope: a frame id, plus
    /// the element selector only when one was picked.
    func testCardScopeBody() {
        let frame = CardScope(frameId: "f1").body
        checkEqual(frame["frameId"] as? String, "f1")
        checkNil(frame["selector"], "A frame scope carries no selector")
        let element = CardScope(frameId: "f1", selector: "body > main > h1:nth-of-type(1)").body
        checkEqual(element["selector"] as? String, "body > main > h1:nth-of-type(1)")
        checkTrue(JSONSerialization.isValidJSONObject(["title": "Make it bolder", "scope": element]))
    }

    func testAgentModelMenu() throws {
        let connected = try JSONDecoder().decode(AgentModelAccount.self, from: Data(#"{"connected":true,"kind":"chatgpt","model":"model-b","menus":{"chatgpt":[{"id":"model-a","name":"Model A"},{"id":"model-b","name":"Model B","blurb":"Everyday model"}],"anthropic-key":[{"id":"other","name":"Other"}]}}"#.utf8))
        checkEqual(connected.options.map(\.id), ["model-a", "model-b"])
        checkEqual(connected.label, "Model B")
        let disconnected = try JSONDecoder().decode(AgentModelAccount.self, from: Data(#"{"connected":false}"#.utf8))
        checkEqual(disconnected.options.count, 0)
        checkEqual(disconnected.label, "Auto")
        let olderServer = try JSONDecoder().decode(AgentModelAccount.self, from: Data(#"{"connected":true,"kind":"chatgpt","model":"custom"}"#.utf8))
        checkEqual(olderServer.options.count, 0)
        checkEqual(olderServer.label, "custom")
    }

    func testPromptContext() {
        checkEqual(PromptContextReference.mentionQuery(in: "@"), "")
        checkEqual(PromptContextReference.mentionQuery(in: "Rewrite @Welcome card"), "Welcome card")
        checkNil(PromptContextReference.mentionQuery(in: "hello@example.com"), "Email is not a mention query")
        checkNil(PromptContextReference.mentionQuery(in: "@Page\nMore text"), "A newline ends mention completion")
        checkEqual(PromptContextReference.removingMentionQuery(from: "Rewrite @Welcome"), "Rewrite ")
        checkEqual(PromptContextReference.removingMentionQuery(from: "hello@example.com"), "hello@example.com")
        checkEqual(PromptContextReference.taskTitle("Rewrite", references: []), "Rewrite")
        let frame = PromptContextReference(kind: .frame, sourceID: "frame-1", name: "Welcome card")
        let title = PromptContextReference.taskTitle("Rewrite", references: [frame])
        checkTrue(title.contains("frame: \"Welcome card\" (id: \"frame-1\")"))
        let request = CardQueueRequest(title: title, scope: CardScope(frameId: "frame-1"), assignment: .specialist(.copy)).body
        checkEqual(request["title"] as? String, title)
        checkEqual(request["agents"] as? [String], ["copy"])
        checkEqual((request["scope"] as? [String: String])?["frameId"], "frame-1")
    }

    func testContextPeople() throws {
        let user = try JSONDecoder().decode(DoopUser.self, from: Data(#"{"id":"self","name":"Alex","email":"alex@example.com"}"#.utf8))
        let presences = try JSONDecoder().decode([CanvasPresence].self, from: Data(#"[{"clientId":"self-tab","userId":"self","name":"Alex","color":"red","kind":"user"},{"clientId":"other-tab","userId":"other","name":"Alex","color":"blue","kind":"user"},{"clientId":"other-tab-2","userId":"other","name":"Alex","color":"blue","kind":"user"},{"clientId":"legacy","name":"Alex","color":"green","kind":"user"},{"clientId":"legacy","name":"Alex","color":"green","kind":"user"},{"clientId":"agent","name":"Alex","color":"orange","kind":"agent"}]"#.utf8))
        let people = PromptContextReference.people(currentUser: user, presences: presences)
        checkEqual(people.map(\.sourceID), ["self", "other", "client:legacy"])
        checkEqual(people.map(\.name), ["Alex", "Alex", "Alex"])
        checkEqual(PromptContextReference.people(currentUser: nil, presences: presences).count, 3)
    }

    func testCardAgentAssignmentBody() {
        let automatic = CardQueueRequest(title: "Make it clearer", scope: nil).body
        checkEqual(automatic["title"] as? String, "Make it clearer")
        checkNil(automatic["agents"], "Auto leaves the server's default pipeline unchanged")

        let scopedAutomatic = CardQueueRequest(
            title: "Make this frame clearer",
            scope: CardScope(frameId: "frame-1")
        ).body
        checkNil(scopedAutomatic["agents"], "Auto keeps the default pipeline for scoped tasks")
        checkEqual((scopedAutomatic["scope"] as? [String: String])?["frameId"], "frame-1")

        let scoped = CardQueueRequest(
            title: "Rewrite this heading",
            scope: CardScope(frameId: "frame-1", selector: "main h1"),
            assignment: .specialist(.copy)
        ).body
        checkEqual(scoped["agents"] as? [String], ["copy"])
        checkEqual((scoped["scope"] as? [String: String])?["frameId"], "frame-1")
        checkEqual((scoped["scope"] as? [String: String])?["selector"], "main h1")
        checkTrue(JSONSerialization.isValidJSONObject(scoped))
        checkEqual(SpecialistAgent.allCases.map(\.id), ["ux", "copy", "brand", "a11y", "polish"])
    }

    func testAgentActivityStates() throws {
        func tasks(_ json: String) throws -> [CanvasTask] {
            try JSONDecoder().decode([CanvasTask].self, from: Data(json.utf8))
        }
        checkNil(AgentActivityState.summarize(canvasName: "Canvas", tasks: []), "Empty task history")
        let active = try tasks(#"[{"id":"working","agentName":"Builder","status":"Designing","startedAt":1000,"pipeline":["design","review"],"stage":1},{"id":"queued","agentName":"","status":"Next","startedAt":2000}]"#)
        let state = AgentActivityState.summarize(canvasName: "Canvas", tasks: active)!
        checkEqual(state.phase, "working")
        checkEqual(state.activeCount, 1)
        checkEqual(state.startedAt, 1)
        checkEqual(state.stage, 2)
        checkEqual(state.stageCount, 2)
        let queued = AgentActivityState.summarize(canvasName: "Canvas", tasks: [active[1]])!
        checkEqual(queued.phase, "queued")
        checkTrue(queued.isActive)
        checkNil(queued.stage, "No invented pipeline progress")
        let failed = try tasks(#"[{"id":"failed","agentName":"Builder","status":"Working","startedAt":1000,"failedAt":2000,"failureReason":"Could not connect"}]"#)
        let terminal = AgentActivityState.summarize(canvasName: "Canvas", tasks: failed)!
        checkEqual(terminal.phase, "failed")
        checkEqual(terminal.status, "Could not connect")
        checkFalse(terminal.isActive)
        let run = try tasks(#"[{"id":"a","agentName":"Claude","status":"Reading the brief","startedAt":1000,"endedAt":5000},{"id":"b","agentName":"Claude","status":"Laying out the hero","startedAt":5000,"endedAt":9000},{"id":"c","agentName":"Claude","status":"Picking colors","startedAt":9000,"endedAt":12000},{"id":"d","agentName":"Claude","status":"Tightening copy","startedAt":12000}]"#)
        let steps = AgentActivityState.summarize(canvasName: "Canvas", tasks: run)!
        checkEqual(steps.steps, ["Laying out the hero", "Picking colors"])
        checkEqual(steps.startedAt, 1)
        let first = AgentActivityState.summarize(canvasName: "Canvas", tasks: [run[3]])!
        checkEqual(first.steps, [])
        let data = try JSONEncoder().encode(state)
        checkEqual(try JSONDecoder().decode(AgentActivityState.self, from: data), state)
    }

    func testSelfHostedPortIsPreserved() {
        let server = ServerAddress("https://design.example.com:8443")!
        checkEqual(server.home.absoluteString, "https://design.example.com:8443/auth")
        checkFalse(server.contains(URL(string: "https://design.example.com")!))
    }
}

private func checkEqual<T: Equatable>(_ actual: T, _ expected: T) { precondition(actual == expected) }
private func checkTrue(_ value: Bool) { precondition(value) }
private func checkFalse(_ value: Bool, _ message: String = "") { precondition(!value, message) }
private func checkNil<T>(_ value: T?, _ message: String) { precondition(value == nil, message) }
