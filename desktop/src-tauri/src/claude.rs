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

fn collect(
    mut child: Child,
    timeout: Duration,
    cancel: Arc<AtomicBool>,
    mut on_line: impl FnMut(&str),
) -> Result<bool, String> {
    let stdout = child.stdout.take().ok_or("Missing CLI output")?;
    let (sender, receiver) = std::sync::mpsc::sync_channel(32);
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if line.len() > 2_000_000 || sender.send(line).is_err() {
                break;
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
            Ok(line) => on_line(&line),
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
    if !["default", "sonnet", "opus"].contains(&model) {
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
    fn run_ids_cannot_escape_the_task_directory() {
        assert!(valid_id("12345678-1234-1234-1234-123456789abc"));
        assert!(!valid_id("../../../../tmp/foreign"));
        assert!(!valid_id("https://example.com"));
    }
}
