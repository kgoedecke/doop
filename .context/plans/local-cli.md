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
desktop integration, service management, tunnel access and external provider
credentials are outside this implementation.

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
