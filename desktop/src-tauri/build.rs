fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "claude_status",
            "claude_connect",
            "claude_login",
            "claude_install",
            "claude_run",
            "claude_stop",
        ]),
    ))
    .expect("failed to build desktop permissions");
}
