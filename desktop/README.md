# doop desktop

A thin [Tauri](https://tauri.app) shell around the hosted app. It loads
`https://doop.design` in a native window — there is no bundled frontend, so
every deploy is instantly "in" the desktop app and the binary only
needs a new release when the shell itself changes (icon, menu, Tauri bump).

The released DMG talks to the hosted service at doop.design. Self-hosting
your own doop instance? Build a shell for it without patching anything:

```sh
DOOP_APP_URL=https://doop.example.com bun run build
```

The URL is baked in at compile time (`src-tauri/src/main.rs`); the in-shell
navigation allowlist follows it automatically.

Links outside doop.design open in the system browser (`src-tauri/src/main.rs`).
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

## Build

```sh
bun run build  # .app + .dmg in src-tauri/target/release/bundle/
```

CI (`.github/workflows/desktop.yml`) builds an unsigned .app on every PR that
touches `desktop/`, and on manual dispatch.

## Releasing a DMG

`.github/workflows/desktop-release.yml` builds a universal (Apple Silicon +
Intel) DMG:

- push a tag `desktop-v*` → DMG attached to a GitHub Release
- manual dispatch → DMG as a workflow artifact

```sh
# bump "version" in src-tauri/tauri.conf.json and package.json first
git tag desktop-v0.1.0 && git push origin desktop-v0.1.0
```

Until the `APPLE_*` secrets exist the DMG is **unsigned**: it runs, but
because of Gatekeeper, downloaders must approve it under System Settings →
Privacy & Security → "Open Anyway". Fine for testers, not for the public —
don't link it from the site.

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
