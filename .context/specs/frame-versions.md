# Frame version history

Why: an agent's `set_frame_html`, a stream started with `start=true`, or a human pasting a whole
document into the Inspector replaced a frame's HTML in memory and (400 ms later) in the
database, and nothing kept the old copy. The browser's undo stack (`src/lib/history.ts`) is
local to one client and deliberately never reverts another actor's work, so there was no way
back from a redesign nobody asked for. This spec adds a server-side history per frame, with
restore from the browser and from MCP.

## What a version is (`server/actions.ts`)

History is kept per **burst** of edits, not per write: a stream's chunks, an agent's tweak right
after its redesign, a human typing in the Inspector (autosaved every 700 ms) are each one burst.
What gets filed is the state a burst **starts from** - the HTML and size the frame had when a new
burst replaced it - so every burst's final state is captured exactly once, when the next burst
begins, and the live frame is always the open burst's result.

- A full replace always opens a burst: `set_frame_html` (which passes `replace: true` to
  `updateFrame`, so two whole-document writes that keep a big shared stylesheet are still two
  versions), a REST `PATCH` whose HTML shares less than half of its start plus end with the old
  one (`sharedSpan`: common prefix + common suffix, the same `smallTweak` test that decides
  between a reveal and an in-place morph), a stream's opening chunk, a restore. The suffix
  matters: an `edit_frame_html` near the top of a document used to count as a rewrite under the
  prefix-only check, and would have replayed as a reveal.
- A small tweak joins the open burst when the same actor (name + kind) made it within
  `BURST_IDLE_MS` (2 min) of the burst's last write: `edit_frame_html`, element-panel edits,
  Inspector typing, non-opening stream chunks. Otherwise it opens a burst too.
- Snapshots are attributed to the open burst's actor and last write time. After a restart the
  burst table is empty, so the first write files the current state under the frame's own
  `updatedBy`/`updatedAt` with an unknown kind - the only case `saved_by_kind` is null.
- An empty previous state (a frame created without HTML, then streamed into) is not filed.
- `persist.saveFrameVersion` skips the insert when the newest row already holds the same HTML at
  the same size (a burst that ended where it began), then prunes past `MAX_FRAME_VERSIONS` (50)
  per frame. Writes queue per frame, and a frame's or canvas's deletion queues behind them, since
  a write reads before it inserts and must not put history back after a delete. Listing waits for
  the frame's queued writes (a replace files its version behind the response), and shutdown's
  `flush` waits for all of them, so a design never survives a restart without its history.

`restoreFrameVersion(frameId, versionId, actor)` ends any live stream or playback on the frame,
files the current state as a version (so a restore is itself reversible), writes the version's
HTML + width + height (name and position stay), broadcasts `frame:updated` and logs
"restored X to an earlier version by Y". A version id resolves only on its own frame.

## Storage (`frame_versions`, migration 0029)

`{ id, frame_id, canvas_id, html, width, height, saved_at, saved_by, saved_by_kind }`, indexed
by frame and by canvas. Cold path: written fire-and-forget like every other row, read only when
someone opens the history. Deleting a frame or canvas deletes its rows; duplicating a canvas does
not copy them.

## API

- `GET /api/frames/:id/versions` - newest first, without HTML (`FrameVersionInfo` in
  `shared/types.ts`: id, size, author, time, `htmlBytes`).
- `GET /api/frames/:id/versions/:versionId` - one version with its HTML.
- `POST /api/frames/:id/versions/:versionId/restore` - `{ frame, replaced }`: the restored frame
  and the complete state it swapped out. The browser records its undo entry from `replaced`, not
  from its own copy, which mid-reveal holds only the HTML shown so far.
- Access is the frame's canvas access (`requireFrame`); anyone who can edit can restore.
- MCP: `list_frame_versions` (read-only) and `restore_frame_version`, mentioned in the server
  instructions and the agent guide so an agent can honour "go back to the previous version".

## UI (`src/components/FrameHistoryModal.tsx`)

Opened from the frame's right-click menu ("Version history…") and the Inspector footer
("History"). Lists the live design on top, then each version with author (agent icon for agents),
age, size and bytes. Picking one renders its HTML in a script-less sandboxed iframe at its own
size, scaled to fit; "Restore this version" goes through the API, records a local undo entry so
⌘Z reverts it, and closes with a notice.

## Non-goals (for now)

- A diff view between versions; the preview is the comparison.
- Named/pinned versions, or restoring name and position.
- Canvas-level snapshots across many frames.
