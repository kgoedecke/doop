# Comment notifications

Why: comments, replies and @mentions are only ever broadcast to the clients that have the canvas
open. Anyone reviewing asynchronously (a client leaving feedback on a shared link, a teammate in
another timezone) is silently missed unless they poll `get_comments` over MCP
([doop#172](https://github.com/kgoedecke/doop/issues/172)). This spec covers the first native
path, email; outbound webhooks are a separate spec.

## Event seam (`server/events.ts`)

`emitCanvasEvent(canvasId, event)` / `onCanvasEvent(listener)`: a tiny in-process bus for what
happens AFTER a mutation is stored and broadcast. The action layer emits (one call per mutation,
so REST and MCP both fire it); listeners register at boot in `server/index.ts`. A throwing
listener is logged and skipped - a broken notifier never fails the comment it was told about.

Events today: `comment.created`, `comment.replied` (both carry the comment, its frame and the
`actorKind`). The union is meant to grow - frame created, agent task done, comment resolved - and
webhooks will consume it alongside email.

## Email (`server/commentNotifications.ts`)

- **Recipients** (`recipientsFor`): the canvas owner, invited members (`canvas_members`), every
  member of the canvas's workspace, plus everyone who already wrote in the thread (the only
  durable trace a share-link visitor leaves). Minus the author when a human wrote it. An agent's
  reply goes to everyone, including the account whose key or session ran the agent - MCP
  attributes the reply's `fromUserId` to that account, but they did not type the words.
- **Coalescing**: a review session is a burst, so each (recipient, canvas) batch is held for
  `COALESCE_MS` (2 min) and sent as one plain-text digest. Held mail lives in memory only; a
  restart inside the window drops it. Acceptable for a courtesy email, and keeps the feature
  state-free.
- **Delivery** goes through `server/mailer.ts` (SMTP). Without `SMTP_HOST` nothing is queued.
- **Deep link**: `/c/<canvasId>?frame=<frameId>&comment=<rootId>`. `Stage` already honours
  `?frame=`; `FrameView` opens the pinned thread named by `?comment=` (always the root id, since
  only roots have pins).
- At send time the recipient is re-checked (`mailableForComments`): banned, opted out, or the
  canvas deleted during the window means no mail.

## Preference (`server/notificationPrefs.ts`, table `notification_prefs`)

Sparse per-user row `{ user_id, comment_emails, updated_at }`; no row = on (opt-out). Read and
written by `GET`/`PUT /api/notifications`, which also report `emailConfigured` so the settings
UI (Settings → Your account → Notifications) can say why the switch is inert on an instance
without SMTP. Shared shape in `shared/notifications.ts`.

## Non-goals (for now)

- Email on resolve: low signal for the person who left the comment; a webhook event instead.
- Durable queue / retries: see the webhook spec, which needs them anyway.
- Human @mentions: the only mention syntax is for resident agent roles; a mention path for
  people would need a picker and a parser first.
