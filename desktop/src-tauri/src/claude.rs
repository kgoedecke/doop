//! Direct Claude CLI transport. Connection configuration stays on this device.
use serde_json::{json, Value};
use command_group::{CommandGroup, GroupChild};
use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Command, Stdio},
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
    subscription_environment(&mut cmd);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    Ok(cmd)
}

fn subscription_environment(cmd: &mut Command) {
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

// Model selections are per Doop account on this device, not hosted preferences.
static MODEL_SELECTIONS: Mutex<()> = Mutex::new(());

fn read_models(path: &std::path::Path) -> Result<HashMap<String, String>, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "Could not read local Claude model selections".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(_) => Err("Could not read local Claude model selections".into()),
    }
}

fn selected_model(path: &std::path::Path, user_id: &str) -> Result<String, String> {
    let model = read_models(path)?.remove(user_id).unwrap_or_else(|| "default".into());
    if !valid_model(&model) { return Err("Invalid local Claude model selection".into()); }
    Ok(model)
}

fn save_model(path: &std::path::Path, user_id: &str, model: &str) -> Result<(), String> {
    if user_id.is_empty() || user_id.len() > 256 || !valid_model(model) { return Err("Invalid model selection".into()); }
    let _guard = MODEL_SELECTIONS.lock().map_err(|_| "Could not save local Claude model selection")?;
    let mut models = read_models(path)?;
    models.insert(user_id.into(), model.into());
    let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("Missing Claude data directory")?)
        .map_err(|_| "Could not save local Claude model selection")?;
    serde_json::to_writer(file.as_file_mut(), &models).map_err(|_| "Could not save local Claude model selection")?;
    file.persist(path).map_err(|_| "Could not save local Claude model selection")?;
    Ok(())
}

#[tauri::command]
pub async fn claude_set_model(app: AppHandle, user_id: String, model: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !enabled_users(&app)?.contains(&user_id) { return Err("Connect Claude on this device first".into()); }
        if !custom_profile(&read_profile(&app)?) { return Err("Configure a custom profile in Doop claude.json first".into()); }
        save_model(&directory(&app)?.join("models.json"), &user_id, &model)
    }).await.map_err(|e| e.to_string())?
}

fn private_working_directory() -> Result<tempfile::TempDir, String> {
    let mut builder = tempfile::Builder::new();
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o700));
    }
    builder.tempdir().map_err(|_| "Could not prepare Claude working directory".into())
}

// Device-local configuration is owned by the OS user. Web pages cannot write it
// or submit executable paths, environment variables or shell code.
fn parse_profile(source: &[u8]) -> Result<Value, String> {
    let profile: Value = serde_json::from_slice(source).map_err(|_| "Doop claude.json must be valid JSON")?;
    let fields = profile.as_object().ok_or("Doop claude.json must be an object")?;
    for (key, value) in fields {
        if !["launcher", "configDir", "settings"].contains(&key.as_str()) {
            return Err(format!("Unknown option in Doop claude.json: {key}"));
        }
        let path = value.as_str().ok_or("Claude configuration paths must be strings")?;
        if !PathBuf::from(path).is_absolute() {
            return Err(format!("{key} in Doop claude.json must be an absolute path"));
        }
        if key == "configDir" && !PathBuf::from(path).is_dir() {
            return Err("The configured Claude Code folder is missing".into());
        }
    }
    Ok(profile)
}

fn read_profile(app: &AppHandle) -> Result<Value, String> {
    let path = app.path().app_config_dir().map_err(|e| e.to_string())?.join("claude.json");
    match std::fs::metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(_) => Err("Could not read Doop claude.json".into()),
        Ok(metadata) => {
            if metadata.len() > 1_000_000 { return Err("Doop claude.json is too large".into()); }
            parse_profile(&std::fs::read(path).map_err(|_| "Could not read Doop claude.json")?)
        }
    }
}

fn valid_model(model: &str) -> bool {
    !model.is_empty() && model.len() <= 256 && model.as_bytes()[0].is_ascii_alphanumeric()
        && model.chars().all(|c| c.is_ascii_alphanumeric() || "._:/@[]+-".contains(c))
}

// Connection variables documented by Claude Code. Do not forward arbitrary
// settings env: NODE_OPTIONS and loader/PATH overrides can execute unrelated code.
fn provider_env(key: &str) -> bool {
    key.starts_with("ANTHROPIC_") || key.starts_with("AWS_") || key.starts_with("AZURE_")
        || key.starts_with("GOOGLE_") || key.starts_with("CLAUDE_CODE_USE_")
        || key.starts_with("VERTEX_REGION_")
        || ["CLAUDE_CONFIG_DIR", "GCLOUD_PROJECT", "CLOUD_ML_REGION",
            "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", "CLAUDE_CODE_GATEWAY_MODEL_DISCOVERY_TIMEOUT_MS",
            "CLAUDE_CODE_SKIP_BEDROCK_AUTH", "CLAUDE_CODE_SKIP_VERTEX_AUTH", "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
            "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
            "NODE_EXTRA_CA_CERTS", "CLAUDE_CODE_CLIENT_CERT", "CLAUDE_CODE_CLIENT_KEY",
            "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE", "CLAUDE_CODE_CERT_STORE", "CLAUDE_CODE_GZIP_REQUEST_BODIES",
            "API_TIMEOUT_MS", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_CODE_OAUTH_TOKEN"].contains(&key)
}

fn connection_settings(source: &Value) -> Value {
    let mut settings = json!({"disableAllHooks": true, "enabledPlugins": {}});
    // Copy connection/model configuration only. Never import hooks, permissions,
    // plugins, project instructions or MCP servers from the user's profile.
    for key in ["model", "modelPicker", "availableModels", "modelOverrides", "modelSettings",
        "apiKeyHelper", "awsAuthRefresh", "awsCredentialExport"] {
        if let Some(value) = source.get(key) { settings[key] = value.clone(); }
    }
    if let Some(env) = source["env"].as_object() {
        settings["env"] = Value::Object(env.iter().filter(|(key, value)| provider_env(key) && value.is_string())
            .map(|(key, value)| (key.clone(), value.clone())).collect());
    }
    settings
}

fn custom_profile(profile: &Value) -> bool {
    ["launcher", "configDir", "settings"].iter().any(|key| profile[*key].is_string())
}

fn profile_settings(profile: &Value) -> Result<Value, String> {
    // No device-local opt-in: preserve Doop's subscription-only configuration.
    if !custom_profile(profile) { return Ok(connection_settings(&json!({}))); }
    let path = profile["settings"].as_str().map(PathBuf::from).or_else(|| {
        profile["configDir"].as_str().map(PathBuf::from).or_else(|| std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from)).or_else(||
            std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(|home| PathBuf::from(home).join(".claude")))
            .map(|dir| dir.join("settings.json"))
    });
    match path {
        Some(path) if path.is_file() => {
            if std::fs::metadata(&path).map_err(|_| "Could not read Claude settings")?.len() > 1_000_000 {
                return Err("Claude settings file is too large".into());
            }
            let source: Value = serde_json::from_slice(&std::fs::read(path).map_err(|_| "Could not read Claude settings")?)
                .map_err(|_| "Claude settings must be valid JSON")?;
            Ok(connection_settings(&source))
        }
        _ if profile["settings"].is_string() => Err("The selected Claude settings file is missing".into()),
        _ => Ok(connection_settings(&json!({}))),
    }
}

fn profile_command(profile: &Value, settings: &Value) -> Result<Command, String> {
    if !custom_profile(profile) { return command(); }
    let executable = match profile["launcher"].as_str() {
        Some(path) if PathBuf::from(path).is_absolute() && PathBuf::from(path).is_file() => PathBuf::from(path),
        Some(_) => return Err("The selected Claude Code launcher is missing".into()),
        None => executable()?,
    };
    let mut cmd = Command::new(executable);
    // GUI apps often omit the user's CLI install directories from PATH.
    let mut paths: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        paths.push(PathBuf::from(home).join(".local/bin"));
    }
    if cfg!(unix) { paths.extend([PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")]); }
    cmd.env("PATH", std::env::join_paths(paths).map_err(|_| "Invalid executable search path")?).env_remove("CLAUDECODE");
    if let Some(env) = settings["env"].as_object() {
        for (key, value) in env { if let Some(value) = value.as_str() { cmd.env(key, value); } }
    }
    // The explicit Doop configuration takes precedence over settings-file env.
    if let Some(dir) = profile["configDir"].as_str() { cmd.env("CLAUDE_CONFIG_DIR", dir); }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    Ok(cmd)
}

fn restrict_agent(cmd: &mut Command, settings_file: &std::path::Path) {
    cmd.args(["--setting-sources", "", "--strict-mcp-config", "--tools", "", "--allowedTools", "mcp__doop__*",
        "--permission-mode", "dontAsk", "--disable-slash-commands", "--no-session-persistence", "--settings"])
        .arg(settings_file);
}

fn settings_file(settings: &Value) -> Result<tempfile::NamedTempFile, String> {
    let mut file = tempfile::NamedTempFile::new().map_err(|_| "Could not prepare Claude settings")?;
    let mut settings = settings.clone();
    settings.as_object_mut().ok_or("Invalid Claude settings")?.remove("env");
    serde_json::to_writer(file.as_file_mut(), &settings).map_err(|_| "Could not prepare Claude settings")?;
    Ok(file)
}

fn catalog_from_initialize(response: &Value) -> Vec<Value> {
    let mut seen = HashSet::new();
    response["models"].as_array().into_iter().flatten().filter_map(|model| {
        let id = model["value"].as_str()?;
        if !valid_model(id) || !seen.insert(id.to_owned()) { return None; }
        Some(json!({"id": id, "name": model["displayName"].as_str().unwrap_or(id),
            "blurb": model["description"].as_str().unwrap_or("")}))
    }).take(500).collect()
}

// Claude Code's SDK initialization handshake returns its effective model menu,
// including custom entries and gateway discovery, without an inference prompt.
fn probe_profile(profile: &Value, settings: &Value) -> Result<Value, String> {
    let settings_file = settings_file(settings)?;
    let mut cmd = profile_command(profile, settings)?;
    let working_dir = private_working_directory()?;
    cmd.current_dir(working_dir.path());
    restrict_agent(&mut cmd, settings_file.path());
    cmd.args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
        "--mcp-config", "{\"mcpServers\":{}}"]);
    cmd.stdin(Stdio::piped());
    let mut child = spawn_group(&mut cmd).map_err(|_| "Could not start the selected Claude Code launcher")?;
    let mut stdin = child.inner().stdin.take().ok_or("Missing Claude input")?;
    if writeln!(stdin, "{}", json!({"type":"control_request", "request_id":"doop-initialize", "request":{"subtype":"initialize"}})).is_err() {
        stop_child(&mut child); return Err("Could not initialize Claude Code".into());
    }
    let stop = Arc::new(AtomicBool::new(false));
    let mut initialized = None;
    let _ = collect(child, Duration::from_secs(30), stop.clone(), |line| {
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            if value["type"] == "control_response" && value["response"]["request_id"] == "doop-initialize" {
                if value["response"]["subtype"] == "success" { initialized = Some(value["response"]["response"].clone()); }
                stop.store(true, Ordering::SeqCst);
            }
        }
    });
    drop(stdin);
    initialized.ok_or("Could not read this profile's model options. Check its configuration and update Claude Code, then Refresh.".into())
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

fn spawn_group(cmd: &mut Command) -> std::io::Result<GroupChild> {
    let mut group = cmd.group();
    // The Windows implementation starts suspended, assigns the job, then resumes
    // execution. Descendants cannot escape supervision during launcher startup.
    #[cfg(windows)]
    group.kill_on_drop(true).creation_flags(0x08000000);
    group.spawn()
}

fn stop_child(child: &mut GroupChild) {
    let _ = child.kill();
    let _ = child.wait();
}

// Check the Unix leader without reaping it: its PID/process-group ID must remain
// reserved until descendants have been killed. Windows jobs use stable handles.
fn finish_exited_group(child: &mut GroupChild) -> std::io::Result<Option<std::process::ExitStatus>> {
    #[cfg(unix)]
    {
        // SAFETY: siginfo_t accepts zero initialization and waitid writes into a
        // valid, exclusively borrowed object. This function owns the child; no
        // other code waits for it. WNOWAIT preserves its PID until kill + wait.
        let exited = unsafe {
            let mut info: libc::siginfo_t = std::mem::zeroed();
            if libc::waitid(libc::P_PID, child.id() as libc::id_t, &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            info.si_pid() != 0
        };
        if !exited { return Ok(None); }
        let _ = child.kill();
        child.inner().wait().map(Some)
    }
    #[cfg(windows)]
    {
        let status = child.inner().try_wait()?;
        if status.is_some() { let _ = child.kill(); }
        Ok(status)
    }
}

fn collect(
    mut child: GroupChild,
    timeout: Duration,
    cancel: Arc<AtomicBool>,
    mut on_line: impl FnMut(&str),
) -> Result<bool, String> {
    let stdout = child.inner().stdout.take().ok_or("Missing CLI output")?;
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
    let mut leader_status = None;
    let result = loop {
        if leader_status.is_none() {
            match finish_exited_group(&mut child) {
                Ok(Some(status)) => { leader_status = Some(status); }
                Ok(None) => {},
                Err(error) => { stop_child(&mut child); break Err(error.to_string()); }
            }
        }
        if cancel.load(Ordering::SeqCst) || started.elapsed() > timeout {
            if leader_status.is_none() { stop_child(&mut child); }
            break Err("Claude run stopped or timed out. Retry when ready.".into());
        }
        match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(line)) => on_line(&line),
            Ok(Err(error)) => {
                if leader_status.is_none() { stop_child(&mut child); }
                break Err(error);
            },
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                if let Some(status) = leader_status { break Ok(status.success()); }
                std::thread::sleep(Duration::from_millis(50));
            },
            Err(_) => {}
        }
    };
    drop(receiver);
    let _ = reader.join();
    result
}

fn unavailable_status(enabled: bool, installed: bool, error: Option<String>) -> Value {
    json!({"installed": installed, "connected": false, "enabled": enabled,
        "modelDiscovery": true, "models": [], "configError": error})
}

fn profile_status(profile: &Value, enabled: bool) -> Result<Value, String> {
    let settings = profile_settings(profile)?;
    let mut cmd = match profile_command(profile, &settings) {
        Ok(cmd) => cmd,
        Err(error) if profile["launcher"].is_string() => return Err(error),
        Err(_) => return Ok(unavailable_status(enabled, false, None)),
    };
    let auth_settings = settings_file(&settings)?;
    let working_dir = private_working_directory()?;
    cmd.current_dir(working_dir.path()).args(["--setting-sources", "", "--settings"])
        .arg(auth_settings.path()).args(["auth", "status"]);
    let mut output = String::new();
    let ok = collect(spawn_group(&mut cmd).map_err(|_| "Could not start the configured Claude Code launcher")?,
        Duration::from_secs(20), Arc::new(AtomicBool::new(false)), |line| {
            if output.len() < 32_000 { output.push_str(line); }
        })?;
    let auth: Value = serde_json::from_str(&output).map_err(|_| "Claude Code returned an invalid authentication status")?;
    let connected = ok && auth["loggedIn"] == true;
    // Authentication failures must not trigger another CLI process or its timeout.
    let (models, warning) = if connected && custom_profile(profile) {
        match probe_profile(profile, &settings) {
            Ok(initialized) => (catalog_from_initialize(&initialized), None),
            Err(error) => (vec![], Some(error)),
        }
    } else { (vec![], None) };
    let mut status = json!({"installed": true, "connected": connected, "enabled": enabled,
        "email": auth["email"], "plan": auth["subscriptionType"], "authMethod": auth["authMethod"],
        "provider": auth["apiProvider"], "modelDiscovery": true,
        "customProfile": custom_profile(profile), "models": models, "modelWarning": warning});
    // Absent catalog retains the built-in subscription menu on old and new shells.
    if !custom_profile(profile) { status.as_object_mut().unwrap().remove("models"); }
    Ok(status)
}

#[tauri::command]
pub async fn claude_status(app: AppHandle, user_id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let enabled = enabled_users(&app)?.contains(&user_id);
        // Preserve consent and preference visibility when a local file is broken.
        // Runs still fail closed; the UI can explain the error and disconnect.
        Ok(match read_profile(&app).and_then(|profile| {
            let mut status = profile_status(&profile, enabled)?;
            if custom_profile(&profile) {
                status["model"] = json!(selected_model(&directory(&app)?.join("models.json"), &user_id)?);
            }
            Ok(status)
        }) {
            Ok(status) => status,
            Err(error) => unavailable_status(enabled, executable().is_ok(), Some(error)),
        })
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn claude_connect(app: AppHandle, user_id: String, enabled: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if user_id.is_empty() || user_id.len() > 256 { return Err("Invalid account".into()); }
        let mut users = enabled_users(&app)?;
        if enabled && !users.contains(&user_id) {
            let accepted = rfd::MessageDialog::new().set_title("Use local Claude for Doop?")
                .set_description("Doop will run your installed Claude CLI on this computer for this Doop account's canvas tasks, using your selected profile and its provider billing. Only Doop canvas tools are enabled. Tasks run while this desktop app is open.")
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
        let ok = collect(spawn_group(&mut cmd).map_err(|e| format!("Could not start the installer: {e}"))?,
            Duration::from_secs(600), Arc::new(AtomicBool::new(false)), |_| {})
            .map_err(|_| "Installation did not finish in time. Refresh to check, or use the installation guide.")?;
        if !ok { return Err("Installation failed. Check your internet connection or use the installation guide.".into()); }
        let mut verify = command()?;
        verify.arg("--version");
        let ok = collect(spawn_group(&mut verify).map_err(|e| e.to_string())?,
            Duration::from_secs(20), Arc::new(AtomicBool::new(false)), |_| {})?;
        if !ok { return Err("Claude Code was installed but could not start. See the installation guide.".into()); }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn claude_login(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let profile = read_profile(&app)?;
        let settings = profile_settings(&profile)?;
        let mut cmd = profile_command(&profile, &settings)?;
        let auth_settings = settings_file(&settings)?;
        cmd.current_dir(directory(&app)?).args(["--setting-sources", "", "--settings"]).arg(auth_settings.path()).args(["auth", "login"]);
        let ok = collect(
            spawn_group(&mut cmd).map_err(|e| e.to_string())?,
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
    let result = tauri::async_runtime::spawn_blocking(move || run_cli(&handle, &user_id, &job, cancel)).await;
    *state.active.lock().map_err(|e| e.to_string())? = None;
    result.map_err(|e| e.to_string())?
}

fn run_model<'a>(profile: &Value, model: &'a str) -> Result<Option<&'a str>, String> {
    if !valid_model(model) { return Err("Invalid model".into()); }
    if custom_profile(profile) { return Ok((model != "default").then_some(model)); }
    // Legacy aliases retain the subscription defaults used before custom profiles.
    match model {
        "default" | "sonnet" => Ok(Some("claude-sonnet-5")),
        "opus" => Ok(Some("claude-opus-5")),
        "claude-fable-5-1" | "claude-opus-5" | "claude-sonnet-5" | "claude-haiku-4-5-20251001" => Ok(Some(model)),
        _ => Err("Select a subscription model, or configure a custom profile in Doop claude.json.".into()),
    }
}

fn run_cli(app: &AppHandle, user_id: &str, job: &Value, cancel: Arc<AtomicBool>) -> Result<Value, String> {
    let id = field(job, "id")?;
    let token = field(job, "token")?;
    if token.len() != 64 || !token.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid run token".into());
    }
    let model = field(job, "model")?;
    if !valid_model(model) { return Err("Invalid model".into()); }
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
        let profile = read_profile(app)?;
        let selected = if custom_profile(&profile) {
            selected_model(&directory(app)?.join("models.json"), user_id)?
        } else { model.to_owned() };
        let settings = profile_settings(&profile)?;
        let settings_file = settings_file(&settings)?;
        let mut cmd = profile_command(&profile, &settings)?;
        restrict_agent(&mut cmd, settings_file.path());
        cmd.current_dir(&dir)
            .args(["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--max-turns", &turns.to_string()])
            .arg("--mcp-config")
            .arg(&config)
            .arg("--system-prompt-file")
            .arg(&system_path)
            .stdin(Stdio::piped());
        if let Some(model) = run_model(&profile, &selected)? {
            cmd.args(["--model", model]);
        }
        let mut child = spawn_group(&mut cmd).map_err(|e| e.to_string())?;
        if let Some(mut stdin) = child.inner().stdin.take() {
            if let Err(error) = stdin.write_all(prompt.as_bytes()) {
                stop_child(&mut child);
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
    #[test]
    fn local_config_defaults_and_validation() {
        assert_eq!(parse_profile(b"{}").unwrap(), json!({}));
        let absolute = std::env::temp_dir().join("claude-launcher");
        let config = json!({"launcher": absolute});
        assert_eq!(parse_profile(&serde_json::to_vec(&config).unwrap()).unwrap(), config);
        for invalid in [json!([]), json!({"launcher":"relative-command"}), json!({"launcher":false}), json!({"env":{}})] {
            assert!(parse_profile(&serde_json::to_vec(&invalid).unwrap()).is_err());
        }
    }

    #[test]
    fn profile_settings_keep_connections_but_not_hooks_tools_or_plugins() {
        let settings = connection_settings(&json!({
            "env": {"CLAUDE_CODE_USE_FOUNDRY":"1", "ANTHROPIC_MODEL":"deployment-a", "NODE_OPTIONS":"untrusted"},
            "modelPicker":{"replaceBuiltInOptions":true}, "availableModels":["deployment-a"],
            "apiKeyHelper":"credential-helper", "hooks":{"SessionStart":[]},
            "enabledPlugins":{"unrelated":true}, "permissions":{"defaultMode":"bypassPermissions"}
        }));
        assert_eq!(settings["env"]["ANTHROPIC_MODEL"], "deployment-a");
        assert_eq!(settings["availableModels"], json!(["deployment-a"]));
        assert_eq!(settings["apiKeyHelper"], "credential-helper");
        assert!(settings["env"]["NODE_OPTIONS"].is_null());
        assert!(settings["permissions"].is_null());
        assert!(settings["hooks"].is_null());
        assert_eq!(settings["disableAllHooks"], true);
        assert_eq!(settings["enabledPlugins"], json!({}));
    }

    #[test]
    fn discovered_models_preserve_custom_deployments_and_reject_invalid_ids() {
        let models = catalog_from_initialize(&json!({"models":[
            {"value":"team/deployment-v2", "displayName":"Team model", "resolvedModel":"team/deployment-v2"},
            {"value":"team/deployment-v2"}, {"value":"--settings"}, {"value":"bad\nmodel"}
        ]}));
        assert_eq!(models.len(), 1);
        assert_eq!(models[0]["id"], "team/deployment-v2");
        assert_eq!(models[0]["name"], "Team model");
        assert!(valid_model("arn:aws:bedrock:region:account:inference-profile/model"));
        assert!(valid_model("claude-opus-5-5[1m]"));
    }

    #[test]
    #[ignore = "Uses an explicitly selected local CLI profile; no inference request"]
    fn live_profile_model_discovery() {
        let launcher = std::env::var("DOOP_TEST_CLAUDE_LAUNCHER").expect("Set DOOP_TEST_CLAUDE_LAUNCHER");
        let profile = json!({"launcher":launcher});
        let settings = profile_settings(&profile).unwrap();
        let response = probe_profile(&profile, &settings).unwrap();
        let models = catalog_from_initialize(&response);
        assert!(!models.is_empty());
        if let Ok(expected) = std::env::var("DOOP_TEST_CLAUDE_MODEL") {
            assert!(models.iter().any(|m| m["id"] == expected), "Expected profile model not discovered");
        }
        println!("Discovered {} profile models", models.len());
    }

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
            .group_spawn()
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
            .group_spawn()
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
            .group_spawn().unwrap();
        let started = Instant::now();
        let error = collect(child, Duration::from_secs(15), Arc::new(AtomicBool::new(false)), |_| {}).unwrap_err();
        assert!(error.contains("2 MB"));
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn default_connection_does_not_import_profile_settings_or_credentials() {
        let profile = json!({});
        assert!(!custom_profile(&profile));
        assert_eq!(profile_settings(&profile).unwrap(), json!({"disableAllHooks":true,"enabledPlugins":{}}));
        let mut cmd = Command::new("not-executed");
        subscription_environment(&mut cmd);
        let removed: Vec<_> = cmd.get_envs().filter(|(_, v)| v.is_none()).map(|(k, _)| k.to_string_lossy().into_owned()).collect();
        for key in ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CONFIG_DIR"] {
            assert!(removed.iter().any(|k| k == key));
        }
        assert_eq!(run_model(&profile, "default").unwrap(), Some("claude-sonnet-5"));
        assert_eq!(run_model(&profile, "sonnet").unwrap(), Some("claude-sonnet-5"));
        assert_eq!(run_model(&profile, "opus").unwrap(), Some("claude-opus-5"));
        assert!(run_model(&profile, "team/deployment-v2").is_err());
        let custom = json!({"configDir":"/configured/profile"});
        assert_eq!(run_model(&custom, "default").unwrap(), None);
        assert_eq!(run_model(&custom, "opus").unwrap(), Some("opus"));
        assert_eq!(run_model(&custom, "team/deployment-v2").unwrap(), Some("team/deployment-v2"));
    }

    #[test]
    fn model_validation_matches_the_web_contract() {
        for valid in ["default", "team/deployment-v2", "claude-opus-5-5[1m]", "arn:aws:bedrock:region:account:inference-profile/model"] {
            assert!(valid_model(valid));
        }
        for invalid in ["", "--settings", "bad\nmodel", "two words", "model;command", "é-model", "model\\path"] {
            assert!(!valid_model(invalid));
        }
        assert!(valid_model(&"a".repeat(256)));
        assert!(!valid_model(&"a".repeat(257)));
    }

    #[test]
    fn provider_settings_preserve_network_and_auth_configuration() {
        let mut env = serde_json::Map::new();
        for key in ["HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "CLAUDE_CODE_CLIENT_KEY", "CLAUDE_CODE_SKIP_FOUNDRY_AUTH", "CLAUDE_CODE_SKIP_BEDROCK_AUTH", "CLAUDE_CODE_SKIP_VERTEX_AUTH", "VERTEX_REGION_CLAUDE_OPUS_4_6", "API_TIMEOUT_MS", "CLAUDE_CODE_MAX_OUTPUT_TOKENS"] {
            env.insert(key.into(), json!("configured"));
        }
        let settings = connection_settings(&json!({"env":env}));
        assert_eq!(settings["env"], json!(env));
        for key in ["NODE_OPTIONS", "PATH", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"] { assert!(!provider_env(key)); }
    }

    #[cfg(unix)]
    #[test]
    fn explicit_config_directory_overrides_settings_environment() {
        let dir = tempfile::tempdir().unwrap();
        let profile = json!({"launcher":"/bin/sh", "configDir":dir.path()});
        let cmd = profile_command(&profile, &json!({"env":{"CLAUDE_CONFIG_DIR":"/wrong","HTTPS_PROXY":"https://proxy.test"}})).unwrap();
        let env: std::collections::HashMap<_, _> = cmd.get_envs().collect();
        assert_eq!(env.get(std::ffi::OsStr::new("CLAUDE_CONFIG_DIR")), Some(&Some(dir.path().as_os_str())));
        assert_eq!(env.get(std::ffi::OsStr::new("HTTPS_PROXY")), Some(&Some(std::ffi::OsStr::new("https://proxy.test"))));
    }

    #[test]
    fn invalid_configuration_keeps_disconnect_available() {
        let dir = tempfile::tempdir().unwrap();
        let error = profile_status(&json!({"launcher":dir.path().join("missing-launcher")}), true).unwrap_err();
        assert!(error.contains("launcher is missing"));
        let status = unavailable_status(true, true, Some(error));
        assert_eq!(status["enabled"], true);
        assert_eq!(status["connected"], false);
        assert!(status["configError"].is_string());
        assert!(parse_profile(b"invalid json").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn signed_out_profiles_do_not_start_model_discovery() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let launcher = dir.path().join("launcher");
        let calls = dir.path().join("calls");
        let source = format!("#!/bin/sh\necho call >> '{}'\nprintf '{{\"loggedIn\":false,\"apiProvider\":\"foundry\"}}\\n'\nexit 1\n", calls.display());
        std::fs::write(&launcher, source).unwrap();
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o700)).unwrap();
        let settings = dir.path().join("settings.json");
        std::fs::write(&settings, "{}").unwrap();
        let status = profile_status(&json!({"launcher":launcher,"settings":settings}), true).unwrap();
        assert_eq!(status["connected"], false);
        assert_eq!(status["enabled"], true);
        assert_eq!(status["customProfile"], true);
        assert_eq!(std::fs::read_to_string(calls).unwrap(), "call\n");
    }

    #[cfg(unix)]
    #[test]
    fn launcher_descendants_are_stopped_after_normal_exit_and_cancellation() {
        for cancel in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let sentinel = dir.path().join("leaked");
            let script = if cancel {
                "(sleep 3; touch \"$1\") & echo ready; wait"
            } else {
                "(sleep 3; touch \"$1\") & echo ready"
            };
            let mut command = Command::new("/bin/sh");
            command.args(["-c", script, "test"]).arg(&sentinel).stdout(Stdio::piped());
            let child = spawn_group(&mut command).unwrap();
            let stop = Arc::new(AtomicBool::new(false));
            let started = Instant::now();
            let result = collect(child, Duration::from_secs(5), stop.clone(), |line| {
                if cancel && line == "ready" { stop.store(true, Ordering::SeqCst); }
            });
            assert_eq!(result.is_err(), cancel);
            // well under the descendant's 3s sleep, with room for a slow CI runner
            assert!(started.elapsed() < Duration::from_secs(2));
            std::thread::sleep(Duration::from_millis(3200));
            assert!(!sentinel.exists(), "launcher descendant survived cleanup");
        }
    }

    #[test]
    fn custom_model_selections_are_local_per_user_and_written_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("models.json");
        assert_eq!(selected_model(&path, "alice").unwrap(), "default");
        save_model(&path, "alice", "team/deployment-v2").unwrap();
        save_model(&path, "bob", "opus").unwrap();
        assert_eq!(selected_model(&path, "alice").unwrap(), "team/deployment-v2");
        assert_eq!(selected_model(&path, "bob").unwrap(), "opus");
        assert!(save_model(&path, "alice", "--settings").is_err());
        assert_eq!(selected_model(&path, "alice").unwrap(), "team/deployment-v2");
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        std::fs::write(&path, "broken JSON").unwrap();
        assert!(selected_model(&path, "alice").is_err());
        assert!(save_model(&path, "alice", "model").is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "broken JSON");
    }

    #[cfg(unix)]
    #[test]
    fn probe_working_directory_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = private_working_directory().unwrap();
        assert_eq!(std::fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777, 0o700);
    }

    #[test]
    fn run_ids_cannot_escape_the_task_directory() {
        assert!(valid_id("12345678-1234-1234-1234-123456789abc"));
        assert!(!valid_id("../../../../tmp/foreign"));
        assert!(!valid_id("https://example.com"));
    }
}
