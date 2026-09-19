# Claude desktop verification

## Automated regression checks

From the repository root:

```sh
npx vitest run tests/localAgentPreferences.test.ts tests/localAgentRuns.test.ts tests/localAgentRouting.test.ts
cargo test --manifest-path desktop/src-tauri/Cargo.toml --offline
```

The route tests cover reconnect wakeups, repeated idle polls, model changes that
preserve active runs, and explicit disabling that cancels them. Native tests cover
bounded output parsing, oversized output terminating promptly, ordinary streaming,
cancellation, installer download failure, and run ID validation.

## Fresh sign-in and consent smoke test

Use a test OS account or machine without an existing Claude login, and a rebuilt
Doop desktop shell. Do not log out of a primary account just to perform this test.

1. With the CLI installed, open Settings → Doop Agent → Claude Plan and sign in.
   Complete browser authorization. Verify the desktop returns to the connected
   state and displays the expected account. This verifies the actual non-TTY
   invocation, including its callback and exit status.
2. Connect Claude Plan for a Doop account that has not granted local consent.
   Cancel the native dialog first and confirm the provider is not enabled.
   Connect again and accept; confirm the app remains responsive and the provider
   becomes active.
3. Start a small canvas task. While it runs, change the selected Claude model.
   Confirm the current task completes and a subsequent task uses the new model.
   Explicitly stopping a task or disconnecting should still cancel it.

The macOS `rfd` 0.16 synchronous message dialog implementation calls `run_on_main`,
which dispatches to the main thread while the application event loop is running.
Doop calls it from a blocking worker so the event loop remains available. Calling
from a worker is therefore supported; keep the real-window smoke test above for
platform regressions.

## Verification performed for PR #155

- 12 server routing/run/preference tests passed.
- Seven native tests passed, including oversized output without a trailing newline.
- TypeScript and ESLint checks passed for the server changes.
- The installed Claude CLI was started with closed stdin, piped stdout/stderr, an
  isolated temporary configuration directory, and inherited API credentials removed.
  It emitted a browser authorization URL and waited for authorization without a TTY.
  The process was stopped before authorization; the existing login was preserved.
- The user manually tested Claude sign-in in the desktop app and confirmed it
  works. This supplements the automated non-TTY startup check above.
- The native consent dialog smoke test remains a separate manual check; the
  sign-in confirmation does not establish that both consent outcomes were tested.
