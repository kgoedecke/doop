// doop desktop shell: a single webview over the hosted app. The window is
// built in code (not tauri.conf.json) because the navigation handler below
// needs the app handle. It opens on /auth, not /: someone launching the
// installed app never wants the marketing landing page — /auth shows the
// sign-in form when logged out and renders Home once a session exists.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

/// The hosted app this shell wraps. Self-hosters can point release builds at
/// their own instance without patching the source:
///   DOOP_APP_URL=https://doop.example.com npm run build
const APP_URL: &str = match option_env!("DOOP_APP_URL") {
    Some(url) => url,
    None => "https://doop.design",
};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let entry = if cfg!(debug_assertions) {
                "http://localhost:4300/auth".to_string()
            } else {
                format!("{}/auth", APP_URL.trim_end_matches('/'))
            };
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
            // Marks every page loaded in the shell so the app's analytics can
            // tell desktop sessions from browser ones (src/lib/posthog.ts).
            let desktop_marker = format!(
                "window.__DOOP_DESKTOP__ = '{}';",
                app.package_info().version
            );
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
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to start doop");
}
