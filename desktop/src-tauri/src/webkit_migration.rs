//! The one-time move from the WebKit shell's storage to Chromium's, so the
//! update that replaces the WebKit app with the Chromium one keeps people
//! signed in and keeps what the page remembered (theme, panel layout, the
//! agent pick, onboarding).
//!
//! Both shells are the same bundle (design.doop.desktop), so this process's
//! default WKWebsiteDataStore is the WebKit shell's store. Its cookies come
//! from WKHTTPCookieStore; its localStorage has no API, so a hidden WKWebView
//! loads a blank document at the app's origin and reads it there. Nothing is
//! written to the WebKit store.
//!
//! The window first opens hidden on the app's /favicon.ico (same origin, no
//! scripts). The cookies go straight into the webview's Chromium cookie
//! manager, with the expiry and SameSite WebKit had (Tauri's set_cookie drops
//! both, and Chromium does not keep a cookie without an expiry across a
//! restart), and are flushed to disk; the localStorage entries are written in
//! that document; then the window goes to the app, showing itself as it does.
//! A marker file in the Chromium profile it filled makes this a first-launch
//! step (a debug build's cef-dev profile has its own). A read that fails or
//! outlasts READ_TIMEOUT only costs a sign-in; a landing document that never
//! loads (offline) gives up after LANDING_TIMEOUT and opens the app without
//! migrating, and the next launch tries again.
use std::cell::RefCell;
use std::path::PathBuf;
use std::ptr::NonNull;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use block2::RcBlock;
use cef::{ImplBrowser, ImplBrowserHost, ImplCookieManager, ImplRequestContext};
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::MainThreadMarker;
use objc2_foundation::{
    NSArray, NSError, NSHTTPCookie, NSHTTPCookieSameSiteLax, NSHTTPCookieSameSiteStrict, NSString,
    NSURL,
};
use objc2_web_kit::{WKWebView, WKWebViewConfiguration, WKWebsiteDataStore};
use tauri::{AppHandle, Manager, Url, WebviewWindow};

/// The document the window waits on: the app's origin, no scripts.
pub const LANDING_PATH: &str = "/favicon.ico";
const MARKER: &str = "webkit-migrated";
const READ_TIMEOUT: Duration = Duration::from_secs(5);
/// How long the hidden window waits for the landing document before it
/// shows the app without migrating.
const LANDING_TIMEOUT: Duration = Duration::from_secs(15);
const POLL: Duration = Duration::from_millis(100);
/// How long Chromium gets to report the migrated cookies before the app loads
/// anyway (setting them is fire-and-forget).
const COOKIE_WAIT: Duration = Duration::from_secs(2);

/// Seconds from the Windows epoch (1601), where Chromium's time starts, to
/// the Unix one.
const WINDOWS_TO_UNIX_EPOCH_SECS: f64 = 11_644_473_600.0;

#[derive(Clone, Copy, Debug, PartialEq)]
enum SameSite {
    Unspecified,
    Lax,
    Strict,
}

/// A WebKit cookie for the app's host, as Chromium should hold it.
#[derive(Clone, Debug, PartialEq)]
struct MigratedCookie {
    name: String,
    value: String,
    /// Set for a domain cookie (".doop.design"); none keeps it host-only,
    /// which `__Host-` cookies need.
    domain: Option<String>,
    path: String,
    secure: bool,
    http_only: bool,
    /// Unix seconds; none for a session cookie.
    expires: Option<f64>,
    same_site: SameSite,
}

/// What the WebKit shell kept for the app's origin.
#[derive(Default)]
struct WebKitData {
    cookies: Vec<MigratedCookie>,
    storage: Vec<(String, String)>,
}

#[derive(Default)]
struct Read {
    cookies: Option<Vec<MigratedCookie>>,
    storage: Option<Vec<(String, String)>>,
}

#[derive(Default)]
struct Progress {
    data: Option<WebKitData>,
    landed: Option<WebviewWindow<crate::ShellRuntime>>,
    applied: bool,
}

/// Managed state while the first launch moves storage over.
pub struct Migration {
    origin: Url,
    entry: Url,
    progress: Mutex<Progress>,
}

/// The marker sits in the profile it describes, so a debug build's
/// migration into cef-dev leaves the release profile's own still to come.
fn marker() -> Option<PathBuf> {
    crate::chromium_profile_dir().map(|profile| profile.join(MARKER))
}

/// True until the move has run once into this build's profile.
pub fn pending() -> bool {
    marker().is_some_and(|marker| !marker.exists())
}

/// The URL the window opens on while migrating.
pub fn landing(origin: &Url) -> Url {
    let mut url = origin.clone();
    url.set_path(LANDING_PATH);
    url
}

/// Starts reading the WebKit store. Call on the main thread, in setup,
/// before the window is built hidden on `landing(origin)`.
pub fn start(app: &AppHandle, origin: Url, entry: Url) {
    app.manage(Migration {
        origin: origin.clone(),
        entry,
        progress: Mutex::new(Progress::default()),
    });
    let handle = app.clone();
    read_webkit(app, &origin, move |data| {
        eprintln!(
            "WebKit migration: {} cookies, {} localStorage entries",
            data.cookies.len(),
            data.storage.len()
        );
        let state = handle.state::<Migration>();
        if let Ok(mut progress) = state.progress.lock() {
            progress.data = Some(data);
        }
        apply_when_ready(&handle);
    });
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(LANDING_TIMEOUT);
        give_up(&handle);
    });
}

/// The landing document never loaded (offline, a server error): show the
/// app without migrating, leaving the marker for the next launch to retry.
fn give_up(app: &AppHandle) {
    let state = app.state::<Migration>();
    {
        let Ok(mut progress) = state.progress.lock() else {
            return;
        };
        if progress.applied {
            return;
        }
        progress.applied = true;
    }
    eprintln!("WebKit migration: the landing page did not load; opening the app without it");
    let entry = state.entry.clone();
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window("main") else {
            eprintln!("WebKit migration: no main window to show");
            return;
        };
        if let Err(error) = window.show() {
            eprintln!("WebKit migration: could not show the window: {error}");
        }
        let _ = window.navigate(entry);
    });
}

/// The window has finished loading the landing document.
pub fn landed(window: WebviewWindow<crate::ShellRuntime>) {
    let app = window.app_handle().clone();
    let Some(state) = app.try_state::<Migration>() else {
        return;
    };
    if let Ok(mut progress) = state.progress.lock() {
        progress.landed = Some(window);
    }
    apply_when_ready(&app);
}

/// Hands the data to Chromium once it is read and the window is on the
/// app's origin, whichever comes last.
fn apply_when_ready(app: &AppHandle) {
    let state = app.state::<Migration>();
    let (window, data) = {
        let Ok(mut progress) = state.progress.lock() else {
            return;
        };
        if progress.applied || progress.landed.is_none() || progress.data.is_none() {
            return;
        }
        progress.applied = true;
        (
            progress.landed.take().unwrap(),
            progress.data.take().unwrap(),
        )
    };
    let origin = state.origin.clone();
    set_cookies(&window, &origin, data.cookies.clone());
    let entry = state.entry.clone();
    // cookies_for_url waits on the main thread, so the wait runs off it
    std::thread::spawn(move || {
        wait_for_cookies(&window, &origin, &data.cookies);
        // marked before the hand-over: a crash in between costs a sign-in,
        // never a second migration over what Chromium has since stored
        if let Some(marker) = marker() {
            if let Some(profile) = marker.parent() {
                let _ = std::fs::create_dir_all(profile);
            }
            let _ = std::fs::write(marker, b"");
        }
        let _ = window.eval(restore_script(&data.storage, &entry));
        // the script navigates itself; this only rescues a script that never ran
        std::thread::sleep(Duration::from_secs(3));
        if window.url().is_ok_and(|url| url.path() == LANDING_PATH) {
            let _ = window.navigate(entry);
        }
    });
}

/// Writes the cookies into the webview's own Chromium cookie manager, then
/// flushes it, so even a quit right after the first launch keeps them.
fn set_cookies(
    window: &WebviewWindow<crate::ShellRuntime>,
    origin: &Url,
    cookies: Vec<MigratedCookie>,
) {
    if cookies.is_empty() {
        return;
    }
    let url = origin.to_string();
    let _ = window.with_webview(move |webview| {
        let url = cef::CefString::from(url.as_str());
        let Some(manager) = webview
            .downcast_ref::<tauri_runtime_cef::Webview>()
            .and_then(|webview| webview.browser().host())
            .and_then(|host| host.request_context())
            .and_then(|context| context.cookie_manager(None))
        else {
            eprintln!("WebKit migration: no Chromium cookie manager");
            return;
        };
        for cookie in &cookies {
            manager.set_cookie(Some(&url), Some(&cef_cookie(cookie)), None);
        }
        manager.flush_store(None);
    });
}

fn cef_cookie(cookie: &MigratedCookie) -> cef::Cookie {
    let mut cef_cookie = cef::Cookie {
        name: cookie.name.as_str().into(),
        value: cookie.value.as_str().into(),
        path: cookie.path.as_str().into(),
        secure: cookie.secure.into(),
        httponly: cookie.http_only.into(),
        same_site: match cookie.same_site {
            SameSite::Unspecified => cef::CookieSameSite::UNSPECIFIED,
            SameSite::Lax => cef::CookieSameSite::LAX_MODE,
            SameSite::Strict => cef::CookieSameSite::STRICT_MODE,
        },
        ..Default::default()
    };
    if let Some(domain) = &cookie.domain {
        cef_cookie.domain = domain.as_str().into();
    }
    if let Some(expires) = cookie.expires {
        cef_cookie.has_expires = 1;
        cef_cookie.expires = cef::Basetime {
            val: chromium_time(expires),
        };
    }
    cef_cookie
}

/// Unix seconds as Chromium's base::Time: microseconds since 1601.
fn chromium_time(unix_secs: f64) -> i64 {
    ((unix_secs + WINDOWS_TO_UNIX_EPOCH_SECS) * 1_000_000.0) as i64
}

fn wait_for_cookies(
    window: &WebviewWindow<crate::ShellRuntime>,
    origin: &Url,
    wanted: &[MigratedCookie],
) {
    if wanted.is_empty() {
        return;
    }
    let deadline = Instant::now() + COOKIE_WAIT;
    while Instant::now() < deadline {
        let present = window.cookies_for_url(origin.clone()).unwrap_or_default();
        if wanted
            .iter()
            .filter(|c| c.path == "/")
            .all(|c| present.iter().any(|p| p.name() == c.name))
        {
            return;
        }
        std::thread::sleep(POLL);
    }
    eprintln!("WebKit migration: Chromium did not report every cookie in time");
}

/// Writes the entries into the landing document's localStorage (the app's
/// origin), then loads the app.
fn restore_script(storage: &[(String, String)], entry: &Url) -> String {
    let entries = serde_json::to_string(storage).unwrap_or_else(|_| "[]".into());
    let entry = serde_json::to_string(entry.as_str()).unwrap_or_else(|_| "\"/\"".into());
    format!(
        "(() => {{ try {{ for (const [k, v] of {entries}) localStorage.setItem(k, v) }} catch (e) {{ console.error(e) }} location.replace({entry}) }})()"
    )
}

thread_local! {
    /// The hidden WKWebView, kept alive on the main thread while it is read.
    static READER: RefCell<Option<Retained<WKWebView>>> = const { RefCell::new(None) };
}

/// Reads the store's cookies for `origin` and that origin's localStorage,
/// then calls `done` once, with whatever was read by READ_TIMEOUT.
fn read_webkit(app: &AppHandle, origin: &Url, done: impl FnOnce(WebKitData) + Send + 'static) {
    let read = Arc::new(Mutex::new(Read::default()));
    let Some(mtm) = MainThreadMarker::new() else {
        done(WebKitData::default());
        return;
    };
    let host = origin.host_str().unwrap_or_default().to_string();
    let origin_text = origin.origin().ascii_serialization();
    unsafe {
        let store = WKWebsiteDataStore::defaultDataStore(mtm);

        let cookies_read = Arc::clone(&read);
        let on_cookies = RcBlock::new(move |cookies: NonNull<NSArray<NSHTTPCookie>>| {
            let cookies = cookies.as_ref();
            let migrated = cookies
                .iter()
                .filter_map(|cookie| migrated_cookie(&cookie, &host))
                .collect();
            if let Ok(mut read) = cookies_read.lock() {
                read.cookies = Some(migrated);
            }
        });
        store.httpCookieStore().getAllCookies(&on_cookies);

        let config = WKWebViewConfiguration::new(mtm);
        config.setWebsiteDataStore(&store);
        let webview = WKWebView::initWithFrame_configuration(
            mtm.alloc(),
            objc2_foundation::NSRect::ZERO,
            &config,
        );
        let base = NSURL::URLWithString(&NSString::from_str(&format!("{origin_text}/")));
        webview.loadHTMLString_baseURL(
            &NSString::from_str("<!doctype html><title></title>"),
            base.as_deref(),
        );
        READER.with(|reader| *reader.borrow_mut() = Some(webview));
    }

    // the page's localStorage is read by polling: the blank document needs a
    // moment to commit at the origin, and a delegate class would be the only
    // other way to hear that it did
    let app = app.clone();
    let script = format!(
        "location.origin === {} ? JSON.stringify(Object.entries(localStorage)) : ''",
        serde_json::to_string(&origin_text).unwrap_or_default()
    );
    let deadline = Instant::now() + READ_TIMEOUT;
    std::thread::spawn(move || {
        loop {
            let finished = read
                .lock()
                .map(|r| r.cookies.is_some() && r.storage.is_some())
                .unwrap_or(true);
            if finished || Instant::now() >= deadline {
                break;
            }
            let read = Arc::clone(&read);
            let script = script.clone();
            let _ = app.run_on_main_thread(move || ask_storage(&script, read));
            std::thread::sleep(POLL);
        }
        let _ = app.run_on_main_thread(|| {
            READER
                .with(|reader| reader.borrow_mut().take())
                .map(drop)
                .unwrap_or(())
        });
        let read = read
            .lock()
            .map(|mut r| std::mem::take(&mut *r))
            .unwrap_or_default();
        done(WebKitData {
            cookies: read.cookies.unwrap_or_default(),
            storage: read.storage.unwrap_or_default(),
        });
    });
}

fn ask_storage(script: &str, read: Arc<Mutex<Read>>) {
    READER.with(|reader| {
        let reader = reader.borrow();
        let Some(webview) = reader.as_ref() else {
            return;
        };
        let on_result = RcBlock::new(move |result: *mut AnyObject, _error: *mut NSError| {
            let Some(text) =
                (unsafe { result.as_ref() }).and_then(|r| r.downcast_ref::<NSString>())
            else {
                return;
            };
            let text = text.to_string();
            if text.is_empty() {
                return;
            }
            if let Ok(entries) = serde_json::from_str::<Vec<(String, String)>>(&text) {
                if let Ok(mut read) = read.lock() {
                    read.storage.get_or_insert(entries);
                }
            }
        });
        unsafe {
            webview
                .evaluateJavaScript_completionHandler(&NSString::from_str(script), Some(&on_result))
        };
    });
}

/// The cookie as Chromium should hold it, if it belongs to `host`. WebKit
/// writes a host-only cookie's domain bare and a domain cookie's with a
/// leading dot; a bare one goes to Chromium without a domain, which keeps it
/// host-only (and keeps `__Host-` cookies valid).
fn migrated_cookie(cookie: &NSHTTPCookie, host: &str) -> Option<MigratedCookie> {
    let domain = cookie.domain().to_string();
    if !applies_to(&domain, host) {
        return None;
    }
    let same_site = match cookie.sameSitePolicy() {
        Some(policy) if &*policy == unsafe { NSHTTPCookieSameSiteStrict } => SameSite::Strict,
        Some(policy) if &*policy == unsafe { NSHTTPCookieSameSiteLax } => SameSite::Lax,
        _ => SameSite::Unspecified,
    };
    Some(MigratedCookie {
        name: cookie.name().to_string(),
        value: cookie.value().to_string(),
        domain: domain.starts_with('.').then_some(domain),
        path: cookie.path().to_string(),
        secure: cookie.isSecure(),
        http_only: cookie.isHTTPOnly(),
        expires: cookie
            .expiresDate()
            .map(|date| date.timeIntervalSince1970()),
        same_site,
    })
}

fn applies_to(domain: &str, host: &str) -> bool {
    match domain.strip_prefix('.') {
        Some(bare) => host == bare || host.ends_with(&format!(".{bare}")),
        None => host == domain,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_entries_then_loads_the_app() {
        let entry = Url::parse("https://doop.design/auth").unwrap();
        let script = restore_script(&[("doop-theme".into(), "dark\"</script>".into())], &entry);
        assert!(script.contains(r#"[["doop-theme","dark\"</script>"]]"#));
        assert!(script.ends_with(r#"location.replace("https://doop.design/auth") })()"#));
    }

    #[test]
    fn counts_chromium_time_from_1601() {
        // 2026-01-01T00:00:00Z
        assert_eq!(chromium_time(1_767_225_600.0), 13_411_699_200_000_000);
    }

    #[test]
    fn keeps_host_only_cookies_to_their_host() {
        assert!(applies_to("doop.design", "doop.design"));
        assert!(!applies_to("doop.design", "www.doop.design"));
        assert!(applies_to(".doop.design", "www.doop.design"));
        assert!(applies_to(".doop.design", "doop.design"));
        assert!(!applies_to(".evil.design", "doop.design"));
        assert!(!applies_to("localhost", "doop.design"));
    }

    #[test]
    fn lands_on_the_origins_icon() {
        let origin = Url::parse("https://doop.design").unwrap();
        assert_eq!(landing(&origin).as_str(), "https://doop.design/favicon.ico");
    }
}
