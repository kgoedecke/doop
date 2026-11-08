//! Which Doop server the shell opens. Official builds open doop.design (or
//! the `DOOP_APP_URL` they were built with); the sign-in screen's server
//! settings (src/components/ServerSettings.tsx) let a person point the same
//! build at a self-hosted instance instead, through `server_choose`.
//!
//! The choice is the server's origin in `server.json` in the app's data
//! directory (`server-dev.json` for debug builds, which otherwise open the
//! local dev server). It is read once at launch: the navigation allowlist,
//! the remote IPC grant and the first page all follow it, so changing it
//! restarts the app.
//!
//! The IPC grant is capabilities/default.json with its remote URLs swapped
//! for the chosen origin, added at runtime: that file is the one list of
//! what a page may ask the shell for, and a chosen server gets exactly that.
//! It is also why a change needs the person's say-so in a native dialog. The
//! asking page is the current server's, and the next one can run Claude Code
//! on this computer, read fonts the person picks and write their Codex and
//! Claude settings.
//!
//! A server that never loads leaves no page to change it from. So at launch
//! the shell checks a chosen server answers and, when it does not, asks in a
//! native dialog whether to try again or go back to doop.design (every
//! platform: Windows and Linux have no menu bar), and on macOS the app menu
//! also has "Use doop.design…" while another server is chosen.
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use rfd::{AsyncMessageDialog, MessageButtons, MessageDialogResult, MessageLevel};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Url};

const CAPABILITY: &str = include_str!("../capabilities/default.json");
const CONNECT: &str = "Connect";
const SWITCH: &str = "Switch";
const CANCEL: &str = "Cancel";
const RETRY: &str = "Try Again";
/// How long a server gets to answer the check before it counts as absent.
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

static ACTIVE: OnceLock<String> = OnceLock::new();

/// The server the shell opens with nothing chosen.
pub fn default_url() -> String {
    let url = if cfg!(debug_assertions) {
        // A second worktree runs its dev pair on other ports (vite.config.ts);
        // DOOP_DEV_URL points a dev shell at it. Keep tauri.conf.json's devUrl
        // in step so IPC keeps treating the pages as local.
        option_env!("DOOP_DEV_URL").unwrap_or("http://localhost:4300")
    } else {
        crate::APP_URL
    };
    url.trim_end_matches('/').to_string()
}

/// The server this launch opens, without a trailing slash. Read from disk on
/// the first call (the menu or setup, both before any page loads).
pub fn active(app: &AppHandle) -> &'static str {
    ACTIVE.get_or_init(|| chosen(app).unwrap_or_else(default_url))
}

/// The server this launch opens, for code with no app handle; only valid
/// once the app is running.
pub fn active_url() -> String {
    ACTIVE.get().cloned().unwrap_or_else(default_url)
}

pub fn is_custom(app: &AppHandle) -> bool {
    !same_server(active(app), &default_url())
}

fn config_file(app: &AppHandle) -> Option<PathBuf> {
    let name = if cfg!(debug_assertions) {
        "server-dev.json"
    } else {
        "server.json"
    };
    app.path().app_data_dir().ok().map(|dir| dir.join(name))
}

fn chosen(app: &AppHandle) -> Option<String> {
    let text = std::fs::read_to_string(config_file(app)?).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    normalize(value.get("url")?.as_str()?).ok()
}

fn save(app: &AppHandle, url: Option<&str>) -> Result<(), String> {
    let file = config_file(app).ok_or("Could not find the app's data folder.")?;
    match url {
        None => match std::fs::remove_file(&file) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                Err("Could not reset the server setting.".into())
            }
            _ => Ok(()),
        },
        Some(url) => {
            if let Some(dir) = file.parent() {
                std::fs::create_dir_all(dir)
                    .map_err(|_| "Could not create the app's data folder.")?;
            }
            std::fs::write(&file, json!({ "url": url }).to_string())
                .map_err(|_| "Could not save the server setting.".into())
        }
    }
}

/// A typed address as the origin it names: `doop.example.com`,
/// `https://doop.example.com/c/abc` and `HTTPS://Doop.Example.com/` are all
/// `https://doop.example.com`. Only http(s) with a host and no credentials.
pub fn normalize(input: &str) -> Result<String, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("Enter the address of a Doop server.".into());
    }
    let with_scheme = if input.contains("://") {
        input.to_string()
    } else {
        format!("https://{input}")
    };
    let url = Url::parse(&with_scheme).map_err(|_| format!("“{input}” is not a web address."))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("The address must start with https:// or http://.".into());
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(format!("“{input}” is not a web address."));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("The address must not contain a user name or password.".into());
    }
    Ok(url.origin().ascii_serialization())
}

/// doop.design and www.doop.design are one server.
fn same_server(a: &str, b: &str) -> bool {
    let bare = |url: &str| url.trim_end_matches('/').replacen("://www.", "://", 1);
    bare(a) == bare(b)
}

/// Hosts whose pages stay in the window: the server's, with and without
/// `www.`, and local addresses (the dev server, a local self-host).
pub fn app_hosts(server: &str) -> Vec<String> {
    let mut hosts: Vec<String> = vec!["localhost".into(), "127.0.0.1".into()];
    if let Some(host) = Url::parse(server).ok().as_ref().and_then(Url::host_str) {
        hosts.push(host.to_string());
        hosts.push(match host.strip_prefix("www.") {
            Some(bare) => bare.to_string(),
            None => format!("www.{host}"),
        });
    }
    hosts
}

/// The shell capability, granted to `server` instead of doop.design.
fn capability_for(server: &str) -> Result<String, String> {
    let mut capability: Value =
        serde_json::from_str(CAPABILITY).map_err(|error| error.to_string())?;
    capability["identifier"] = json!("shell-chosen-server");
    capability["description"] =
        json!("capabilities/default.json, for the server picked in the app");
    capability["remote"] = json!({ "urls": [server] });
    Ok(capability.to_string())
}

/// Lets a chosen server's pages use the shell's IPC. The bundled capability
/// already covers the default server (and dev builds' local pages).
pub fn grant(app: &AppHandle) -> Result<(), String> {
    if !is_custom(app) {
        return Ok(());
    }
    let capability = capability_for(active(app))?;
    app.add_capability(capability)
        .map_err(|error| error.to_string())
}

/// Every Doop server answers this public route, so a typo or another site
/// is caught before the app restarts onto it.
async fn probe(server: &str) -> Result<(), String> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let unreachable =
        || format!("No Doop server answered at {server}. Check the address and try again.");
    let client = reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(format!("{server}/api/locale-config"))
        .send()
        .await
        .map_err(|_| unreachable())?;
    if !response.status().is_success() {
        return Err(unreachable());
    }
    let body: Value = response.json().await.map_err(|_| unreachable())?;
    match body.get("defaultLocale") {
        Some(Value::String(_)) => Ok(()),
        _ => Err(unreachable()),
    }
}

/// Windows shows custom labels only with comctl v6 and otherwise answers
/// with plain OK / Cancel, so OK counts as the custom confirm.
fn accepted(choice: &MessageDialogResult, confirm: &str) -> bool {
    match choice {
        MessageDialogResult::Ok => true,
        MessageDialogResult::Custom(label) => label == confirm,
        _ => false,
    }
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

fn display(server: &str) -> String {
    Url::parse(server)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_else(|| server.to_string())
}

/// Asks, saves and restarts; false when the person said no. Going back to
/// the default needs no warning, since the bundled grant already covers it.
async fn switch(app: &AppHandle, server: String) -> Result<bool, String> {
    let to_default = same_server(&server, &default_url());
    let choice = if to_default {
        dialog(
            app,
            &format!("Switch back to {}?", display(&server)),
            "doop will restart and open it.",
        )
        .set_buttons(MessageButtons::OkCancelCustom(SWITCH.into(), CANCEL.into()))
        .show()
        .await
    } else {
        dialog(
            app,
            &format!("Connect doop to {}?", display(&server)),
            &format!(
                "doop will restart and open {server}.\n\nThe server you connect to can use this app's access to your computer: it can run Claude Code here, read fonts you pick and add itself to your Codex and Claude settings. Only connect to a server you trust."
            ),
        )
        .set_level(MessageLevel::Warning)
        .set_buttons(MessageButtons::OkCancelCustom(CONNECT.into(), CANCEL.into()))
        .show()
        .await
    };
    if !accepted(&choice, if to_default { SWITCH } else { CONNECT }) {
        return Ok(false);
    }
    save(app, if to_default { None } else { Some(&server) })?;
    app.request_restart();
    Ok(true)
}

/// The chosen server's launch check: nothing for the default server, which
/// the app menu and the bundled grant already cover, and nothing while the
/// chosen one answers. Otherwise the window shows the webview's error page,
/// so ask until the person goes back to the default or the server answers,
/// and then load `entry` again. Closing the dialog leaves the window as it is.
pub fn check_on_launch(app: &AppHandle, entry: Url) {
    if !is_custom(app) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let server = active(&app);
        let mut failed = false;
        while let Err(error) = probe(server).await {
            failed = true;
            let back = format!("Use {}", display(&default_url()));
            let choice = dialog(&app, &format!("Can’t reach {}", display(server)), &error)
                .set_level(MessageLevel::Warning)
                .set_buttons(MessageButtons::OkCancelCustom(RETRY.into(), back.clone()))
                .show()
                .await;
            match launch_choice(&choice, &back) {
                LaunchChoice::Retry => continue,
                LaunchChoice::Default => {
                    if let Err(error) = save(&app, None) {
                        dialog(&app, "Couldn’t switch servers", &error)
                            .set_level(MessageLevel::Error)
                            .show()
                            .await;
                        return;
                    }
                    app.request_restart();
                    return;
                }
                LaunchChoice::Dismissed => return,
            }
        }
        if failed {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.navigate(entry);
            }
        }
    });
}

#[derive(Debug, PartialEq)]
enum LaunchChoice {
    Retry,
    Default,
    Dismissed,
}

/// Windows without comctl v6 shows plain OK / Cancel: OK is the retry, and
/// Cancel there cannot be told from closing the dialog, so it does nothing.
fn launch_choice(choice: &MessageDialogResult, back: &str) -> LaunchChoice {
    match choice {
        MessageDialogResult::Ok => LaunchChoice::Retry,
        MessageDialogResult::Custom(label) if label == RETRY => LaunchChoice::Retry,
        MessageDialogResult::Custom(label) if label == back => LaunchChoice::Default,
        _ => LaunchChoice::Dismissed,
    }
}

#[tauri::command]
pub fn server_status(app: AppHandle) -> Value {
    json!({
        "url": active(&app),
        "defaultUrl": default_url(),
        "custom": is_custom(&app),
    })
}

/// Point the app at `url` (the default server's address resets the choice).
/// Resolves false when nothing changed: the same server, or a cancel.
#[tauri::command]
pub async fn server_choose(app: AppHandle, url: String) -> Result<bool, String> {
    let server = normalize(&url)?;
    if same_server(&server, active(&app)) {
        return Ok(false);
    }
    if !same_server(&server, &default_url()) {
        probe(&server).await?;
    }
    switch(&app, server).await
}

/// The app menu's way back while another server is chosen, for a server
/// that no longer loads.
#[cfg(target_os = "macos")]
pub mod menu {
    use super::*;
    use tauri::menu::MenuItem;

    pub const MENU_ID: &str = "server-reset";

    /// None while the default server is open.
    pub fn item(app: &AppHandle) -> tauri::Result<Option<MenuItem<crate::ShellRuntime>>> {
        if !is_custom(app) {
            return Ok(None);
        }
        let label = format!("Use {}…", display(&default_url()));
        MenuItem::with_id(app, MENU_ID, label, true, None::<&str>).map(Some)
    }

    pub fn reset(app: &AppHandle) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = switch(&app, default_url()).await {
                dialog(&app, "Couldn’t switch servers", &error)
                    .set_level(MessageLevel::Error)
                    .show()
                    .await;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_typed_addresses_to_origins() {
        assert_eq!(
            normalize("doop.example.com").unwrap(),
            "https://doop.example.com"
        );
        assert_eq!(
            normalize(" HTTPS://Doop.Example.com/c/abc?x=1#y ").unwrap(),
            "https://doop.example.com"
        );
        assert_eq!(
            normalize("http://localhost:4400/").unwrap(),
            "http://localhost:4400"
        );
        assert_eq!(
            normalize("https://doop.example.com:443").unwrap(),
            "https://doop.example.com"
        );
    }

    #[test]
    fn refuses_what_is_not_a_web_server() {
        assert!(normalize("").is_err());
        assert!(normalize("file:///etc/passwd").is_err());
        assert!(normalize("javascript://alert(1)").is_err());
        assert!(normalize("https://user:pass@doop.example.com").is_err());
        assert!(normalize("https://").is_err());
    }

    #[test]
    fn www_and_bare_hosts_are_one_server() {
        assert!(same_server(
            "https://www.doop.design",
            "https://doop.design/"
        ));
        assert!(!same_server(
            "https://doop.example.com",
            "https://doop.design"
        ));
    }

    #[test]
    fn keeps_the_chosen_hosts_in_the_window() {
        let hosts = app_hosts("https://doop.example.com");
        assert!(hosts.contains(&"doop.example.com".to_string()));
        assert!(hosts.contains(&"www.doop.example.com".to_string()));
        assert!(hosts.contains(&"localhost".to_string()));
        assert!(!hosts.contains(&"doop.design".to_string()));
    }

    #[test]
    fn grants_the_bundled_permissions_to_the_chosen_origin() {
        let capability: Value =
            serde_json::from_str(&capability_for("https://doop.example.com").unwrap()).unwrap();
        let bundled: Value = serde_json::from_str(CAPABILITY).unwrap();
        assert_eq!(
            capability["remote"]["urls"],
            json!(["https://doop.example.com"])
        );
        assert_eq!(capability["permissions"], bundled["permissions"]);
        assert_eq!(capability["windows"], bundled["windows"]);
        assert_ne!(capability["identifier"], bundled["identifier"]);
        // the runtime accepts it as a capability file
        assert!(capability_for("https://doop.example.com")
            .unwrap()
            .parse::<tauri::utils::acl::capability::CapabilityFile>()
            .is_ok());
    }

    #[test]
    fn reads_the_launch_dialog_by_its_buttons() {
        let back = "Use doop.design";
        let custom = |label: &str| MessageDialogResult::Custom(label.into());
        assert_eq!(launch_choice(&custom(RETRY), back), LaunchChoice::Retry);
        assert_eq!(
            launch_choice(&MessageDialogResult::Ok, back),
            LaunchChoice::Retry
        );
        assert_eq!(launch_choice(&custom(back), back), LaunchChoice::Default);
        assert_eq!(
            launch_choice(&MessageDialogResult::Cancel, back),
            LaunchChoice::Dismissed
        );
    }

    #[test]
    fn restarts_only_on_the_confirm_button() {
        assert!(accepted(
            &MessageDialogResult::Custom(CONNECT.into()),
            CONNECT
        ));
        assert!(accepted(&MessageDialogResult::Ok, CONNECT));
        assert!(!accepted(
            &MessageDialogResult::Custom(CANCEL.into()),
            CONNECT
        ));
        assert!(!accepted(&MessageDialogResult::Cancel, CONNECT));
    }
}
