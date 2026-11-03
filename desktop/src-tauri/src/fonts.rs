//! Add fonts installed on this computer to a Doop font library. The files come
//! from the native file panel, opened in the fonts folder, never from a
//! page-supplied path: the page may read a file only by the path the panel
//! returned, once per pick, and then uploads it through the ordinary font
//! upload, so the server reads the face's metadata exactly as it does for a
//! dropped file. Doop checks no font licences; the page says so before the
//! upload, and the choice stays with the person.
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{ipc::Response, AppHandle, Manager};

/// The server's own limit for one face (shared/fonts.ts, MAX_FONT_BYTES).
pub const MAX_FONT_BYTES: u64 = 10 * 1024 * 1024;

const EXTENSIONS: [&str; 4] = ["ttf", "otf", "woff", "woff2"];

/// The files the panel has handed out, the only ones `fonts_read_local` reads.
#[derive(Default)]
pub struct LocalFonts(Mutex<HashSet<PathBuf>>);

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Where this platform keeps installed fonts, the person's own folder first.
fn font_dirs(
    os: &str,
    home: Option<&Path>,
    local_app_data: Option<&Path>,
    windir: Option<&Path>,
) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    match os {
        "macos" => {
            if let Some(home) = home {
                dirs.push(home.join("Library/Fonts"));
            }
            dirs.push(PathBuf::from("/Library/Fonts"));
        }
        "windows" => {
            if let Some(data) = local_app_data {
                dirs.push(data.join("Microsoft").join("Windows").join("Fonts"));
            }
            dirs.push(
                windir
                    .map(|w| w.join("Fonts"))
                    .unwrap_or_else(|| PathBuf::from(r"C:\Windows\Fonts")),
            );
        }
        _ => {
            if let Some(home) = home {
                dirs.push(home.join(".local/share/fonts"));
                dirs.push(home.join(".fonts"));
            }
            dirs.push(PathBuf::from("/usr/share/fonts"));
        }
    }
    dirs
}

fn is_font_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| EXTENSIONS.iter().any(|known| known.eq_ignore_ascii_case(e)))
        .unwrap_or(false)
}

/// Why a picked file was left out: not a single font file (a collection, or
/// something the panel let through), or a font file over the server's limit.
#[derive(Debug, PartialEq)]
enum Skip {
    Kind,
    Size,
}

impl Skip {
    fn reason(&self) -> &'static str {
        match self {
            Skip::Kind => "kind",
            Skip::Size => "size",
        }
    }
}

/// The file's name and size when it is a single font file the server accepts;
/// otherwise its name and why it is left out.
fn describe(path: &Path) -> Result<(String, u64), (String, Skip)> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string());
    if !is_font_file(path) {
        return Err((name, Skip::Kind));
    }
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() && meta.len() > MAX_FONT_BYTES => Err((name, Skip::Size)),
        Ok(meta) if meta.is_file() => Ok((name, meta.len())),
        _ => Err((name, Skip::Kind)),
    }
}

/// Opens the native file panel in the fonts folder and remembers the picks.
/// Answers `{ picked: [{ path, name, size }], skipped: [{ name, reason: "kind" | "size" }] }`.
#[tauri::command]
pub async fn fonts_choose_local(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut picker = rfd::FileDialog::new()
            .set_title("Add fonts from this computer")
            .add_filter("Fonts", &EXTENSIONS);
        let home = home_dir();
        let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
        let windir = std::env::var_os("WINDIR").map(PathBuf::from);
        let dirs = font_dirs(
            std::env::consts::OS,
            home.as_deref(),
            local_app_data.as_deref(),
            windir.as_deref(),
        );
        if let Some(dir) = dirs.into_iter().find(|d| d.is_dir()) {
            picker = picker.set_directory(dir);
        }
        let Some(paths) = picker.pick_files() else {
            return Ok(json!({ "picked": [], "skipped": [] }));
        };
        let state = app.state::<LocalFonts>();
        let mut allowed = state
            .0
            .lock()
            .map_err(|_| "The font picker is busy. Try again.".to_string())?;
        let mut picked = Vec::new();
        let mut skipped = Vec::new();
        for path in paths {
            match describe(&path) {
                Ok((name, size)) => {
                    picked.push(
                        json!({ "path": path.to_string_lossy(), "name": name, "size": size }),
                    );
                    allowed.insert(path);
                }
                Err((name, why)) => skipped.push(json!({ "name": name, "reason": why.reason() })),
            }
        }
        Ok(json!({ "picked": picked, "skipped": skipped }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The bytes of one file the panel handed out, read once: the path leaves the
/// allow list as it is read, so a page cannot keep reading it.
#[tauri::command]
pub fn fonts_read_local(app: AppHandle, path: String) -> Result<Response, String> {
    let path = PathBuf::from(path);
    let state = app.state::<LocalFonts>();
    let allowed = state
        .0
        .lock()
        .map_err(|_| "The font picker is busy. Try again.".to_string())?
        .remove(&path);
    if !allowed {
        return Err("Pick the font through the file panel first.".into());
    }
    let bytes =
        std::fs::read(&path).map_err(|e| format!("{} could not be read: {e}", path.display()))?;
    if bytes.len() as u64 > MAX_FONT_BYTES {
        return Err(format!("{} is over the 10 MB limit.", path.display()));
    }
    Ok(Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn knows_single_font_files_by_extension_in_any_case() {
        for ok in ["a.ttf", "b.OTF", "c.woff", "d.Woff2"] {
            assert!(is_font_file(Path::new(ok)), "{ok}");
        }
        for no in ["e.ttc", "f.dfont", "g.txt", "h", "i.ttf.zip"] {
            assert!(!is_font_file(Path::new(no)), "{no}");
        }
    }

    #[test]
    fn describes_a_small_font_file_and_skips_the_rest_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let font = dir.path().join("Brand.ttf");
        std::fs::File::create(&font)
            .unwrap()
            .write_all(b"\0\x01\0\0")
            .unwrap();
        assert_eq!(describe(&font), Ok(("Brand.ttf".to_string(), 4)));
        let collection = dir.path().join("Helvetica.ttc");
        std::fs::write(&collection, b"ttcf").unwrap();
        assert_eq!(
            describe(&collection),
            Err(("Helvetica.ttc".to_string(), Skip::Kind))
        );
        assert_eq!(
            describe(&dir.path().join("missing.otf")),
            Err(("missing.otf".to_string(), Skip::Kind))
        );
        let dir_name = dir
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(describe(dir.path()), Err((dir_name, Skip::Kind)));
        // a real font file over the limit is named for its size, not its kind
        let big = dir.path().join("Huge.otf");
        let file = std::fs::File::create(&big).unwrap();
        file.set_len(MAX_FONT_BYTES + 1).unwrap();
        assert_eq!(describe(&big), Err(("Huge.otf".to_string(), Skip::Size)));
    }

    #[test]
    fn opens_in_the_persons_own_fonts_folder_first() {
        let home = Path::new("/Users/me");
        assert_eq!(
            font_dirs("macos", Some(home), None, None),
            vec![
                PathBuf::from("/Users/me/Library/Fonts"),
                PathBuf::from("/Library/Fonts")
            ]
        );
        assert_eq!(
            font_dirs("macos", None, None, None),
            vec![PathBuf::from("/Library/Fonts")]
        );
        let linux = font_dirs("linux", Some(home), None, None);
        assert_eq!(linux[0], PathBuf::from("/Users/me/.local/share/fonts"));
        assert_eq!(linux.last(), Some(&PathBuf::from("/usr/share/fonts")));
        let windows = font_dirs(
            "windows",
            None,
            Some(Path::new(r"C:\Users\me\AppData\Local")),
            Some(Path::new(r"D:\Windows")),
        );
        assert_eq!(
            windows[0],
            Path::new(r"C:\Users\me\AppData\Local")
                .join("Microsoft")
                .join("Windows")
                .join("Fonts")
        );
        assert_eq!(windows[1], Path::new(r"D:\Windows").join("Fonts"));
        assert_eq!(
            font_dirs("windows", None, None, None),
            vec![PathBuf::from(r"C:\Windows\Fonts")]
        );
    }
}
