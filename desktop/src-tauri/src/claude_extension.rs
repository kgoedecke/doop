//! Hand the extension to Claude's installer. Claude still owns the installation
//! confirmation; Doop only stages the bundle in its cache and opens it.
use std::fs;
use tauri::{AppHandle, Manager};
#[cfg(not(target_os = "macos"))]
use tauri_plugin_opener::OpenerExt;

fn validate_bundle(bundle: &[u8]) -> Result<(), String> {
    if bundle.len() < 4 || bundle.len() > 20 * 1024 * 1024 || !bundle.starts_with(b"PK\x03\x04") {
        return Err("The Claude extension could not be prepared. Please try again.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn claude_add_extension(app: AppHandle, bundle: Vec<u8>) -> Result<(), String> {
    validate_bundle(&bundle)?;
    tauri::async_runtime::spawn_blocking(move || {
        let directory = app
            .path()
            .app_cache_dir()
            .map_err(|e| e.to_string())?
            .join("claude-extension");
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let path = directory.join("doop.mcpb");
        fs::write(&path, bundle).map_err(|e| e.to_string())?;

        #[cfg(target_os = "macos")]
        {
            let status = std::process::Command::new("/usr/bin/open")
                .args(["-b", "com.anthropic.claudefordesktop"])
                .arg(&path)
                .status()
                .map_err(|e| e.to_string())?;
            if !status.success() {
                return Err("Install Claude Desktop, then try Add to Claude again.".into());
            }
        }
        #[cfg(not(target_os = "macos"))]
        app.opener()
            .open_path(path.to_string_lossy().into_owned(), None::<String>)
            .map_err(|_| "Install Claude Desktop, then try Add to Claude again.".to_string())?;

        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::validate_bundle;

    #[test]
    fn rejects_html_error_pages_and_oversized_downloads() {
        assert!(validate_bundle(b"<!doctype html>").is_err());
        assert!(validate_bundle(b"").is_err());
        let mut oversized = vec![0; 20 * 1024 * 1024 + 1];
        oversized[..4].copy_from_slice(b"PK\x03\x04");
        assert!(validate_bundle(&oversized).is_err());
        assert!(validate_bundle(b"PK\x03\x04bundle").is_ok());
    }
}
