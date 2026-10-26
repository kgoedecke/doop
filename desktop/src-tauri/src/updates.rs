//! Manual checks use the same published installer as the website. A HEAD
//! request reads its release tag without downloading or following the DMG.
use std::time::Duration;

use rfd::{AsyncMessageDialog, MessageButtons, MessageDialogResult, MessageLevel};
use semver::Version;
use tauri::{menu::MenuItem, AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

pub const MENU_ID: &str = "check-for-updates";
const MENU_LABEL: &str = "Check for Updates…";
const DOWNLOAD_URL: &str = "https://doop.design/download/mac";
const RELEASE_PREFIX: &str = "https://github.com/kgoedecke/doop/releases/download/desktop-v";

struct UpdateMenu(MenuItem<tauri::Wry>);

pub fn menu_item(app: &AppHandle) -> tauri::Result<MenuItem<tauri::Wry>> {
    let item = MenuItem::with_id(app, MENU_ID, MENU_LABEL, true, None::<&str>)?;
    app.manage(UpdateMenu(item.clone()));
    Ok(item)
}

/// Menu events run on the UI thread. Disable the item before spawning work
/// and keep it disabled through the result dialog to prevent duplicate checks.
pub fn check(app: &AppHandle) {
    let item = app.state::<UpdateMenu>().0.clone();
    if !item.is_enabled().unwrap_or(false) || item.set_enabled(false).is_err() {
        return;
    }
    let _ = item.set_text("Checking for Updates…");
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        show_result(&app).await;
        let _ = item.set_text(MENU_LABEL);
        let _ = item.set_enabled(true);
    });
}

fn dialog(app: &AppHandle, title: &str, description: &str) -> AsyncMessageDialog {
    let dialog = AsyncMessageDialog::new()
        .set_title(title)
        .set_description(description);
    match app.get_webview_window("main") {
        Some(window) => dialog.set_parent(&window),
        None => dialog,
    }
}

async fn show_result(app: &AppHandle) {
    // Official installers point at doop.design. Replacing a self-hosted shell
    // with one would silently change its server.
    if !matches!(
        crate::APP_URL.trim_end_matches('/'),
        "https://doop.design" | "https://www.doop.design"
    ) {
        dialog(app, "Custom desktop build", "This app connects to a custom Doop server. Contact whoever provided this app for an updated desktop build.")
            .show().await;
        return;
    }

    let current = &app.package_info().version;
    match latest_version(DOWNLOAD_URL).await {
        Ok(latest) if latest.cmp_precedence(current).is_gt() => {
            let choice = dialog(
                app,
                "A new version of doop is available",
                &format!("doop {latest} is available. You have {current}.\n\nDownload the installer, then open it and drag doop into Applications to replace this version."),
            )
            .set_buttons(MessageButtons::OkCancelCustom("Download Update".into(), "Not Now".into()))
            .show().await;
            if choice == MessageDialogResult::Custom("Download Update".into())
                && app.opener().open_url(DOWNLOAD_URL, None::<&str>).is_err()
            {
                dialog(
                    app,
                    "Couldn’t open the download",
                    &format!("Open {DOWNLOAD_URL} in your browser to download the update."),
                )
                .set_level(MessageLevel::Error)
                .show()
                .await;
            }
        }
        Ok(_) => {
            dialog(
                app,
                "You’re up to date",
                &format!("doop {current} is up to date."),
            )
            .show()
            .await;
        }
        Err(error) => {
            eprintln!("Desktop update check failed: {error}");
            dialog(
                app,
                "Couldn’t check for updates",
                "Check your internet connection and try again in a moment.",
            )
            .set_level(MessageLevel::Error)
            .show()
            .await;
        }
    }
}

async fn latest_version(endpoint: &str) -> Result<Version, String> {
    let response = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .user_agent(concat!("doop-desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?
        .head(endpoint)
        .header(reqwest::header::CACHE_CONTROL, "no-cache")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_redirection() {
        return Err(format!("Unexpected download status: {}", response.status()));
    }
    let location = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .ok_or("Missing download location")?;
    release_version(location)
}

fn release_version(location: &str) -> Result<Version, String> {
    let (version, filename) = location
        .strip_prefix(RELEASE_PREFIX)
        .and_then(|path| path.split_once('/'))
        .ok_or("Unrecognized desktop release URL")?;
    let version = Version::parse(version).map_err(|e| e.to_string())?;
    if !version.pre.is_empty() || filename != format!("doop_{version}_universal.dmg") {
        return Err("Expected a stable universal macOS installer".into());
    }
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;

    #[test]
    fn checks_headers_without_downloading_and_rejects_failed_responses() {
        let location = format!("Location: {RELEASE_PREFIX}0.6.0/doop_0.6.0_universal.dmg\r\n");
        for (status, headers, succeeds) in [
            ("302 Found", location.as_str(), true),
            ("200 OK", location.as_str(), false),
            ("302 Found", "", false),
            ("503 Service Unavailable", "", false),
        ] {
            let server = TcpListener::bind("127.0.0.1:0").unwrap();
            let endpoint = format!("http://{}/download/mac", server.local_addr().unwrap());
            let response = format!(
                "HTTP/1.1 {status}\r\n{headers}Content-Length: 0\r\nConnection: close\r\n\r\n"
            );
            let request = std::thread::spawn(move || {
                let (mut stream, _) = server.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(&stream);
                let mut request_line = String::new();
                reader.read_line(&mut request_line).unwrap();
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                        break;
                    }
                }
                stream.write_all(response.as_bytes()).unwrap();
                request_line
            });
            let result = tauri::async_runtime::block_on(latest_version(&endpoint));
            assert_eq!(request.join().unwrap(), "HEAD /download/mac HTTP/1.1\r\n");
            assert_eq!(result.is_ok(), succeeds, "{status}: {result:?}");
            if succeeds {
                assert_eq!(result.unwrap(), Version::new(0, 6, 0));
            }
        }
    }

    #[test]
    fn reads_published_installer_version_and_compares_numerically() {
        let latest =
            release_version(&format!("{RELEASE_PREFIX}0.10.0/doop_0.10.0_universal.dmg")).unwrap();
        for (current, newer) in [
            ("0.9.0", true),
            ("0.10.0", false),
            ("0.11.0", false),
            ("0.10.0-beta.1", true),
            ("0.10.0+custom", false),
        ] {
            assert_eq!(
                latest
                    .cmp_precedence(&Version::parse(current).unwrap())
                    .is_gt(),
                newer
            );
        }
    }

    #[test]
    fn rejects_unexpected_downloads_instead_of_reporting_up_to_date() {
        for location in [
            DOWNLOAD_URL.to_string(),
            format!("{RELEASE_PREFIX}invalid/doop_invalid_universal.dmg"),
            format!("{RELEASE_PREFIX}0.6.0-beta.1/doop_0.6.0-beta.1_universal.dmg"),
            format!("{RELEASE_PREFIX}0.6.0/doop_0.5.0_universal.dmg"),
            format!("{RELEASE_PREFIX}0.6.0/doop_0.6.0_x64-setup.exe"),
            format!("{RELEASE_PREFIX}0.6.0/doop_0.6.0_universal.dmg/extra"),
            "https://example.com/desktop-v0.6.0/doop_0.6.0_universal.dmg".into(),
        ] {
            assert!(release_version(&location).is_err(), "{location}");
        }
    }
}
