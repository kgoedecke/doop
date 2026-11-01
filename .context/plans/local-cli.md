# Local CLI implementation plan

1. Create a private standalone development copy with the original upstream history.
2. Package the existing production frontend, TypeScript server, migrations and
   runtime dependencies behind an npm `doop start` executable. Retain the existing
   server implementation rather than introducing another backend.
3. Resolve bundled assets relative to the installed module. Use a persistent,
   platform-appropriate data root, loopback binding, a generated session signing
   key, a per-directory lock and explicit startup errors.
4. Pack and install the actual npm tarball outside the repository. Exercise
   signup, protected API routes, canvas/frame edits, WebSockets, MCP initialization
   and tool calls, invalid arguments, port conflicts and concurrent startup.
5. Shut down and restart with the same data root. Verify session/key stability,
   database persistence, migrated startup and lock cleanup.
6. Run existing environment/auth/storage tests, typecheck, lint and formatting.
   Add Windows/macOS/Linux CI coverage for the installed artifact. Push reviewed
   changes and report any platform checks still awaiting CI.

The first release remains a private tarball preview. Registry publication,
desktop UI integration, remote tunnels and external provider credentials remain
outside this implementation.

## OpenCode-style CLI expansion

Reference: a temp-directory clone of anomalyco/opencode checked out at v2.2.5,
commit 9bbb8ce. The v2 package is named `@opencode/cli`. Its declarative command
tree, handlers and shared service connection informed this expansion.

1. Split Doop foreground startup, service control, client requests, integrations,
   diagnostics and upgrades into separate modules with lazy backend startup.
2. Add a per-user detached supervisor, authenticated local control, persistent
   installation settings, graceful stop/reload/restart and optional OS login jobs.
3. Add API requests, origin-scoped CLI sessions, local MCP client pairing, bundled
   skill installation, diagnostics and npm tarball upgrades with update/upgrade aliases.
4. Extend the actual installed-tarball E2E checks to cover these command groups,
   invalid control credentials, session/logout behavior, restart persistence,
   generated client configuration and an actual upgrade into an isolated prefix.
5. Document boundaries: local MCP OAuth pairing is supported; OpenCode-style
   one-time remote links and tunnels are not. Native login-job adapters require
   OS service-manager permissions and are distinct from ordinary detached startup.

Expansion verification on Windows: the packed npm installation passed real Chrome
rendering, existing API/WebSocket/MCP checks and restart persistence. The expanded
command tests passed detached service lifecycle and reload, rejection of malformed
and unauthenticated control requests, CLI account login/logout, authenticated API
mutations, all four client configuration writers, skill installation, doctor and
an actual tarball upgrade into a separate npm prefix. Task Scheduler registration
and removal were also exercised with an isolated test task; no login task was
left installed. Typecheck, lint, formatting and doc-lint passed. Cross-platform CI
is configured; the new service adapters were exercised locally on Windows only.

## Verification completed

- Windows, Node 24.22.1: production build and installed-tarball E2E passed,
  including real Chrome, authenticated canvas loading, image upload persistence,
  API/WebSocket/MCP behavior, restart persistence, locking and port conflicts.
- Existing environment, storage, agent-key and access-control suites: 43 tests
  passed across four files.
- Typecheck, lint, formatting and documentation checks passed.
- The Windows integration harness now launches Node directly with the tsx loader
  and waits for process exit before deleting data, avoiding orphaned server
  children and locked temporary files.
- macOS/Linux installed-package checks are configured in the CLI workflow;
  they were not run on the local Windows machine.
