//! Self-update through tauri-plugin-updater. Official release builds read the
//! signed feed named in tauri.conf.json (`plugins.updater`) shortly after
//! launch and then once a day, download a newer shell in the background and
//! offer to restart into it. On macOS the app menu's Check for Updates… runs
//! the same check on demand and reports every outcome; background checks
//! stay silent unless an update is ready.
//!
//! The feed (latest.json, written by desktop-release.yml) and every package
//! it names are signed with the key whose public half is in tauri.conf.json;
//! the plugin refuses a package whose signature does not verify.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use rfd::{AsyncMessageDialog, MessageButtons, MessageDialogResult, MessageLevel};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const FIRST_CHECK: Duration = Duration::from_secs(15);
const CHECK_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
const RESTART: &str = "Restart Now";
const LATER: &str = "Later";

#[derive(Default)]
pub struct UpdateState {
    /// One check (and its dialog) at a time, whoever started it.
    busy: AtomicBool,
    /// A verified download the person put off. A later check offers it again
    /// without downloading, and on macOS it is installed on quit.
    ready: Mutex<Option<(Update, Vec<u8>)>>,
}

#[derive(Clone, Copy, PartialEq)]
enum Trigger {
    Background,
    Manual,
}

/// Official installers point at doop.design. Replacing a self-hosted shell
/// with one would silently change its server, and a debug build would be
/// replaced by a release.
fn updates_enabled() -> bool {
    !cfg!(debug_assertions)
        && matches!(
            crate::APP_URL.trim_end_matches('/'),
            "https://doop.design" | "https://www.doop.design"
        )
}

pub fn start(app: &AppHandle) {
    app.manage(UpdateState::default());
    if !updates_enabled() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            run(&app, Trigger::Background).await;
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

/// Runs on exit: a download put off with Later replaces the app bundle now,
/// so the next launch is the new version. Windows installs by running the
/// installer, which relaunches the app, so it waits for the next prompt.
pub fn install_on_quit(app: &AppHandle) {
    if !cfg!(target_os = "macos") {
        return;
    }
    let Some(state) = app.try_state::<UpdateState>() else {
        return;
    };
    let ready = state.ready.lock().ok().and_then(|mut ready| ready.take());
    if let Some((update, bytes)) = ready {
        if let Err(error) = update.install(&bytes) {
            eprintln!("Installing doop {} on quit failed: {error}", update.version);
        }
    }
}

async fn run(app: &AppHandle, trigger: Trigger) {
    let state = app.state::<UpdateState>();
    if state.busy.swap(true, Ordering::AcqRel) {
        return;
    }
    #[cfg(target_os = "macos")]
    menu::checking(app, true);
    match ready_update(app).await {
        Ok(Some((update, bytes))) => offer(app, update, bytes).await,
        Ok(None) if trigger == Trigger::Manual => {
            let current = &app.package_info().version;
            dialog(
                app,
                "You’re up to date",
                &format!("doop {current} is up to date."),
            )
            .show()
            .await;
        }
        Ok(None) => {}
        Err(error) => {
            eprintln!("Desktop update check failed: {error}");
            if trigger == Trigger::Manual {
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
    #[cfg(target_os = "macos")]
    menu::checking(app, false);
    state.busy.store(false, Ordering::Release);
}

/// The newest release, downloaded and verified, or None when this is it.
async fn ready_update(app: &AppHandle) -> Result<Option<(Update, Vec<u8>)>, String> {
    let handle = app.clone();
    let updater = app
        .updater_builder()
        // Windows: the installer is launched and the process exits at once.
        .on_before_exit(move || {
            crate::claude::shutdown(&handle.state::<crate::claude::ClaudeState>())
        })
        .build()
        .map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let kept = app
        .state::<UpdateState>()
        .ready
        .lock()
        .ok()
        .and_then(|mut ready| ready.take_if(|(kept, _)| kept.version == update.version));
    if let Some(kept) = kept {
        return Ok(Some(kept));
    }
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    Ok(Some((update, bytes)))
}

async fn offer(app: &AppHandle, update: Update, bytes: Vec<u8>) {
    let later = if cfg!(target_os = "macos") {
        "\n\nChoose Later to install it when you quit doop."
    } else {
        ""
    };
    let choice = dialog(
        app,
        "A new version of doop is ready",
        &format!(
            "doop {} is ready to install. You have {}.\n\nRestarting stops an agent run in progress.{later}",
            update.version,
            app.package_info().version
        ),
    )
    .set_buttons(MessageButtons::OkCancelCustom(RESTART.into(), LATER.into()))
    .show()
    .await;
    if !accepted(&choice) {
        if let Ok(mut ready) = app.state::<UpdateState>().ready.lock() {
            *ready = Some((update, bytes));
        }
        return;
    }
    crate::claude::shutdown(&app.state::<crate::claude::ClaudeState>());
    // Windows does not return from a successful install: the plugin starts
    // the installer, which relaunches the app, and exits.
    match update.install(&bytes) {
        Ok(()) => app.restart(),
        Err(error) => {
            eprintln!("Installing doop {} failed: {error}", update.version);
            dialog(
                app,
                "Couldn’t install the update",
                "Download the latest doop from doop.design and install it over this version.",
            )
            .set_level(MessageLevel::Error)
            .show()
            .await;
        }
    }
}

/// Windows shows custom labels only with comctl v6 and otherwise answers
/// with plain OK / Cancel, so OK counts as the custom confirm.
fn accepted(choice: &MessageDialogResult) -> bool {
    match choice {
        MessageDialogResult::Ok => true,
        MessageDialogResult::Custom(label) => label == RESTART,
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

/// The macOS app menu's Check for Updates… item. Windows has no menu bar
/// (the page draws its own tab strip), so it relies on the scheduled checks.
#[cfg(target_os = "macos")]
pub mod menu {
    use super::*;
    use tauri::menu::MenuItem;

    pub const MENU_ID: &str = "check-for-updates";
    const LABEL: &str = "Check for Updates…";

    struct UpdateMenu(MenuItem<tauri::Wry>);

    pub fn item(app: &AppHandle) -> tauri::Result<MenuItem<tauri::Wry>> {
        let item = MenuItem::with_id(app, MENU_ID, LABEL, true, None::<&str>)?;
        app.manage(UpdateMenu(item.clone()));
        Ok(item)
    }

    /// Menu events run on the UI thread; the item stays disabled from the
    /// click through the result dialog so checks cannot stack.
    pub fn check(app: &AppHandle) {
        if !updates_enabled() {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                dialog(
                    &app,
                    "Custom desktop build",
                    "This app connects to a custom Doop server or is a development build. Contact whoever provided this app for an updated desktop build.",
                )
                .show()
                .await;
            });
            return;
        }
        checking(app, true);
        let app = app.clone();
        tauri::async_runtime::spawn(async move { run(&app, Trigger::Manual).await });
    }

    pub(super) fn checking(app: &AppHandle, busy: bool) {
        if let Some(menu) = app.try_state::<UpdateMenu>() {
            let _ = menu.0.set_enabled(!busy);
            let _ = menu.0.set_text(if busy {
                "Checking for Updates…"
            } else {
                LABEL
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restarts_only_on_the_confirm_button() {
        assert!(accepted(&MessageDialogResult::Custom(RESTART.into())));
        assert!(accepted(&MessageDialogResult::Ok));
        assert!(!accepted(&MessageDialogResult::Custom(LATER.into())));
        assert!(!accepted(&MessageDialogResult::Cancel));
    }

    #[test]
    fn debug_builds_never_update() {
        assert!(!updates_enabled());
    }
}
