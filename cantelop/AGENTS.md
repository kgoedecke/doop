# Hosted Claude runtime

- This service belongs to Doop but deploys independently through Cantelop. Keep the existing app identity and workspace/session naming stable.
- Use SDK 1.0 `CantelopClient` App definitions, `@cantelop/sdk/session` for behaviours/activities, and `@cantelop/sdk/harnesses/claude` for native execution/auth/image. Declare `createClaudeRuntime` from the SDK; it owns the durable lifecycle and uses `createClaudeHarness` internally. Do not implement local behaviours, state stores, native runners or protected execution subclasses. The SDK generates protocol Edge routes. Cantelop owns Workspaces, Sandbox lifecycle, and event transport.
- Verify SDK changes against https://github.com/stepandel/cantelop-sdk and the npm registry. Keep both SDK dependency pins in sync in the shared root Bun lockfile. Both packages pin the published `1.0.1` npm release.
- Keep Claude Code unmodified and use native authentication. Never collect or export Claude credentials, or put application signing keys in the runtime environment.
- Import protocol types and backend-safe helpers directly from `@cantelop/sdk/harnesses/claude/protocol`; do not add local contract shims, configuration validators or output fragment decoders.
- From the repository root run `bun install --frozen-lockfile`, `bun run cantelop:check` and `bun run cantelop:build`. The artifact build uses the SDK compiler. CI smoke-tests the CLI-built image; build, dev and deploy require Cantelop CLI 0.15.2 or newer, which declares the per-command `/commands/{type}` routes the SDK uses. Also run the root typecheck, lint, and hosted Claude integration tests when changing shared modules.
- Do not import `.cantelop`, `.dev`, local credentials, or deployment state from another checkout.
