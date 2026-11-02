#!/usr/bin/env bash
# Repacks the AppImage without the libwayland-* it bundles from the build
# machine (desktop.yml, desktop-release.yml). Those copies are older than the
# Mesa on current distros (Fedora, Arch), and WebKitGTK's web process then
# aborts with "Could not create default EGL display: EGL_BAD_PARAMETER",
# leaving an empty window. Every desktop that runs the AppImage has its own
# libwayland, so the system's is what loads instead. Tauri passes linuxdeploy
# no extra flags, so its --exclude-library cannot be used.
#
# With TAURI_SIGNING_PRIVATE_KEY set the updater signature is written again,
# since the repacked file no longer matches the one the build signed.
set -euo pipefail

APPIMAGETOOL_URL=https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage
APPIMAGETOOL_SHA256=ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0
# the runtime becomes the shipped AppImage's executable header (and is covered
# by its updater signature); without --runtime-file appimagetool fetches it
# from type2-runtime's moving `continuous` release, so it is pinned here too
RUNTIME_URL=https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64
RUNTIME_SHA256=2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d

appimage=$(realpath "$1")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

curl -fsSL -o "$work/appimagetool" "$APPIMAGETOOL_URL"
echo "$APPIMAGETOOL_SHA256  $work/appimagetool" | sha256sum -c --quiet
chmod +x "$work/appimagetool"
curl -fsSL -o "$work/runtime" "$RUNTIME_URL"
echo "$RUNTIME_SHA256  $work/runtime" | sha256sum -c --quiet

# no FUSE on CI runners or in containers
export APPIMAGE_EXTRACT_AND_RUN=1
(cd "$work" && "$appimage" --appimage-extract >/dev/null)
rm -f "$work"/squashfs-root/usr/lib/libwayland-*.so*
ARCH=x86_64 "$work/appimagetool" --no-appstream --runtime-file "$work/runtime" "$work/squashfs-root" "$appimage"

if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  rm -f "$appimage.sig"
  bunx tauri signer sign "$appimage"
fi
