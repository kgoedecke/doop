# Canvas-owned files

Private-file implementation is in progress. Use synthetic content until HTTP,
rendering, export and deployment verification are complete. Rendering/export changes still require complete implementation review and deployment
acceptance before confidential use.

Each uploaded image, font or profile photo belongs to one canvas. Uploads require
the authenticated account and its current canvas edit rights, including after
file I/O. A display name does not identify that account. Account suspension or
deletion removes authorization; an upload ticket also requires a current normal
MCP credential for the same account. Set `DOOP_MCP_TOKEN` before using the command
returned by `upload_asset(local_file=true)`. Tickets are single use and expire
after 15 minutes. Keep credentials out of documents and generated URLs.

Choose a canvas in the browser font library and profile-photo settings before
uploading. The font library is specific to that canvas. People without its access
see the profile's initials when the private photo is unavailable. There is no
global private-file library or automatic invitation to the photo's canvas.

An asset URL cannot move a private file to another canvas. Whole-canvas duplicate
and explicit browser frame/layer clipboard actions check source read and target
edit rights, copy bytes under new target-owned IDs, and rewrite URL carriers.
Clipboard source revisions must still match; stale or denied copies report an
error. They do not silently drop files or retry an uncertain copy. Same-canvas
copies can reuse their own files. Deleting the source leaves a successfully
committed target copy independent.

Incompatible databases must be reset. No ownerless uploads, ownership backfill,
old clipboard decoder, or legacy JSON store import is supported. Deleting a
canvas cascades its metadata; physical blob retention is not secure erasure.
Objects without committed metadata are not a supported file identity.

Supported interfaces for these ownership changes are the updated web client and
normal authenticated HTTP/MCP APIs. The iOS native Blitz renderer, native export
and native clipboard consumers have not been updated or validated for private
files; use the web client for this work. A desktop shell loading the updated web
client uses that web code, but native-shell integration has not been verified.
There is no legacy endpoint or public-media fallback for native consumers.

For focused native server checks, provision a disposable PostgreSQL database
server and set `DOOP_TEST_DATABASE_URL` to a role allowed to create/drop test
databases. Each fixture creates its own UUID database, starts the actual Doop
server, then closes it and drops the database. For example:

```sh
bun run test tests/privateCanvasCreation.test.ts tests/privateResourceOwnership.test.ts tests/privateCanvasCopies.test.ts tests/privateClipboardCopies.test.ts
```

Raw `/a/` and `/i/` requests require a current normal browser cookie session and
current stored parent access. A normal MCP credential authorizes MCP reads, not
cookie-less browser file URLs. Private responses use `private, no-store`; each
internal cache waiter rechecks its own authority. Ranges are unsupported and an
authorized Range request receives the complete bounded representation. No public
object redirect or cross-origin font grant is provided. Opaque browser and server
resource embedding is a separate materialization requirement still in progress.

MCP screenshot and PNG/JPG export results contain bounded real images. When a full
image exceeds 12,288 bytes (16,384 base64 characters), the inline image is a JPEG
thumbnail, with its own actual MIME, dimensions and `full_resolution=false`.
Metadata separately identifies the requested full format and dimensions. The full
`/i/` download still requires a current normal browser session with canvas access;
an MCP bearer alone cannot fetch it. A thumbnail does not prove that full text or
every visual detail was inspected.

PDFs that fit that same inline limit are embedded as `application/pdf`. Larger
PDF results return `inline_embedded=false` and the existing authenticated PDF
download URL. Pages remain in the requested same-canvas order. Image and PDF URLs
render current stored designs when fetched, rather than immutable snapshots.
Doop does not automatically download these URLs on a bot's behalf. External
hotlinks, private replay and public publication are unsupported. An authorized
person's downloaded or copied files cannot be recalled. Rendering, revocation
and deployment verification remains required before confidential use.

For the focused read/cache checks, Chrome/Chromium, PostgreSQL, Python3.9+ and Docker
are required. The real S3 fixture starts and stops itself for the test; it uses a
pinned Garage image, non-root process, private bucket, loopback listener and
random temporary credentials. Docker must be able to mount the checkout's parent
directory; runtime state is created beside the checkout and removed after tests.
It does not use a production bucket. Missing infrastructure fails the check.

```sh
bun run test tests/privateFileAccess.test.ts tests/privateMediaCache.test.ts tests/privateMediaStorage.test.ts tests/privateRenderIdentity.test.ts
```

The same fixture can be controlled directly (the runtime path must not exist):

```sh
python3 scripts/private-storage-fixture.py start --runtime-dir ../doop-private-storage-local
python3 scripts/private-storage-fixture.py stop --runtime-dir ../doop-private-storage-local
```

Only the protected runtime `sdk.json` contains fixture keys; commands print no
credentials. Stop checks its ownership label and removes only its own container;
the direct CLI retains the runtime directory for inspection. Ownership intent is
committed before Docker creation; cleanup checks the exact name and owner label.
A lost creation result, absent ownership record or unconfirmed cleanup preserves
the protected runtime instead of claiming removal. The stop command can reconcile
a pending candidate when Docker exposes it. Do not commit fixture state.
CI provides PostgreSQL and the pinned S3 fixture image for every test shard.
These disposable origin/application tests do not establish an external provider's
ACL configuration, aliases, ingress or CDN behavior. Startup performs no bucket or
CDN privacy validation; verify the actual deployment before confidential release.

The web client prepares private images and fonts under the current frame or pinned
reference context before giving bounded bytes to an opaque iframe. The child gets
no session, key, or privileged fetch callback. Normal browser editing saves the
canonical resource IDs. HTML downloads embed authorized private files and recheck
current access before saving. Private documents and their mutations are excluded
from session replay; ordinary documents can resume recording after replacement.

Browser raster exports fetch external resources without credentials and reject
redirects. Image/font bytes must pass the same server admission policy before the
local browser decodes them. Limits include 64 resource occurrences, 15,000,000
encoded media bytes, 64 MiB intrinsic decoded media, 1 MiB source, 32 MiB expanded
documents, and bounded parser work/depth. External resources too large for the
bounded admission wrapper fail local rendering. A current authorized server render
may be used where local rendering is unsupported; missing or denied private files
never become a public or blank-success fallback. Self-contained SVG files are
supported; SVG files loading other resources are unsupported.

The browser observes session/account changes, denied current context and canvas
WebSocket revocation/deletion events. It discards prepared documents, aborts pending
exports and revokes held download object URLs. The application has no registered
service worker or Cache API media store. A disconnected browser cannot observe a
server-side access change immediately; each new request still reauthorizes. Existing
authorized downloads and system clipboard contents remain outside that recall.

Community listing metadata does not grant access to private frame images or files.
Managed company publication remains denied. Social/OG consumers and external mail
image hotlinks have no private-media access; notification messages contain normal
application links, not embedded private files or public render capabilities.

Additional focused rendering/export checks (same disposable prerequisites):

```sh
bun run test tests/privateRendering.test.ts tests/privateConsumers.test.ts tests/privateExport.test.ts tests/privatePdfRendering.test.ts tests/privateReplay.test.ts tests/privateMaterializationDrain.test.ts
```

The drain test holds actual disk reads beyond the default 30-second caller
deadline and checks a competing claimant. These focused results do not replace the
full service suite or actual HTTPS/storage/ingress deployment checks.
