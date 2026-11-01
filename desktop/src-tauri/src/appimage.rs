//! Name and icon for an AppImage window. GNOME and KDE take both from the
//! installed .desktop file whose name or StartupWMClass matches the window
//! class (the binary name, `doop-desktop`), never from the window itself. The
//! .deb and .rpm install one; an AppImage started from a download folder has
//! none, so its window shows up as "doop-desktop" with a generic icon. The
//! deep-link plugin's `doop-desktop-handler.desktop` does not match either.
//!
//! So an AppImage writes an entry of its own, rewritten when the AppImage
//! moved. It cannot be NoDisplay: GNOME does not match windows to hidden
//! entries, so doop also appears among the installed apps, as it does after an
//! AppImage manager integrates it. Its icon is a file in the app's data dir
//! named by absolute path: an icon placed in the user's hicolor theme stays
//! invisible wherever a stale icon-theme.cache sits beside it.
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const WM_CLASS: &str = "doop-desktop";
const ICON: &[u8] = include_bytes!("../icons/128x128@2x.png");

pub fn integrate(app: &AppHandle) {
    let Some(appimage) = std::env::var_os("APPIMAGE").map(PathBuf::from) else {
        return;
    };
    let (Ok(data), Ok(app_data)) = (app.path().data_dir(), app.path().app_data_dir()) else {
        return;
    };
    if let Err(error) = write(&data.join("applications"), &app_data, &appimage) {
        eprintln!("Registering the AppImage with the desktop failed: {error}");
    }
}

fn write(applications: &Path, app_data: &Path, appimage: &Path) -> std::io::Result<()> {
    fs::create_dir_all(app_data)?;
    let icon = app_data.join("icon.png");
    if fs::read(&icon).ok().as_deref() != Some(ICON) {
        fs::write(&icon, ICON)?;
    }

    fs::create_dir_all(applications)?;
    let path = applications.join(format!("{WM_CLASS}.desktop"));
    let entry = entry(appimage, &icon);
    if fs::read_to_string(&path).ok().as_deref() != Some(entry.as_str()) {
        fs::write(&path, entry)?;
    }
    Ok(())
}

fn entry(appimage: &Path, icon: &Path) -> String {
    // Exec quoting per the Desktop Entry spec: inside double quotes, `"`, `` ` ``,
    // `$` and `\` take a backslash
    let mut exec = String::new();
    for c in appimage.to_string_lossy().chars() {
        if matches!(c, '"' | '`' | '$' | '\\') {
            exec.push('\\');
        }
        exec.push(c);
    }
    format!(
        "[Desktop Entry]\nType=Application\nName=doop\nExec=\"{exec}\"\nIcon={}\nStartupWMClass={WM_CLASS}\nTerminal=false\n",
        icon.display()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_window_class_and_quotes_the_path() {
        let entry = entry(
            Path::new("/home/a b/$x\"doop.AppImage"),
            Path::new("/home/a b/.local/share/design.doop.desktop/icon.png"),
        );
        assert!(entry.contains("Exec=\"/home/a b/\\$x\\\"doop.AppImage\"\n"));
        assert!(entry.contains("StartupWMClass=doop-desktop\n"));
        assert!(entry.contains("Icon=/home/a b/.local/share/design.doop.desktop/icon.png\n"));
        assert!(!entry.contains("NoDisplay"));
    }

    #[test]
    fn writes_the_entry_and_icon_and_follows_a_moved_appimage() {
        let data = tempfile::tempdir().unwrap();
        let applications = data.path().join("applications");
        let app_data = data.path().join("design.doop.desktop");
        let appimage = Path::new("/opt/doop.AppImage");
        write(&applications, &app_data, appimage).unwrap();
        let desktop = applications.join("doop-desktop.desktop");
        let icon = app_data.join("icon.png");
        assert_eq!(
            fs::read_to_string(&desktop).unwrap(),
            entry(appimage, &icon)
        );
        assert_eq!(fs::read(&icon).unwrap(), ICON);

        let moved = Path::new("/home/me/doop.AppImage");
        write(&applications, &app_data, moved).unwrap();
        assert_eq!(fs::read_to_string(&desktop).unwrap(), entry(moved, &icon));
    }
}
