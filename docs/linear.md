# Linear integration

Install **Doop** in Linear, delegate an issue to it from the assignment menu,
and Doop creates a canvas, runs its resident design agent, and returns the
canvas link in the Linear agent session. Linear keeps the human assignee;
Doop is the delegated agent.

## Server setup

1. Create an OAuth application named **Doop** in Linear’s **Settings → API**.
   Its name and icon are what people see in Linear’s assignment menu.
2. Set its callback URL to
   `https://YOUR_DOOP_HOST/api/integrations/linear/callback`.
3. Enable webhooks, select **Agent session events**, and set the webhook URL to
   `https://YOUR_DOOP_HOST/webhooks/linear`. This must be publicly reachable
   over HTTPS; it does not use a browser login.
4. Set `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, and
   `LINEAR_WEBHOOK_SECRET` on the Doop server. Set `BETTER_AUTH_URL` to its
   public origin. Restart the server; the database migration runs at boot.
5. In Doop **Settings**, connect the model account that will run designs.
   A configured server model and available resident task allowance also work.
6. In Doop **Integrations → Linear**, click **Install Doop agent**. A Linear
   workspace admin must approve installation.
7. In Linear, delegate an issue with a design brief to **Doop**. Watch the
   agent session for acknowledgment, an **Open design in Doop** link while
   it works, and a final result or actionable failure.

The install requests `actor=app` with `read,write,app:assignable` scopes.
OAuth uses one-time user-bound state, PKCE, and refresh-token rotation.
No personal API key is needed for automatic pickup.

## Ownership and behavior

Each Linear workspace has one Doop installer, and each Doop user can install
one workspace. Another account cannot silently take over an existing
installation. All delegated jobs bill the installer’s connected model account
or resident task allowance. Anyone able to delegate to the app in its
authorized Linear teams can initiate that work; the installation UI explains
this before redirecting to Linear.

A new agent session creates one private canvas and one design card attributed
to that installer. Ticket context becomes a bounded design prompt (up to
4,000 characters including Doop’s instructions). The original issue remains
in Linear. The canvas is private by default: the installer can invite
collaborators or enable link sharing in Doop. A Linear link does not grant
access to the canvas. Doop reports results in the agent session; it does not
mark the issue itself Done.

Initial delegation is supported. Follow-up design edits happen on the Doop
canvas; ordinary messages in the Linear session do not queue another paid
run. Linear’s **Stop** signal cancels pending work and stops the runner at its
next model/tool boundary. A tool already in flight may finish.

Disconnecting in Doop cancels pending/active design cards and removes local
credentials. Existing canvases stay. Uninstall the application in Linear
Settings as well to remove its agent identity and revoke its OAuth access.
Linear’s app-revoked webhook also disconnects it locally.

## Delivery and recovery

The webhook verifies HMAC-SHA256 over the raw bytes and a timestamp within
one minute. It persists the inbox before acknowledging; external API and
model calls happen in the worker. Events must match the installed organization,
app user, and configured OAuth client.

Session IDs deduplicate retries. The canvas, task, and session mapping commit
in one transaction before the resident runner starts. At most three sessions
per installer are dispatched at once. Results use durable activity IDs so an
ambiguous network failure can be retried without repeating the design.
Provider failures back off for a minute.

Unclaimed cards survive restart and use Doop’s existing queue recovery.
Interrupted claimed cards are marked failed by that recovery and reported to
Linear. Interrupted preparation is failed after two minutes rather than
automatically spending again; in the narrow crash window after allowance
consumption, a metered allowance slot may already have been spent. Runs that
remain unfinished after an hour fail visibly. Retry failed designs in Doop or
start a new delegation session; redelivering the same webhook never restarts
the job. As with the existing in-memory resident runner, use one active Doop
server process for design execution.

## Read-only MCP access

You can still connect a personal API key instead, with read access limited to
the relevant Linear teams. This provides ticket reading, not automatic pickup:

- `list_linear_issues`: open, unarchived tickets by default, newest updates
  first. Optional `team_key`, `assignee_id`, and `state_type`; `first`
  is capped at 50. Pass `pageInfo.endCursor` as `after` to continue.
- `get_linear_issue`: metadata and description by UUID or identifier,
  such as `ENG-123`.

These tools use the MCP session owner’s personal connection, or their app
installation if no personal key is connected. Credentials stay server-side.

Implementation references: [Linear agents](https://linear.app/developers/agents),
[agent interaction](https://linear.app/developers/agent-interaction),
[OAuth](https://linear.app/developers/oauth-2-0-authentication), and
[webhook verification](https://linear.app/developers/webhooks).
