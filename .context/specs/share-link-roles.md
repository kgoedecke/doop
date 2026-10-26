# Share link roles: view, comment, edit

A canvas's share link grants one of four levels to signed-in people who are not its owner, an
invited member or a member of its workspace: `none` (private, the default), `view`, `comment` or
`edit`. The owner picks the level in the Share modal ("Anyone with the link can…"). Signing in is
still required at every level; a signed-out visitor gets the sign-in screen, as before.

## Model

`Canvas.linkAccess` (`shared/canvasRole.ts`: `LinkAccess`) lives in the existing nullable
`canvases.link_access` text column. `none` is stored as `NULL`; unknown values read back as
private, so older rows (`edit` or `NULL`) keep working with no migration.

`canvasRole(userId, canvas)` in `server/access.ts` answers `'edit' | 'comment' | 'view' | null`:
ownerless legacy canvases are `edit` (so they can be claimed); the owner, invited members and
workspace members are `edit`; everyone else gets the link's level, or `null`. Three gates sit on
it: `canAccessCanvas` (read), `canCommentCanvas` and `canEditCanvas`. `hasDurableCanvasAccess`
is unchanged and never counts a share link at any level, so sync keys, GitHub connections,
webhooks, automations and live activities stay out of reach of link visitors.

## Enforcement

- REST (`server/index.ts`): `requireCanvas` / `requireFrame` take a required `need` role, so a
  route that forgets to name one does not compile. Reads (canvas GET, members, sync flow, doc
  history, frame versions, screenshots) need `view`; comment create, reply and resolve need
  `comment`; everything else that writes needs `edit`: frames, append, delete, approval, version
  restore, pages, rename, publish, docs, references, proposals, assets, imports (web and the
  integrations' importers), board cards, task feedback and agent retries. A refused role answers 403 with the
  caller's `role`. Extension canvas routes receive the same helper.
- An `@mention` turns a comment into a command the resident agent carries out on frames, so a
  comment or reply that mentions an agent needs `edit` (REST and MCP `reply_to_comment`).
- WebSocket room: the join computes the role and puts it on `init.canvas.role`. Inbound messages
  are checked against the live role on every message (`roomMessageNeeds`): `cursor` and
  `viewport` need `view`; `editing` and `frame:drag` need `edit`, and anything unknown needs
  `edit`. Joins below edit do not start the demo or the resident card kick. Changing the link
  sends each room connection `{ type: 'role', role }` and closes (4403) the ones left without
  access.
- MCP (`server/mcp.ts`): `canvasFor` / `frameFor` take a required `need` role, mapped per tool
  (reads `view`, comment threads `comment`, every other write `edit`, including `set_status`,
  `save_decision` and `get_feedback`). Feedback is claimed into results, and the set_status nudge
  appended, only for agents that can edit. A refusal on a readable canvas says which role the
  account has. Resident runs (local agent, Gemini cloud) require edit for their run-scoped MCP.

## Client

`GET /api/canvases/:id` and the room `init` carry `canvas.role`; `src/lib/store.ts` exposes
`roleOf`, `canEditOpenCanvas`, `canCommentOpenCanvas` and `toolAllowed`. Below edit the editor
is read-only: the tool rail shows Select and Hand (plus Comment for `comment`), frames select
but do not move, resize or enter text editing, context menus, Import, the Inspector and Design
panel, the agent composer, Layers and Pages edits, Memory curation, rename and edit shortcuts
are gone. A "View only" / "Can comment" badge sits beside the canvas name. Viewers read comment
threads without a reply field. The server enforces all of it regardless.

## Tests

`tests/canvasRole.test.ts` (access matrix, room message roles, stored values) and
`tests/shareLinkRoles.test.ts` (real server: REST writes refused for view and comment links,
comments allowed for comment links, the @mention rule, WS drag/editing not relayed, MCP writes
refused for a visitor's agent key, live role change and disconnect).
