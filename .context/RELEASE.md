# RELEASE - doop

## Versioning (release-please)

`.github/workflows/release-please.yml` runs on every push to `main` and keeps a release PR open
per package, driven by conventional commits (`release-please-config.json`,
`.release-please-manifest.json`):

- `.` (the web app) -> "chore(main): release x.y.z" bumps `package.json` + `CHANGELOG.md`;
  merging it creates the `vX.Y.Z` tag and a GitHub Release. Tag + notes only - nothing is built
  or deployed from it.
- `desktop/` -> "chore(desktop): release x.y.z" bumps `desktop/package.json`,
  `src-tauri/tauri.conf.json`, `Cargo.toml` + `desktop/CHANGELOG.md`. It cannot bump
  `Cargo.lock`, so `desktop.yml` copies the shell's version line from `Cargo.toml` into the
  lock ahead of `cargo test --locked`; the lock catches up in the next commit that builds the shell. It does NOT
  tag: the `desktop-v*` tag is pushed by hand after merging (next section). Since no GitHub
  Release is cut, the workflow's last step flips the merged desktop PR's label from
  `autorelease: pending` to `autorelease: tagged` itself; a merged PR left `pending` makes every
  later run abort with "untagged, merged release PRs outstanding".

Both packages are 0.x, so breaking changes bump the minor, not the major. With the default
`GITHUB_TOKEN` the release PR gets no CI run; a `RELEASE_PLEASE_TOKEN` PAT secret fixes that.

## Self-hosted server (Docker)

No container release pipeline for the server app. Self-hosting is
`docker compose up` (`docker-compose.yml` + `Dockerfile`) - builds the app image locally, runs it
on port 4400 alongside a `postgres:16-alpine` container, and applies DB migrations at boot
(`server/db/index.ts`). CI (`ci.yml`) validates every push/PR to `main` (typecheck, lint,
format:check, build, test) but does not build or push a container image.
The CI build uses `bun run --bun build` to match the `oven/bun` Docker build stage,
where `node` commands run with Bun. Extension tests also build with both runtimes
and run the Bun-built archive under Node, including its nested runtime dependencies.

## Desktop app (Tauri: macOS DMG + Windows NSIS installer)

Driven by `.github/workflows/desktop-release.yml`; every desktop job shares the toolchain setup
in `.github/actions/setup-desktop`:

- Push a tag matching `desktop-v*` -> `dmg-macos` builds a universal (Apple Silicon + Intel) DMG
  with `bunx tauri build --target universal-apple-darwin --bundles dmg`, `nsis-windows` builds
  `doop_<version>_x64-setup.exe` with `bunx tauri build --bundles nsis`, and a final `release`
  job (`needs` both) attaches the two to one GitHub Release - so a tag is never published with
  only one installer.
- `workflow_dispatch` or a PR touching the workflow file itself -> same builds, uploaded as
  workflow artifacts instead (keeps the pipeline validated without cutting a release).
- macOS signing/notarization: automatic once the `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` repo secrets exist (see
  `desktop/README.md`). Without them the DMG is unsigned - it still works, but downloaders must
  approve it via System Settings -> Privacy & Security.
- The Windows installer is unsigned (no Authenticode certificate configured): SmartScreen warns on
  first run and users click "More info" -> "Run anyway".
- Connecting an OAuth integration (Meta, Linear, Slack) from the app opens the
  provider in the system browser and returns over a `doop://integration/<id>` link; the app
  finishes it under its own session (`shared/desktopConnect.ts`). This is web-only: shells from
  0.2.1 already deliver any `doop://` link, and older shells open Integrations in the browser.
- The macOS View menu (`desktop/src-tauri/src/view_menu.rs`) holds the canvas toggles (Rulers,
  Show/Hide UI, Layers and Agents panels) and zoom. Items reach the page as `view-command`
  events; the page mirrors its state back through `view_menu_state` (`src/lib/viewMenu.ts`,
  gated on `window.__DOOP_VIEW_MENU__`), so checkmarks follow it and canvas items are disabled
  off a canvas. Only ⌘ shortcuts are bound in the menu; ⇧R / ⇧1 / ⇧2 stay with the page.
- The shell tells the page its platform via `window.__DOOP_DESKTOP_PLATFORM__` (read in
  `src/lib/shell.ts`); only macOS gets the overlay title bar / traffic-light inset.
- Desktop app version is tracked separately from the root `package.json` and bumped by
  release-please (see above); after the release PR merges, tag as `desktop-vX.Y.Z`.

## Claude Desktop extension

`bun run build:claude-extension` packages `claude-extension/manifest.json`, the Doop logo,
license and pinned `mcp-remote` runtime into `public/claude-extension/doop.mcpb`. Both `dev`
and `build` run it automatically; Vite copies the download into the production `dist/`.
Connect AI → Claude offers a prefilled **Add to Claude** link for public HTTPS servers.
The shared endpoint check filters common local addresses while allowing public IPv6
and numeric-prefixed DNS names; the connecting client checks actual reachability.
In updated desktop shells it prepares the extension, prefills the current `/mcp` URL,
and invokes `claude_add_extension` to open Claude's installer. Native installation
requires a desktop release; the online link ships with the web app. Manual downloads
remain a collapsed fallback for older shells and local browser sessions.
OAuth requests for consent open `/oauth/consent`. The approval screen resolves the client
from a code bound to the signed-in account; `/api/mcp-consent/:code` handles approval and
denial through better-auth. This also supports other MCP clients that request consent.

`tests/claudeExtension.test.ts` extracts the actual archive outside the repository and checks
tools, resources, OAuth and reconnecting against a fresh Doop server. Before releasing,
also install it in Claude Desktop on macOS and Windows. Installation, build and release
notes live in [`claude-extension/README.md`](../claude-extension/README.md). No directory
submission or publication is performed by the build.

## Codex desktop setup

Connect AI → Codex can register Doop directly in the shared Codex config through
`codex_add_mcp`. Browser sessions hand off to the installed app with a `doop://connect/codex`
link; the app opens a review screen and writes only after the user clicks Add to Codex.
The native capability marker gates older shells. Release the updated desktop binary
and frontend together; no downloadable integration bundle is built. Codex still owns
the separate OAuth approval. Config preservation, conflict handling and handoff checks
are covered by Rust/frontend tests; desktop CI now runs the Rust tests on both platforms.
See [`desktop/README.md`](../desktop/README.md#add-to-codex) for release smoke checks.

## Cursor marketplace plugin

`cursor-plugin/` is a standalone Cursor plugin directory; `.cursor-plugin/marketplace.json` at
repo root indexes it. It contains the hosted MCP connection, the scoped `doop-design` skill,
metadata, logo, and license. It needs no build artifact or release download. The app's
**Connect AI → Cursor → Add to Cursor** uses Cursor's MCP install link for the current Doop
instance and is available independently of marketplace publication.

After local Cursor smoke testing, sync the plugin commit to public `kgoedecke/doop` through the
existing cherry-pick workflow. Confirm the root marketplace manifest and `cursor-plugin/` are
present at the same paths. The OSS export script was removed; do not recreate a wipe-and-export
step. This development repository is private and cannot serve as a public listing source. A maintainer submits the public repository
at `https://cursor.com/marketplace/publish`. Cursor must approve the plugin before it appears in
the public marketplace. No workflow submits or publishes it automatically. Bump the version
in `cursor-plugin/.cursor-plugin/plugin.json` for plugin updates; full setup and reviewer steps
live in `cursor-plugin/README.md`.

## Other workflows

- `.github/workflows/desktop.yml` - desktop app CI (build/check) outside of the release path.
- `.github/workflows/cla.yml` - CLA sign-off check on PRs (AGPL-3.0 project, CLA-based
  contribution per `CLA.md` / `CONTRIBUTING.md`).
