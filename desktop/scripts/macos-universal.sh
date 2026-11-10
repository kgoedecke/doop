#!/usr/bin/env bash
# Builds the universal macOS app for desktop-release.yml. The Tauri 3 CLI
# bundles CEF for one architecture at a time (its universal target lipo's the
# helper but ships one architecture's framework), so this does what Electron
# apps do: build the Chromium shell for Apple Silicon and for Intel, unsigned,
# merge the two into one doop.app (scripts/universal-app.mjs), then sign it
# inside out with the entitlements Chromium needs under the hardened runtime,
# notarize it and pack the DMG and the updater package.
#
# Signing and notarization run when the APPLE_* secrets are set, the updater
# signature when TAURI_SIGNING_PRIVATE_KEY is (required on a desktop-v* tag,
# scripts/updater-config.sh), as with the WebKit build. Output keeps the paths
# and names the WebKit universal build had:
#   <target>/universal-apple-darwin/release/bundle/macos/doop.app[.tar.gz[.sig]]
#   <target>/universal-apple-darwin/release/bundle/dmg/doop_<version>_universal.dmg
set -euo pipefail
cd "$(dirname "$0")/.."

crate=src-tauri-chromium
target_dir=${CARGO_TARGET_DIR:-$crate/target}
version=$(jq -r .version "$crate/tauri.conf.json")
bundle=$target_dir/universal-apple-darwin/release/bundle
app=$bundle/macos/doop.app

# refuses a tag build without the updater key before an hour of compiling
bash scripts/updater-config.sh >/dev/null

for arch in aarch64 x86_64; do
  bun run build:chromium --target "$arch-apple-darwin" --bundles app --no-sign
done

rm -rf "$bundle"
mkdir -p "$bundle/macos" "$bundle/dmg"
bun scripts/universal-app.mjs \
  "$target_dir/aarch64-apple-darwin/release/bundle/macos/doop.app" \
  "$target_dir/x86_64-apple-darwin/release/bundle/macos/doop.app" \
  "$app"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  keychain_args=()
  if [ -n "${APPLE_CERTIFICATE:-}" ]; then
    keychain=$work/signing.keychain-db
    keychain_password=$(uuidgen)
    security create-keychain -p "$keychain_password" "$keychain"
    security set-keychain-settings -lut 21600 "$keychain"
    security unlock-keychain -p "$keychain_password" "$keychain"
    echo "$APPLE_CERTIFICATE" | base64 --decode > "$work/certificate.p12"
    security import "$work/certificate.p12" -k "$keychain" -P "${APPLE_CERTIFICATE_PASSWORD:-}" -T /usr/bin/codesign
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" >/dev/null
    # shellcheck disable=SC2046
    security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')
    keychain_args=(--keychain "$keychain")
  fi

  # what the Tauri 3 CLI gives a CEF app: Chromium's JIT and its separately
  # built framework are refused by the hardened runtime otherwise
  cat > "$work/entitlements.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict>
</plist>
PLIST
  sign() {
    codesign --force --timestamp --options runtime --entitlements "$work/entitlements.plist" \
      ${keychain_args[@]+"${keychain_args[@]}"} --sign "$APPLE_SIGNING_IDENTITY" "$1"
  }

  # inside out: the framework's libraries, the framework, the helpers, the app
  xattr -cr "$app"
  framework="$app/Contents/Frameworks/Chromium Embedded Framework.framework"
  while IFS= read -r -d '' library; do sign "$library"; done < <(find "$framework/Libraries" -name '*.dylib' -print0)
  sign "$framework"
  for helper in "$app/Contents/Frameworks/"*" Helper"*.app; do sign "$helper"; done
  sign "$app"
  codesign --verify --deep --strict --verbose=2 "$app"

  if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
    ditto -c -k --keepParent "$app" "$work/notarize.zip"
    xcrun notarytool submit "$work/notarize.zip" --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" \
      --team-id "$APPLE_TEAM_ID" --wait
    xcrun stapler staple "$app"
  else
    echo "::warning::APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID not set: signed but not notarized"
  fi
else
  echo "::warning::APPLE_SIGNING_IDENTITY not set: the universal app is unsigned (ad-hoc)"
  codesign --force --deep --sign - "$app"
fi

# the DMG the WebKit build made: its background, window and icon positions
# (src-tauri-chromium/tauri.conf.json > bundle > macOS > dmg)
dmg=$bundle/dmg/doop_${version}_universal.dmg
mkdir -p "$work/dmg"
ditto "$app" "$work/dmg/doop.app"
create-dmg \
  --volname doop \
  --background src-tauri/dmg/background.png \
  --window-size 660 400 \
  --icon doop.app 180 170 \
  --app-drop-link 480 170 \
  --hide-extension doop.app \
  "$dmg" "$work/dmg"
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  codesign --force --timestamp ${keychain_args[@]+"${keychain_args[@]}"} --sign "$APPLE_SIGNING_IDENTITY" "$dmg"
fi

# the updater package: the app as a tar.gz with doop.app at its root, signed
# with the key whose public half is plugins.updater.pubkey
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  tar -czf "$app.tar.gz" -C "$bundle/macos" doop.app
  bunx tauri signer sign "$app.tar.gz"
fi

ls -la "$bundle/macos" "$bundle/dmg"
