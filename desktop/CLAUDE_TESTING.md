# Claude desktop verification

## Automated regression checks

From the repository root:

```sh
npx vitest run tests/claudeModels.test.ts tests/localAgentPreferences.test.ts tests/localAgentRuns.test.ts tests/localAgentRouting.test.ts tests/localAgentSelection.test.ts tests/localClaudeBrowser.test.tsx tests/localClaudeConnection.test.tsx
cargo test --manifest-path desktop/src-tauri/Cargo.toml --offline
```

The route tests cover reconnect wakeups, repeated idle polls, model changes that
preserve active runs, and explicit disabling that cancels them. Native tests cover
bounded output parsing, oversized output terminating promptly, ordinary streaming,
cancellation, installer download failure, and run ID validation.

## Fresh sign-in and consent smoke test

Use a test OS account or machine without an existing Claude login, and a rebuilt
Doop desktop shell. Do not log out of a primary account just to perform this test.

1. With the CLI installed, open Settings → Doop Agent → Claude Code and sign in.
   Complete browser authorization. Verify the desktop returns to the connected
   state and displays the expected account. This verifies the actual non-TTY
   invocation, including its callback and exit status.
2. Connect Claude Code for a Doop account that has not granted local consent.
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

## Custom configuration smoke test

1. With no Doop `claude.json`, verify the same Claude Code row offers the normal
   sign-in flow and original subscription model defaults. Inherited API credentials
   and user settings must not switch its provider. No launcher picker should appear.
2. Configure a trusted existing CLI profile through the device-local `claude.json`
   described in the README. Refresh the connection. Confirm third-party credentials
   are recognized without an Anthropic subscription login.
3. Connect and open the composer model menu. Verify custom model options match the
   CLI configuration and selecting an option preserves its exact deployment ID in
   the native model selection file. The server preference remains a standard model
   placeholder. Restart the desktop and confirm the selection persists.
4. Send a small canvas task with that model. Verify the provider accepts it and a
   Doop tool changes the canvas. A populated model menu alone does not prove that
   every listed deployment exists or is authorized.
5. Verify malformed configuration produces an actionable error without falling
   back to a different provider. Disconnect must remain available; a missing custom
   launcher must not offer reinstalling the default CLI. Restoring `{}` returns to
   the default subscription behavior.
6. With the desktop open, start a small task from the browser. Its picker should
   show “Desktop model” without exposing the local model menu. Verify that the
   desktop uses its saved selection and the resulting canvas edit syncs back.

The native unit tests cover config validation, filtered settings and custom model
IDs. The ignored `live_profile_model_discovery` test accepts
`DOOP_TEST_CLAUDE_LAUNCHER` and optional `DOOP_TEST_CLAUDE_MODEL` environment variables;
it initializes the real CLI without submitting an inference request.

## Configuration-file verification (2026-10-22)

- After addressing the review, 47 focused frontend/server tests and 28 native tests
  passed. TypeScript, lint, targeted formatting and diff checks passed. The opt-in
  native live catalog test was skipped by the ordinary test run.
- The local macOS development build read `claude.json` pointing to an existing
  Foundry launcher, recognized its authentication and displayed 15 CLI model options.
- The standard connection card had no launcher or profile controls. The user
  approved the existing native CLI connection consent dialog.
- Selecting Haiku 5.5 saved `claude-haiku-5-5` in the native `claude/models.json`
  file with mode 0600. The selection survived a full app restart. Automated checks
  verified the API receives only a standard-model placeholder and explicit
  model-change telemetry receives only a generic custom-model label.
- A desktop-originated task changed the existing smoke-test frame to “Local model
  verified”. A browser-originated task subsequently changed it to “Browser
  forwarding verified”. The live CLI process used `--model claude-haiku-5-5`,
  `--strict-mcp-config` and `--allowedTools mcp__doop__*` for the browser task.
- A fresh browser canvas showed the disabled “Desktop model” picker. Custom
  deployment names and IDs were absent from that picker.
- Regression coverage includes subscription defaults, malformed configuration,
  missing launchers, gateway/proxy environment forwarding, config-directory
  precedence, local selection storage, failed menu actions, signed-out discovery
  skipping, and process-group cleanup after normal exit and cancellation.
- Local controls use PostHog's documented `ph-no-capture` exclusion for replay and
  autocapture: https://posthog.com/docs/session-replay/privacy. Analytics ingestion
  was not live-tested; analytics is disabled in this local build.
- Other providers, fresh subscription OAuth, Windows/Linux, and image input were
  not live-tested in this run. The CLI menu is not proof that every listed cloud
  deployment exists or is authorized.

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
