# TECHSTACK - doop

## 1. Language and Runtime

- TypeScript 5.5.3 (strict mode) - primary language across `server/`, `src/`, and `shared/`.
- Node.js - runtime; `tsx` 4.23.9 runs server TypeScript directly with no build step.
  `bun run dev` starts local actors unless an external actor API is configured.
  `bun run start` requires `TERSE_ACTOR_URL` for a separately hosted actor API with a public WebSocket endpoint.
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
- `ws` 8.18.0 - WebSocket server for cursors, presence, and collaboration over one room per canvas;
  frame edits use separate actor subscriptions.

## 3. Data and Persistence

- PostgreSQL 16 (`postgres:16-alpine` in `docker-compose.yml`) - existing application records.
  Legacy frame rows are imported automatically on first canvas access, preserving IDs and references.
- `durable-actors` - `CanvasIndex` owns ordered frame IDs and lifecycle bookkeeping;
  `FrameActor` owns each whole frame. Each uses 1 CPU and 256 MiB. Browser subscriptions go directly
  to both actor types, with fresh snapshots on reconnect.
  Local actors start automatically in development/tests;
  production requires a separate actor API, with browser WebSockets connecting directly to it.
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

- Bun 1.3.10 - package manager; lockfile at `bun.lock`, installed with `bun install --frozen-lockfile` in CI.
- Vite 5.3.3 - frontend build tool (`vite build`).

## 7. Testing Stack

- Vitest 4.1.11 - unit/integration tests across `server/` and `src/`; `bun run test` starts isolated
  actors and runs Vitest against throwaway PGlite databases. Tests live in `tests/`.

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

- Experimental Gemini cloud pilot: `server/geminiCloudRuns.ts` dispatches resident harness tasks
  to per-user workers; `server/geminiCloudMcp.ts` exposes run-scoped canvas tools. The standalone
  worker runs official Gemini CLI headlessly, with Google credentials retained in its own volume.
  `workers/gemini/Dockerfile` builds the worker. Setup and limitations: `docs/gemini-cloud-pilot.md`.
  `DOOP_GEMINI_CLOUD_WORKERS` enables operator-managed routing and BYO metering; unset by default.

- Docker - `Dockerfile` + `docker-compose.yml`; `docker compose up` runs the app container
  (port 4400) and a `postgres:16-alpine` db container for self-hosting. Actors run separately,
  configured through `TERSE_ACTOR_URL` and `TERSE_API_KEY`.

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

## OSS integration scope

The integration registries currently register Linear only. Canvas imports offer websites, live-app
sync and GitHub repositories; frame exports offer PNG/JPG with progress feedback and desktop saving.
Figma, Canva and PSD are deferred. Migration 0019 is reserved for the deferred Figma integration;
the OSS journal skips it while retaining the shared migration tags and timestamps for 0020–0022.
Gemini cloud workers remain an operator-managed, opt-in pilot; see `docs/gemini-cloud-pilot.md`.
