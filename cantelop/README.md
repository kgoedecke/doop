# Hosted Claude runtime

Doop's hosted Claude service uses `@cantelop/sdk@1.0.0-alpha.9`, including the
SDK-maintained Claude harness, native authentication provider and Docker image.
The service deploys independently of Doop. Its original App name is
`doop-claude-runtime`; contributor overrides retain their existing App identity.

Both Doop and this service pin the published **1.0.0-alpha.9** npm release,
including portable backend declarations, the App-name build override and per-task Claude settings.
Live development and deployment require Cantelop CLI **0.15.1** or newer and a
platform supporting manifest schema 3, CLI build protocol 6, integration protocol 2
and native auth declarations. See the [upstream SDK](https://github.com/stepandel/cantelop-sdk)
and its [integration requirements](https://github.com/stepandel/cantelop-sdk/blob/main/docs/integration-foundation.md).

## Verification

Use Node 22+, Bun 1.3.10 and Docker with linux/amd64 support:

```sh
bun install --frozen-lockfile
bun run cantelop:check
bun run cantelop:test
bun run cantelop:build
bun run typecheck
bun run lint
```

`cantelop:build` runs the Cantelop CLI to generate matching Edge, Session runtime
and backend artifacts and qualify the runtime image. The CLI writes the backend
to `cantelop/.cantelop/client`. Doop imports it directly, using the shared Bun
workspace SDK installation, including the generated types. Run this build before starting Doop, type checking,
testing or building its Docker image. Ordinary Doop commands reuse the artifacts.
The SDK strips native code from the backend and embeds the runtime identity.

Qualify the SDK-owned native image independently of the CLI:

```sh
docker build --platform linux/amd64 \
  -f node_modules/@cantelop/sdk/dist/harnesses/claude/Dockerfile \
  -t doop-claude-sdk .
docker run --rm doop-claude-sdk sh -c \
  'claude --version && python3 -m py_compile /opt/app/login-pty.py'
```

The pinned SDK currently ships Claude Code 2.1.259 and its PTY helper. Updating
Claude and the image belongs to the SDK release; this repository no longer
maintains a separate CLI download or login subprocess.

## Architecture

- `src/cantelop.ts` defines the named App, native `claudeAuth`, SDK Dockerfile and runtime handlers. `cantelop.json` is the schema-3 definition pointer. The SDK generates Edge `/commands`; the service has no custom HTTP API.
- `src/cantelop.ts` declares the SDK's `createClaudeRuntime` with workspace and permission settings. The SDK owns configuration, durable queues, cancellation, steering, status events and recovery, and uses `createClaudeHarness` internally for native execution.
- `src/cantelop.ts` imports the public SDK protocol directly. There are no local contract shims, validators, behaviours, state stores or native runners. The SDK validates configuration and decodes output fragments; Doop only maps native results to canvas task results. Existing snapshots and conversation migration stay compatible.

Only the authenticated Doop backend holds an App-scoped integration token. It
chooses the Workspace slug from the existing issuer/user hash and checks Session
ownership before dispatch, snapshots, cancellation and streaming. Browser clients
cannot choose Workspaces or receive the App token. Run-scoped MCP tokens retain
their existing canvas authorization and revocation rules.

Native sign-in uses the SDK method `workspace.auth().login({ force, signal })`.
The SDK checks existing sign-in or confirms logout before starting native login.
It returns an attempt ID and Anthropic link, then accepts `submitCode({ attemptId, code })`
for the code form. `cancelLogin({ attemptId })` stops only the selected attempt.
The SDK owns prompt parsing, timeouts, rejected-code retries and process cleanup;
raw CLI output stays private. Native status and the matching reconnect attempt
must both be confirmed before Doop enables tasks. Disconnect stops tasks before
native logout; unconfirmed sign-out remains retryable.

## Migration and deployment

Follow the [root setup guide](../README.md#set-up-your-own-hosted-claude-service).
Preserve App name, `CLAUDE_REMOTE_ISSUER`, Doop user IDs, Workspace derivation and
existing Session IDs. The issuer is now a durable identity namespace; changing it
would create different Workspaces. Existing `.claude` credentials remain in place.
Legacy conversation IDs and resumption flags seed the SDK's own durable conversation
store once; existing SDK state takes precedence on later activations.

The old per-user ES256 JWT/API configuration is retired. Doop now requires the
platform-issued `CANTELOP_INTEGRATION_TOKEN`. Never use administrative CLI login
credentials or put this token in the native Sandbox environment. Existing legacy
signing-key entries may remain in a contributor's private environment but are unused.

`src/cantelop.ts` is the single App definition. Keep its name equal to Doop's
`CANTELOP_APP_SLUG`. Configure the backend environment using the root `.env.example`.
Build and deploy with the CLI:

```sh
bun run cantelop:build
cantelop login
bun run cantelop:deploy
```

`cantelop:dev` uses container mode. Rebuild the generated client and restart Doop
after changing runtime source, App configuration or the SDK. Build Doop's Docker
image after `cantelop:build`; it packages the compiled client and requires no
Cantelop CLI or Docker daemon inside the image.

Tests cover Doop's App compilation and backend integration with controlled SDK
responses: user isolation, task-scoped MCP access, cancellation, reconnect gating
and link/code login. Native harness behavior and fragment decoding belong to the
SDK test suite. These tests make no model calls and use no user credentials. A production sign-in, task, cancellation and reconnect still need
verification against the compatible deployed platform using the user's own account.

Claude execution policy and native tool defaults are declared in `src/cantelop.ts`.
Doop dispatches each task with `settings` for its model, system prompt, turn limit,
MCP permissions and run-scoped credentials. There is no separate configuration request.
