# Outbound webhooks

Why: the second native notification path after comment email
([doop#172](https://github.com/kgoedecke/doop/issues/172)) and the one integrators asked for:
`comment.*`, `frame.created` and agent-task events pushed to Slack / n8n / issue trackers instead
of a 5-minute `get_comments` poller. User-facing reference: `docs/webhooks.md`.

## Scope and ownership

Per **user**, not per canvas or workspace: a webhook registered under Settings → Webhooks fires
for every canvas its owner durably has access to (`hasDurableCanvasAccess`: owner, invited
member, workspace member — never a share-link visit). This mirrors account-scoped agent keys and
matches the asker's poller, which iterated `list_canvases`. Up to `MAX_WEBHOOKS` (10) per user. A
per-workspace variant (a team Slack channel) can sit on the same registry later by adding a
`workspace_id` owner column.

## Event seam

`server/events.ts` (introduced with comment email) grew `comment.resolved`, `frame.created`,
`task.completed` and `task.failed`, emitted from `actions.resolveComment`, `actions.createFrame`,
`actions.completeCard` and `actions.failCard`. Board cards are the only "agent task" that is an
event: status tasks opening and closing are narration, not outcomes. Email and webhooks are both
listeners; neither knows about the other.

## Registry and delivery (`server/webhooks.ts`)

- Table `webhooks` (migration 0024): `id, user_id, url, secret, events jsonb, enabled,
created_at, last_status, last_at, last_error, failures`. Hydrated into memory at boot like
  workspaces; every write goes through. The secret is stored as-is because it signs deliveries
  (like an integration token), and leaves the server only on create and rotate.
- Fan-out: on each event, every enabled hook subscribed to `event.type` whose owner has durable
  access to the canvas gets one POST. Body = envelope `{id, type, at, canvas}` + `payloadFor(event)`;
  frames never include HTML.
- Signing: `X-Doop-Signature: sha256=HMAC(secret, "<timestamp>.<body>")`, with
  `X-Doop-Timestamp`, `X-Doop-Event`, `X-Doop-Delivery`.
- Retries: `RETRY_DELAYS_MS` = 10 s, 1 min, 5 min, in memory, then dropped. Each retry re-checks
  that the hook still exists, is on, and that its owner still has durable access to the canvas,
  so a revoked member's endpoint never receives a payload that was queued before the revoke. Health
  (`lastStatus/lastAt/lastError/failures`) lands on the row; `DISABLE_AFTER_FAILURES` (100)
  consecutive failures pause the hook (`enabled=false`, explanatory `lastError`); re-enabling
  resets the counter. Overlapping attempts record in start order (a late failure cannot overwrite
  a newer success). Every mutation writes the row before touching memory, and creates for one
  account are serialised so the per-account cap holds under concurrent requests. No durable queue
  by design: the issue asked for real-time and state-free,
  and a receiver that is down for hours should fix the receiver.
- URL screening (SSRF): `http(s)` only, no credentials, `localhost`/loopback/link-local/RFC 1918/
  CGNAT/ULA refused — syntactically at save time and by DNS lookup at save time and before every
  delivery. `redirect: 'manual'` so a public URL cannot bounce the request inward.
  `WEBHOOK_ALLOW_PRIVATE_URLS=true` opts out for self-hosts on a private Docker network. The
  residual lookup-then-connect window is accepted and documented.
- Timeout 10 s per attempt; response bodies are cancelled, never read.

## API (`server/webhookRoutes.ts`, `/api/webhooks`)

`GET /` list · `POST /` `{url, events}` → info + `secret` · `PATCH /:id` `{url?, events?, enabled?}` ·
`DELETE /:id` · `POST /:id/rotate` → `{secret}` · `POST /:id/test` → `{ok, status, error?}` (a
synchronous `ping`). Input problems are `WebhookInputError` → 400 with the message.

## UI

Settings → Webhooks (`src/components/Webhooks.tsx`): URL + event checkboxes, secret shown once
with the signature recipe, per-hook health line, Send test / Rotate secret / Turn off / Remove.
