fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "claude_status",
            "claude_set_model",
            "claude_connect",
            "claude_login",
            "claude_install",
            "claude_run",
            "claude_stop",
            "claude_add_extension",
            "codex_add_mcp",
        ]),
    ))
    .expect("failed to build desktop permissions");
}
