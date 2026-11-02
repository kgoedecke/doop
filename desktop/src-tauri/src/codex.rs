//! Register this Doop instance in the configuration shared by Codex clients.
//! This only installs the MCP URL; Codex owns OAuth and its credentials.
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Manager, Url, WebviewWindow};
use toml_edit::{value, DocumentMut, Item, Table};

static CONFIG_WRITE: Mutex<()> = Mutex::new(());

fn config_path(home: &Path, override_home: Option<PathBuf>) -> Result<PathBuf, String> {
    let directory = match override_home {
        Some(path) if !path.as_os_str().is_empty() => {
            if !path.is_absolute() || !path.is_dir() {
                return Err("CODEX_HOME must point to an existing absolute directory.".into());
            }
            path
        }
        _ => home.join(".codex"),
    };
    Ok(directory.join("config.toml"))
}

fn mcp_url(mut page: Url) -> Result<String, String> {
    if !matches!(page.scheme(), "http" | "https")
        || page.host_str().is_none()
        || !page.username().is_empty()
        || page.password().is_some()
    {
        return Err("Open your Doop server before connecting Codex.".into());
    }
    page.set_path("/mcp");
    page.set_query(None);
    page.set_fragment(None);
    Ok(page.to_string())
}

fn edit_config(text: &str, url: &str) -> Result<String, String> {
    // Parse errors can quote lines containing credentials. Keep them local,
    // and return only an actionable message to the hosted page.
    let mut document = text.parse::<DocumentMut>().map_err(|_| {
        "Your Codex config is not valid TOML. Fix it in Codex settings, then try again.".to_string()
    })?;
    if document.get("mcp_servers").is_none() {
        let mut servers = Table::new();
        servers.set_implicit(true);
        document["mcp_servers"] = Item::Table(servers);
    }
    let inline = document["mcp_servers"].as_inline_table().is_some();
    let servers = document["mcp_servers"].as_table_like_mut().ok_or(
        "The mcp_servers setting in your Codex config must be a table. Fix it in Codex settings, then try again.",
    )?;
    if let Some(existing) = servers.get_mut("doop") {
        let connection = existing.as_table_like_mut().ok_or(
            "The doop entry in your Codex config is not a server. Rename or remove it in Codex settings, then try again.",
        )?;
        if connection.get("url").and_then(Item::as_str) != Some(url)
            || connection.contains_key("command")
            || connection.contains_key("args")
        {
            return Err("Codex already has a different doop connection. Rename or remove it in Codex settings, then try again. Your settings were not changed.".into());
        }
        // Keep existing credentials, tool policies and custom timeouts.
        if connection.get("enabled").and_then(Item::as_bool) == Some(false) {
            connection.insert("enabled", value(true));
        } else {
            return Ok(text.to_string());
        }
    } else {
        // Inline mcp_servers tables need an inline value; ordinary tables can
        // have the readable [mcp_servers.doop] child table.
        if inline {
            let mut entry = toml_edit::InlineTable::new();
            entry.insert("url", url.into());
            servers.insert("doop", Item::Value(entry.into()));
        } else {
            let mut entry = Table::new();
            entry["url"] = value(url);
            servers.insert("doop", Item::Table(entry));
        }
    }
    Ok(document.to_string())
}

fn read_config(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(_) => Err(
            "Could not read your Codex config. Check its file permissions and try again.".into(),
        ),
    }
}

fn install_at(path: &Path, url: &str) -> Result<(), String> {
    let _lock = CONFIG_WRITE
        .lock()
        .map_err(|_| "Codex setup is busy. Try again.")?;
    // Follow an existing dotfile symlink instead of replacing the link itself.
    // Broken links fail closed so they cannot be replaced accidentally.
    let path = match fs::symlink_metadata(path) {
        Ok(_) => fs::canonicalize(path).map_err(|_| "Could not resolve your Codex config file.")?,
        Err(error) if error.kind() == ErrorKind::NotFound => path.to_path_buf(),
        Err(_) => return Err("Could not access your Codex config file.".into()),
    };
    let before = read_config(&path)?;
    let edited = edit_config(before.as_deref().unwrap_or(""), url)?;
    if before.as_deref() == Some(&edited) {
        return Ok(());
    }
    let directory = path
        .parent()
        .ok_or("Could not locate your Codex config directory.")?;
    fs::create_dir_all(directory).map_err(|_| "Could not create your Codex config directory.")?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory)
        .map_err(|_| "Could not prepare your Codex config. Check its file permissions.")?;
    if before.is_some() {
        let permissions = fs::metadata(&path)
            .map_err(|_| "Could not read your Codex config permissions.")?
            .permissions();
        temporary
            .as_file()
            .set_permissions(permissions)
            .map_err(|_| "Could not preserve your Codex config permissions.")?;
    }
    temporary
        .write_all(edited.as_bytes())
        .map_err(|_| "Could not write your Codex config.")?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| "Could not save your Codex config.")?;
    if read_config(&path)? != before {
        return Err("Your Codex config changed during setup. Please try again.".into());
    }
    temporary.persist(&path).map_err(|_| {
        "Could not replace your Codex config. Check its file permissions and try again."
    })?;
    Ok(())
}

#[tauri::command]
pub async fn codex_add_mcp(window: WebviewWindow) -> Result<(), String> {
    let url = mcp_url(
        window
            .url()
            .map_err(|_| "Could not read the current Doop server.")?,
    )?;
    let home = window
        .path()
        .home_dir()
        .map_err(|_| "Could not find your home directory.")?;
    let path = config_path(&home, std::env::var_os("CODEX_HOME").map(PathBuf::from))?;
    tauri::async_runtime::spawn_blocking(move || install_at(&path, &url))
        .await
        .map_err(|_| "Codex setup could not finish. Please try again.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "https://doop.design/mcp";

    #[test]
    fn preserves_settings_comments_and_other_servers_and_is_idempotent() {
        let before = "# My settings\nmodel = 'example'\n\n[mcp_servers.paper]\ncommand = '/path/paper' # keep me\nargs = ['mcp']\n";
        let after = edit_config(before, URL).unwrap();
        assert!(after.starts_with(before));
        assert_eq!(
            after.parse::<DocumentMut>().unwrap()["mcp_servers"]["doop"]["url"].as_str(),
            Some(URL)
        );
        assert_eq!(edit_config(&after, URL).unwrap(), after);
    }

    #[test]
    fn keeps_existing_credentials_and_enables_same_server() {
        let before = "[mcp_servers.doop]\nurl = 'https://doop.design/mcp'\nenabled = false\nbearer_token_env_var = 'DOOP_TOKEN'\n";
        let after = edit_config(before, URL).unwrap();
        let parsed = after.parse::<DocumentMut>().unwrap();
        assert_eq!(
            parsed["mcp_servers"]["doop"]["enabled"].as_bool(),
            Some(true)
        );
        assert_eq!(
            parsed["mcp_servers"]["doop"]["bearer_token_env_var"].as_str(),
            Some("DOOP_TOKEN")
        );
    }

    #[test]
    fn rejects_invalid_or_conflicting_config_without_exposing_contents() {
        for text in [
            "secret = invalid-secret",
            "mcp_servers = 3",
            "[mcp_servers]\ndoop = 3",
            "[mcp_servers.doop]\ncommand = 'something'",
            "[mcp_servers.doop]\nurl = 'https://other.example/mcp'",
            "[mcp_servers.doop]\nurl = 'https://doop.design/mcp'\ncommand = 'something'",
        ] {
            let error = edit_config(text, URL).unwrap_err();
            assert!(!error.contains("invalid-secret"));
            assert!(!error.contains("something"));
        }
    }

    #[test]
    fn supports_inline_and_empty_tables() {
        for text in [
            "",
            "# comment only\n",
            "mcp_servers = {}\n",
            "mcp_servers = { paper = { command = 'paper' } }\n",
        ] {
            let after = edit_config(text, URL).unwrap();
            assert_eq!(
                after.parse::<DocumentMut>().unwrap()["mcp_servers"]["doop"]["url"].as_str(),
                Some(URL)
            );
            assert_eq!(edit_config(&after, URL).unwrap(), after);
        }
    }

    #[test]
    fn derives_endpoint_from_the_webview_and_drops_page_parameters() {
        assert_eq!(
            mcp_url(Url::parse("https://doop.design/c/123?token=secret#fragment").unwrap())
                .unwrap(),
            URL
        );
        assert_eq!(
            mcp_url(Url::parse("http://localhost:4301/auth").unwrap()).unwrap(),
            "http://localhost:4301/mcp"
        );
        for invalid in [
            "file:///tmp/app",
            "https://user:pass@doop.design",
            "doop://connect/codex",
        ] {
            assert!(mcp_url(Url::parse(invalid).unwrap()).is_err());
        }
    }

    #[test]
    fn honors_codex_home_and_rejects_invalid_overrides() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(
            config_path(home.path(), None).unwrap(),
            home.path().join(".codex/config.toml")
        );
        assert_eq!(
            config_path(home.path(), Some(home.path().to_path_buf())).unwrap(),
            home.path().join("config.toml")
        );
        assert!(config_path(home.path(), Some(PathBuf::from("relative"))).is_err());
        assert!(config_path(home.path(), Some(home.path().join("missing"))).is_err());
    }

    #[test]
    fn writes_atomically_and_leaves_conflicting_files_untouched() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join(".codex/config.toml");
        install_at(&path, URL).unwrap();
        let installed = fs::read_to_string(&path).unwrap();
        install_at(&path, URL).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), installed);
        assert!(install_at(&path, "https://another.example/mcp").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), installed);
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn preserves_symlinks_and_private_permissions() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("actual.toml");
        let link = directory.path().join("config.toml");
        fs::write(&target, "# My config\n").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        symlink(&target, &link).unwrap();
        install_at(&link, URL).unwrap();
        assert!(fs::symlink_metadata(&link).unwrap().is_symlink());
        assert!(fs::read_to_string(&target).unwrap().contains(URL));
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let new_path = directory.path().join("new.toml");
        install_at(&new_path, URL).unwrap();
        assert_eq!(
            fs::metadata(&new_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
