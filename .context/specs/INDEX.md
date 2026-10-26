# doop - specs Index

Complete record of `.context/specs/`. This file is NOT @-imported by CLAUDE.md; it is reached by
link from [../INDEX.md](../INDEX.md), so it costs nothing until someone opens it, which is why it
lists every file in this folder.

## Active

- [prototyping.md](prototyping.md) - Clickable prototypes: interaction data attributes in frame
  HTML (triggers, actions, transitions, canonical form), per-page flow start, the prototype player
  and `/c/<id>/proto`, the editor's Prototype mode and connectors, and the MCP tools.
- [frame-approval.md](frame-approval.md) - Human sign-off for development, revision checks,
  automatic review invalidation, and approval metadata for MCP and resident agents.
- [frame-versions.md](frame-versions.md) - Per-frame design history: burst-based snapshots of the
  HTML a redesign, stream or restore replaced, the `frame_versions` table, REST + MCP restore, and
  the history modal.
- [chatgpt-app.md](chatgpt-app.md) - Doop as a ChatGPT app: what app review needs from `/mcp`
  (discovery, DCR, explicit tool annotations, profile tool), the inline preview card component
  (`server/chatgptApp.ts`), the "Claude Design for ChatGPT" marketing page, and the manual
  directory-submission checklist.
- [slack-agent.md](slack-agent.md) - Slack app: install per workspace, signed Events API / slash
  command inbox, the durable worker that creates a canvas, runs the resident agent and posts the
  result back in the thread, thread follow-ups, billing to the installer.
- [outbound-webhooks.md](outbound-webhooks.md) - Per-user outbound webhooks for comment, frame and
  agent-task events: event seam, signed delivery with retries and self-pausing, SSRF screening of
  the target URL, API and settings UI.
- [comment-notifications.md](comment-notifications.md) - Email for comments and replies people
  were not in the room to see: the canvas event bus, recipient rules, 2-minute coalescing, the
  per-user opt-out, and the `?frame=&comment=` deep link.
- [share-link-roles.md](share-link-roles.md) - View-only, comment-only and edit share links:
  `canvasRole` and the read/comment/edit gates across REST, the WebSocket room and MCP, and the
  editor's read-only mode.
- [workspaces-billing.md](workspaces-billing.md) - Shared workspaces (org-level canvas access with
  roles) and the per-seat Team plan on Stripe: data model, entitlement rules, API, webhook flow.
