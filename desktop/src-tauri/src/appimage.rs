//! Name and icon for an AppImage window. GNOME and KDE take both from the
//! installed .desktop file whose name or StartupWMClass matches the window
//! class (the binary name, `doop-desktop`), never from the window itself. The
//! .deb and .rpm install one; an AppImage started from a download folder has
//! none, so its window shows up as "doop-desktop" with a generic icon. The
//! deep-link plugin's `doop-desktop-handler.desktop` does not match either.
//!
//! So an AppImage writes an entry of its own, rewritten when the AppImage
//! moved. It is named apart from the packages' `doop-desktop.desktop`, which a
//! user entry of the same name would shadow, and the packaged app removes it:
//! after switching from the AppImage to the .deb or .rpm, the menu must not
//! keep launching a deleted AppImage. It cannot be NoDisplay: GNOME does not match windows to hidden
//! entries, so doop also appears among the installed apps, as it does after an
//! AppImage manager integrates it. Its icon is a file in the app's data dir
//! named by absolute path: an icon placed in the user's hicolor theme stays
//! invisible wherever a stale icon-theme.cache sits beside it.
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const WM_CLASS: &str = "doop-desktop";
const ENTRY: &str = "doop-desktop-appimage.desktop";
const ICON: &[u8] = include_bytes!("../icons/128x128@2x.png");

pub fn integrate(app: &AppHandle) {
    let (Ok(data), Ok(app_data)) = (app.path().data_dir(), app.path().app_data_dir()) else {
        return;
    };
    let applications = data.join("applications");
    let Some(appimage) = std::env::var_os("APPIMAGE").map(PathBuf::from) else {
        remove(&applications);
        return;
    };
    if let Err(error) = write(&applications, &app_data, &appimage) {
        eprintln!("Registering the AppImage with the desktop failed: {error}");
    }
}

/// Drops the AppImage's entry from a packaged (or dev) run; the icon in the
/// app's data dir is left, it is all the entry pointed at.
fn remove(applications: &Path) {
    let path = applications.join(ENTRY);
    match fs::remove_file(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => eprintln!("Removing the AppImage's desktop entry failed: {error}"),
    }
}

fn write(applications: &Path, app_data: &Path, appimage: &Path) -> std::io::Result<()> {
    fs::create_dir_all(app_data)?;
    let icon = app_data.join("icon.png");
    if fs::read(&icon).ok().as_deref() != Some(ICON) {
        fs::write(&icon, ICON)?;
    }

    fs::create_dir_all(applications)?;
    let path = applications.join(ENTRY);
    let entry = entry(appimage, &icon);
    if fs::read_to_string(&path).ok().as_deref() != Some(entry.as_str()) {
        fs::write(&path, entry)?;
    }
    Ok(())
}

fn entry(appimage: &Path, icon: &Path) -> String {
    format!(
        "[Desktop Entry]\nType=Application\nName=doop\nExec={}\nIcon={}\nStartupWMClass={WM_CLASS}\nTerminal=false\n",
        escape_value(&exec_arg(appimage)),
        escape_value(&icon.to_string_lossy())
    )
}

/// One quoted Exec argument per the Desktop Entry spec: inside the quotes `"`,
/// `` ` ``, `$` and `\` take a backslash, and a literal `%` is written `%%`
/// so it is not read as a field code.
fn exec_arg(path: &Path) -> String {
    let mut arg = String::from('"');
    for c in path.to_string_lossy().chars() {
        match c {
            '"' | '`' | '$' | '\\' => arg.push('\\'),
            '%' => arg.push('%'),
            _ => {}
        }
        arg.push(c);
    }
    arg.push('"');
    arg
}

/// The string escapes every value goes through, applied after Exec quoting
/// (so a quoted backslash ends up as four).
fn escape_value(value: &str) -> String {
    let mut escaped = String::new();
    for c in value.chars() {
        match c {
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\t' => escaped.push_str("\\t"),
            '\r' => escaped.push_str("\\r"),
            _ => escaped.push(c),
        }
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_window_class_and_quotes_the_path() {
        let entry = entry(
            Path::new("/home/a b/$x\"100%\\doop.AppImage"),
            Path::new("/home/a b/.local/share/design.doop.desktop/icon.png"),
        );
        assert!(entry.contains("Exec=\"/home/a b/\\\\$x\\\\\"100%%\\\\\\\\doop.AppImage\"\n"));
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
        let desktop = applications.join(ENTRY);
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

    #[test]
    fn a_packaged_run_removes_the_appimage_entry_and_never_the_packages() {
        let data = tempfile::tempdir().unwrap();
        let applications = data.path().join("applications");
        write(
            &applications,
            &data.path().join("app"),
            Path::new("/opt/doop.AppImage"),
        )
        .unwrap();
        let packaged = applications.join("doop-desktop.desktop");
        fs::write(&packaged, "[Desktop Entry]\n").unwrap();

        remove(&applications);
        assert!(!applications.join(ENTRY).exists());
        assert!(packaged.exists());
        // nothing to remove is not an error
        remove(&applications);
    }
}
