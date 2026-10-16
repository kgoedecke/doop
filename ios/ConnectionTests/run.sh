#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
test_dir=$(mktemp -d)
fixture_pid=""
cleanup() {
  if [ -n "$fixture_pid" ]; then
    kill "$fixture_pid" 2>/dev/null || true
    wait "$fixture_pid" 2>/dev/null || true
  fi
  rm -rf "$test_dir"
}
trap cleanup EXIT
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$test_dir/key.pem" -out "$test_dir/cert.pem" \
  -days 1 -subj /CN=127.0.0.1 >/dev/null 2>&1
bun ios/ConnectionTests/server.ts "$test_dir/cert.pem" "$test_dir/key.pem" > "$test_dir/port" &
fixture_pid=$!
for ((attempt = 0; attempt < 100; attempt++)); do
  if [ -s "$test_dir/port" ]; then break; fi
  kill -0 "$fixture_pid"
  sleep 0.1
done
test -s "$test_dir/port"
swiftc -parse-as-library ios/Doop/Core/*.swift ios/Doop/CanvasModel.swift ios/ConnectionTests/Checks.swift -o "$test_dir/checks"
"$test_dir/checks" "$(cat "$test_dir/port")"
