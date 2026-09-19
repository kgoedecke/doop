# doop desktop

A thin [Tauri](https://tauri.app) shell around the hosted app. It loads
`https://doop.design` in a native window — there is no bundled frontend, so
every deploy is instantly "in" the desktop app and the binary only
needs a new release when the shell itself changes (icon, menu, Tauri bump).

The released installers (macOS DMG and Windows NSIS setup) talk to the hosted
service at doop.design. Self-hosting your own doop instance? Build a shell for
it without patching anything:

```sh
DOOP_APP_URL=https://doop.example.com bun run build
```

The URL is baked in at compile time (`src-tauri/src/main.rs`); the in-shell
navigation allowlist follows it automatically.

Links outside doop.design open in the system browser (`src-tauri/src/main.rs`).
Google / Microsoft / SSO sign-in runs there too: identity providers refuse
embedded webviews, so the page opens the provider in the browser and the
finished sign-in returns through a `doop://auth?token=…` link (deep-link
plugin, scheme in `tauri.conf.json`) that the page redeems for a session — see
`src/lib/desktopAuth.ts`. macOS only routes `doop://` to an installed bundle, so
`tauri dev` cannot receive it. To test locally, build a `.app` with
`bunx tauri build --debug --bundles app` (a debug build still targets
localhost:4300) and launch it. A built bundle treats localhost as a remote
origin, so temporarily add `http://localhost:4300` to `remote.urls` in
`capabilities/default.json` for that test or the page gets no IPC (no events,
no opener) — and take it out again before committing.
When a deploy ships a new client bundle, long-running windows get a
"doop was updated — Reload" toast on WebSocket reconnect (see `serverBuild`
in the `init` message).

## Develop

Requires the [Rust toolchain](https://rustup.rs) plus this directory's deps (via [bun](https://bun.sh)):

```sh
bun install
bun run dev    # opens the shell against the local vite server (localhost:4300)
```

`bun run dev` expects the dev server in the repo root to be running.

## Local Claude CLI

Settings → Doop Agent includes **Claude Plan** in shells built with the
local-runner capability. Install the native `claude` executable, sign in through
`claude auth login` (or the row's **Sign in** button), then choose **Use instead**.
No Claude Agent SDK is installed or used. The shell invokes `claude -p` directly
and consumes newline-delimited JSON output.

The first connection shows a native consent dialog. It allows this Doop account
on this device to use the CLI's existing login for canvas tasks. Claude credentials
stay in Claude's local credential storage; Doop never reads or uploads them. The
runner excludes inherited API-key/provider overrides so it does not silently bill
an API key. Claude's own login and usage limits determine account access.

- The local-provider preference and model choice (Fable 5.1, Opus 5, Sonnet 5, Haiku 4.5) are
  account-wide. Existing Sonnet/Opus choices map to their named versions; the old
  CLI-default choice becomes Sonnet 5. Fable 5.1 requires Claude Code 2.1.255 or newer.
  Device consent remains local. A connected ChatGPT/OpenAI account
  is retained, and its **Use instead** button switches back to server execution.
- Queued design cards, comments and feedback run while the desktop is open.
  Offline work stays queued with no automatic server fallback. Only one desktop
  claims a user's runs at a time. Closing/reloading during a run interrupts it;
  its lease expires and the card becomes retryable. Retry starts a fresh CLI run.
- The native process receives only the current run's Doop MCP tools. Built-in
  shell/file tools, user/project settings, hooks and unrelated MCP servers are
  disabled. `--bare` is intentionally not used because it skips subscription auth.
- **Stop task** cancels the local process; **Disconnect** disables Doop's local
  connection without signing the user out of Claude Code. Recent text output is
  visible in Settings; canvas tool activity appears through existing task/status
  events. The CLI also retains its normal local session history.
- Repository-import jobs and separately billed image generation currently require
  a server provider. Other existing canvas tools and completion checks are reused.

The server migration `0016_local_agent` stores the preference only. Per-run MCP
credentials are random, ephemeral, canvas-scoped tokens revoked on completion or
cancellation. The `/local-agent/mcp/:id` route rechecks canvas access and bans;
Vite proxies that route in development. The relay shares the existing resident
runner's single-process ownership model; it is not a distributed worker queue.

Ship the updated server/frontend and rebuild the desktop shell together. Older
shells display an update hint; browser sessions display a desktop-only hint.
Subscription availability is governed by Anthropic's current terms and account
policy; an existing CLI login is not a promise of unlimited usage.

## Build

```sh
bun run build  # macOS: .app + .dmg; Windows: NSIS .exe in src-tauri/target/release/bundle/
```

CI (`.github/workflows/desktop.yml`) builds an unsigned macOS .app and Windows
NSIS installer on every PR that touches `desktop/`, on pushes to `main` (to
keep the Rust build cache warm), and on manual dispatch. The toolchain setup
shared by every desktop job lives in `.github/actions/setup-desktop`.

## Releasing Desktop Installers

`.github/workflows/desktop-release.yml` builds a universal (Apple Silicon +
Intel) DMG for macOS and an NSIS installer for Windows:

- push a tag `desktop-v*` → both installers attached to a GitHub Release. The
  release is created only after both builds succeed, so a tag never ships
  with one installer missing.
- manual dispatch → DMG and Windows installer as workflow artifacts

Versions are bumped by release-please: commits touching `desktop/` open a
"chore(desktop): release x.y.z" PR that updates `package.json`,
`src-tauri/tauri.conf.json`, `Cargo.toml` and `Cargo.lock` together, plus
`desktop/CHANGELOG.md`. Merging it does not tag — push the tag by hand:

```sh
# after the release PR is merged; X.Y.Z is the version that PR set in desktop/package.json
git tag desktop-vX.Y.Z && git push origin desktop-vX.Y.Z
```

Until the `APPLE_*` secrets exist the DMG is **unsigned**: it runs, but
because of Gatekeeper, downloaders must approve it under System Settings →
Privacy & Security → "Open Anyway". Fine for testers, not for the public —
don't link it from the site.

The Windows installer is **always unsigned** — there is no Authenticode
certificate configured. SmartScreen shows "Windows protected your PC" on
first run; users click "More info" → "Run anyway". Signing it is the
equivalent of the Apple setup below: a code-signing certificate wired into
`bundle.windows` in `src-tauri/tauri.conf.json` (see the Tauri Windows
code-signing guide). Until then, same rule as the DMG: testers only.

### One-time signing setup (needs an Apple Developer membership)

1. In the [developer portal](https://developer.apple.com/account/resources/certificates/list),
   create a **Developer ID Application** certificate; download and open it so
   it lands in your login keychain.
2. Export it from Keychain Access as a `.p12` with a password, then:
   ```sh
   base64 -i cert.p12 | gh secret set APPLE_CERTIFICATE
   gh secret set APPLE_CERTIFICATE_PASSWORD  # the .p12 password
   gh secret set APPLE_SIGNING_IDENTITY      # "Developer ID Application: <name> (<team id>)"
   ```
3. Create an [app-specific password](https://account.apple.com/account/manage)
   for notarization, then:
   ```sh
   gh secret set APPLE_ID        # your Apple ID email
   gh secret set APPLE_PASSWORD  # the app-specific password
   gh secret set APPLE_TEAM_ID   # 10-char team id from the developer portal
   ```
4. Tag a release. Tauri signs and notarizes during the build; the resulting
   DMG opens with no warnings and can be linked from doop.design.

## Icon

`app-icon.png` (1024px, the layered-D mark from `src/App.tsx` `<Logo/>`) is
the source for all platform icons. After replacing it:

```sh
npx tauri icon app-icon.png
rm -rf src-tauri/icons/ios src-tauri/icons/android
```
