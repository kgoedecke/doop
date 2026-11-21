# Doop for Android

A native Kotlin/Jetpack Compose app for ARM64 Android phones and tablets, Android
8.0 (API 26) or newer. It uses the existing Doop REST and WebSocket APIs. Frames
are rendered by the same pinned Rust Blitz/Skia engine as iOS, through a small JNI
adapter; the main interface and canvas are native Android views.

## Build and run

Install Android Studio, its bundled JDK, SDK Platform 36, Build Tools 36.0.0,
Platform Tools, and NDK **30.0.16248370**. Install Rust through rustup, Python 3,
CMake, and Ninja. On Apple Silicon, use an ARM64 emulator image or an ARM64 phone.

```sh
rustup target add aarch64-linux-android
cargo install cargo-ndk --locked
export ANDROID_HOME="$HOME/Library/Android/sdk"
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$HOME/.cargo/bin:$PATH"
cd android
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n design.doop.android/.MainActivity
```

Alternatively, open this `android/` directory in Android Studio and run **app**.
Gradle invokes `scripts/build-native.py` automatically. Its first build downloads
Rust dependencies and Skia binaries and needs several GB of disk space. Subsequent
builds reuse the Rust target directory already ignored under `ios/BlitzKit/rust`.
Java 25 from Android Studio works with the pinned Gradle 9.1 wrapper; source and
bytecode target Java 17. The Gradle distribution checksum is pinned.

```sh
./gradlew testDebugUnitTest lintDebug
# With an ARM64 emulator booted or device connected:
./gradlew connectedDebugAndroidTest
./gradlew assembleRelease bundleRelease
```

Debug APKs use the local Android debug signing key. Release APKs and AABs are
unsigned until a distribution signing configuration is supplied. No store upload
or production signing credentials are part of this project.

## Features

- Email sign-in and registration; Google, Microsoft, Apple web sign-in and OIDC
  through Custom Tabs and the existing challenge-checked `doop://auth` handoff.
- Encrypted persistent session cookies using Android Keystore, partitioned by
  server. HTTPS self-hosted origins, sign-out, account deletion and account links.
- Searchable canvas library, workspace filters, creation, rename, duplication,
  deletion, link sharing and previews.
- Live authenticated canvas snapshots and incremental events, reconnects,
  page selection, collaborators, cursors and agent streaming labels.
- Native pan, pinch zoom, double-tap fitting, title dragging and edge/center
  snapping; viewport-cropped Blitz tiles, system and web fonts, SVGs, images,
  CSS animations, and element hit testing.
- Frame creation, dimensions, names, HTML editing, locking, scoped prompts,
  specialist agents, people/frame context references and account model selection.
- Copy/paste/duplicate/delete for frames and elements, session undo, comments,
  agent task status, PNG/HTML exports and selection links.
- Optional ongoing Android notification for background task progress. Enable
  **Follow working agents** in Settings; a foreground data-sync service polls the
  canvas summaries every 15 seconds. Stop it from Settings or the notification.
  Android controls foreground-service time limits; it does not use Apple APNs or
  claim to receive push notifications after the process is terminated.

## Platform details

- `app/src/main/cpp/blitz_jni.c` adapts the existing C ABI to Android bitmaps.
  All document calls run on one serial executor. Standard UTF-8 byte arrays avoid
  Java's modified UTF-8 corrupting emoji and other supplementary characters.
- Native libraries and the APK use 16 KB page alignment. Only `arm64-v8a` is
  packaged, matching the first supported device/emulator architecture.
- The Android renderer uses the OS CA directory for its Rust HTTP client. Frame
  resources are retained in documents; Blitz's desktop disk-cache feature is
  disabled specifically on Android because its constructor requires a desktop
  home directory. iOS keeps its existing disk cache.
- A network-blocked WebView runs the shared inert `SelectionDOM.js` parser for
  element edits. It never loads the frame as a page or executes frame scripts.
- PNG export waits for image/font loads, resolves the selected element again,
  bounds output to 4096 px per side / 8 MP, and shares an app-cache URI with a
  temporary read grant. Sharing a link never changes canvas access.
- Production traffic requires HTTPS. Debug builds permit HTTP only for
  localhost, `127.0.0.1` and the emulator host alias `10.0.2.2`.
- OAuth providers and live AI generation still require the corresponding server
  configuration/model account, just as on iOS. Provider redirects must be tested
  with real accounts before store distribution.

## Validation

JVM tests cover server-address validation, provider callback challenges and
expiry, legacy pages, frame limits, snapping, model-account selection and frame layout/version round trips. Instrumentation tests exercise
the real native renderer (CSS, SVG, Unicode, system fonts, network images and
tiles), inert element edits, cookie persistence, live page/reconnect behavior,
version-conflict rejection, layout-preserving undo, model selection,
and the Compose sign-in/create/edit/undo/comment/prompt flow against an isolated
local HTTP/WebSocket fixture. These tests do not send prompts or mutate data on
Doop Cloud.

The local build was verified with seven JVM tests and ten instrumentation tests
on an ARM64 Android 17 / API 37 emulator. Debug APK, minified release APK and
release AAB builds pass, as does Android lint (no errors). Native ELF segments and
APK packaging were checked for 16 KB page alignment. A locally signed copy of
the optimized release also launches successfully and loads the Doop Cloud
sign-in screen and configured provider buttons.

## Android visual identity and zoom rendering

The Android theme follows Doop's neutral white/graphite palette, Disc-D mark,
variable Inter and Hanken Grotesk fonts, and Lucide icons. Font weights and every
Material color role are specified so dialogs, sheets, and controls do not fall
back to the default purple theme. The canvas uses selection blue and the iOS
composer's blue send action. Selection tools appear only for a selected frame.

Bitmap dimensions use the same double-precision multiplication as the Rust
renderer. Crops smaller than one physical pixel receive a one-pixel backing
buffer; allocation headroom keeps rounded exports below the native limit.
Instrumentation covers fractional zoom and subpixel crops of tall frames.
Preview failures remain inline, with an explicit retry, and do not loop modal
alerts or continuously rerender a failed tile.
