#!/bin/bash
# Build the doopblitz static library for the iOS simulator and device targets.
# Output: ios/BlitzKit/lib/<PLATFORM_NAME>/libdoopblitz.a, which the Xcode
# project links through LIBRARY_SEARCH_PATHS = BlitzKit/lib/$(PLATFORM_NAME).
# Usage: ios/BlitzKit/build.sh [iphonesimulator|iphoneos|all]  (default: all)
set -euo pipefail
cd "$(dirname "$0")/rust"
export PATH="$HOME/.cargo/bin:$PATH"
want="${1:-all}"
build() {
  local platform="$1" target="$2"
  rustup target list --installed | grep -q "^$target$" || rustup target add "$target"
  cargo build --release --target "$target"
  mkdir -p "../lib/$platform"
  cp "target/$target/release/libdoopblitz.a" "../lib/$platform/libdoopblitz.a"
  echo "built ../lib/$platform/libdoopblitz.a"
}
case "$want" in
  all) build iphonesimulator aarch64-apple-ios-sim; build iphoneos aarch64-apple-ios ;;
  iphonesimulator) build iphonesimulator aarch64-apple-ios-sim ;;
  iphoneos) build iphoneos aarch64-apple-ios ;;
  *) echo "unknown platform: $want" >&2; exit 2 ;;
esac
