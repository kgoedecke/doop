# RELEASE - doop

## Self-hosted server (Docker)

No versioned release/tag pipeline for the server app itself. Self-hosting is
`docker compose up` (`docker-compose.yml` + `Dockerfile`) - builds the app image locally, runs it
on port 4400 alongside a `postgres:16-alpine` container, and applies DB migrations at boot
(`server/db/index.ts`). CI (`ci.yml`) validates every push/PR to `main` (typecheck, lint,
format:check, build, test) but does not build or push a container image.

## Desktop app (Tauri, macOS DMG)

Driven by `.github/workflows/desktop-release.yml`:

- Push a tag matching `desktop-v*` -> builds a universal (Apple Silicon + Intel) DMG with
  `bunx tauri build --target universal-apple-darwin --bundles dmg` and attaches it to a GitHub
  Release.
- `workflow_dispatch` or a PR touching the workflow file itself -> same build, uploaded as a
  workflow artifact instead (keeps the pipeline validated without cutting a release).
- Signing/notarization: automatic once the `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` repo secrets exist (see
  `desktop/README.md`). Without them the DMG is unsigned - it still works, but downloaders must
  approve it via System Settings -> Privacy & Security.
- Desktop app version is tracked separately in `desktop/package.json` (currently ahead of the root
  `package.json` version) - bump both when cutting a desktop release, and tag as `desktop-vX.Y.Z`.

## Other workflows

- `.github/workflows/desktop.yml` - desktop app CI (build/check) outside of the release path.
- `.github/workflows/cla.yml` - CLA sign-off check on PRs (AGPL-3.0 project, CLA-based
  contribution per `CLA.md` / `CONTRIBUTING.md`).
