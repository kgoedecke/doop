# Slack integration

Install **Doop** in Slack, mention `@Doop` with a design brief (or run
`/doop <brief>`), and Doop creates a canvas, runs its resident design agent,
and posts the finished design back in the thread with a link to the canvas.

## Server setup

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps)
   named **Doop**. Its name and icon are what people see when they mention it.
2. Under **OAuth & Permissions**, add the bot scopes `app_mentions:read`,
   `chat:write`, `commands`, `files:write`, `channels:history`,
   `groups:history`, `im:history` and `mpim:history`, and set the redirect URL to
   `https://YOUR_DOOP_HOST/api/integrations/slack/callback`.
3. Under **Event Subscriptions**, set the request URL to
   `https://YOUR_DOOP_HOST/webhooks/slack` and subscribe the bot to
   `app_mention`, `app_uninstalled` and `tokens_revoked`. The URL must be
   publicly reachable over HTTPS; Slack only enables the subscriptions once
   the running server answers its `url_verification` challenge.
4. Under **Slash Commands**, add `/doop` with the same request URL.
5. Set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and `SLACK_SIGNING_SECRET` on
   the Doop server. Set `BETTER_AUTH_URL` to its public origin. Restart the
   server; the database migration runs at boot.
6. In Doop **Settings**, connect the model account that will run designs. A
   configured server model and available resident task allowance also work.
7. In Doop **Integrations → Slack**, click **Install Doop in Slack** and
   approve the installation for your workspace.
8. In Slack, invite `@Doop` to a channel and mention it with a brief. Doop
   replies “Doop is on it” in a thread, edits that reply to add an **Open
   design in Doop** link once the canvas exists, and posts the finished
   frame with the canvas link when the design is done, or an actionable
   error if it is not.

The install uses Slack OAuth v2 with one-time user-bound state. Bot tokens do
not expire; a revoked token shows up as a failed delivery and in the
`tokens_revoked` event, which disconnects the workspace locally.

## Ownership and behavior

Each Slack workspace has one Doop installer, and each Doop user can install
one workspace. Another account cannot silently take over an existing
installation. Every request bills the installer’s connected model account or
resident task allowance. Anyone in the workspace who can mention the app or
run `/doop` can start that work; the Integrations page explains this before
redirecting to Slack.

A mention creates one private canvas and one design card attributed to the
installer. The message becomes a bounded design prompt (up to 4,000 characters
including Doop’s instructions); Slack mentions, channel links and URLs are
rendered as plain text, and the bot’s own mention is removed. The canvas is
private by default: the installer can invite collaborators or enable link
sharing in Doop. The Slack link does not grant access to the canvas. Doop
ignores messages posted by bots, including its own.

Mentioning `@Doop` again in the same thread queues a follow-up card on the
same canvas (the agent sees the existing frames), and spends another run. A
reply in the thread that does not mention `@Doop` does nothing; edits can
also be made directly on the canvas. There is no stop signal from Slack:
cancel a card on the canvas, or disconnect the workspace.

`/doop <brief>` behaves like a mention. Slack shows the acknowledgment
immediately; Doop then posts its own message in the channel and threads the
link and result under it. If Doop has not been invited to that channel, the
link and result go through the slash command’s response URL instead, which
Slack honours for 30 minutes, so invite `@Doop` for anything long-running.

The result message embeds the finished frame via Doop’s public frame image
URL (`/i/<frameId>.png`), so Slack must be able to reach your Doop host. If
Slack rejects the image, Doop posts the text and link alone.

Disconnecting in Doop cancels pending/active design cards and removes the
bot token. Existing canvases stay. Remove the app from Slack as well to revoke
its access; Slack’s `app_uninstalled` and `tokens_revoked` events also
disconnect it locally.

## Delivery and recovery

The webhook verifies Slack’s v0 signature (HMAC-SHA256 over the timestamp and
raw body) and rejects timestamps more than five minutes old. It persists the
inbox row before acknowledging and answers with `X-Slack-No-Retry`; external
API and model calls happen in the worker. Slack’s `event_id` (or the slash
command’s `trigger_id`) is the row id, so a redelivery never starts a second
run.

The canvas, task and session mapping commit in one transaction before the
resident runner starts. At most three sessions per installer are dispatched at
once. The acknowledgment is updated in place rather than re-posted, so a
retried link never piles up messages; the result is posted once and marked
reported. Provider failures back off for a minute.

Unclaimed cards survive restart and use Doop’s existing queue recovery.
Interrupted claimed cards are marked failed by that recovery and reported to
Slack. Interrupted preparation is failed after two minutes rather than
automatically spending again; in the narrow crash window after allowance
consumption, a metered allowance slot may already have been spent. Runs that
remain unfinished after an hour fail visibly. Retry failed designs in Doop or
mention `@Doop` again; redelivering the same event never restarts the job. As
with the existing in-memory resident runner, use one active Doop server
process for design execution.

Implementation references: [Events API](https://api.slack.com/apis/events-api),
[verifying requests](https://api.slack.com/authentication/verifying-requests-from-slack),
[OAuth v2](https://api.slack.com/authentication/oauth-v2) and
[slash commands](https://api.slack.com/interactivity/slash-commands).
