//! Opening a link in the person's browser: for the page (`open_external`,
//! src/lib/desktop.ts: sign-in, Help & docs, integration connects) and for a
//! navigation that leaves the app (main.rs). The opener plugin does it, except
//! in a Linux AppImage: the plugin runs `xdg-open` under the bundle's
//! environment, which on a current distro cannot start the browser
//! (src/host_env.rs). There the host's `xdg-open` runs under the host's
//! environment, and the plugin is only the fallback for a host without one.
use tauri::{AppHandle, Url};
use tauri_plugin_opener::OpenerExt;

/// Hands `url` to the system; an error means nothing could take it. Callers
/// keep it off the UI thread, since the plugin can wait on the program it runs.
pub fn open_url(app: &AppHandle, url: &str) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    if crate::host_env::in_appimage() {
        match open_on_host(url) {
            Ok(()) => return Ok(()),
            Err(error) => eprintln!("The system's xdg-open did not start: {error}"),
        }
    }
    app.opener()
        .open_url(url, None::<String>)
        .map_err(|error| error.to_string())
}

/// Starts the host's `xdg-open`; an error means it is not there to start. How
/// it exits is only logged: it passes on the status of whatever it ran
/// (`$BROWSER`, `gio`, `kde-open`), which can report a failure after the
/// browser opened, so trying the plugin as well could open the link twice.
#[cfg(target_os = "linux")]
fn open_on_host(url: &str) -> Result<(), String> {
    use std::process::Stdio;
    let mut child = crate::host_env::command("xdg-open")
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| error.to_string())?;
    std::thread::spawn(move || match child.wait() {
        Ok(status) if !status.success() => eprintln!("xdg-open exited with {status}"),
        Ok(_) => {}
        Err(error) => eprintln!("Waiting for xdg-open failed: {error}"),
    });
    Ok(())
}

/// The page's way to the browser. Web links only: the opener plugin's grant
/// in capabilities/default.json was scoped to http(s), and this replaces it.
#[tauri::command]
pub async fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    let url = web_link(&url)?;
    tauri::async_runtime::spawn_blocking(move || open_url(&app, url.as_str()))
        .await
        .map_err(|error| error.to_string())?
}

fn web_link(url: &str) -> Result<Url, String> {
    let url = Url::parse(url).map_err(|error| error.to_string())?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        scheme => Err(format!("{scheme}: links do not open in the browser")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_links_go_to_the_browser() {
        assert!(web_link("https://doop.design/desktop/signin?provider=google").is_ok());
        assert!(web_link("http://localhost:4300/docs").is_ok());
        for url in [
            "file:///etc/passwd",
            "doop://auth?token=x",
            "javascript:alert(1)",
            "/relative",
            "smb://host/share",
        ] {
            assert!(web_link(url).is_err(), "{url}");
        }
    }
}
