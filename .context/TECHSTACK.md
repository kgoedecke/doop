# TECHSTACK - doop

## 1. Language and Runtime

- TypeScript 5.5.3 (strict mode) - primary language across `server/`, `src/`, and `shared/`.
- Node.js - runtime; `tsx` 4.23.9 runs server TypeScript directly with no build step, both in dev
  (`tsx watch`) and prod (`NODE_ENV=production tsx server/index.ts`).
- Bun 1.3.10 - pinned via `packageManager` in `package.json`; used as the package manager and
  script runner, not as the server runtime.
- Rust (stable) - `desktop/src-tauri`, the Tauri desktop shell.

## 2. Core Frameworks and Libraries

- Express 4.19.2 - HTTP server framework in `server/`.
- React 18.3.1 - UI framework in `src/`.
- Zustand 4.5.4 - client-side state management.
- Radix UI primitives (`@radix-ui/react-*`, ^1.x-2.x) + shadcn 4.19.0 - accessible UI primitives
  generated into `src/components/ui`.
- `@anthropic-ai/sdk` 0.115.0 and `@modelcontextprotocol/sdk` 1.12.0 - power the built-in Doop
  Agent and the MCP server that lets external agents (e.g. Claude Code) design on a canvas.
- `ws` 8.18.0 - WebSocket server for realtime multiplayer (cursors, presence, frame edits,
  activity feed) over one room per canvas.

## 3. Data and Persistence

- PostgreSQL 16 (`postgres:16-alpine` in `docker-compose.yml`) - primary database.
- drizzle-orm 0.45.2 + drizzle-kit - schema in `server/db/schema.ts` and
  `server/db/auth-schema.ts`; migrations generated via `npx drizzle-kit generate` into
  `server/db/migrations`, applied at boot by `server/db/index.ts` (never by drizzle-kit itself).
- `@electric-sql/pglite` 0.5.4 - embedded Postgres so `bun run dev` works with zero external
  services.
- `pg` 8.22.0 - Postgres driver for the real-database path.

## 5. Security and Secrets

- better-auth 1.6.26 - authentication: email/password, generic OIDC/SSO, and Google / Microsoft
  sign-in (social providers, `GOOGLE_*` / `MICROSOFT_*` client pairs). Configuration and secrets
  (`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, provider client IDs/secrets) come from the
  environment (`.env`, documented in `.env.example`); never committed.

## 6. Build and Dependency Management

- Bun 1.3.10 - package manager; lockfile at `bun.lock`, installed with `bun install
--frozen-lockfile` in CI.
- Vite 5.3.3 - frontend build tool (`vite build`).

## 7. Testing Stack

- Vitest 4.1.11 - unit/integration tests across `server/` and `src/`; run via `bun run test`
  (`vitest run`). Tests live in `tests/`.

## 8. CI/CD and Delivery

- GitHub Actions:
  - `.github/workflows/ci.yml` - gates `typecheck`, `lint`, `format:check`, `build`, `test` on
    push to `main` and on PRs; a separate job lints the PR title with commitlint (PRs land on
    `main` as a squash, so the PR title becomes the commit subject).
  - `.github/workflows/cla.yml` - CLA check (this is an AGPL-3.0 project with CLA-based
    contribution).
  - `.github/workflows/desktop.yml` / `desktop-release.yml` - Tauri desktop app CI and DMG
    release (tag `desktop-v*`, universal macOS build, optional Apple signing/notarization).

## 9. Infrastructure and Deployment

- Docker - `Dockerfile` + `docker-compose.yml`; `docker compose up` runs the app container
  (port 4400) and a `postgres:16-alpine` db container for self-hosting.

## 10. Frontend Stack

- React 18.3.1 + Vite 5.3.3 - SPA, entry at `index.html`.
- Tailwind CSS 4.3.3 (`@tailwindcss/vite` 4.3.3) - styling; `tw-animate-css` 1.4.0 for animation
  utilities. Design tokens in `src/styles.css` (see `.context/DESIGN.md`).
- Tauri 2.9.0 (`@tauri-apps/cli`, `desktop/src-tauri`) - desktop app wrapper around the web build.

## 11. Developer Experience Tooling

- ESLint 10.8.1 + typescript-eslint 8.67.0 + eslint-plugin-react-hooks 7.1.1 - lint, config in
  `eslint.config.js`.
- Prettier 3.9.6 - formatting (no semicolons, single quotes, printWidth 120), config in
  `.prettierrc.json`.
- Husky 9.1.7 + lint-staged 17.3.0 - pre-commit hook runs `lint-staged` (`.husky/pre-commit`).
- commitlint 21.2.2 (`@commitlint/config-conventional`) - conventional commit / PR title linting,
  config in `commitlint.config.js`.

## 12. Hosted Claude execution

Task-specific settings travel in the SDK queue dispatch; stable execution policy
and native tool defaults live in the App definition. No `configure` request is used.

- Root and `cantelop/` pin `@cantelop/sdk` **1.0.0-alpha.9** with separate Bun lockfiles.
  `cantelop/src/cantelop.ts` declares the App, SDK-owned durable Claude runtime,
  `claudeAuth` and the SDK-owned Claude Dockerfile. Schema-3 `cantelop.json` points
  to the definition; the SDK generates protocol-2 Edge `/commands` routes.
- `server/remoteClaudeClient.ts` imports the typed compiled backend from the repository-root
  `.cantelop/client`. The SDK compiler emits portable declarations, embeds
  the matching runtime identity and removes native provider code. `cantelop:build`
  runs the CLI and copies its generated client to Doop's artifact directory so
  it uses Doop's SDK installation. Ordinary dev/build/start/typecheck/test commands
  reuse this client; rebuild after changing the App definition or SDK.
- `server/remoteClaudeClient.ts` uses SDK Workspace/Session/auth references and SSE
  iterators directly, with no legacy route adapter. Subscription cleanup aborts
  blocked reads before closing the iterator, including failed initial dispatch. SDK `workspace.auth().login()`
  owns existing-sign-in checks and confirmed logout before forced reconnect.
  Doop's backend selects `CANTELOP_APP_SLUG`, holds `CANTELOP_INTEGRATION_TOKEN`
  and chooses each user's Workspace. The SDK derives the hosted Edge URL;
  `CANTELOP_EDGE_URL` is an optional override. `CLAUDE_REMOTE_ISSUER` remains in the old user hash to preserve
  existing Workspaces; per-user ES256 JWTs and audiences are retired.
- `server/remoteClaude.ts` authorizes status, selection, login and logout requests.
  Native sign-in preserves the Anthropic link and code form. SDK `auth.login()`
  returns a link/attempt ID; `submitCode()` validates the code through the CLI,
  and `cancelLogin()` stops that attempt. Raw native output stays in the SDK.
  Native credentials remain in the Workspace; Doop relays only the sign-in code.
  Forced reconnect cancels hosted work and confirms logout before fresh login.
  Reconnect attempts remain generation-fenced.
- `src/components/RemoteClaude.tsx` renders the Claude Plan controls and code form.
  `RemoteClaudeLogin` handles UI state and retries, and cancels late-created attempts
  when the sign-in component is disposed. A stable SDK `code_rejected` response
  keeps the form ready for another code. There is no terminal component
  or xterm dependency; the SDK owns the native login lifecycle.
- `cantelop/src/cantelop.ts` declares `createClaudeRuntime` with Doop's workspace
  and permission defaults. The SDK owns configuration, durable queues, targeted
  cancellation, steering, snapshots and recovery, and calls `createClaudeHarness`
  internally. Doop imports the public SDK protocol directly; the SDK validates
  configuration and decodes native fragments. No local contracts, validators,
  lifecycle or state store remain. Existing snapshots stay compatible.
- MCP callback validation is independent of the SDK endpoint: HTTPS origins are
  accepted, and HTTP `host.docker.internal` origins are allowed in development.
  Remote runtimes still require a reachable callback.
- `LocalAgentRuns` retains task-scoped MCP capabilities and revocation. Remote runs
  cannot be claimed by desktop polling. Authentication failures pause hosted work;
  transport, billing and rate-limit errors do not mark users signed out.
- `cantelop:build` runs `cantelop build` to compile and qualify the service with
  Docker. Service tests use Node's test runner and fake Claude executables;
  root Vitest tests cover SDK protocol, compiled backend and authentication.
  CI builds the client before root checks and smoke-tests the SDK-owned image.
- Live dev/deployment requires CLI 0.15.1 or newer and a platform supporting
  schema 3, build protocol 6, integration protocol 2 and native authentication.
- `cantelop/src/cantelop.ts` is the single App definition. Backend environment
  configuration preserves the App name and `CLAUDE_REMOTE_ISSUER` namespace.
  Doop Docker builds package the generated `.cantelop/client`; run
  `cantelop:build` first. Tokens are supplied only at runtime.
