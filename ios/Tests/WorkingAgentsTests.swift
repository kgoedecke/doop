import Foundation
import DoopCore

enum WorkingAgentsChecks {
    static func run() throws {
        let now = 1_800_000_000_000.0
        let claude = try decode(CanvasPresence.self, ##"{"clientId":"agent:Claude","name":"Claude","color":"#D97757","kind":"agent","status":"Laying out the hero"}"##)
        let idle = try decode(CanvasPresence.self, ##"{"clientId":"agent:Codex","name":"Codex","color":"#2743EE","kind":"agent"}"##)
        let person = try decode(CanvasPresence.self, ##"{"clientId":"web-1","name":"Kevin","color":"#0E9F6E","kind":"user","status":"x"}"##)
        let queued = try decode(CanvasTask.self, ##"{"id":"t1","agentName":"","status":"Make a landing page","startedAt":1799999990000}"##)
        let running = try decode(CanvasTask.self, ##"{"id":"t2","agentName":"Doop","status":"Picking a palette","startedAt":1799999995000}"##)
        let done = try decode(CanvasTask.self, ##"{"id":"t3","agentName":"Gemini","status":"Done","startedAt":0,"endedAt":3}"##)
        let stale = try decode(CanvasTask.self, ##"{"id":"t4","agentName":"","status":"Old idea","startedAt":1799000000000}"##)
        let critic = try decode(CanvasTask.self, ##"{"id":"t5","agentName":"","status":"Review it","startedAt":1799999990000,"pipeline":["doop","a11y"],"stage":1}"##)
        let custom = try decode(CanvasTask.self, ##"{"id":"t6","agentName":"","status":"Check","startedAt":1799999990000,"pipeline":["critic"]}"##)

        let pills = WorkingAgents.list(presences: [claude, idle, person], tasks: [done], now: now)
        expect(pills.map(\.name) == ["Claude"] && pills[0].status == "Laying out the hero", "only agents with a status, and no finished task")

        let waiting = WorkingAgents.list(presences: [], tasks: [queued], now: now)
        expect(waiting.map(\.status) == ["Starting…"] && waiting[0].name == "Doop", "a queued card shows as starting")

        expect(WorkingAgents.list(presences: [], tasks: [stale], now: now).isEmpty, "a card left waiting for long is not starting")
        expect(WorkingAgents.list(presences: [], tasks: [critic], now: now).first?.name == "Accessibility", "a card names its stage's role")
        expect(WorkingAgents.list(presences: [], tasks: [custom], now: now).first?.name == "@critic", "a custom role by its handle")

        let claimed = WorkingAgents.list(presences: [], tasks: [queued, running], now: now)
        expect(claimed.map(\.status) == ["Picking a palette"], "a running task replaces the starting pill")

        let both = WorkingAgents.list(presences: [claude], tasks: [running, queued], now: now)
        expect(both.map(\.name) == ["Claude", "Doop"], "presence statuses lead, unclaimed task agents follow")

        let event = try decode(CanvasEvent.self, ##"{"type":"status","clientId":"agent:Claude","status":null}"##)
        expect(event.type == "status" && event.status == nil, "a cleared status decodes")
    }

    private static func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private static func expect(_ condition: Bool, _ message: String) { precondition(condition, message) }
}
