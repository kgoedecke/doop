#!/usr/bin/env bash
# Prints the `tauri build --config` override for the updater packages
# (desktop-release.yml): on when TAURI_SIGNING_PRIVATE_KEY is set, required
# on a desktop-v* tag so a release always reaches installed apps.
set -euo pipefail
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  echo '{"bundle":{"createUpdaterArtifacts":true}}'
elif [[ "${GITHUB_REF:-}" == refs/tags/desktop-v* ]]; then
  echo "::error::TAURI_SIGNING_PRIVATE_KEY is not set; a release without updater packages would strand installed apps" >&2
  exit 1
else
  echo "::warning::TAURI_SIGNING_PRIVATE_KEY not set: building without updater packages" >&2
  echo '{}'
fi
