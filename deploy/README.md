# Managed company container

Build with the pinned base images and frozen Bun lockfile using Openbot's
`scripts/doop-test.py image` command. The source fingerprint label identifies the
base revision plus reviewed changes. Retain the exported OCI archive and its
manifest, configuration and archive digests; a base revision alone is insufficient.
`VITE_POSTHOG_*` build arguments, when used, enter public browser assets.

The image runs as `node` (UID 1000), with Chromium's sandbox enabled. Run it with
`--read-only --cap-drop=ALL --security-opt=no-new-privileges` and
`--security-opt=seccomp=/absolute/path/to/chromium-seccomp.json`. The profile retains
the pinned Moby defaults plus clone, setns, unshare and chroot for Chromium's
nested user namespace. The parent has no capabilities: chroot remains denied in
the parent namespace. Do not add SYS_ADMIN, SYS_CHROOT, privileged mode, an
unconfined seccomp profile or `--no-sandbox`.

Mount a node-writable private volume at `/app/data`, provide writable `/tmp`
(for example `--tmpfs=/tmp:rw,nosuid,noexec,size=256m`) and `/dev/shm` (256 MiB in
the test runner), and bound memory, CPU and process count. Application code stays
read-only. Bind application PORT 4400 behind an HTTPS proxy; the image uses an
unprivileged port. The proxy and production certificate provisioning are operator
responsibilities. Local test origins are loopback HTTP and contain synthetic data.

Set `BETTER_AUTH_URL` to the external origin and provide a random, stable
`BETTER_AUTH_SECRET`. `SECRETS_ENCRYPTION_KEYS` must contain the application's
comma-separated `key-id:base64` entries, each encoding 32 bytes (the first key is used for new secrets); preserve them with the data volume. Supply
secrets through a private environment file or your deployment secret mechanism,
never build arguments. Set `MANAGED_COMPANY_WORKSPACES` as documented in
`../docs/managed-company.md`. Startup validates those declared workspace/bot facts;
it does not inspect container privileges, browser sandbox support or proxy TLS.
The reusable test runner checks runtime privileges and actual Chromium PNG/PDF
rendering separately. Its read-only metadata observer is test infrastructure and
is not needed for ordinary deployment.

Managed-company authorization does not implement private media delivery. Use
synthetic data until the separate private file-access prerequisite is accepted.
