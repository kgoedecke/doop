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
//! Chromium takes cookies only for the URL its webview is on, so the window
//! first opens hidden on the app's /favicon.ico (same origin, no scripts),
//! gets the cookies, the localStorage entries, and then goes to the app,
//! showing itself as it does. A marker file in the app data directory makes
//! this a first-launch-only step; a read that fails or outlasts READ_TIMEOUT
//! only costs a sign-in.
use std::cell::RefCell;
use std::ptr::NonNull;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::MainThreadMarker;
use objc2_foundation::{NSArray, NSError, NSHTTPCookie, NSString, NSURL};
use objc2_web_kit::{WKWebView, WKWebViewConfiguration, WKWebsiteDataStore};
use tauri::webview::cookie::Cookie;
use tauri::{AppHandle, Manager, Url, WebviewWindow};

/// The document the window waits on: the app's origin, no scripts.
pub const LANDING_PATH: &str = "/favicon.ico";
const MARKER: &str = "webkit-migrated";
const READ_TIMEOUT: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_millis(100);
/// How long Chromium gets to report the migrated cookies before the app loads
/// anyway (setting them is fire-and-forget).
const COOKIE_WAIT: Duration = Duration::from_secs(2);

/// What the WebKit shell kept for the app's origin.
#[derive(Default)]
struct WebKitData {
    cookies: Vec<Cookie<'static>>,
    storage: Vec<(String, String)>,
}

#[derive(Default)]
struct Read {
    cookies: Option<Vec<Cookie<'static>>>,
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

/// True until the move has run once on this machine.
pub fn pending(app: &AppHandle) -> bool {
    app.path()
        .app_data_dir()
        .map(|dir| !dir.join(MARKER).exists())
        .unwrap_or(false)
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
    for cookie in &data.cookies {
        let _ = window.set_cookie(cookie.clone());
    }
    let origin = state.origin.clone();
    let entry = state.entry.clone();
    let app = app.clone();
    // cookies_for_url waits on the main thread, so the wait runs off it
    std::thread::spawn(move || {
        wait_for_cookies(&window, &origin, &data.cookies);
        // marked before the hand-over: a crash in between costs a sign-in,
        // never a second migration over what Chromium has since stored
        if let Ok(dir) = app.path().app_data_dir() {
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(dir.join(MARKER), b"");
        }
        let _ = window.eval(restore_script(&data.storage, &entry));
        // the script navigates itself; this only rescues a script that never ran
        std::thread::sleep(Duration::from_secs(3));
        if window.url().is_ok_and(|url| url.path() == LANDING_PATH) {
            let _ = window.navigate(entry);
        }
    });
}

fn wait_for_cookies(
    window: &WebviewWindow<crate::ShellRuntime>,
    origin: &Url,
    wanted: &[Cookie<'static>],
) {
    if wanted.is_empty() {
        return;
    }
    let deadline = Instant::now() + COOKIE_WAIT;
    while Instant::now() < deadline {
        let present = window.cookies_for_url(origin.clone()).unwrap_or_default();
        if wanted
            .iter()
            .filter(|c| c.path().is_none_or(|p| p == "/"))
            .all(|c| present.iter().any(|p| p.name() == c.name()))
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
fn migrated_cookie(cookie: &NSHTTPCookie, host: &str) -> Option<Cookie<'static>> {
    let domain = cookie.domain().to_string();
    let host_only = !domain.starts_with('.');
    let bare = domain.trim_start_matches('.');
    let applies = if host_only {
        host == bare
    } else {
        host == bare || host.ends_with(&format!(".{bare}"))
    };
    if !applies {
        return None;
    }
    let mut migrated = Cookie::new(cookie.name().to_string(), cookie.value().to_string());
    if !host_only {
        migrated.set_domain(domain);
    }
    migrated.set_path(cookie.path().to_string());
    migrated.set_secure(cookie.isSecure());
    migrated.set_http_only(cookie.isHTTPOnly());
    // expiry and SameSite are not passed on: the CEF runtime's set_cookie
    // drops both, persist_session_cookies keeps the cookie, and the server
    // still expires the session it names
    Some(migrated)
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
    fn lands_on_the_origins_icon() {
        let origin = Url::parse("https://doop.design").unwrap();
        assert_eq!(landing(&origin).as_str(), "https://doop.design/favicon.ico");
    }
}
