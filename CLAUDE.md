@.context/INDEX.md

This is a placeholder. Will need to be updated.
https://github.com/kgoedecke/doop

# doop

Doop is the open-source alternative to Paper.design: a multiplayer design canvas for humans and AI
agents. Every design lives on a shareable Canvas (`/c/<id>`) holding Frames - artboards that
render real HTML in sandboxed iframes. People edit in the browser; AI agents edit through the
built-in MCP server, streaming designs in live. Everyone sees cursors, presence, frame edits, agent
status, and an activity feed in realtime over one WebSocket room per canvas.

## Tech stack

TypeScript/React/Express/Postgres (drizzle), realtime over `ws`, MCP server for agent access, Tauri
desktop shell. Full details in `.context/TECHSTACK.md`, which `.context/INDEX.md` links.

Always use the `clean-code:typescript` skill when writing or reviewing TypeScript code in this
repo.

## First-time setup after clone

```bash
bun install
bun run dev   # zero-config: embedded Postgres (pglite), server + web concurrently
```

Or self-host via Docker: `docker compose up` (real Postgres, port 4400).

## Project layout

```
src/               - React frontend (Vite entry: index.html)
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
