# Hosted Claude runtime

Doop's hosted Claude service uses `@cantelop/sdk@1.0.0-alpha.5`, including the
SDK-maintained Claude harness, native authentication provider and Docker image.
The service deploys independently of Doop. Its original App name is
`doop-claude-runtime`; contributor overrides retain their existing App identity.

Both Doop and this service pin the same **1.0.0-alpha.5** archive in
[`vendor/`](../vendor/README.md), including the SDK's backend declaration fix.
Live development and deployment require Cantelop CLI **0.15.1** or newer and a
platform supporting manifest schema 3, CLI build protocol 6, integration protocol 2
and native auth declarations. See the [upstream SDK](https://github.com/stepandel/cantelop-sdk)
and its [integration requirements](https://github.com/stepandel/cantelop-sdk/blob/main/docs/integration-foundation.md).

## Verification

Use Node 22+, Bun 1.3.10 and Docker with linux/amd64 support:

```sh
bun run cantelop:install
bun run cantelop:check
bun run cantelop:test
bun run cantelop:build
bun run typecheck
bun run lint
```

`cantelop:build` uses the SDK compiler to generate matching protocol Edge, Session
and backend artifacts under `.cantelop/artifacts`. `cantelop:client` generates the
backend module and `client.d.mts` declarations under the repository root's `.cantelop/claude-client`
so its SDK imports resolve to Doop's SDK installation. Doop's dev, build and start scripts
compile that backend automatically, as do type checking and tests. Doop imports
the generated App types directly. The compiler removes native runtime and auth
code from the backend and embeds the deployed runtime identity.

Qualify the SDK-owned native image independently of the CLI:

```sh
cd cantelop
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

Setup writes ignored `src/cantelop.local.ts` with a literal App name and points
`cantelop.local.json` at it. Both runtime and backend builds select that definition.
Hosted Doop Docker builds accept the public `CLAUDE_REMOTE_APP` build argument so
the compiled backend matches the independently deployed App. Credentials are
supplied only at runtime. Generated backend artifacts are copied into Doop's
runtime image without native Claude code or runtime source files.

After the compatible CLI/platform is available:

```sh
cantelop login
bun run cantelop:setup --app YOUR_EXISTING_APP --mcp-origin https://doop.example
```

The setup check reads an absent Session projection through the authenticated SDK
protocol; it does not provision a Workspace or start Claude. `cantelop:dev` uses
container mode with a compatible CLI. Rebuild both artifacts and restart Doop
after changing runtime source or App configuration.

Tests use fake Claude executables and controlled SDK protocol responses. They
verify cancellation, migration, recovery, tenant selection, reconnect gating,
link/code login, setup and compiler separation without model calls or user
credentials. A production sign-in, task, cancellation and reconnect still need
verification against the compatible deployed platform using the user's own account.
