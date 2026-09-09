# RELEASE - doop

## Versioning (release-please)

`.github/workflows/release-please.yml` runs on every push to `main` and keeps a release PR open
per package, driven by conventional commits (`release-please-config.json`,
`.release-please-manifest.json`):

- `.` (the web app) -> "chore(main): release x.y.z" bumps `package.json` + `CHANGELOG.md`;
  merging it creates the `vX.Y.Z` tag and a GitHub Release. Tag + notes only - nothing is built
  or deployed from it.
- `desktop/` -> "chore(desktop): release x.y.z" bumps `desktop/package.json`,
  `src-tauri/tauri.conf.json`, `Cargo.toml`, `Cargo.lock` + `desktop/CHANGELOG.md`. It does NOT
  tag: the `desktop-v*` tag is pushed by hand after merging (next section).

Both packages are 0.x, so breaking changes bump the minor, not the major. With the default
`GITHUB_TOKEN` the release PR gets no CI run; a `RELEASE_PLEASE_TOKEN` PAT secret fixes that.

## Self-hosted server (Docker)

No container release pipeline for the server app. Self-hosting is
`docker compose up` (`docker-compose.yml` + `Dockerfile`) - builds the app image locally, runs it
on port 4400 alongside a `postgres:16-alpine` container, and applies DB migrations at boot
(`server/db/index.ts`). CI (`ci.yml`) validates every push/PR to `main` (typecheck, lint,
format:check, build, test) but does not build or push a container image.

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
- The shell tells the page its platform via `window.__DOOP_DESKTOP_PLATFORM__` (read in
  `src/lib/shell.ts`); only macOS gets the overlay title bar / traffic-light inset.
- Desktop app version is tracked separately from the root `package.json` and bumped by
  release-please (see above); after the release PR merges, tag as `desktop-vX.Y.Z`.

## Other workflows

- `.github/workflows/desktop.yml` - desktop app CI (build/check) outside of the release path.
- `.github/workflows/cla.yml` - CLA sign-off check on PRs (AGPL-3.0 project, CLA-based
  contribution per `CLA.md` / `CONTRIBUTING.md`).
