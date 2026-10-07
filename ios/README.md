# doop for iOS

A native SwiftUI iPhone/iPad app, targeting iOS 16+. The app does **not** load the
Doop website for its main interface, and it does **not** use WebKit to draw frames:
every frame is rendered by [Blitz](https://github.com/DioxusLabs/blitz), a Rust
HTML/CSS engine (Stylo + Taffy + Parley), compiled into the app as a static library.

## Architecture

- **SwiftUI**: email/password sign-in and registration, canvas library, search,
  workspace filtering, canvas creation/rename/duplicate/delete, navigation,
  account/server settings, frame list and properties, HTML editing, frame and
  element comments, agent tasks, sharing, and HTML export.
- **Swift networking**: `DoopClient` talks to the existing REST API using session
  cookies. `CanvasModel` owns the canvas state and its authenticated WebSocket room,
  including reconnection, frame updates, agent tasks, comments and presence.
- **Native canvas** (`Doop/Blitz/BlitzCanvasView.swift`): a UIKit view with one
  Core Animation layer per frame. Pan, pinch zoom, tap to select, double tap to zoom
  to a frame, drag a frame by its title. Labels, selection outlines and collaborator
  cursors are native layers, so a board with many frames costs one small bitmap per
  frame instead of one web document per frame.
- **Blitz engine** (`Doop/Blitz/BlitzDocument.swift` over `BlitzKit/`): each frame's
  HTML is parsed once into a Blitz document. The canvas asks for a bitmap at the
  density the current zoom needs (up to 3 bitmap pixels per CSS pixel, 4096 px max
  side, about two screens of pixels per frame), re-renders when fonts and images
  arrive, and re-parses when an agent streams new HTML. Off-screen frames keep a
  small bitmap and, after a few seconds, release their document; on-screen frames
  keep theirs, so zooming into a fitted board never waits on a re-parse. Google
  Fonts via `<link>` and network images work; scripts do not run (frames show their
  static HTML).
- **Deep zoom tiles**: a base bitmap is capped at 3 bitmap pixels per CSS pixel and
  about two screens of pixels. When the screen density exceeds what the base bitmap
  holds, the part of the frame on screen (plus a 30% margin) is painted as a tile at
  up to 8 bitmap pixels per CSS pixel and composited over the base, so text stays
  sharp at any zoom at roughly one screen of pixels per paint. Tiles refresh when a
  gesture settles and when the frame's HTML changes; a tiled frame holds its
  animations still.
- **SVG**: `blitz-paint` is pulled in with `default-features = false` so the bridge
  controls what it links; its `svg` feature must stay on, or neither inline `<svg>`
  elements nor SVG images (`<img src="….svg">`, backgrounds) are painted at all.
  SVG images are parsed by usvg, which accepts `em`-sized roots such as iconify's.
- **Device-pixel layout**: Taffy rounds every box to whole CSS pixels after layout,
  which at a paint scale above 1 puts a different number of device pixels on each
  side of a box sitting on a half pixel (a 1.5px outline, a handle centred on it).
  The bridge re-rounds the resolved layout on the device-pixel grid before each
  paint (`round_layout_to_device`), the way browsers snap at paint time; a bridge
  test checks the two borders of such a box differ by at most one device pixel.
- **CSS animations**: a frame whose document reports running animations or
  transitions (`doopblitz_doc_is_animating`) is played by a `CADisplayLink` while
  it is on screen: each step paints only the on-screen part of the frame as a tile
  (`doopblitz_doc_render_region_at`) at a density chosen so one step stays near
  550k pixels, about 10-20 ms on Skia, which gives 30-40 steps a second at any
  zoom. Playback pauses during gestures and for frames narrower than 100 pt, at
  most two frames play at once, and when an animation ends the tile is repainted
  at the density the camera wants. Base bitmaps keep the last animation pose.
- **Element inspection**: with Inspect on, tapping inside the selected frame hit
  tests the Blitz DOM. The chip shows `tag#id.class` and the element's text, the
  outline shows its box, and Comment posts an element-anchored comment with the
  same `tag:nth-of-type(n)` selector path the web editor and agents use.

The main app uses the existing backend APIs. Live Activity background updates require
the server additions and Apple push configuration described below. Use Doop Cloud or an
HTTPS self-hosted origin. Native session cookies persist; the client can also import
an existing WKWebView login for the selected host. Passwords are never saved by the app.
Cookies follow normal domain/path scoping, not port isolation.

### BlitzKit (the Rust side)

`BlitzKit/rust` is a small crate exposing a C ABI (`BlitzKit/include/doopblitz.h`):
create a document from HTML at a frame size and scale, render to RGBA, hit test a
point, query a selector, read a node's rect and inspector info. Blitz is pinned to a
commit in `Cargo.toml`. The Xcode target runs `BlitzKit/build.sh $PLATFORM_NAME` as
its first build phase, which needs a Rust toolchain:

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # once
rustup target add aarch64-apple-ios aarch64-apple-ios-sim           # build.sh adds these too
```

The library is arm64 only (Apple Silicon simulators and devices); the project
excludes the x86_64 simulator slice. `cargo test --release` in `BlitzKit/rust` runs
the ABI against a real frame.

Painting uses Blitz's **Skia** backend (`anyrender_skia`, prebuilt Skia binaries pulled
by `skia-bindings` at build time), which renders `filter`, `backdrop-filter` and
`drop-shadow`; the pure-Rust Vello CPU backend (`--no-default-features --features
vello-cpu`) skips those. Skia raster runs on the CPU today; its Metal surface is the
path to GPU painting. All documents share one font context (`base_font_context` in
`rust/src/lib.rs`): Blitz would otherwise load the system font files once per
document, which on Skia cost tens of megabytes per frame. The crate also enables the
`image` codecs (PNG, JPEG, GIF, WebP) explicitly, because Blitz leaves them to feature
unification and without them PNG frames paint blank.

Two examples help when something renders wrong: `cargo run --release --example
shot -- <html> <w> <h> <scale> [out.ppm]` paints one frame the way the app does, and
`cargo run --release --example memory -- <dir> <copies> <scale>` reports resident
memory for a board of documents.

`BlitzKit/vendor/blitz-paint` is the upstream `blitz-paint` crate at the pinned commit
with one fix, wired in through `[patch]` in `rust/Cargo.toml`: CSS filter lengths
(blur radii, drop-shadow offsets) are scaled with the paint scale. Upstream applies
them in device pixels, so a `blur(22px)` hero looked like fog zoomed out and barely
blurred on a 3× screen. Remove the vendored copy once the fix lands upstream.

The vendored copy also adds `paint_scene_region`, a signed-offset entry point for
painting a window of a document (the upstream offset is an unsigned shift), and fixes
the painter's culling window to follow that offset; without it a tile only showed
elements that happened to fall within the tile's own size measured from the frame
origin. `cargo run --release --example tile -- <html> <w> <h> <scale> <x> <y> <rw>
<rh> <out>` checks a tile against the same window of a full render.

The vendored copy carries a second fix: an element with `opacity` or `filter` and
`overflow: visible` had its layer clipped to its own border box, cutting off
absolutely positioned children such as cursor labels; the clip now covers the
element's scrollable overflow.

A third engine gap is worked around in the bridge rather than vendored: Blitz rebuilds
its style device when the scale changes but does not recascade, and Stylo snaps border
and outline widths to whole device pixels at cascade time. A frame first styled at a
fitted board's tiny scale therefore kept hairlines that had snapped up to one device
pixel (about 11 CSS px) and showed thick borders once zoomed in. `doopblitz_doc_set_viewport`
now requests a recascade on every scale change; `rescaling_restyles_device_pixel_snapped_borders`
in `rust/tests/abi.rs` guards it. Both engine issues are worth sending upstream. Known engine gaps on both backends: `text-shadow`, 3D transforms,
`mix-blend-mode`, CSS counters, `writing-mode`, multi-column, form placeholders and
`<select>`, emoji fallback, SVG styled through CSS and SVG `<pattern>` fills.

## Run

1. Open `ios/Doop.xcodeproj` in Xcode.
2. Select **Doop** and an iPhone or iPad simulator, then Run. The first build compiles
   the Rust library (a few minutes); later builds are incremental.
3. Sign in with your Doop email and password, or choose another server in Settings.
4. For a physical device, set your development team and registered bundle identifier
   under Signing & Capabilities.

For a local simulator test server with a trusted HTTPS certificate, launch with:

```sh
xcrun simctl launch booted design.doop.ios -serverOrigin https://localhost:18443
```

## Validation

```sh
swift run --package-path ios DoopCoreChecks
(cd ios/BlitzKit/rust && cargo test --release)
xcodebuild -project ios/Doop.xcodeproj -scheme Doop \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath ios/DerivedData CODE_SIGNING_ALLOWED=NO build
```

Verified with Xcode 27.0 on macOS 27 (Apple M4), iOS 27.0 simulator (iPhone 18 Pro):

- The Rust library builds for `aarch64-apple-ios-sim` and `aarch64-apple-ios`. The ABI
  tests render a 1512×1250 production frame, hit test its heading, round-trip the
  selector path, re-render at 2×, replace streamed HTML, and keep 60 documents apart.
- The app signs in against a local HTTPS server, opens a 60-frame board of real
  production frames and renders every frame through Blitz. The scripted stress run
  below holds 60 fps (the simulator's cap) with zero frames over 25 ms through a board
  sweep, zoom to 1×, pan at 1×, pinch to 2× and zoom out; all 60 frames paint in
  1.6 s; resident memory runs 480 MB at fit, about 700 MB at 1× and 815 MB at 2×.

Still to verify on a physical device: ProMotion 120 Hz, real touch gestures, streamed
agent updates, element comments landing in the web editor, reconnect recovery,
background/foreground transitions, large text, VoiceOver, and iPad layout. This is not
a claim of complete feature parity or App Store readiness.

### Stress test (simulator automation)

The app only accepts HTTPS origins, so a local server is fronted by a TLS proxy whose
CA the simulator trusts. Debug builds accept launch arguments that sign in with test
credentials on a `localhost` origin, open a canvas and run a scripted camera that logs
per-phase frame times (`subsystem design.doop.ios`, category `canvas.perf`):

```sh
bun run dev                                               # doop on http://localhost:4400
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 30 -subj "/CN=doop local test CA"
openssl req -newkey rsa:2048 -nodes -keyout localhost.key -out localhost.csr -subj "/CN=localhost"
printf "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n" > ext.cnf
openssl x509 -req -in localhost.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out localhost.pem -days 30 -extfile ext.cnf
node ios/scripts/local-https.mjs localhost.pem localhost.key 18443 &
xcrun simctl boot "iPhone 18 Pro" && xcrun simctl keychain booted add-root-cert ca.pem
node ios/scripts/stress-seed.mjs <dir-of-frames-with-manifest.json> 60   # prints the canvas id
xcrun simctl install booted ios/DerivedData/Build/Products/Debug-iphonesimulator/Doop.app
xcrun simctl launch booted design.doop.ios -serverOrigin https://localhost:18443 \
  -testEmail <seed email> -testPassword <seed password> -openCanvas <id> -stressTest 1
xcrun simctl spawn booted log show --last 2m --info --predicate 'subsystem == "design.doop.ios"' --style compact
```

`-holdCamera "x,y,zoom"` parks the camera for screenshots (prefix a negative x with
a space so the argument parser keeps it); `-pickElement "x,y"` selects the element at
frame-local CSS px; `-dumpFrame "<name>"` writes that frame's rendered bitmaps to the
app's tmp directory; `-exportCanvas <id>|list` writes the signed-in account's canvas
JSON there; `-fakeCursors 1` adds three wandering collaborators (a person, Claude
and Codex) to check the cursor chrome without a second client. The seed script's test account
exists only on the local dev database.

## Remaining work

- Native SSO needs a browser authentication session plus a secure server callback /
  single-use session exchange. Email/password is the implemented sign-in path.
- Model-account setup currently opens Doop's account settings in the system browser.
- Element comments pin to the selected element; replies and resolution controls have
  not yet moved to native UI.
- Frames that depend on scripts render as static HTML. A per-frame WebKit fallback
  for those is the next tier, not built yet.
- Advanced web workflows such as design memory, GitHub imports, workspace billing,
  undo/redo and the full element inspector are not yet native features.
- Live model-generated tasks require a configured server provider or connected model
  account.
- App Store/TestFlight release needs signing, device QA, privacy metadata and an archive.
  No build has been submitted or published.

## App Store submission

What the project carries for review, and what still happens outside the repo:

- `PrivacyInfo.xcprivacy` in the app and the Live Activity extension declare the
  required-reason APIs (UserDefaults, file timestamps) and the data the app
  handles (name, email, canvas content; none of it used for tracking). Keep the
  App Privacy answers in App Store Connect in line with them.
- `INFOPLIST_KEY_ITSAppUsesNonExemptEncryption = NO`: only HTTPS, which is exempt.
- Deployment target iOS 16.2 for the app and the extension (ActivityKit's floor).
- Account deletion: Settings → Delete account calls better-auth's
  `POST /api/auth/delete-user` with the password; the server's `beforeDelete`
  hook (`server/accountDeletion.ts`) deletes canvases only that user could reach,
  removes them from shared canvases and workspaces, and drops their push tokens.
- Settings links to `/privacy` and `/terms` on the configured server (the
  server proxies both from the marketing site) and to support@doop.design as
  the channel for support requests and for reporting a canvas.
- `.github/workflows/ios-release.yml` archives a Release build with Xcode-managed
  signing and uploads it to App Store Connect on an `ios-v*` tag (secrets listed
  in the workflow). `ios/ExportOptions.plist` holds the export settings.

Still manual: the App Store Connect record, screenshots, the review demo account
on the public server, and a run on physical iPhone and iPad hardware before the
first TestFlight build goes out.

## Floating controls and Live Activities

The library and canvas use floating capsule controls with native Liquid Glass on
iOS 26+, material on older systems, and an opaque accessible fallback when Reduce
Transparency is enabled. The canvas renders underneath the controls; Fit reserves
space for the dock.

On iOS 16.2+, opening a canvas with active or queued agents starts a Lock Screen
Live Activity and Dynamic Island status where available. It shows the canvas,
latest task narration, elapsed time, active count, and pipeline stages when the
server actually supplies a pipeline. Finished/failed activities end automatically.
This is a Live Activity, not a Home Screen widget or app-icon badge.

Local updates work while viewing the canvas. For updates after the app is
backgrounded, run the updated server (including migration `0025_live_activities`)
and configure these server-only environment variables:

```sh
DOOP_APNS_TEAM_ID=your_apple_team_id
DOOP_APNS_KEY_ID=your_apns_key_id
DOOP_APNS_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
DOOP_APNS_BUNDLE_ID=design.doop.ios
```

On iOS 17.2+ the app also registers a push-to-start token (`PUT
/api/live-activities/push-to-start`, same migration), so the
server opens a Live Activity the moment an agent task begins on any canvas the user
owns or is a member of, whether or not the app is open or that canvas was ever
opened on the phone. The delivery loop announces each task once per device, skips
canvases that already report an activity, and the app ends a duplicate if both
paths race. Sign-out retires the token.

Use your Apple APNs signing key; keep it out of source control. Enable Push
Notifications for the app's registered identifier and sign both app and widget
extension with your team. If changing the app bundle ID, update the extension ID
and `DOOP_APNS_BUNDLE_ID` too. Debug builds register sandbox tokens; Release uses
production. The server checks durable canvas membership on registration and every
update, coalesces updates, removes expired/invalid registrations, and ends activity
access after revocation. Share-link-only visitors cannot register background updates.

Starting an activity requires opening the canvas in the foreground; push-to-start
is not implemented. Without push configuration, the last local status becomes
stale after two minutes and asks the user to reopen Doop. Sign-out/server changes
end local activities. Apple controls delivery timing and activity availability.
APNs delivery on a signed physical device remains to be verified with real credentials.

Server checks: `bunx vitest run tests/liveActivities.test.ts tests/liveActivityDelivery.test.ts`.

## Working agents

The home screen's sparkle button opens a native Agents view across all canvases
in your library. It groups active work and queued tasks by canvas, shows elapsed
time and real pipeline stages, and opens the related canvas. It refreshes every
five seconds while visible and active, with pull-to-refresh and explicit error
states. Update the server for the `activeTasks` field on `/api/canvases`; older
servers display an update message. Counts reflect agents per canvas.
