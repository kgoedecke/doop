// doop desktop shell: a single webview over the hosted app. The window is
// built in code (not tauri.conf.json) because the navigation handler below
// needs the app handle. It opens on /auth, not /: someone launching the
// installed app never wants the marketing landing page — /auth shows the
// sign-in form when logged out and renders Home once a session exists.
//
// The title bar is an overlay (macOS): the web app draws a Figma-style tab
// strip at the top of the page (src/components/DesktopTabs.tsx) and leaves
// room for the traffic lights. Tabs are purely a web-app concept — the shell
// only marks the page as desktop; opening links in the system browser goes
// through the opener plugin, granted in capabilities/default.json.
//
// Because tabs live in the page, the macOS menu is built here rather than
// taken from Tauri's default: that one binds Cmd+W to "Close Window", which
// on a single-window app closes the whole app. Ours binds Cmd+W to "Close
// Tab" and hands the keystroke to the page as a `close-tab` event
// (src/lib/desktop.ts closes the active canvas tab).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "macos")]
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
#[cfg(target_os = "macos")]
use tauri::{AppHandle, Emitter};
use tauri::{Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

/// The hosted app this shell wraps. Self-hosters can point release builds at
/// their own instance without patching the source:
///   DOOP_APP_URL=https://doop.example.com npm run build
/// (When overriding, also put the origin in capabilities/default.json or the
/// page cannot reach the shell's IPC — external links then open in-window.)
const APP_URL: &str = match option_env!("DOOP_APP_URL") {
    Some(url) => url,
    None => "https://doop.design",
};

fn base_url() -> String {
    if cfg!(debug_assertions) {
        // A second worktree runs its dev pair on other ports (vite.config.ts);
        // DOOP_DEV_URL points a dev shell at it. Keep tauri.conf.json's devUrl
        // in step so IPC keeps treating the pages as local.
        option_env!("DOOP_DEV_URL")
            .unwrap_or("http://localhost:4300")
            .trim_end_matches('/')
            .to_string()
    } else {
        APP_URL.trim_end_matches('/').to_string()
    }
}

/// Where the traffic lights sit: on the tab strip's content line. The strip
/// is 40px and tab content centres 21px from the top (DesktopTabs.tsx keeps
/// its buttons and labels on that line); the ~14px buttons start at 21 - 7.
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHTS: (f64, f64) = (13.0, 21.0);

/// AppKit re-lays the traffic lights out whenever the window resizes,
/// changes focus or theme, dropping the position set at build time — so the
/// shell puts them back after every such event.
#[cfg(target_os = "macos")]
fn place_traffic_lights(ns_window_ptr: *mut std::ffi::c_void) {
    use objc2_app_kit::{NSWindow, NSWindowButton};

    // SAFETY: Tauri hands out a live NSWindow pointer, and window events are
    // delivered on the main thread — the only place AppKit may be touched.
    unsafe {
        let ns_window = &*ns_window_ptr.cast::<NSWindow>();
        let (Some(close), Some(mini), Some(zoom)) = (
            ns_window.standardWindowButton(NSWindowButton::CloseButton),
            ns_window.standardWindowButton(NSWindowButton::MiniaturizeButton),
            ns_window.standardWindowButton(NSWindowButton::ZoomButton),
        ) else {
            return;
        };
        let (Some(container), Some(content)) = (
            close.superview().and_then(|v| v.superview()),
            ns_window.contentView(),
        ) else {
            return;
        };
        // The buttons live in a title-bar container view anchored to the top;
        // grow it so the buttons can sit lower, then move each button.
        let button = close.frame();
        let bar_height = button.size.height + TRAFFIC_LIGHTS.1;
        let mut container_rect = container.frame();
        container_rect.origin.y = content.frame().size.height - bar_height;
        container_rect.size.height = bar_height;
        container.setFrame(container_rect);
        let gap = mini.frame().origin.x - button.origin.x;
        for (i, b) in [close, mini, zoom].into_iter().enumerate() {
            let mut origin = b.frame().origin;
            origin.x = TRAFFIC_LIGHTS.0 + i as f64 * gap;
            b.setFrameOrigin(origin);
        }
    }
}

/// Menu item id for Cmd+W; the page listens for the event of the same name.
#[cfg(target_os = "macos")]
const CLOSE_TAB: &str = "close-tab";

/// Tauri's default macOS menu minus "Close Window" (Cmd+W), which is replaced
/// by "Close Tab" in the File menu. Everything else stays: the app menu
/// (About/Services/Hide/Quit), Edit (the predefined items are what make
/// Cmd+C/V/Z reach the webview at all), View and Window.
#[cfg(target_os = "macos")]
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let pkg = app.package_info();
    let about = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        ..Default::default()
    };
    let app_menu = Submenu::with_items(
        app,
        pkg.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[&MenuItem::with_id(app, CLOSE_TAB, "Close Tab", true, Some("Cmd+W"))?],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(app, "View", true, &[&PredefinedMenuItem::fullscreen(app, None)?])?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window])
}

fn main() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());
    #[cfg(target_os = "macos")]
    let builder = builder.menu(build_menu).on_menu_event(|app, event| {
        if event.id() == CLOSE_TAB {
            let _ = app.emit(CLOSE_TAB, ());
        }
    });
    builder
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if matches!(
                event,
                tauri::WindowEvent::Resized(_)
                    | tauri::WindowEvent::Focused(_)
                    | tauri::WindowEvent::ThemeChanged(_)
                    | tauri::WindowEvent::ScaleFactorChanged { .. }
            ) {
                if let Ok(ns_window) = window.ns_window() {
                    place_traffic_lights(ns_window);
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (window, event);
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let entry = format!("{}/auth", base_url());
            // Hosts that stay inside the shell; any other http(s) target opens
            // in the system browser. Hostless schemes (about:, blob:) stay in —
            // sandboxed frame content depends on them.
            let mut app_hosts: Vec<String> =
                vec!["localhost".into(), "127.0.0.1".into()];
            if let Some(host) = Url::parse(APP_URL)?.host_str() {
                app_hosts.push(host.to_string());
                app_hosts.push(match host.strip_prefix("www.") {
                    Some(bare) => bare.to_string(),
                    None => format!("www.{host}"),
                });
            }
            // Marks every page loaded in the shell so the app can tell desktop
            // sessions from browser ones (src/lib/shell.ts) and render the
            // tab strip; the version lets the app adapt to shell capabilities
            // (traffic-light inset arrived with the overlay title bar, 0.1.2)
            // and the platform tells it which window framing it lives under.
            let desktop_marker = format!(
                "window.__DOOP_DESKTOP__ = '{}'; window.__DOOP_DESKTOP_PLATFORM__ = '{}';",
                app.package_info().version,
                std::env::consts::OS
            );
            let builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::External(entry.parse()?))
                    .initialization_script(&desktop_marker)
                    .title("doop")
                    .inner_size(1440.0, 900.0)
                    .min_inner_size(900.0, 600.0)
                    .on_navigation(move |url| {
                        let in_app = match url.host_str() {
                            Some(host) => app_hosts.iter().any(|h| h == host),
                            None => true,
                        };
                        if !in_app {
                            let _ = handle.opener().open_url(url.as_str(), None::<String>);
                        }
                        in_app
                    });
            #[cfg(target_os = "macos")]
            let builder = builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true);
            let _webview_window = builder.build()?;
            #[cfg(target_os = "macos")]
            if let Ok(ns_window) = _webview_window.ns_window() {
                place_traffic_lights(ns_window);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to start doop");
}
