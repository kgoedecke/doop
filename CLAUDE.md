@.context/INDEX.md

This is a placeholder. Will need to be updated.
https://github.com/kgoedecke/doop

# doop

Doop is the open-source alternative to Paper.design: a multiplayer design canvas for humans and AI
agents. Every design lives on a shareable Canvas (`/c/<id>`) holding Frames - artboards that
render real HTML in sandboxed iframes. People edit in the browser; AI agents edit through the
built-in MCP server, streaming designs in live. Browsers subscribe to one frame socket per canvas
for pages and frames: the canvas's Terse actor when its owner has the `canvas-actors` flag, else the
server's Postgres stand-in with the same protocol (`.context/TECHSTACK.md`, Data and Persistence);
per-canvas WebSocket rooms carry cursors, presence, and collaboration events.

## Tech stack

TypeScript/React/Express/Postgres (drizzle), a Terse actor per flagged canvas (SQLite via drizzle), `ws` for collaboration, MCP for agent access, Tauri
desktop shell. Full details in `.context/TECHSTACK.md`, which `.context/INDEX.md` links.

Always use the `clean-code:typescript` skill when writing or reviewing TypeScript code in this
repo.

## First-time setup after clone

```bash
bun install
bun run dev   # zero-config: embedded Postgres (pglite), local actors, server + web
```

Or self-host via Docker: set `TERSE_ACTOR_URL` and `TERSE_API_KEY` for a separately hosted actor
API with a public WebSocket endpoint (or `DOOP_CANVAS_ACTORS=off` to keep every canvas's frames in
Postgres), then `docker compose up` (real Postgres, port 4400).

## Project layout

```
src/               - React frontend (Vite entry: index.html)
src/actor.ts       - CanvasActor: one canvas's pages, frames and history
server/postgresCanvas.ts - the same for canvases whose frames stay in Postgres
src/actor-db/      - the canvas actor's drizzle schema and migrations
src/components/ui/ - shadcn-generated UI primitives
src/pages/         - route-level pages
src/hooks/         - React hooks
src/lib/           - client-side utilities
server/            - Express backend, WebSocket room, MCP server, better-auth
server/db/         - drizzle-orm schema (schema.ts, auth-schema.ts) and migrations
shared/            - types/utilities shared between server and client
desktop/           - Tauri desktop app wrapper
desktop/src-tauri/ - Rust side of the desktop app
scripts/           - repo maintenance scripts
tests/             - vitest test suite
```

## Language

TypeScript. Always use the `clean-code:typescript` skill when writing or reviewing TypeScript
code. Formatter and lint rules are captured in `.context/CODESTYLE.md`, which `.context/INDEX.md`
links.
