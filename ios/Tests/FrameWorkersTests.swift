import Foundation
import DoopCore

enum FrameWorkersChecks {
    static func run() throws {
        let claude = try presence(##"{"clientId":"agent:Claude","name":"Claude","color":"#D97757","kind":"agent","activeFrameId":"f1"}"##)
        let codex = try presence(##"{"clientId":"agent:Codex","name":"Codex","color":"#2743EE","kind":"agent","activeFrameId":"f1"}"##)
        let person = try presence(##"{"clientId":"web-1","name":"Kevin","color":"#0E9F6E","kind":"user","activeFrameId":"f2"}"##)
        let idle = try presence(##"{"clientId":"agent:Gemini","name":"Gemini","color":"#8B5CF6","kind":"agent","activeFrameId":null}"##)

        let streaming = FrameWorkers.byFrame(streams: ["f1": FrameStream(name: "Claude", color: "#D97757")],
                                             presences: [claude, codex, person, idle])
        expect(streaming["f1"]?.map(\.name) == ["Claude", "Codex"], "the streaming agent leads, other agents follow")
        expect(streaming["f1"]?.first?.streaming == true, "the stream is marked as streaming")
        expect(streaming["f1"]?.first?.title == "Claude is designing", "a stream reads as designing")
        expect(streaming["f1"]?.last?.title == "Codex", "an open frame reads as the agent's name")
        expect(streaming["f2"] == nil, "a person's open frame is not shown as work")
        expect(streaming.count == 1, "an agent with no open frame shows nowhere")

        let open = FrameWorkers.byFrame(streams: [:], presences: [claude])
        expect(open["f1"] == [FrameWorker(name: "Claude", color: "#D97757", streaming: false)], "an open frame without a stream")
        expect(FrameWorkers.byFrame(streams: [:], presences: []).isEmpty, "nobody at work")

        let event = try JSONDecoder().decode(CanvasEvent.self, from: Data(##"""
        {"type":"frame:streaming","frameId":"f1","active":true,"actor":{"name":"Claude","kind":"agent","color":"#D97757","clientId":"agent:Claude"}}
        """##.utf8))
        expect(event.active == true && event.actor?.name == "Claude" && event.actor?.color == "#D97757", "frame:streaming decodes")
    }

    /// As the room sends it in `init` and `presence:join`.
    private static func presence(_ json: String) throws -> CanvasPresence {
        try JSONDecoder().decode(CanvasPresence.self, from: Data(json.utf8))
    }

    private static func expect(_ condition: Bool, _ message: String) { precondition(condition, message) }
}
