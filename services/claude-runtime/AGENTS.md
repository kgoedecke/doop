# Hosted Claude runtime

- This service belongs to Doop but deploys independently through Cantelop. Keep the existing app identity and workspace/session naming stable.
- Use `@cantelop/sdk/api` for Edge routes and `@cantelop/sdk/session` for Session behaviours and managed activities. Cantelop owns Workspaces, Sandbox lifecycle, and event transport.
- Verify SDK changes against https://github.com/stepandel/cantelop-sdk and the npm registry. Keep the pinned version and Bun lockfile in sync.
- Keep Claude Code unmodified and use native authentication. Never collect or export Claude credentials, or put application signing keys in the runtime environment.
- `src/contracts.ts` and `src/terminal-crypto.ts` are shared with Doop. Keep these modules independent of Node and the SDK.
- From the repository root run `bun run claude:install`, `bun run claude:check`, `bun run claude:test`, and `bun run claude:build`. The build requires the Cantelop CLI and Docker. Also run the root typecheck, lint, and hosted Claude integration tests when changing shared modules.
- Do not import `.cantelop`, `.dev`, local credentials, or deployment state from another checkout.
