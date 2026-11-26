//! Programs the shell starts on the person's system: the browser behind
//! `xdg-open`, the `xdg-mime` that registers doop:// links, Claude Code and its
//! login shell. Outside a Linux AppImage they start like any other process.
//!
//! An AppImage starts the shell through linuxdeploy's AppRun, which puts the
//! bundle first on `PATH` and `LD_LIBRARY_PATH` and points GTK, GIO and
//! GStreamer at the libraries built on the CI machine (Ubuntu 22.04). The shell
//! needs that, but a host program inheriting it loads the bundle's older glib,
//! libsystemd and libdbus in place of its own and dies on a missing symbol: on
//! a current distro `xdg-open` handed the sign-in page to `kde-open6` or `gio`,
//! which never started, so Google sign-in never reached the browser. So a host
//! program gets the environment without the bundle: its entries are taken out
//! of every search path, and the variables the GTK hook sets outright, whose
//! earlier values are gone, are dropped. The shell's own environment is left
//! as it is; WebKitGTK's helper processes still need it.
use std::ffi::OsStr;
#[cfg(target_os = "linux")]
use std::ffi::OsString;
#[cfg(target_os = "linux")]
use std::path::{Path, PathBuf};
use std::process::Command;

/// Search paths AppRun (`AppRun.wrapped`) and its hooks put the bundle's
/// directories in front of.
#[cfg(target_os = "linux")]
const SEARCH_PATHS: &[&str] = &[
    "PATH",
    "LD_LIBRARY_PATH",
    "XDG_DATA_DIRS",
    "GST_PLUGIN_SYSTEM_PATH",
    "GST_PLUGIN_SYSTEM_PATH_1_0",
    "QT_PLUGIN_PATH",
    "PYTHONPATH",
    "PERLLIB",
    "GSETTINGS_SCHEMA_DIR",
    "GI_TYPELIB_PATH",
];

/// Set outright by the AppImage runtime, AppRun and linuxdeploy's GTK hook
/// (`apprun-hooks/linuxdeploy-plugin-gtk.sh`): the bundle's own location, the
/// Python home inside it, its GTK and GIO modules, and the theme and backend it
/// forces on the shell. Whatever the person had set is already gone.
#[cfg(target_os = "linux")]
const BUNDLE_ONLY: &[&str] = &[
    "APPDIR",
    "APPIMAGE",
    "ARGV0",
    "OWD",
    "PYTHONHOME",
    "PYTHONDONTWRITEBYTECODE",
    "GTK_DATA_PREFIX",
    "GTK_THEME",
    "GDK_BACKEND",
    "GTK_EXE_PREFIX",
    "GTK_PATH",
    "GTK_IM_MODULE_FILE",
    "GDK_PIXBUF_MODULE_FILE",
    "GIO_MODULE_DIR",
    "GIO_EXTRA_MODULES",
];

/// What the GTK hook puts right after the bundle in `XDG_DATA_DIRS`
/// (`$APPDIR/usr/share:/usr/share:$XDG_DATA_DIRS`). Left in, it would put
/// `/usr/share` ahead of the session's own directories, and a session that had
/// none would lose the spec's `/usr/local/share:/usr/share` default.
#[cfg(target_os = "linux")]
const HOOK_DATA_DIR: &str = "/usr/share";

/// A command for a program on the person's system. Inside an AppImage it runs
/// without the bundle's environment, and since `PATH` is set on the command,
/// a bare program name is looked up on the host's `PATH` too.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(target_os = "linux")]
    for (name, value) in changes(
        |name| std::env::var_os(name),
        |dir| std::fs::canonicalize(dir).ok(),
    ) {
        match value {
            Some(value) => cmd.env(name, value),
            None => cmd.env_remove(name),
        };
    }
    cmd
}

/// Whether the shell runs from an AppImage, and so starts host programs with
/// an environment of their own.
#[cfg(target_os = "linux")]
pub fn in_appimage() -> bool {
    appdir(|name| std::env::var_os(name)).is_some()
}

/// The bundle's root: an absolute `APPDIR` below the root (a root `APPDIR`
/// would strip every path).
#[cfg(target_os = "linux")]
fn appdir(var: impl Fn(&str) -> Option<OsString>) -> Option<OsString> {
    var("APPDIR").filter(|dir| {
        let dir = Path::new(dir);
        dir.is_absolute() && dir.parent().is_some()
    })
}

/// What a host program's environment needs changed: a new value, or `None`
/// to remove the variable. Nothing outside an AppImage.
///
/// The runtime's `APPDIR` is the mount point as it was created, but AppRun
/// builds `PATH` and `LD_LIBRARY_PATH` from its own resolved location, so under
/// a symlinked `TMPDIR` (or `/home` on Fedora Atomic) those entries carry the
/// resolved path: both count as the bundle.
#[cfg(target_os = "linux")]
fn changes(
    var: impl Fn(&str) -> Option<OsString>,
    resolve: impl Fn(&Path) -> Option<PathBuf>,
) -> Vec<(&'static str, Option<OsString>)> {
    let Some(appdir) = appdir(&var) else {
        return Vec::new();
    };
    let appdir = PathBuf::from(appdir);
    let mut roots = vec![appdir.clone()];
    roots.extend(resolve(&appdir).filter(|resolved| *resolved != appdir));
    let in_bundle = |entry: &Path| roots.iter().any(|root| entry.starts_with(root));
    let mut changes = Vec::new();
    for &name in SEARCH_PATHS {
        let Some(value) = var(name) else { continue };
        let mut host = Vec::new();
        let mut after_bundle = false;
        for entry in std::env::split_paths(&value) {
            if entry.as_os_str().is_empty() {
                continue;
            }
            if in_bundle(&entry) {
                after_bundle = name == "XDG_DATA_DIRS";
                continue;
            }
            if std::mem::take(&mut after_bundle) && entry == Path::new(HOOK_DATA_DIR) {
                continue;
            }
            host.push(entry);
        }
        let host = std::env::join_paths(host)
            .ok()
            .filter(|joined| !joined.is_empty());
        if host.as_ref() != Some(&value) {
            changes.push((name, host));
        }
    }
    changes.extend(
        BUNDLE_ONLY
            .iter()
            .filter(|name| var(name).is_some())
            .map(|&name| (name, None)),
    );
    changes
}

/// Linux paths and `:`-separated lists, as an AppImage sees them (on Windows
/// `/tmp/...` is not even absolute, so nothing there is an AppImage).
#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
        let map: HashMap<String, OsString> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), OsString::from(v)))
            .collect();
        move |name| map.get(name).cloned()
    }

    /// No symlink on the way to the bundle.
    fn resolved(_: &Path) -> Option<PathBuf> {
        None
    }

    fn changes(var: impl Fn(&str) -> Option<OsString>) -> Vec<(&'static str, Option<OsString>)> {
        super::changes(var, resolved)
    }

    fn changed(changes: &[(&str, Option<OsString>)], name: &str) -> Option<Option<String>> {
        changes
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, v)| v.as_ref().map(|v| v.to_string_lossy().into_owned()))
    }

    #[test]
    fn leaves_everything_alone_outside_an_appimage() {
        let vars = env(&[
            ("PATH", "/usr/bin"),
            ("LD_LIBRARY_PATH", "/opt/lib"),
            ("GTK_THEME", "Adwaita"),
        ]);
        assert!(changes(vars).is_empty());
    }

    #[test]
    fn a_root_or_relative_appdir_is_no_appimage() {
        for appdir in ["/", "squashfs-root", ""] {
            assert!(
                changes(env(&[("APPDIR", appdir), ("PATH", "/usr/bin")])).is_empty(),
                "{appdir:?}"
            );
        }
    }

    #[test]
    fn takes_the_bundle_out_of_the_search_paths_and_keeps_the_hosts() {
        let vars = env(&[
            ("APPDIR", "/tmp/.mount_doopAb12"),
            ("PATH", "/tmp/.mount_doopAb12/usr/bin/:/tmp/.mount_doopAb12/usr/sbin/:/usr/local/bin:/usr/bin"),
            ("LD_LIBRARY_PATH", "/tmp/.mount_doopAb12/usr/lib/:/tmp/.mount_doopAb12//usr/lib/x86_64-linux-gnu/:/opt/cuda/lib"),
            ("XDG_DATA_DIRS", "/tmp/.mount_doopAb12/usr/share:/usr/share:/usr/local/share"),
            ("GST_PLUGIN_SYSTEM_PATH", "/tmp/.mount_doopAb12/usr/lib/gstreamer:"),
        ]);
        let changes = changes(vars);
        assert_eq!(
            changed(&changes, "PATH"),
            Some(Some("/usr/local/bin:/usr/bin".into()))
        );
        assert_eq!(
            changed(&changes, "LD_LIBRARY_PATH"),
            Some(Some("/opt/cuda/lib".into()))
        );
        assert_eq!(
            changed(&changes, "XDG_DATA_DIRS"),
            Some(Some("/usr/local/share".into()))
        );
        // nothing of the host's left: removed, not set empty (an empty entry means the cwd)
        assert_eq!(changed(&changes, "GST_PLUGIN_SYSTEM_PATH"), Some(None));
        // unset stays unset
        assert_eq!(changed(&changes, "PYTHONPATH"), None);
    }

    #[test]
    fn a_session_without_data_dirs_gets_the_spec_default_back() {
        // what the GTK hook and AppRun leave when the session set none
        let hooked = "/tmp/.mount_x/usr/share/:/tmp/.mount_x/usr/share:/usr/share:";
        let vars = env(&[("APPDIR", "/tmp/.mount_x"), ("XDG_DATA_DIRS", hooked)]);
        assert_eq!(changed(&changes(vars), "XDG_DATA_DIRS"), Some(None));
        let vars = env(&[
            ("APPDIR", "/tmp/.mount_x"),
            (
                "XDG_DATA_DIRS",
                "/tmp/.mount_x/usr/share:/usr/share:/var/lib/flatpak/exports/share",
            ),
        ]);
        assert_eq!(
            changed(&changes(vars), "XDG_DATA_DIRS"),
            Some(Some("/var/lib/flatpak/exports/share".into()))
        );
    }

    #[test]
    fn the_sessions_data_dirs_keep_their_order() {
        // Ubuntu's GNOME session, after AppRun and the GTK hook
        let vars = env(&[
            ("APPDIR", "/tmp/.mount_x"),
            (
                "XDG_DATA_DIRS",
                "/tmp/.mount_x/usr/share/:/tmp/.mount_x/usr/share:/usr/share:/usr/share/gnome:/usr/local/share/:/usr/share/",
            ),
        ]);
        assert_eq!(
            changed(&changes(vars), "XDG_DATA_DIRS"),
            Some(Some(
                "/usr/share/gnome:/usr/local/share/:/usr/share/".into()
            ))
        );
    }

    #[test]
    fn a_bundle_reached_through_a_symlink_is_still_the_bundle() {
        // TMPDIR=/home/u/tmp where /home links to /var/home: AppRun's entries
        // carry the resolved path
        let vars = env(&[
            ("APPDIR", "/home/u/tmp/.mount_x"),
            ("PATH", "/var/home/u/tmp/.mount_x/usr/bin:/usr/bin"),
            ("LD_LIBRARY_PATH", "/var/home/u/tmp/.mount_x/usr/lib/"),
        ]);
        let resolve = |dir: &Path| {
            (dir == Path::new("/home/u/tmp/.mount_x"))
                .then(|| PathBuf::from("/var/home/u/tmp/.mount_x"))
        };
        let changes = super::changes(vars, resolve);
        assert_eq!(changed(&changes, "PATH"), Some(Some("/usr/bin".into())));
        assert_eq!(changed(&changes, "LD_LIBRARY_PATH"), Some(None));
    }

    #[test]
    fn a_host_path_that_only_shares_a_prefix_with_the_bundle_stays() {
        let vars = env(&[
            ("APPDIR", "/opt/doop"),
            ("PATH", "/opt/doop/usr/bin:/opt/doop-tools/bin:/usr/bin"),
        ]);
        assert_eq!(
            changed(&changes(vars), "PATH"),
            Some(Some("/opt/doop-tools/bin:/usr/bin".into()))
        );
    }

    #[test]
    fn an_untouched_search_path_is_not_rewritten() {
        let vars = env(&[("APPDIR", "/tmp/.mount_x"), ("PATH", "/usr/bin:/bin")]);
        assert_eq!(changed(&changes(vars), "PATH"), None);
    }

    #[test]
    fn drops_what_the_gtk_hook_and_runtime_set() {
        let vars = env(&[
            ("APPDIR", "/tmp/.mount_x"),
            ("APPIMAGE", "/home/me/doop.AppImage"),
            ("GTK_THEME", "Adwaita:dark"),
            ("GDK_BACKEND", "x11"),
            ("GIO_MODULE_DIR", "/tmp/.mount_x//usr/lib/gio/modules"),
            (
                "GIO_EXTRA_MODULES",
                "/tmp/.mount_x/usr/lib/x86_64-linux-gnu/gio/modules",
            ),
            ("PYTHONHOME", "/tmp/.mount_x/usr/"),
            ("PYTHONDONTWRITEBYTECODE", "1"),
            (
                "GSETTINGS_SCHEMA_DIR",
                "/tmp/.mount_x//usr/share/glib-2.0/schemas",
            ),
            ("HOME", "/home/me"),
        ]);
        let changes = changes(vars);
        for name in [
            "APPDIR",
            "APPIMAGE",
            "GTK_THEME",
            "GDK_BACKEND",
            "GIO_MODULE_DIR",
            "GIO_EXTRA_MODULES",
            "PYTHONHOME",
            "PYTHONDONTWRITEBYTECODE",
            "GSETTINGS_SCHEMA_DIR",
        ] {
            assert_eq!(changed(&changes, name), Some(None), "{name}");
        }
        assert_eq!(changed(&changes, "HOME"), None);
        assert_eq!(changed(&changes, "GTK_PATH"), None);
    }
}
