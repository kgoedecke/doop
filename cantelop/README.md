# Hosted Claude runtime

This directory is Doop's Cantelop Edge API and native Claude Session service.
Imported from `cantelop-claude-api` at commit
`33a1a0b15eb1d57746c9ade80ad685dd53bc1e18`. Make future changes here.
It deploys independently of Doop's Express server to the
`doop-claude-runtime` app named in `cantelop.json` (or your local manifest override). Moving the source does not move user data.

The SDK dependency is pinned in `package.json` and `bun.lock`.
See the [official SDK documentation](https://github.com/stepandel/cantelop-sdk).
Use Node 22+, Bun 1.3.10, Cantelop CLI 0.11.2 or newer, and Docker with linux/amd64 support.

From the repository root:

```sh
bun run cantelop:install
bun run cantelop:check
bun run cantelop:test
bun run cantelop:build
bun run cantelop:dev
```

The service has its own Bun lockfile and TypeScript configurations. Its tests
use Node's test runner; Doop's tests use Vitest. Both run in CI.
The service's `src/contracts.ts` is independent of Node and the SDK. Doop calls the auth routes through its own backend.

For a contributor deployment, run `cantelop login` followed by
`bun run cantelop:setup` from the repository root. Setup creates a local app
manifest, generates matching public/private identity configuration, deploys,
and checks `/v1/identity` without allocating a Workspace or Session. See the
[root setup guide](../README.md#set-up-your-own-hosted-claude-service).

Rerun setup to deploy changes to that app. To inspect its releases from this directory:

```sh
cantelop releases -config cantelop.local.json
```

The committed `cantelop.json` remains the original deployment target. Manual
operators can still use `cantelop doctor`, `cantelop deploy --dry-run`, and
`cantelop deploy` with their original configuration. Do not copy another
checkout's `.cantelop` directory, private key, bearer token, or `.env`.
Keep app name, identity issuer, audience, verification key, user IDs, workspace
slug derivation, and session IDs stable. After a deployment, test native sign-in,
a canvas task, cancellation, and stream reconnection with your own account.

Doop owns the private application signing key; this service receives only its
public JWK. Configure the matching variables described in the
[root README](../README.md#claude-plan-hosted-execution-with-your-own-claude-account).
Claude credentials and conversation state remain in existing Cantelop Workspaces.

## Architecture

- `src/api.ts`: `defineApi`, JWT verification, `app.workspaces.open`, `app.sessions.open`, dispatch, and authenticated event streaming. No local server or Docker daemon management.
- `src/session.ts`: `defineSessionBehaviour`, managed activities for long-running turns, queue/steer/cancel handling, and recovery.
- `src/login.ts`, `src/login-process.ts`, and `runtime/login-pty.py`: native login lifecycle and code entry.
- `src/claude.ts`: native CLI subprocess, process-group cancellation, stream parsing, explicit tool/MCP settings, and native authentication status.
- `src/state.ts`: atomic snapshots of configuration, queue, message status, and Claude conversation identity under `/workspace/.cantelop`.
- `cantelop.json` and `docker/Dockerfile`: Edge/Session entrypoints and system dependencies. Cantelop supplies the runtime user, startup command, and `/workspace` mount.

Each application identity maps to a server-derived Workspace slug. Separate sessions for that user mount the same Workspace. Claude's own authentication state lives in `/workspace/.claude` via `CLAUDE_CONFIG_DIR`; the application never reads or exports those credentials. Each logical Session stores a distinct Claude conversation ID and configuration.

## Authentication boundary

Doop issues a short-lived ES256 JWT for each user. The hosted API verifies it and derives the user's Workspace and auth Session. Claude Code runs its unmodified `claude auth login` command with `CLAUDE_CONFIG_DIR=/workspace/.claude`; Doop never reads or exports Claude credentials.

Login uses two calls. `POST /v1/auth/login` returns an Anthropic HTTPS sign-in URL and attempt ID. After signing in on Anthropic's site, the user pastes the one-time code into Doop. `POST /v1/auth/login/code` sends it to Claude Code and returns confirmed native auth status. The code uses PKCE, so it cannot be redeemed without the verifier held by Claude Code in the Sandbox. Raw terminal output stays in Session memory. Only one attempt runs per user's auth Session; it expires after ten minutes. `POST /v1/auth/cancel` stops it.

## Local setup

Requires Node.js 22+, Cantelop CLI 0.11.2+, Bun, and Docker with `linux/amd64` support.
CLI 0.11.2 waits for the container HTTP runtime to become ready before sending
requests, avoiding the startup race in 0.11.1. For Doop browser testing, follow
the [fully local setup](../README.md#fully-local-claude-development-no-tunnel);
the commands below run this service alone from the `cantelop/` directory.

The dev script runs `cantelop dev --container` so Sessions use this service's
Docker image, including Claude Code, Python, and `/opt/app/login-pty.py`, with
the Workspace mounted at `/workspace`. This also applies to
`bun run cantelop:dev` from the repository root.

```sh
bun install --frozen-lockfile
cp .env.example .env
# Set AUTH_PUBLIC_JWK, AUTH_ISSUER, and AUTH_AUDIENCE for your identity provider.
bun run check
bun run test
bun run build
bun run dev
```

Use an ES256 JWT issued by your application authentication system as `USER_TOKEN`, matching the public key, issuer, and audience configured in `.env`. Use the API base URL printed by `cantelop dev` as `BASE_URL`. The project does not issue application tokens.

`bun run build` runs `cantelop build`, which reads `cantelop.json` and builds both the Edge API and native Session image. The Dockerfile downloads Claude Code 2.1.267 directly and checks repository-pinned SHA-256 hashes for Linux amd64 and arm64 before installing it. Runtime auto-updates are disabled. To update Claude, change the version and both checksums together using Anthropic's release manifest, then run the service tests and image build. CI similarly pins the Cantelop CLI release archive and checksum in `.github/workflows/ci.yml`; neither build executes a downloaded installer script.

## API usage

For interactive subscription login:

1. `POST /v1/auth` with `{}` opens the user's Workspace and returns native `auth.status` directly.
2. If signed out, `POST /v1/auth/login` with `{}` returns `{type: "auth.login", attemptId, url, expiresAt}`. Open only a validated Anthropic HTTPS URL.
3. After the user signs in, `POST /v1/auth/login/code` with `{attemptId, code}` returns `{type: "auth.status", authenticated: true}` after Claude confirms sign-in. A rejected code returns `code_rejected` and can be retried. An expired attempt returns `login_not_active`.
4. `POST /v1/auth/cancel` with `{attemptId}` stops an attempt. Use `{force: true}` with the login call when reauthentication is required even if stale credentials report signed in.

The API derives the auth Session from the caller's JWT. Successful status and code confirmation release its Sandbox after persisting credentials in the Workspace. A confirmed logout releases the Sandbox after native sign-out.

Create a configured agent Session:

```sh
curl "$BASE_URL/v1/sessions" -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"tools":["Read","Glob","Grep"],"allowedTools":["Read","Glob","Grep"],"mcps":{}}'
```

Optional session execution settings can be supplied alongside MCP configuration:

```json
{
  "model": "sonnet",
  "systemPrompt": "You operate this canvas using only the supplied Doop tools.",
  "maxTurns": 24,
  "tools": [],
  "allowedTools": ["mcp__doop__*"],
  "mcps": {
    "doop": {
      "type": "http",
      "url": "https://your-doop.example/local-agent/mcp/RUN_ID",
      "headers": { "Authorization": "Bearer RUN_SCOPED_TOKEN" }
    }
  }
}
```

- `model`: optional native model alias or ID, 1–128 ASCII letters, digits, dots, underscores or hyphens, starting with a letter or digit. Omit it or use `default` for Claude's native default. Availability is determined by the user's account and installed Claude version.
- `systemPrompt`: optional nonblank replacement for Claude's default system prompt, at most 32 KiB in UTF-8. Passed using a private temporary file, removed after the turn, and persisted as part of the Session configuration. It is not appended to the user's message.
- `maxTurns`: optional integer from 1 to 100, applied to each message, including resumed turns. Omission retains Claude's native default. A turn-limit failure is reported as a failed message, not successful completion.

All configuration is immutable and survives reactivation. Create a fresh Session when changing models, prompts, or run-scoped MCP tokens. Model usage still requires the user's native Claude authentication; these fields do not accept provider credentials.

Message `text` accepts up to 32 KiB of UTF-8. Every POST body remains limited to 48 KiB of encoded JSON, including configuration, MCP headers, and JSON escaping. Larger context must be fetched through MCP or split into separate tasks.

Session creation is asynchronous: observe `session.ready` and `auth.status`. A Session can be configured before native sign-in; each turn rechecks authentication and fails without starting a model call if unauthenticated. Store the returned `sessionId` as `SESSION_ID`.

`tools` selects available built-in tools; it defaults to none. `allowedTools` grants unattended execution for the listed tool names or native rules. Other permissions are denied (`dontAsk`); there is no blanket permission bypass. Custom tools are MCP tools, not JSON function declarations.

`mcps` is a name-to-server map. For example:

```json
{
  "docs": { "type": "http", "url": "https://your-mcp.example/mcp" },
  "local": { "type": "stdio", "command": "node", "args": ["/workspace/tools/server.js"] }
}
```

HTTP/SSE servers may include `headers`; stdio servers may include `env`. Tool code and dependencies must exist in the Sandbox. MCP settings may contain secrets and are persisted within the user's Workspace. Grant matching permissions explicitly, such as `mcp__docs__search`. Session configuration is immutable; create a new Session to change it.

Send queued or steering messages:

```sh
curl "$BASE_URL/v1/messages" -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"$SESSION_ID\",\"text\":\"Inspect this project\",\"mode\":\"queue\"}"

curl "$BASE_URL/v1/messages" -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"$SESSION_ID\",\"text\":\"Focus on authentication\",\"mode\":\"steer\"}"
```

Each response has a platform `receiptId` and an application `messageId`. Supply an optional UUID `messageId` to retry a message idempotently; reusing it with different text emits `message_id_conflict`.

Cancel an active or queued application message:

```sh
curl "$BASE_URL/v1/cancel" -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"$SESSION_ID\",\"messageId\":\"$MESSAGE_ID\"}"
```

Watch output:

```sh
curl -N "$BASE_URL/v1/events?sessionId=$SESSION_ID" \
  -H "Authorization: Bearer $USER_TOKEN"
```

This returns SDK-native SSE. WebSocket clients use the `cantelop.events.v1` subprotocol and must supply the bearer header through a compatible client. Browser `EventSource` and browser WebSocket constructors cannot set arbitrary Authorization headers; a browser integration needs a same-origin backend/cookie adapter. Tokens are deliberately not accepted in query strings.

The SDK handles bounded replay using `Last-Event-ID` or `stream_id`/`after` query parameters. Large Claude frames are emitted as `claude.fragment`: concatenate `json` by `eventId` and `index`, then parse when `total` fragments arrive. Other frames use `claude`. Events are private model output and may contain user data.

Request a durable state snapshot after a stream reset:

```sh
curl "$BASE_URL/v1/snapshot" -H "Authorization: Bearer $USER_TOKEN" \
  -H 'Content-Type: application/json' -d "{\"sessionId\":\"$SESSION_ID\"}"
```

The HTTP 200 response contains `{sessionId, type: "session.state", configured, messages, truncated}` directly, with the latest 50 messages and prompt previews capped at 256 characters. It is a summary, not a full transcript API. Sandbox recovery still emits a `session.state` event.

| Method | Route                      | Behaviour                                                    |
| ------ | -------------------------- | ------------------------------------------------------------ |
| GET    | `/health`                  | Public liveness                                              |
| GET    | `/v1/identity`             | Verify JWT identity without provisioning resources           |
| POST   | `/v1/auth`                 | Open Workspace and return native auth status                 |
| POST   | `/v1/auth/login`           | Start native sign-in and return Anthropic URL and attempt ID |
| POST   | `/v1/auth/login/code`      | Submit code and return confirmed native auth status          |
| POST   | `/v1/auth/cancel`          | Cancel the caller's active login attempt                     |
| POST   | `/v1/auth/logout`          | Sign out with native Claude Code                             |
| POST   | `/v1/sessions`             | Create and configure a Session                               |
| POST   | `/v1/messages`             | Queue or steer a message                                     |
| POST   | `/v1/cancel`               | Cancel a queued or active message                            |
| POST   | `/v1/snapshot`             | Return persisted Session summary directly                    |
| GET    | `/v1/events?sessionId=...` | SDK SSE/WebSocket stream                                     |

All API routes except health require an application JWT. Workspace selection is derived from verified identity; clients cannot select another user's Workspace. Session ownership is checked before dispatch, requests, and event subscription.

Auth checks, login, code submission, cancellation, and snapshots use `session.request()` and return their replies directly. Login errors are mapped to HTTP 409 (`login_not_active`), 422 (`code_rejected`), 502 (`login_failed`), or 504 (`login_timeout`). Newly created Workspace registration errors are retried with bounded backoff; request retries reuse the original message ID.

## Queue, cancellation, and durability

Cantelop serializes command handlers in the Session mailbox. A managed activity runs a turn while the mailbox stays responsive. The application persists its pending prompt queue separately from the platform mailbox. Only one turn runs per Session.

- `queue`: FIFO after pending work.
- `steer`: interrupt the active native process group, wait for termination, then run the steering prompt before pending work. Repeated steering is newest-first. This is interrupt-and-resume, not mid-generation injection.
- `cancel`: remove a queued message or terminate the active turn. Finished messages are unchanged. Completed tool effects cannot be undone.

The runner uses SIGTERM, then SIGKILL for stubborn process groups, and waits before starting the next turn. Tools that deliberately detach into their own process group may outlive a turn; Sandbox termination is the broader cleanup boundary.

Configuration, message IDs/statuses, pending queue, and conversation identity survive Sandbox loss. On reactivation, previously running work becomes `interrupted` and is **not replayed** because tools may already have produced effects. The recovery hook resumes only queued work. Output events use Cantelop's bounded in-memory stream; full event history is not durable. Claude manages its own native transcript. An interruption before the transcript is written can make a later resume fail and may require a new Session.

Sessions share files within the same user's Workspace; concurrent sessions can edit the same files. Data persists when Cantelop releases a Sandbox. A Session retains at most 1,000 application messages; create a new Session after that. Queue snapshots are atomically replaced; this is not a general transactional database or an exactly-once tool-execution guarantee.

## Deployment and remaining work

Configure the public identity settings in `cantelop.json` through Cantelop App configuration, then use the standard `cantelop doctor` / `cantelop deploy --dry-run` / `cantelop deploy` workflow. A dry run builds without publishing.

Before production: integrate your identity issuer and key rotation/revocation strategy, add user quotas and admission/rate limits, and define Workspace retention/backup/deletion policies. Review network access for your MCP services under Cantelop's sandbox policy. Do not place shared provider credentials or application signing keys in App environment variables visible to native Sessions.

## Verification

Tests exercise actual SDK route definitions, JWT/tenant checks, Workspace/Session dispatch, managed activity queue/steer/cancel behaviour, durable reactivation, output fragmentation, and native subprocess parsing/cancellation using a fake Claude executable. They do not call a model or use subscription credentials. The login tests use a fake interactive Claude executable and verify PTY input, cancellation, and the two-call API. A real subscription authorization and model turn require the user’s own account; automated tests do not sign in as the user.

### Re-authentication

The native CLI owns credential refresh in the durable workspace. Terminal native
`authentication_failed` errors and an explicit signed-out status emit
`auth.required` with the affected message ID. Status command failures are not
classified as sign-out. A successful CLI turn after an internal auth retry does
not emit `auth.required`; billing, rate-limit, and network failures retain normal
failure handling.

Clients should pause new work for the affected user and offer native sign-in.
Pass `force: true` to `POST /v1/auth/login` to open a new login even when stale saved credentials still report signed in. Clear the pause only after `POST /v1/auth/login/code` returns confirmed `authenticated: true`. Interrupted work must not be
replayed automatically because earlier tool actions may already have completed.

### Signing out

`POST /v1/auth/logout` with `{}` runs native `claude auth logout` in the caller’s auth Session and verifies `claude auth status` reports signed out. It cancels and awaits any interactive login first, clears cached login completion, and returns HTTP 200 with `{sessionId, type: "auth.status", authenticated: false}` only after confirmation. Stop the caller’s agent tasks before signing out. No workspace files or conversations are deleted. The request waits up to 45 seconds; a timeout does not confirm sign-out and can be retried.
