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
//
// Sign-in with Google / Microsoft / SSO cannot happen in the webview —
// identity providers refuse embedded browsers — so the page opens the
// provider in the system browser and the finished sign-in comes back as a
// doop://auth?token=… link (src/lib/desktopAuth.ts). The deep-link plugin
// registers the scheme (tauri.conf.json) and forwards each URL to the page
// as a `deep-link://new-url` event; the shell only brings its window to the
// front so the person sees the result of the click.
//
// Downloads (the Inspector's PNG/JPG export links, served with
// Content-Disposition: attachment) need a download handler: without one
// WKWebView treats the response as a navigation and shows the image in the
// window instead of saving it. The shell asks where to save with a native
// save panel (rfd, synchronous: the download callback already runs on the
// UI thread, and tauri-plugin-dialog's blocking variant would wait on that
// same thread) seeded with wry's default of ~/Downloads/<server filename>,
// then reveals the finished file in Finder / Explorer, since the webview
// has no download bar of its own.
//
// The same sources also build the Chromium shell (../src-tauri-chromium, Tauri
// 3's CEF runtime), which is the macOS app: WebKit runs every sandboxed frame
// iframe in the editor's own process, Chromium runs them out of process. Its
// differences are the `cfg(chromium)` blocks, set by build.rs when the CEF
// runtime is linked.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "macos")]
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
#[cfg(target_os = "macos")]
use tauri::Emitter;
#[cfg(target_os = "linux")]
mod appimage;
mod claude;
mod claude_extension;
mod codex;
mod fonts;
mod updates;
mod view_menu;
#[cfg(all(chromium, target_os = "macos"))]
mod webkit_migration;

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::webview::{DownloadEvent, PageLoadEvent};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;

/// The runtime the shell's menu items are typed over: Tauri 2's system
/// webview, or Tauri 3's type-erased runtime, which carries CEF.
#[cfg(not(chromium))]
type ShellRuntime = tauri::Wry;
#[cfg(chromium)]
type ShellRuntime = tauri::DynRuntime;

/// Bring the (only) window forward: after a doop:// link, or when a second
/// instance was launched to deliver one.
fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

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
/// (with Check for Updates added below About), Edit (the predefined items
/// are what make Cmd+C/V/Z reach the webview at all), View (the canvas's
/// view toggles and zoom, src/view_menu.rs) and Window.
#[cfg(target_os = "macos")]
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<ShellRuntime>> {
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
            &updates::menu::item(app)?,
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
        &[&MenuItem::with_id(
            app,
            CLOSE_TAB,
            "Close Tab",
            true,
            Some("Cmd+W"),
        )?],
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
    let view = view_menu::submenu(app)?;
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

/// The Chromium shell's runtime settings. Session cookies outlive a restart
/// (CEF drops them on exit by default), so quitting never signs anyone out.
/// The profile lives in the app's data directory rather than CEF's default
/// under Caches, which cache cleaners and low-disk purges empty; debug builds
/// keep their own, since they encrypt cookies with a mock keychain a release
/// build cannot read (and the reverse). A debug build opens Chrome's remote
/// debugging on the port named by DOOP_CEF_DEBUG_PORT (chrome://inspect, or a
/// CDP client), which is how the frames' renderer processes are inspected;
/// release builds never listen.
#[cfg(chromium)]
fn chromium_runtime() -> tauri_runtime_cef::Cef {
    let mut cef = tauri_runtime_cef::Cef::default().persist_session_cookies(true);
    if let Some(profile) = chromium_profile_dir() {
        cef = cef.root_cache_path(profile);
    }
    let port = std::env::var("DOOP_CEF_DEBUG_PORT")
        .ok()
        .and_then(|port| port.parse().ok())
        .filter(|_| cfg!(debug_assertions));
    match port {
        Some(port) => cef.remote_debugging(tauri_runtime_cef::RemoteDebugging::Port {
            port,
            allowed_origins: Vec::new(),
        }),
        None => cef,
    }
}

/// Application Support/<identifier>/cef, worked out by hand: the runtime is
/// configured before the app (and its path resolver) exists. Keep the
/// identifier in step with both tauri.conf.json files.
#[cfg(chromium)]
fn chromium_profile_dir() -> Option<PathBuf> {
    const IDENTIFIER: &str = "design.doop.desktop";
    let home = std::env::var_os("HOME")?;
    let profile = if cfg!(debug_assertions) {
        "cef-dev"
    } else {
        "cef"
    };
    Some(
        PathBuf::from(home)
            .join("Library/Application Support")
            .join(IDENTIFIER)
            .join(profile),
    )
}

// CEF starts its renderer, GPU and utility processes from this same binary;
// the entry point hands those to Chromium before any of main() runs.
#[cfg_attr(chromium, tauri_runtime_cef::cef_entry_point)]
fn main() {
    let builder = tauri::Builder::default();
    #[cfg(chromium)]
    let builder = builder.runtime(chromium_runtime());
    // single-instance must be the first plugin so a second launch is caught
    // before anything else initialises; it hands the launch's URL args to
    // the deep-link plugin through the `deep-link` feature.
    let builder = builder
        .manage(claude::ClaudeState::default())
        .manage(fonts::LocalFonts::default())
        .invoke_handler(tauri::generate_handler![
            claude::claude_status,
            claude::claude_connect,
            claude::claude_login,
            claude::claude_install,
            claude::claude_choose_cli,
            claude::claude_reset_cli,
            claude::claude_run,
            claude::claude_stop,
            claude_extension::claude_add_extension,
            codex::codex_add_mcp,
            fonts::fonts_choose_local,
            fonts::fonts_read_local,
            view_menu::view_menu_state,
            updates::update_card_ready,
            updates::update_restart
        ])
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_main_window(app)
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build());
    #[cfg(target_os = "macos")]
    let builder = builder.menu(build_menu).on_menu_event(|app, event| {
        if event.id() == CLOSE_TAB {
            let _ = app.emit(CLOSE_TAB, ());
        } else if event.id() == updates::menu::MENU_ID {
            updates::menu::check(app);
        } else {
            view_menu::relay(app, event.id().as_ref());
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
            // macOS registers doop:// from the bundle's Info.plist, so it
            // only works installed; Windows and Linux can register at
            // runtime, which also makes `tauri dev` receive links.
            #[cfg(any(windows, target_os = "linux"))]
            app.deep_link().register_all()?;
            #[cfg(target_os = "linux")]
            appimage::integrate(app.handle());
            let focus_handle = app.handle().clone();
            app.deep_link().on_open_url(move |_event| focus_main_window(&focus_handle));
            updates::start(app.handle());

            let handle = app.handle().clone();
            let entry = format!("{}/auth", base_url());
            // The first Chromium launch after the WebKit app opens hidden on
            // the app's origin and brings the WebKit storage over before the
            // app loads (src/webkit_migration.rs).
            #[cfg(all(chromium, target_os = "macos"))]
            let migrating = webkit_migration::pending();
            #[cfg(not(all(chromium, target_os = "macos")))]
            let migrating = false;
            let first_url: Url = if migrating {
                #[cfg(all(chromium, target_os = "macos"))]
                {
                    let origin = Url::parse(&base_url())?;
                    webkit_migration::start(app.handle(), origin.clone(), entry.parse()?);
                    webkit_migration::landing(&origin)
                }
                #[cfg(not(all(chromium, target_os = "macos")))]
                unreachable!()
            } else {
                entry.parse()?
            };
            // Hosts that stay inside the shell; any other http(s) target opens
            // in the system browser. Hostless web schemes (about:, blob:) stay
            // in — sandboxed frame content depends on them — but mailto: and
            // tel: are hostless too and WKWebView drops them silently, so they
            // go to the system handler (Mail) instead.
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
                "window.__DOOP_DESKTOP__ = '{}'; window.__DOOP_DESKTOP_PLATFORM__ = '{}'; window.__DOOP_CLAUDE_CLI__ = true; window.__DOOP_CLAUDE_INSTALL__ = true; window.__DOOP_CLAUDE_CHOOSE__ = true; window.__DOOP_CLAUDE_EXTENSION__ = {}; window.__DOOP_CODEX_SETUP__ = true; window.__DOOP_VIEW_MENU__ = true; window.__DOOP_LOCAL_FONTS__ = true; window.__DOOP_UPDATE_CARD__ = true;",
                app.package_info().version,
                std::env::consts::OS,
                cfg!(any(target_os = "macos", target_os = "windows"))
            );
            // macOS never reports the saved path on `Finished`, so remember
            // the destinations chosen on `Requested`, keyed by URL. The same
            // URL can be in flight more than once (double-clicking Download),
            // so each key holds a queue: wry gives every request its own
            // deduplicated filename and completions arrive in request order.
            let download_handle = app.handle().clone();
            let downloads: Mutex<HashMap<String, VecDeque<PathBuf>>> =
                Mutex::new(HashMap::new());
            let builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::External(first_url))
                    .initialization_script(&desktop_marker)
                    .on_download(move |_webview, event| {
                        match event {
                            DownloadEvent::Requested { url, destination } => {
                                let mut picker = rfd::FileDialog::new().set_title("Save export");
                                // wry suggests ~/Downloads/<name>, CEF the bare
                                // name; both panels open in Downloads.
                                let dir = destination
                                    .parent()
                                    .filter(|dir| !dir.as_os_str().is_empty())
                                    .map(PathBuf::from)
                                    .or_else(|| download_handle.path().download_dir().ok());
                                if let Some(dir) = dir {
                                    picker = picker.set_directory(dir);
                                }
                                if let Some(name) = destination.file_name().and_then(|n| n.to_str()) {
                                    picker = picker.set_file_name(name);
                                }
                                if let Some(ext) = destination.extension().and_then(|e| e.to_str()) {
                                    picker = picker.add_filter(ext.to_uppercase(), &[ext]);
                                }
                                // Cancelling the panel cancels the download.
                                let Some(chosen) = picker.save_file() else {
                                    return false;
                                };
                                *destination = chosen;
                                if let Ok(mut map) = downloads.lock() {
                                    map.entry(url.to_string())
                                        .or_default()
                                        .push_back(destination.clone());
                                }
                            }
                            DownloadEvent::Finished { url, path, success } => {
                                let remembered = downloads.lock().ok().and_then(|mut map| {
                                    let queue = map.get_mut(url.as_str())?;
                                    let front = queue.pop_front();
                                    if queue.is_empty() {
                                        map.remove(url.as_str());
                                    }
                                    front
                                });
                                if success {
                                    if let Some(saved) = path.or(remembered) {
                                        let _ = download_handle.opener().reveal_item_in_dir(saved);
                                    }
                                }
                            }
                            _ => {}
                        }
                        true
                    })
                    .on_page_load(move |window, payload| {
                        if payload.event() == PageLoadEvent::Started {
                            updates::page_loading(window.app_handle());
                        }
                        #[cfg(all(chromium, target_os = "macos"))]
                        if migrating {
                            let on_landing = payload.url().path() == webkit_migration::LANDING_PATH;
                            match payload.event() {
                                PageLoadEvent::Finished if on_landing => webkit_migration::landed(window),
                                PageLoadEvent::Started if !on_landing => {
                                    let _ = window.show();
                                }
                                _ => {}
                            }
                        }
                    })
                    .title("doop")
                    .visible(!migrating)
                    .inner_size(1440.0, 900.0)
                    .min_inner_size(900.0, 600.0)
                    .on_navigation(move |url| {
                        let in_app = match (url.scheme(), url.host_str()) {
                            ("mailto" | "tel", _) => false,
                            (_, Some(host)) => app_hosts.iter().any(|h| h == host),
                            (_, None) => true,
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
        .build(tauri::generate_context!())
        .expect("failed to start doop")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                claude::shutdown(&app.state::<claude::ClaudeState>());
                updates::install_on_quit(app);
            }
        });
}
