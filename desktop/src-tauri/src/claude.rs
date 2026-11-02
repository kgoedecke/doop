//! Direct Claude CLI transport. Never reads or exports Claude credentials.
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    ffi::{OsStr, OsString},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct ClaudeState {
    active: Mutex<Option<(String, Arc<AtomicBool>)>>,
}

/// The agent has no subprocess-capable tools. Wait for its supervised CLI to
/// be killed and reaped before Tauri tears down the async runtime.
pub fn shutdown(state: &ClaudeState) {
    if let Ok(active) = state.active.lock() {
        if let Some((_, cancel)) = active.as_ref() {
            cancel.store(true, Ordering::SeqCst);
        }
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if state
            .active
            .lock()
            .map(|active| active.is_none())
            .unwrap_or(true)
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// Every place a Claude Code install lands: the native installer's
/// `~/.local/bin`, the npm-local install `claude migrate-installer` leaves in
/// `~/.claude/local`, the login shell's PATH and the app's own (a GUI app's
/// PATH is short), and the Homebrew/npm global locations. Users accumulate
/// more than one over time, and an old npm global (1.x) neither knows
/// `auth status` nor shares a login with the install they use, so when the
/// shell names none worth running the NEWEST one found is the one to run.
fn candidates(shell_path: Option<&OsStr>) -> Vec<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    let name = if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    };
    let mut candidates = Vec::new();
    if let Some(home) = home {
        let home = PathBuf::from(home);
        candidates.push(home.join(".local/bin").join(name));
        candidates.push(home.join(".claude/local").join(name));
    }
    for path in [shell_path.map(OsStr::to_os_string), std::env::var_os("PATH")].into_iter().flatten() {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join(name)));
    }
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
    ]);
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|p| p.is_file())
        .filter(|p| seen.insert(std::fs::canonicalize(p).unwrap_or_else(|_| p.clone())))
        .collect()
}

type Version = (u64, u64, u64);

/// The oldest Claude Code the runner will drive. Anything 2.1 and later is
/// taken to speak `auth status` and `-p` stream-json with the flags run_cli
/// passes; a 1.x install is a leftover npm global from before the native
/// installer and knows neither. Raise this together with the flags.
const MIN_CLAUDE_VERSION: Version = (2, 1, 0);
const MIN_CLAUDE_VERSION_TEXT: &str = "2.1.0";

fn supported(version: Option<Version>) -> bool {
    version.is_some_and(|v| v >= MIN_CLAUDE_VERSION)
}

/// "2.1.281 (Claude Code)" -> (2, 1, 281); None for anything else.
fn parse_version(line: &str) -> Option<Version> {
    let mut parts = line.split_whitespace().next()?.split('.').map(|n| n.parse::<u64>().ok());
    Some((parts.next()??, parts.next()??, parts.next()??))
}

fn version_text((a, b, c): Version) -> String {
    format!("{a}.{b}.{c}")
}

/// The newest of the candidates by `--version`; one that will not say falls
/// to the back, and the first candidate stands in when none will.
fn newest(versioned: Vec<(PathBuf, Option<Version>)>) -> Option<PathBuf> {
    let first = versioned.first().map(|(path, _)| path.clone());
    versioned
        .into_iter()
        .filter_map(|(path, version)| version.map(|v| (v, path)))
        .max_by_key(|(version, _)| *version)
        .map(|(_, path)| path)
        .or(first)
}

fn version_of(path: &Path, env_path: Option<&OsStr>) -> Option<Version> {
    let mut cmd = Command::new(path);
    quiet(&mut cmd, env_path);
    cmd.arg("--version");
    let mut first = None;
    let ok = collect(cmd.spawn().ok()?, Duration::from_secs(10), Arc::new(AtomicBool::new(false)), |line| {
        if first.is_none() { first = Some(line.to_string()); }
    }).unwrap_or(false);
    if ok { first.as_deref().and_then(parse_version) } else { None }
}

/// What the person's terminal sees: the `claude` its `command -v` names (an
/// alias included, which is how `claude migrate-installer` leaves it) and the
/// PATH it runs under. A GUI app starts with `/usr/bin:/bin:/usr/sbin:/sbin`,
/// which misses both the install people use and the `node` an npm install's
/// `#!/usr/bin/env node` needs, so every Claude Code this shell starts runs
/// under the login shell's PATH.
#[derive(Clone, Debug, Default, PartialEq)]
struct ShellView {
    claude: Option<PathBuf>,
    path: Option<OsString>,
}

const SHELL_BEGIN: &str = "__DOOP_SHELL_BEGIN__";
const SHELL_PATH: &str = "__DOOP_SHELL_PATH__";
/// Start-up files print what they like (a motd, a prompt theme's warning), so
/// the answer comes after a marker and only that part is read.
const SHELL_PROBE: &str =
    "printf '\\n__DOOP_SHELL_BEGIN__\\n'; command -v claude; printf '\\n__DOOP_SHELL_PATH__%s\\n' \"$PATH\"";
const SHELL_TIMEOUT: Duration = Duration::from_secs(5);

static SHELL_VIEW: Mutex<Option<ShellView>> = Mutex::new(None);

/// The login shell's view, asked once and kept: an interactive shell start
/// runs the person's rc files, too slow and too eventful for every status
/// poll. `fresh` (the Refresh button) asks again.
fn shell_view(fresh: bool) -> ShellView {
    let Ok(mut cached) = SHELL_VIEW.lock() else {
        return ShellView::default();
    };
    if fresh || cached.is_none() {
        *cached = Some(login_shell().map(|shell| probe_shell(&shell, SHELL_TIMEOUT)).unwrap_or_default());
    }
    cached.clone().unwrap_or_default()
}

#[cfg(unix)]
fn login_shell() -> Option<PathBuf> {
    std::env::var_os("SHELL").map(PathBuf::from).filter(|p| p.is_absolute() && p.is_file())
}

/// Windows has no login shell to ask; the fixed locations and PATH stand.
#[cfg(not(unix))]
fn login_shell() -> Option<PathBuf> {
    None
}

/// A new file only this user can read, never one already there: the temp
/// directory may be shared, and a name planted ahead as a symlink must not
/// redirect the write (`create_new` refuses any existing entry, links included).
fn create_private(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Runs `shell -l -i -c SHELL_PROBE` into a file rather than a pipe: a
/// start-up file that leaves a background process holding stdout would
/// otherwise keep the read open past the timeout.
fn probe_shell(shell: &Path, timeout: Duration) -> ShellView {
    static PROBES: AtomicUsize = AtomicUsize::new(0);
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let file = std::env::temp_dir().join(format!(
        "doop-shell-{}-{}-{nonce}.txt",
        std::process::id(),
        PROBES.fetch_add(1, Ordering::SeqCst)
    ));
    let Ok(out) = create_private(&file) else {
        return ShellView::default();
    };
    let view = (|| {
        let mut child = Command::new(shell)
            .args(["-l", "-i", "-c", SHELL_PROBE])
            .stdin(Stdio::null())
            .stdout(out)
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let started = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if started.elapsed() < timeout => std::thread::sleep(Duration::from_millis(25)),
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
            }
        }
        let home = std::env::var_os("HOME").map(PathBuf::from);
        Some(parse_shell_probe(&std::fs::read_to_string(&file).ok()?, home.as_deref()))
    })();
    let _ = std::fs::remove_file(&file);
    view.unwrap_or_default()
}

fn parse_shell_probe(output: &str, home: Option<&Path>) -> ShellView {
    let mut view = ShellView::default();
    let Some((_, answer)) = output.rsplit_once(SHELL_BEGIN) else {
        return view;
    };
    for line in answer.lines() {
        if let Some(path) = line.strip_prefix(SHELL_PATH) {
            view.path = Some(OsString::from(path)).filter(|p| !p.is_empty());
        } else if view.claude.is_none() && view.path.is_none() {
            view.claude = command_target(line.trim(), home);
        }
    }
    view
}

/// `command -v` prints a path, `alias claude=…` (zsh) or `alias claude='…'`
/// (bash), or a bare name for a function or builtin. Only an absolute path,
/// or an alias whose command is one, names a file to run; an alias's
/// arguments are dropped, since run_cli passes its own. The printed value is
/// one quoted shell word holding the alias's text, whose first word is the
/// command, so a path with spaces survives in either quoting.
fn command_target(line: &str, home: Option<&Path>) -> Option<PathBuf> {
    let target = match line.strip_prefix("alias ") {
        Some(alias) => first_word(&first_word(alias.split_once('=')?.1)?)?,
        None => line.to_string(),
    };
    let path = match target.strip_prefix("~/").or_else(|| target.strip_prefix("$HOME/")) {
        Some(rest) => home?.join(rest),
        None => PathBuf::from(target),
    };
    path.is_absolute().then_some(path)
}

/// The first word of `text` as a POSIX shell reads it: single quotes are
/// literal, double quotes and a bare backslash escape, unquoted whitespace
/// ends the word. None for no word or an unterminated quote.
fn first_word(text: &str) -> Option<String> {
    let mut word = String::new();
    let mut chars = text.trim_start().chars();
    while let Some(c) = chars.next() {
        match c {
            c if c.is_whitespace() => break,
            '\'' => loop {
                match chars.next()? {
                    '\'' => break,
                    c => word.push(c),
                }
            },
            '"' => loop {
                match chars.next()? {
                    '"' => break,
                    '\\' => match chars.next()? {
                        c @ ('"' | '\\' | '$' | '`') => word.push(c),
                        c => word.extend(['\\', c]),
                    },
                    c => word.push(c),
                }
            },
            '\\' => word.push(chars.next()?),
            c => word.push(c),
        }
    }
    (!word.is_empty()).then_some(word)
}

/// Where the Claude Code being run came from, as Settings words it.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Source {
    /// picked in Settings with the file panel
    Chosen,
    /// what `claude` runs in the person's terminal
    Shell,
    /// the newest of the known locations
    Found,
}

impl Source {
    fn name(self) -> &'static str {
        match self {
            Source::Chosen => "chosen",
            Source::Shell => "shell",
            Source::Found => "found",
        }
    }
}

struct Claude {
    path: PathBuf,
    version: Option<Version>,
    source: Source,
    /// the login shell's PATH, which every process started from `path` gets
    env_path: Option<OsString>,
    /// a pick from Settings whose file is gone, set aside for this resolve
    chosen_missing: Option<PathBuf>,
}

/// The shell's `claude` when it is new enough to drive, else the newest of the
/// installs found (probed only then: one `--version` per install).
fn pick(
    shell: Option<(PathBuf, Option<Version>)>,
    found: impl FnOnce() -> Vec<(PathBuf, Option<Version>)>,
) -> Option<(PathBuf, Option<Version>, Source)> {
    if let Some((path, version)) = shell.filter(|(_, version)| supported(*version)) {
        return Some((path, version, Source::Shell));
    }
    let found = found();
    let path = newest(found.clone())?;
    let version = found.iter().find(|(p, _)| *p == path).and_then(|(_, v)| *v);
    Some((path, version, Source::Found))
}

/// The Claude Code to run: the one picked in Settings, else the one the login
/// shell runs, else the newest install found. Probed every time (the shell's
/// view aside): this runs on a refresh, a sign-in, an install check and once
/// per run, and a cache here would hide an update made in place a moment ago.
fn resolved(app: &AppHandle, fresh: bool) -> Result<Claude, String> {
    let env_path = shell_view(fresh).path;
    let shell = shell_view(false).claude;
    let probe = |path: PathBuf| {
        let version = version_of(&path, env_path.as_deref());
        (path, version)
    };
    let mut chosen_missing = None;
    if let Some(path) = chosen_cli(app)? {
        if path.is_file() {
            let version = version_of(&path, env_path.as_deref());
            return Ok(Claude { path, version, source: Source::Chosen, env_path, chosen_missing });
        }
        chosen_missing = Some(path);
    }
    let shell = shell.filter(|p| p.is_file()).map(probe);
    let (path, version, source) = pick(shell, || {
        candidates(env_path.as_deref()).into_iter().map(probe).collect()
    })
    .ok_or("Claude CLI not found. Install Claude Code, then refresh.")?;
    Ok(Claude { path, version, source, env_path, chosen_missing })
}

/// A command for a Claude Code already resolved: one probe per action, the
/// path, version and PATH then carried through the checks and the spawn.
fn command_at(claude: &Claude) -> Command {
    let mut cmd = Command::new(&claude.path);
    quiet(&mut cmd, claude.env_path.as_deref());
    cmd
}

/// The one resolve a sign-in or run makes, refusing a Claude Code below the
/// floor; the UI has already said what to do about it.
fn supported_command(app: &AppHandle) -> Result<Command, String> {
    let claude = resolved(app, false)?;
    if supported(claude.version) {
        return Ok(command_at(&claude));
    }
    let found = claude.version.map(version_text).unwrap_or_else(|| "an unknown version".into());
    Err(format!("Claude Code {found} at {} is older than the {MIN_CLAUDE_VERSION_TEXT} Doop needs. Run `claude update`, then Refresh.", claude.path.display()))
}

/// Piped, stdin-less, API-key-free, under the login shell's PATH when known
/// and (on Windows) without a console window: every Claude Code process this
/// shell starts, probes included.
fn quiet(cmd: &mut Command, env_path: Option<&OsStr>) {
    subscription_environment(cmd);
    if let Some(path) = env_path {
        cmd.env("PATH", path);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
}

/// An explicit subscription mode must not accidentally spend an inherited API key.
fn subscription_environment(cmd: &mut Command) {
    for key in [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
        "CLAUDE_CONFIG_DIR",
        "CLAUDECODE",
    ] {
        cmd.env_remove(key);
    }
}

fn directory(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("claude");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn enabled_users(app: &AppHandle) -> Result<HashSet<String>, String> {
    let path = directory(app)?.join("connections.json");
    if !path.exists() {
        return Ok(HashSet::new());
    }
    serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

const MAX_CLI_LINE_BYTES: usize = 2_000_000;

// Bound allocations even if the CLI never emits a newline.
fn read_cli_line(reader: &mut impl BufRead) -> Result<Option<String>, String> {
    let mut line = Vec::new();
    loop {
        let buffer = reader.fill_buf().map_err(|e| format!("Could not read Claude output: {e}"))?;
        if buffer.is_empty() {
            if line.is_empty() { return Ok(None); }
            break;
        }
        let newline = buffer.iter().position(|b| *b == b'\n');
        let count = newline.map_or(buffer.len(), |index| index);
        if line.len() + count > MAX_CLI_LINE_BYTES {
            return Err("Claude output exceeded the 2 MB line limit. The run was stopped; retry with a smaller tool result.".into());
        }
        line.extend_from_slice(&buffer[..count]);
        reader.consume(count + usize::from(newline.is_some()));
        if newline.is_some() {
            if line.last() == Some(&b'\r') { line.pop(); }
            break;
        }
    }
    String::from_utf8(line).map(Some).map_err(|_| "Claude output was not valid UTF-8.".into())
}

fn collect(
    mut child: Child,
    timeout: Duration,
    cancel: Arc<AtomicBool>,
    mut on_line: impl FnMut(&str),
) -> Result<bool, String> {
    let stdout = child.stdout.take().ok_or("Missing CLI output")?;
    let (sender, receiver) = std::sync::mpsc::sync_channel(32);
    let reader = std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_cli_line(&mut reader) {
                Ok(Some(line)) => { if sender.send(Ok(line)).is_err() { break; } }
                Ok(None) => break,
                Err(error) => { let _ = sender.send(Err(error)); break; }
            }
        }
    });
    let started = Instant::now();
    let result = loop {
        if cancel.load(Ordering::SeqCst) || started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            break Err("Claude run stopped or timed out. Retry when ready.".into());
        }
        match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(line)) => on_line(&line),
            Ok(Err(error)) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(error);
            },
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => match child.try_wait() {
                Ok(Some(status)) => break Ok(status.success()),
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(e) => break Err(e.to_string()),
            },
            Err(_) => {}
        }
    };
    drop(receiver);
    let _ = reader.join();
    result
}

/// `fresh` (the Refresh button; absent from pages older than it) asks the
/// login shell again instead of keeping its first answer.
#[tauri::command]
pub async fn claude_status(app: AppHandle, user_id: String, fresh: Option<bool>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let enabled = enabled_users(&app)?.contains(&user_id);
        let Ok(claude) = resolved(&app, fresh.unwrap_or(false)) else { return Ok(json!({"installed": false, "connected": false, "enabled": enabled})); };
        let mut cmd = command_at(&claude);
        cmd.current_dir(directory(&app)?).args(["auth", "status"]);
        let mut output = String::new();
        let ok = collect(cmd.spawn().map_err(|e| e.to_string())?, Duration::from_secs(20), Arc::new(AtomicBool::new(false)), |line| { if output.len() < 32_000 { output.push_str(line); } })?;
        let auth: Value = serde_json::from_str(&output).unwrap_or(Value::Null);
        // Below the floor, or so old that `auth status` answers with usage text
        // or a crash rather than JSON: nothing from here can work, say so.
        let outdated = !supported(claude.version) || !auth.is_object();
        Ok(json!({"installed": true, "connected": !outdated && ok && auth["loggedIn"] == true, "enabled": enabled,
            "email": auth["email"], "plan": auth["subscriptionType"], "authMethod": auth["authMethod"],
            "outdated": outdated, "cliPath": claude.path.to_string_lossy(), "minVersion": MIN_CLAUDE_VERSION_TEXT,
            "cliVersion": claude.version.map(version_text), "cliSource": claude.source.name(),
            "chosenMissing": claude.chosen_missing.map(|p| p.to_string_lossy().into_owned())}))
    }).await.map_err(|e| e.to_string())?
}

fn chosen_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(directory(app)?.join("cli.json"))
}

/// The Claude Code picked in Settings, if one was. A file that cannot be read
/// or parsed counts as no pick, so it never stands between a person and the
/// installs that do work.
fn chosen_cli(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let file = chosen_file(app)?;
    Ok(read_chosen(&file))
}

fn read_chosen(file: &Path) -> Option<PathBuf> {
    let saved: Value = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    saved["path"].as_str().map(PathBuf::from)
}

/// Saves the pick whole or not at all: written beside the file, then renamed
/// over it, so a crash mid-write leaves the previous pick in place.
fn write_chosen(file: &Path, path: &str) -> std::io::Result<()> {
    let staged = file.with_extension("json.tmp");
    std::fs::write(&staged, json!({"path": path}).to_string())?;
    std::fs::rename(&staged, file).inspect_err(|_| {
        let _ = std::fs::remove_file(&staged);
    })
}

/// Picks the Claude Code to run. The path comes from the native file panel,
/// never from the page: it is the program this shell will execute.
#[tauri::command]
pub async fn claude_choose_cli(app: AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut picker = rfd::FileDialog::new().set_title("Choose Claude Code");
        if let Some(dir) = resolved(&app, false).ok().and_then(|c| c.path.parent().map(Path::to_path_buf)) {
            picker = picker.set_directory(dir);
        }
        let Some(path) = picker.pick_file() else { return Ok(false) };
        let Some(version) = version_of(&path, shell_view(false).path.as_deref()) else {
            return Err(format!("{} did not answer as Claude Code. Choose the claude executable.", path.display()));
        };
        if !supported(Some(version)) {
            return Err(format!("Claude Code {} at {} is older than the {MIN_CLAUDE_VERSION_TEXT} Doop needs. Run `claude update`, or choose another.", version_text(version), path.display()));
        }
        let path = path.to_str().ok_or("Choose a Claude Code whose path is valid UTF-8.")?;
        write_chosen(&chosen_file(&app)?, path).map_err(|e| e.to_string())?;
        Ok(true)
    }).await.map_err(|e| e.to_string())?
}

/// Forgets the pick, so the shell's or the newest install runs again.
#[tauri::command]
pub fn claude_reset_cli(app: AppHandle) -> Result<(), String> {
    match std::fs::remove_file(chosen_file(&app)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

#[tauri::command]
pub async fn claude_connect(app: AppHandle, user_id: String, enabled: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if user_id.is_empty() || user_id.len() > 256 { return Err("Invalid account".into()); }
        let mut users = enabled_users(&app)?;
        if enabled && !users.contains(&user_id) {
            let accepted = rfd::MessageDialog::new().set_title("Use local Claude for Doop?")
                .set_description("Doop will run your installed Claude CLI on this computer for this Doop account's canvas tasks, using your Claude login and usage limits. Only Doop canvas tools are enabled. Tasks run while this desktop app is open.")
                .set_buttons(rfd::MessageButtons::OkCancel).show();
            if accepted != rfd::MessageDialogResult::Ok { return Err("Connection cancelled".into()); }
            users.insert(user_id);
        } else if !enabled { users.remove(&user_id); }
        std::fs::write(directory(&app)?.join("connections.json"), serde_json::to_vec(&users).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}

// Serialize installation across windows and repeated IPC requests.
static INSTALLING: Mutex<()> = Mutex::new(());

fn installer_command() -> Command {
    #[cfg(not(windows))]
    let mut cmd = {
        let mut cmd = Command::new("/bin/bash");
        // Download fully before executing; the URL and script are never supplied by the webview.
        cmd.args(["-c", r#"set -eu
installer=$(mktemp)
trap 'rm -f "$installer"' EXIT
curl --proto '=https' --proto-redir '=https' --fail --show-error --silent --location --connect-timeout 20 --max-time 120 https://claude.ai/install.sh -o "$installer"
bash "$installer"
"#]);
        cmd
    };
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut cmd = Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command",
            "$ErrorActionPreference = 'Stop'; $script = Invoke-RestMethod -Uri 'https://claude.ai/install.ps1' -TimeoutSec 120; Invoke-Expression $script"]);
        cmd.creation_flags(0x08000000);
        cmd
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    cmd
}

#[tauri::command]
pub async fn claude_install(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = INSTALLING.try_lock().map_err(|_| "Claude Code installation is already running.")?;
        if resolved(&app, true).is_ok() { return Ok(()); }
        let accepted = rfd::MessageDialog::new().set_title("Install Claude Code?")
            .set_description("Download and run Anthropic's official installer on this computer? Claude Code installs for your user account and manages its own updates.")
            .set_buttons(rfd::MessageButtons::OkCancel).show();
        if accepted != rfd::MessageDialogResult::Ok { return Err("Installation cancelled.".into()); }
        let mut cmd = installer_command();
        cmd.current_dir(directory(&app)?);
        let ok = collect(cmd.spawn().map_err(|e| format!("Could not start the installer: {e}"))?,
            Duration::from_secs(600), Arc::new(AtomicBool::new(false)), |_| {})
            .map_err(|_| "Installation did not finish in time. Refresh to check, or use the installation guide.")?;
        if !ok { return Err("Installation failed. Check your internet connection or use the installation guide.".into()); }
        let mut verify = command_at(&resolved(&app, true)?);
        verify.arg("--version");
        let ok = collect(verify.spawn().map_err(|e| e.to_string())?,
            Duration::from_secs(20), Arc::new(AtomicBool::new(false)), |_| {})?;
        if !ok { return Err("Claude Code was installed but could not start. See the installation guide.".into()); }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn claude_login(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = supported_command(&app)?;
        cmd.current_dir(directory(&app)?).args(["auth", "login"]);
        let ok = collect(
            cmd.spawn().map_err(|e| e.to_string())?,
            Duration::from_secs(180),
            Arc::new(AtomicBool::new(false)),
            |_| {},
        )?;
        if ok {
            Ok(())
        } else {
            Err(
                "Sign-in did not complete. Run claude auth login in your terminal, then Refresh."
                    .into(),
            )
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn claude_stop(state: State<'_, ClaudeState>) -> Result<(), String> {
    if let Some((_, cancel)) = state.active.lock().map_err(|e| e.to_string())?.as_ref() {
        cancel.store(true, Ordering::SeqCst);
    }
    Ok(())
}

fn field<'a>(job: &'a Value, name: &str) -> Result<&'a str, String> {
    job[name].as_str().ok_or_else(|| format!("Missing {name}"))
}
fn valid_id(id: &str) -> bool {
    id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

// Mirrors isClaudeModel in shared/localAgent.ts: an alias the CLI resolves to
// its newest model, or a pinned claude-* id. The value becomes one argv element,
// so the shape rule is the whole guard.
fn valid_model(model: &str) -> bool {
    if ["default", "fable", "opus", "sonnet", "haiku"].contains(&model) {
        return true;
    }
    let Some(rest) = model.strip_prefix("claude-") else {
        return false;
    };
    (1..=99).contains(&rest.len())
        && rest.as_bytes()[0].is_ascii_alphanumeric()
        && rest
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
}

// Mirrors CLAUDE_EFFORTS in shared/localAgent.ts: `claude --effort` levels.
fn valid_effort(effort: &str) -> bool {
    ["low", "medium", "high", "xhigh", "max"].contains(&effort)
}

#[tauri::command]
pub async fn claude_run(
    app: AppHandle,
    user_id: String,
    job: Value,
    state: State<'_, ClaudeState>,
) -> Result<Value, String> {
    if !enabled_users(&app)?.contains(&user_id) {
        return Err("Connect Claude on this device first".into());
    }
    let id = field(&job, "id")?.to_owned();
    if !valid_id(&id) {
        return Err("Invalid run id".into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut active = state.active.lock().map_err(|e| e.to_string())?;
        if active.is_some() {
            return Err("Claude is already running a task".into());
        }
        *active = Some((id.clone(), cancel.clone()));
    }
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || run_cli(&handle, &job, cancel)).await;
    *state.active.lock().map_err(|e| e.to_string())? = None;
    result.map_err(|e| e.to_string())?
}

fn run_cli(app: &AppHandle, job: &Value, cancel: Arc<AtomicBool>) -> Result<Value, String> {
    let id = field(job, "id")?;
    let token = field(job, "token")?;
    if token.len() != 64 || !token.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid run token".into());
    }
    let model = field(job, "model")?;
    if !valid_model(model) {
        return Err("Invalid model".into());
    }
    let effort = job["effort"].as_str();
    if effort.is_some_and(|effort| !valid_effort(effort)) {
        return Err("Invalid effort".into());
    }
    let prompt = field(job, "prompt")?;
    let system = field(job, "system")?;
    if prompt.len() + system.len() > 1_000_000 {
        return Err("Task is too large".into());
    }
    let turns = job["maxTurns"].as_u64().unwrap_or(24).clamp(1, 40);
    let dir = directory(app)?.join(id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let config = dir.join("mcp.json");
    let system_path = dir.join("system.txt");
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        // Server URL is compiled into the app; a web page cannot choose an arbitrary target.
        let mcp = json!({"mcpServers":{"doop":{"type":"http", "url":format!("{}/local-agent/mcp/{}", crate::base_url(), id), "headers":{"Authorization":format!("Bearer {}", token)}}}});
        options
            .open(&config)
            .map_err(|e| e.to_string())?
            .write_all(mcp.to_string().as_bytes())
            .map_err(|e| e.to_string())?;
        options
            .open(&system_path)
            .map_err(|e| e.to_string())?
            .write_all(system.as_bytes())
            .map_err(|e| e.to_string())?;
        let mut cmd = supported_command(app)?;
        cmd.current_dir(&dir)
            .args([
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
                "--setting-sources",
                "",
                "--strict-mcp-config",
                "--tools",
                "",
                "--allowedTools",
                "mcp__doop__*",
                "--permission-mode",
                "dontAsk",
                "--disable-slash-commands",
                "--max-turns",
                &turns.to_string(),
                "--settings",
                "{\"disableAllHooks\":true}",
            ])
            .arg("--mcp-config")
            .arg(&config)
            .arg("--system-prompt-file")
            .arg(&system_path)
            .stdin(Stdio::piped());
        if model != "default" {
            cmd.args(["--model", model]);
        }
        if let Some(effort) = effort {
            cmd.args(["--effort", effort]);
        }
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        if let Some(mut stdin) = child.stdin.take() {
            if let Err(error) = stdin.write_all(prompt.as_bytes()) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error.to_string());
            }
        }
        let mut final_result = None;
        let ok = collect(child, Duration::from_secs(30 * 60), cancel, |line| {
            let Ok(event) = serde_json::from_str::<Value>(line) else {
                return;
            };
            if event["type"] == "result" {
                final_result = Some(
                    json!({"success":event["is_error"] == false && event["subtype"] == "success", "text":event["result"].as_str().unwrap_or("Claude did not complete the task. Check your login and usage limits, then retry.")}),
                );
            }
            // Send only human-readable progress; MCP headers and tool payloads stay out of UI events.
            let text = event.pointer("/event/delta/text").and_then(Value::as_str);
            if let Some(text) = text {
                let _ = app.emit_to(
                    "main",
                    "claude-progress",
                    json!({"id":id,"text":text.chars().take(2000).collect::<String>()}),
                );
            }
        })?;
        let mut result = final_result.ok_or(
            "Claude exited without a result. Check your CLI login and version, then retry.",
        )?;
        if !ok {
            result["success"] = json!(false);
        }
        Ok(result)
    })();
    let _ = std::fs::remove_file(config);
    let _ = std::fs::remove_file(system_path);
    let _ = std::fs::remove_dir(dir);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn installer_does_not_execute_a_failed_download() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("doop-installer-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let curl = dir.join("curl");
        // Write a partial payload, then simulate a failed download. It must never run.
        std::fs::write(&curl, "#!/bin/sh\nfor arg do target=$arg; done\nprintf 'echo SHOULD_NOT_RUN' > \"$target\"\nexit 22\n").unwrap();
        std::fs::set_permissions(&curl, std::fs::Permissions::from_mode(0o700)).unwrap();
        let output = installer_command()
            .env("PATH", format!("{}:/usr/bin:/bin", dir.display()))
            .env("TMPDIR", &dir)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn streams_every_line_before_reporting_exit() {
        let child = Command::new("/bin/sh")
            .args(["-c", "printf 'first\\nsecond\\n'"])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut lines = Vec::new();
        let ok = collect(
            child,
            Duration::from_secs(2),
            Arc::new(AtomicBool::new(false)),
            |line| lines.push(line.to_owned()),
        )
        .unwrap();
        assert!(ok);
        assert_eq!(lines, vec!["first", "second"]);
    }

    #[cfg(unix)]
    #[test]
    fn cancelled_cli_is_killed_without_waiting_for_its_normal_exit() {
        let child = Command::new("/bin/sleep")
            .arg("10")
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let started = Instant::now();
        assert!(collect(
            child,
            Duration::from_secs(20),
            Arc::new(AtomicBool::new(true)),
            |_| {}
        )
        .is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn bounded_reader_handles_line_endings_and_eof() {
        let mut reader = std::io::Cursor::new(b"first\r\n\nlast");
        assert_eq!(read_cli_line(&mut reader).unwrap(), Some("first".into()));
        assert_eq!(read_cli_line(&mut reader).unwrap(), Some("".into()));
        assert_eq!(read_cli_line(&mut reader).unwrap(), Some("last".into()));
        assert_eq!(read_cli_line(&mut reader).unwrap(), None);
        let mut reader = std::io::Cursor::new(vec![b'x'; MAX_CLI_LINE_BYTES]);
        assert_eq!(read_cli_line(&mut reader).unwrap().unwrap().len(), MAX_CLI_LINE_BYTES);
    }

    #[test]
    fn bounded_reader_rejects_oversized_and_invalid_lines() {
        let mut reader = std::io::Cursor::new(vec![b'x'; MAX_CLI_LINE_BYTES + 1]);
        assert!(read_cli_line(&mut reader).unwrap_err().contains("2 MB"));
        let mut reader = std::io::Cursor::new(vec![0xff, b'\n']);
        assert!(read_cli_line(&mut reader).unwrap_err().contains("UTF-8"));
    }

    #[cfg(unix)]
    #[test]
    fn oversized_output_stops_the_child_promptly() {
        let child = Command::new("/bin/sh")
            .args(["-c", "printf '%02000001d' 0; exec sleep 10"])
            .stdout(Stdio::piped())
            .spawn().unwrap();
        let started = Instant::now();
        let error = collect(child, Duration::from_secs(15), Arc::new(AtomicBool::new(false)), |_| {}).unwrap_err();
        assert!(error.contains("2 MB"));
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    // The login shell is asked on Unix only, and these paths are Unix ones.
    #[cfg(unix)]
    #[test]
    fn reads_the_shells_claude_past_start_up_noise() {
        let home = Path::new("/Users/me");
        let probe = |answer: &str| parse_shell_probe(&format!("Last login: Thu\nwelcome{SHELL_BEGIN}\n{answer}\n{SHELL_PATH}/a/bin:/usr/bin\n"), Some(home));
        let claude = |answer: &str| probe(answer).claude;
        assert_eq!(probe("/opt/claude").path, Some(OsString::from("/a/bin:/usr/bin")));
        assert_eq!(claude("/Users/me/.local/bin/claude"), Some(PathBuf::from("/Users/me/.local/bin/claude")));
        assert_eq!(claude("alias claude=/Users/me/.claude/local/claude"), Some(PathBuf::from("/Users/me/.claude/local/claude")));
        assert_eq!(claude("alias claude='~/.claude/local/claude --verbose'"), Some(PathBuf::from("/Users/me/.claude/local/claude")));
        assert_eq!(claude("alias claude=\"$HOME/bin/claude\""), Some(PathBuf::from("/Users/me/bin/claude")));
        assert_eq!(claude("/Applications/My Tools/claude"), Some(PathBuf::from("/Applications/My Tools/claude")));
        // a function or builtin names no file; nor does a relative alias
        assert_eq!(claude("claude"), None);
        assert_eq!(claude("alias claude=npx"), None);
        assert_eq!(claude(""), None);
        // a path with spaces, as zsh and bash print it, and escaped
        let spaced = Some(PathBuf::from("/Applications/My Tools/claude"));
        assert_eq!(claude("alias claude='\"/Applications/My Tools/claude\" --verbose'"), spaced);
        assert_eq!(claude("alias claude='/Applications/My\\ Tools/claude'"), spaced);
        assert_eq!(claude("alias claude=\"'/Applications/My Tools/claude'\""), spaced);
        // bash's '\'' for a quote inside the alias text, which escapes it in turn
        assert_eq!(claude("alias claude='/opt/it\\'\\''s/claude'"), Some(PathBuf::from("/opt/it's/claude")));
        assert_eq!(claude("alias claude='/opt/claude"), None);
        // only what follows the last marker counts, so an rc file echoing one is harmless
        assert_eq!(
            parse_shell_probe(&format!("{SHELL_BEGIN}\n/wrong/claude\n{SHELL_BEGIN}\n\n{SHELL_PATH}\n"), Some(home)),
            ShellView::default()
        );
        assert_eq!(parse_shell_probe("zsh: command not found: compinit", Some(home)), ShellView::default());
    }

    #[test]
    fn a_pick_is_saved_whole_and_a_broken_one_is_no_pick() {
        let dir = std::env::temp_dir().join(format!("doop-chosen-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("cli.json");
        assert_eq!(read_chosen(&file), None);
        write_chosen(&file, "/opt/My Tools/claude").unwrap();
        assert_eq!(read_chosen(&file), Some(PathBuf::from("/opt/My Tools/claude")));
        assert!(!file.with_extension("json.tmp").exists());
        std::fs::write(&file, "{\"pa").unwrap();
        assert_eq!(read_chosen(&file), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn the_probe_file_is_never_one_already_there() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("doop-private-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("victim");
        std::fs::write(&target, "keep").unwrap();
        let planted = dir.join("planted");
        std::os::unix::fs::symlink(&target, &planted).unwrap();
        assert!(create_private(&planted).is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep");
        let fresh = dir.join("fresh");
        create_private(&fresh).unwrap();
        assert_eq!(std::fs::metadata(&fresh).unwrap().permissions().mode() & 0o777, 0o600);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn prefers_the_shells_claude_unless_it_is_too_old() {
        let shell = PathBuf::from("/Users/me/.claude/local/claude");
        let other = PathBuf::from("/Users/me/.local/bin/claude");
        let unused = || -> Vec<(PathBuf, Option<Version>)> { panic!("the installs are probed only when the shell's is passed over") };
        assert_eq!(pick(Some((shell.clone(), Some((2, 1, 100)))), unused), Some((shell.clone(), Some((2, 1, 100)), Source::Shell)));
        let found = || vec![(other.clone(), Some((2, 1, 281)))];
        assert_eq!(pick(Some((shell.clone(), Some((1, 0, 61)))), found), Some((other.clone(), Some((2, 1, 281)), Source::Found)));
        assert_eq!(pick(Some((shell.clone(), None)), found), Some((other.clone(), Some((2, 1, 281)), Source::Found)));
        assert_eq!(pick(None, found), Some((other.clone(), Some((2, 1, 281)), Source::Found)));
        assert_eq!(pick(None, Vec::new), None);
    }

    #[cfg(unix)]
    #[test]
    fn asks_the_login_shell_and_runs_npm_installs_under_its_path() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("doop-shell-test-{}", std::process::id()));
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let script = |path: &Path, body: &str| {
            std::fs::write(path, body).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        };
        // An npm install: a script whose interpreter only the shell's PATH has.
        script(&bin.join("doop-test-node"), "#!/bin/sh\necho '2.1.300 (Claude Code)'\n");
        script(&bin.join("claude"), "#!/usr/bin/env doop-test-node\n");
        // A shell whose start-up prints noise and extends PATH, as nvm does; its args are -l -i -c PROBE.
        let shell = dir.join("shell");
        script(&shell, &format!("#!/bin/sh\nprintf 'Last login: today'\nPATH='{}':$PATH\nexport PATH\neval \"$4\"\n", bin.display()));
        let view = probe_shell(&shell, Duration::from_secs(10));
        assert_eq!(view.claude, Some(bin.join("claude")));
        let path = view.path.clone().unwrap();
        assert!(path.to_string_lossy().starts_with(&*bin.to_string_lossy()));
        assert_eq!(version_of(&bin.join("claude"), Some(&path)), Some((2, 1, 300)));
        assert_eq!(version_of(&bin.join("claude"), Some(OsStr::new("/usr/bin:/bin"))), None);
        // A shell that never finishes starting is given up on.
        script(&shell, "#!/bin/sh\nsleep 30\n");
        let started = Instant::now();
        assert_eq!(probe_shell(&shell, Duration::from_millis(300)), ShellView::default());
        assert!(started.elapsed() < Duration::from_secs(5));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn picks_the_newest_claude_and_leaves_a_mute_one_last() {
        let a = PathBuf::from("/opt/homebrew/bin/claude");
        let b = PathBuf::from("/Users/me/.claude/local/claude");
        let c = PathBuf::from("/Users/me/.local/bin/claude");
        assert_eq!(parse_version("2.1.281 (Claude Code)"), Some((2, 1, 281)));
        assert_eq!(parse_version("1.0.61 (Claude Code)"), Some((1, 0, 61)));
        assert_eq!(parse_version("Usage: claude [options]"), None);
        assert_eq!(parse_version(""), None);
        assert_eq!(
            newest(vec![(a.clone(), Some((1, 0, 61))), (b.clone(), Some((2, 1, 281))), (c.clone(), Some((2, 1, 9)))]),
            Some(b.clone())
        );
        assert_eq!(newest(vec![(a.clone(), Some((1, 0, 61))), (b.clone(), None)]), Some(a.clone()));
        assert_eq!(newest(vec![(a.clone(), None), (b.clone(), None)]), Some(a.clone()));
        assert_eq!(newest(vec![]), None);
    }

    #[test]
    fn the_floor_is_a_real_version_and_older_ones_are_refused() {
        assert!(parse_version(MIN_CLAUDE_VERSION_TEXT) == Some(MIN_CLAUDE_VERSION));
        assert!(supported(Some(MIN_CLAUDE_VERSION)));
        assert!(supported(Some((2, 1, 281))));
        assert!(supported(Some((3, 0, 0))));
        assert!(!supported(Some((2, 0, 99))));
        assert!(!supported(Some((1, 0, 61))));
        assert!(!supported(None));
    }

    #[test]
    fn run_ids_cannot_escape_the_task_directory() {
        assert!(valid_id("12345678-1234-1234-1234-123456789abc"));
        assert!(!valid_id("../../../../tmp/foreign"));
        assert!(!valid_id("https://example.com"));
    }

    #[test]
    fn models_are_aliases_or_pinned_ids_never_flags() {
        for alias in ["default", "fable", "opus", "sonnet", "haiku"] {
            assert!(valid_model(alias), "{alias}");
        }
        assert!(valid_model("claude-opus-5"));
        assert!(valid_model("claude-haiku-4-5-20251001"));
        assert!(valid_model("claude-sonnet-5.5"));
        assert!(!valid_model("--dangerously-skip-permissions"));
        assert!(!valid_model("claude-"));
        assert!(!valid_model("claude--x"));
        assert!(!valid_model("claude-Opus"));
        assert!(!valid_model("claude-opus 5"));
        assert!(!valid_model("gpt-6"));
        assert!(!valid_model(&format!("claude-{}", "a".repeat(100))));
    }

    #[test]
    fn efforts_are_the_cli_levels() {
        for level in ["low", "medium", "high", "xhigh", "max"] {
            assert!(valid_effort(level), "{level}");
        }
        assert!(!valid_effort("default"));
        assert!(!valid_effort("--verbose"));
        assert!(!valid_effort(""));
    }
}
