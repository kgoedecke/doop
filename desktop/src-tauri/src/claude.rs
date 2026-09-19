//! Direct Claude CLI transport. Never reads or exports Claude credentials.
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
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

fn executable() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    let name = if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    };
    let mut candidates = Vec::new();
    if let Some(home) = home {
        candidates.push(PathBuf::from(home).join(".local/bin").join(name));
    }
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join(name)));
    }
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
    ]);
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .ok_or("Claude CLI not found. Install Claude Code, then refresh.".into())
}

fn command() -> Result<Command, String> {
    let mut cmd = Command::new(executable()?);
    // An explicit subscription mode must not accidentally spend an inherited API key.
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
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    Ok(cmd)
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

#[tauri::command]
pub async fn claude_status(app: AppHandle, user_id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let enabled = enabled_users(&app)?.contains(&user_id);
        let Ok(mut cmd) = command() else { return Ok(json!({"installed": false, "connected": false, "enabled": enabled})); };
        cmd.current_dir(directory(&app)?).args(["auth", "status"]);
        let mut output = String::new();
        let ok = collect(cmd.spawn().map_err(|e| e.to_string())?, Duration::from_secs(20), Arc::new(AtomicBool::new(false)), |line| { if output.len() < 32_000 { output.push_str(line); } })?;
        let auth: Value = serde_json::from_str(&output).unwrap_or(Value::Null);
        Ok(json!({"installed": true, "connected": ok && auth["loggedIn"] == true, "enabled": enabled,
            "email": auth["email"], "plan": auth["subscriptionType"], "authMethod": auth["authMethod"]}))
    }).await.map_err(|e| e.to_string())?
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
        if executable().is_ok() { return Ok(()); }
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
        let mut verify = command()?;
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
        let mut cmd = command()?;
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
    if ![
        "default",
        "sonnet",
        "opus",
        "claude-fable-5-1",
        "claude-opus-5",
        "claude-sonnet-5",
        "claude-haiku-4-5-20251001",
    ]
    .contains(&model)
    {
        return Err("Invalid model".into());
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
        let mut cmd = command()?;
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

    #[test]
    fn run_ids_cannot_escape_the_task_directory() {
        assert!(valid_id("12345678-1234-1234-1234-123456789abc"));
        assert!(!valid_id("../../../../tmp/foreign"));
        assert!(!valid_id("https://example.com"));
    }
}
