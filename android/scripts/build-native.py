#!/usr/bin/env python3
"""Build the shared iOS/Android Blitz engine and its small Android JNI adapter."""
import os
from pathlib import Path
import platform
import shutil
import subprocess

root = Path(__file__).resolve().parents[2]
sdk = Path(os.environ.get("ANDROID_HOME", str(Path.home() / "Library/Android/sdk")))
ndk = sdk / "ndk/30.0.16248370"
host = "darwin-x86_64" if platform.system() == "Darwin" else "linux-x86_64"
toolchain = ndk / "toolchains/llvm/prebuilt" / host
if not toolchain.exists():
    raise SystemExit(f"Install NDK 30.0.16248370 in {sdk} first")
# cargo-ndk's panic reporter prints its environment. Pass build-related variables only.
env = {k: v for k, v in os.environ.items() if k in {
    "HOME", "PATH", "TMPDIR", "CARGO_HOME", "RUSTUP_HOME", "JAVA_HOME", "ANDROID_HOME"
}}
env.update(ANDROID_HOME=str(sdk), ANDROID_NDK_HOME=str(ndk), CARGO_BUILD_JOBS="4")
env["PATH"] = str(Path.home() / ".cargo/bin") + os.pathsep + env.get("PATH", "")
crate = root / "ios/BlitzKit/rust"
subprocess.run(["cargo", "ndk", "-t", "arm64-v8a", "-P", "26", "build", "--release", "--locked"],
               cwd=crate, env=env, check=True)
out = root / "android/app/build/native/jniLibs/arm64-v8a"
out.mkdir(parents=True, exist_ok=True)
subprocess.run([str(toolchain / "bin/aarch64-linux-android26-clang"), "-shared", "-fPIC", "-O2",
    "-Wl,-z,max-page-size=16384", "-Wl,--gc-sections", "-Wl,-soname,libdoop_android.so",
    "-Wl,--exclude-libs,ALL", "-I" + str(root / "ios/BlitzKit/include"),
    str(root / "android/app/src/main/cpp/blitz_jni.c"),
    str(crate / "target/aarch64-linux-android/release/libdoopblitz.a"),
    "-lc++_shared", "-llog", "-landroid", "-ljnigraphics", "-ldl", "-lm", "-o", str(out / "libdoop_android.so")],
    env=env, check=True)
shutil.copy2(toolchain / "sysroot/usr/lib/aarch64-linux-android/libc++_shared.so", out)
subprocess.run([str(toolchain / "bin/llvm-strip"), "--strip-unneeded", str(out / "libdoop_android.so")], check=True)
print("Android Blitz renderer:", out)
