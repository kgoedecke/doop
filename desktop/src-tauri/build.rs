// Shared by both shells: ../src-tauri-chromium builds these same sources on
// Tauri 3's CEF runtime. tauri-runtime-cef declares `links`, so its presence
// shows up here as DEP_TAURI_RUNTIME_CEF_RUNTIME; the sources branch on the
// `chromium` cfg set from it, and read the capabilities kept in this crate.
fn main() {
    println!("cargo::rustc-check-cfg=cfg(chromium)");
    let chromium = std::env::var_os("DEP_TAURI_RUNTIME_CEF_RUNTIME").is_some();
    if chromium {
        println!("cargo::rustc-cfg=chromium");
    }
    let attributes =
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "claude_status",
            "claude_connect",
            "claude_login",
            "claude_install",
            "claude_choose_cli",
            "claude_reset_cli",
            "claude_run",
            "claude_stop",
            "claude_add_extension",
            "codex_add_mcp",
            "fonts_choose_local",
            "fonts_read_local",
            "view_menu_state",
            "update_card_ready",
            "update_restart",
        ]));
    let attributes = if chromium {
        // tauri-build watches only its default capabilities path, so a
        // capability removed here would otherwise survive an incremental build
        println!("cargo:rerun-if-changed=../src-tauri/capabilities");
        attributes.capabilities_path_pattern("../src-tauri/capabilities/**/*")
    } else {
        attributes
    };
    tauri_build::try_build(attributes).expect("failed to build desktop permissions");
}
