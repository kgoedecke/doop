# Frame approval for development

People toggle **Mark as approved** in the Inspector's Development section or use the
frame context menu (including a selection of frames). Badges on frame titles and in
Layers share the status with collaborators. The toggle is green when on, and its label
uses the same muted color as the Padding label. Reviewer and date appear on hover or keyboard focus.
Turning the toggle off moves an approved screen to draft. After a design changes, the
toggle turns off and **Needs review** appears; turn it on to approve again, or use the
compact **Move to draft** text action to dismiss the previous approval.

`Frame.approval` is optional/null for drafts. Otherwise it records `status`
(`ready_for_dev` or `needs_review`), `approvedBy`, `approvedByUserId`, `approvedAt`,
and `approvedFrameUpdatedAt` (the revision reviewed before sign-off). It is stored in
the nullable `frames.approval` JSONB column, migration 0034, and included in normal
canvas reads and websocket frame updates.

`PUT /api/frames/:id/approval` accepts `status: ready_for_dev | draft` and requires
`expectedUpdatedAt`. The server checks canvas access and the reviewed revision, derives
attribution from the authenticated session, rejects approval during a stream/reveal,
and records an activity entry. General frame writes cannot set approval. The client
waits for confirmation and reports errors, including partial batch failures.

`src/lib/frameSaves.ts` tracks queued HTML drafts and in-flight design writes per
frame. Both approval controls and their shared mutation helper check this state,
so context-menu approval cannot race the Inspector's 700 ms autosave. Counts keep
approval blocked across overlapping requests, and settle on success or failure.

`store.updateFrame` changes a ready approval to `needs_review` whenever HTML, width,
or height actually changes. This covers humans, agents, sync, streams, and restores.
Renaming, moving, page changes, hiding, locking, and no-op writes preserve approval.
Duplicated frames/pages/canvases start as drafts. Restoring a design does not restore
its old approval; a person must approve it again.

MCP `get_canvas` and `get_frame` expose `approvalStatus` and the approval record.
`get_canvas` accepts optional `approval_status: draft | ready_for_dev | needs_review`;
the frame list and preview both follow the filter. Resident and local agents also
receive approval in their initial frame list, inspection results, and HTML reads.
Agent guidance says to re-read before implementation and treat only `ready_for_dev`
as current approval. This feature exposes human sign-off; it does not queue or start
implementation jobs.

Agents set approval only when a person asks: MCP `set_frame_approval` (`frame_id`,
`status: ready_for_dev | draft`) and the resident tool of the same name both run `actions.agentSetFrameApproval`.
The approval stays the person's (`approvedBy` / `approvedByUserId`: the MCP connection's
account, or the resident run's requester, who must be able to edit the canvas) and records
the agent as `approvedVia`, shown in the tooltip as "Approved by Kevin via Claude Code".
The agent is the actor of the broadcast and the activity line ("marked … ready for dev for
Kevin"). A stream or reveal in progress, missing edit access
and, for the resident, a run that holds automation-queued work (`isAutomationCard`) are
refused, so an approval workflow cannot approve its own drafts and start itself again.
Agent approvals start approval automations like any other.

Coverage: `tests/frameApproval.test.ts` exercises access, attribution, revision
conflicts, websocket activity, invalidation, MCP reads/filtering and agent approval,
copies, restores, and persistence; `tests/residentApproval.test.ts` the resident tool. `tests/frameApprovalControl.test.tsx` covers pending/failed approval,
re-review, streamed/unsaved changes, late responses, and partial batch failures.
The browser pass exercises draft → ready → needs review → ready → draft with the
Inspector, frame title, and Layers badges visible together.
