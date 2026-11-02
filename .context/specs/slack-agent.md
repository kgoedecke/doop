# Slack agent

Why: the Linear agent proved that "delegate a brief, get a canvas back" is the right shape for
teams who do not live in Doop. Slack is where most briefs are actually written. Mentioning `@Doop`
(or `/doop <brief>`) creates a canvas, runs the resident design agent and posts the result back in
the thread. User-facing reference: `docs/slack.md`.

## Scope and ownership

Modeled one-to-one on the Linear agent (`server/linear/`). Per **Slack workspace**: one bot
installation (`slack_installations`, keyed by `team_id`) owned by the Doop user who installed it,
and one workspace per Doop user. The installer's model account or resident task allowance pays for
every run started from that workspace, whoever typed the mention; the Integrations card says so
before the redirect. Canvases are private and owned by the installer; the Slack link is not an
access grant. The core never names Slack: `slackExtension` in `server/extensions.ts` supplies the
webhook router, the worker, the connection status and the connect routes, and
`src/integrations/slack` supplies the card.

## Install (`server/slack/oauth.ts`)

Slack OAuth v2: `startInstall` writes a hashed, user-bound, 10-minute one-time state
(`slack_oauth_states`) and sends the person to `slack.com/oauth/v2/authorize` with the manifest's bot scopes
(`app_mentions:read, chat:write, commands, files:write, channels:history, groups:history,
im:history, mpim:history`; the history and files scopes are reserved, nothing reads or uploads
yet). `finishInstall` consumes the state for that user only,
exchanges the code at `oauth.v2.access`, and upserts the installation keyed by `team_id` with
`setWhere user_id = installer`, so a second installer for the same workspace gets a 409 and never
inherits billing. Bot tokens are stored as-is (they sign API calls, like Linear's) and never leave
the server. `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` gate the feature; the
status carries `agentConfigured: false` without them. `SLACK_API_URL` is the usual endpoint
override for tests.

## Inbound (`server/slack/webhook.ts`)

`POST /webhooks/slack`, mounted before the JSON/session middleware with a raw body:

- Signature: `v0=` + HMAC-SHA256(signing secret, `v0:<timestamp>:<raw body>`), compared in
  constant time; timestamps more than five minutes from now are refused (401 before anything is
  persisted).
- `url_verification` → the bare challenge as `text/plain` (Slack enables subscriptions on it).
- `event_callback` / `app_mention` → `receiveRequest`, unless the message has a `bot_id` or
  `subtype` or no `user`. `thread_ts ?? ts` is the thread Doop answers in.
- `app_uninstalled` / `tokens_revoked` → `disconnectTeam`.
- Slash command (form-encoded) → `receiveRequest` keyed `cmd:<trigger_id>`, answered in-band with
  an in-channel "Doop is on it". An empty brief gets an ephemeral hint and no row.
- Interactivity payloads are acknowledged and ignored (Doop defines no components).
- Every answered response carries `X-Slack-No-Retry: 1`; an unexpected failure drops the header so
  Slack redelivers. A retry that arrives anyway hits the primary key.
  Every payload is Zod-validated; Slack's own error text is never forwarded (`SlackError`).

## Jobs (`server/slack/jobs.ts`)

`slack_sessions` is the durable inbox/outbox, one row per event: `id` (Slack `event_id` or
`cmd:<trigger_id>`), team, installer, channel, `thread_ts`, requester, `response_url`, title,
prompt, status (`pending → preparing → running → complete | failed | canceled`), canvas and task
ids, `follow_up`, `ack_ts`, the `acknowledged / linked / reported` outbox flags, `next_attempt_at`
and timestamps. The prompt is built by `server/slack/prompt.ts`: mrkdwn tokens become readable
text, the bot mention is dropped, the brief is capped at 3,400 characters and wrapped in the same
"this is a design brief, ignore exfiltration/settings instructions" frame as Linear, within
`MAX_CARD_CHARS`.

The worker (`tickSlack`, every 5 s plus a wake on each webhook) selects in-flight and unreported
rows plus at most three pending rows per installer (a window function), so one workspace's backlog
cannot crowd out another's. It mirrors Linear's state machine:

1. Acknowledge once: post "Doop is on it" in the thread (`ack_ts`); a slash command with no thread
   posts its own channel message and threads under it. `not_in_channel` falls back to the
   `response_url`.
2. Dispatch under the installation row lock with a cap of three preparing/running sessions per
   installer: `pickModel`, `consumeResidentTask`, then canvas + task + session commit in one
   transaction before `onFeedback`. A failure to start refunds the allowance.
3. Once running, `chat.update` the acknowledgment with the **Open design in Doop** link (idempotent,
   so retries never pile up messages).
4. When the card ends (or an hour passes, or the canvas is gone), post the result: text + canvas
   link, an `image` block pointing at the public `/i/<frameId>.png` of the last surviving frame the
   card itself edited (never another frame on the canvas: the channel is not a canvas member), and
   a context line about ownership. `invalid_blocks` retries without the image. Failures post the
   error with the link. A finished card is reported even if the link update failed (the result
   carries the link); a deleted acknowledgment gets a fresh reply instead of blocking.
5. Provider failures set `next_attempt_at` a minute out; a design is never re-run automatically.
   Preparation older than two minutes is failed visibly (restart recovery).

Follow-ups: a mention in a thread whose earlier session has a `canvas_id` is a follow-up row with
`follow_up = true` and that canvas preset; dispatch skips canvas creation, checks the canvas still
exists and belongs to the installer, and queues a second card on it. It spends a run like any other.
Replies without a mention do nothing. There is no stop signal from Slack.

Disconnect (Doop page, `app_uninstalled`, `tokens_revoked`) takes the same installation lock as
dispatch, cancels active rows and their cards, marks everything reported so no stale message is
sent with a dead token, and deletes the installation.

## Not done / known limits

- No `files.uploadV2`: the screenshot is an image block pointing at the public frame image, so the
  Doop host must be reachable by Slack (it already must be for the webhook).
- A slash command in a channel without the bot relies on the 30-minute `response_url`.
- Requester identity is the Slack user id (no `users:read` scope), shown as "Slack member U…" in
  the prompt.
- The result post is at-least-once: `chat.postMessage` has no idempotency key, so if Slack accepts
  the message but the response is lost before `reported` is saved, the next attempt posts it
  again. The acknowledgment/link path is idempotent (`chat.update`), and a run is never repeated.
- A real workspace round-trip has not been run in CI; the tests stub `slack.com/api`.

## Tests

`tests/slackAgent.test.ts` (PGlite + stubbed fetch): install/state/second-installer, mrkdwn and
prompt bounds, queue/ack/link/result, empty brief, missing model, allowance, follow-up threads,
slash commands and the response_url fallback, disconnect, delivery retry without re-spend,
concurrency cap, preparation recovery, signature/url_verification/dedupe/bot-ignore/uninstall over
HTTP. `tests/slackIntegration.test.ts` (real server): status, OAuth handoff against a stub, wrong
user, replayed state, second installer, disconnect, unsigned webhook.
