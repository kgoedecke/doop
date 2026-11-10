#!/bin/sh
# Run the test suite the way CI does: in a Linux container on two CPUs.
#
#   bun run test:linux                              the whole suite
#   bun run test:linux tests/rulersBrowser.test.ts  one file
#   bun run test:linux --shard=3/4                  one CI shard
#
# Browser tests that pass on a Mac and fail on CI usually fail here too, and
# the clipboard tests, which a Mac skips, run. Needs Docker.
set -eu
cd "$(dirname "$0")/.."
docker build --quiet --file tests/linux.Dockerfile --tag doop-test-linux . >/dev/null
exec docker run --rm --cpus 2 --memory 7g --shm-size 1g doop-test-linux "$@"
