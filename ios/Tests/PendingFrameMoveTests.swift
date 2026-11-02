import Foundation
import DoopCore

enum PendingFrameMoveChecks {
    static func run() throws {
        let original = try JSONDecoder().decode(DesignFrame.self, from: Data(#"{"id":"f","canvasId":"c","name":"Original","x":0,"y":0,"width":100,"height":80,"html":"<p>Original</p>"}"#.utf8))
        var moves = PendingFrameMoves()
        let first = moves.begin(frameID: "f", x: 100, y: 200)
        var edited = original
        edited.name = "Renamed remotely"
        edited.html = "<p>Edited remotely</p>"
        edited.width = 300
        var frames = [edited]
        expect(moves.apply(to: &frames), "a full frame event keeps the pending drop")
        expect(frames[0].x == 100 && frames[0].y == 200, "pending position wins over stale geometry")
        expect(frames[0].name == edited.name && frames[0].html == edited.html && frames[0].width == 300,
               "collaborator edits still apply")
        expect(!moves.apply(to: &frames), "an already overlaid model needs no extra publication")

        let second = moves.begin(frameID: "f", x: 400, y: 500)
        expect(!moves.finish(frameID: "f", token: first), "an earlier save cannot clear a later drop")
        frames = [original]
        moves.apply(to: &frames)
        expect(frames[0].x == 400 && frames[0].y == 500, "reconnect snapshots keep the latest pending move")
        expect(moves.finish(frameID: "f", token: second), "the latest save releases its override")
        expect(!moves.finish(frameID: "f", token: first), "late responses remain stale after the latest save finishes")
        frames = [edited]
        expect(!moves.apply(to: &frames) && frames[0] == edited, "server geometry resumes after completion")

        let failed = moves.begin(frameID: "f", x: 600, y: 700)
        var other = original
        other.id = "other"
        let otherMove = moves.begin(frameID: other.id, x: 800, y: 900)
        expect(moves.finish(frameID: "f", token: failed), "a failed latest save releases its override before reload")
        frames = [original, other]
        moves.apply(to: &frames)
        expect(frames[0] == original, "failure recovery restores server coordinates")
        expect(frames[1].x == 800 && frames[1].y == 900, "failure recovery preserves other pending drops")
        frames = []
        expect(!moves.apply(to: &frames) && frames.isEmpty, "a deleted frame is never recreated by an override")
        expect(moves.finish(frameID: other.id, token: otherMove), "deleted frame saves can still finish")
        print("Pending frame move checks passed.")
    }

    private static func expect(_ condition: Bool, _ message: String) { precondition(condition, message) }
}
