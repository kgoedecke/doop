//! The macOS View menu: canvas view toggles and zoom, run by the page.
//!
//! Every item is relayed to the page as a `view-command` event whose payload
//! is the part of its id after `view:` (src/lib/viewMenu.ts lists them). The
//! page owns the state, so it reports it back through `view_menu_state`
//! whenever it changes: the checkmarks follow it, and the canvas-only items
//! are disabled while no canvas is open.
//!
//! Only the ⌘ shortcuts are bound here. A binding takes the keystroke before
//! the page sees it, so ⇧R / ⇧1 / ⇧2 stay with the page: bound here they
//! would swallow a capital R or a "!" typed into any field.
//!
//! Windows has no menu bar; the command is registered there too and finds no
//! menu to update.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use tauri::menu::{CheckMenuItem, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Wry};

pub const EVENT: &str = "view-command";
const PREFIX: &str = "view:";

struct ViewMenu {
    rulers: CheckMenuItem<Wry>,
    ui: CheckMenuItem<Wry>,
    layers: CheckMenuItem<Wry>,
    agents: CheckMenuItem<Wry>,
    /// enabled whenever a canvas is open
    zoom: Vec<MenuItem<Wry>>,
    /// enabled while something on the canvas is selected
    selection: MenuItem<Wry>,
}

fn check(
    app: &AppHandle,
    command: &str,
    label: &str,
    accelerator: Option<&str>,
) -> tauri::Result<CheckMenuItem<Wry>> {
    CheckMenuItem::with_id(
        app,
        format!("{PREFIX}{command}"),
        label,
        false,
        false,
        accelerator,
    )
}

fn item(
    app: &AppHandle,
    command: &str,
    label: &str,
    accelerator: Option<&str>,
) -> tauri::Result<MenuItem<Wry>> {
    MenuItem::with_id(app, format!("{PREFIX}{command}"), label, false, accelerator)
}

/// The View submenu. Everything starts unchecked and disabled until the
/// page reports a canvas.
pub fn submenu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    let menu = ViewMenu {
        rulers: check(app, "rulers", "Rulers", None)?,
        ui: check(app, "ui", "Show/Hide UI", Some("Cmd+."))?,
        layers: check(app, "layers", "Layers Panel", None)?,
        agents: check(app, "agents", "Agents Panel", None)?,
        zoom: vec![
            item(app, "zoom-in", "Zoom In", Some("Cmd+="))?,
            item(app, "zoom-out", "Zoom Out", Some("Cmd+-"))?,
            item(app, "zoom-reset", "Zoom to 100%", Some("Cmd+0"))?,
            item(app, "zoom-fit", "Zoom to Fit", None)?,
        ],
        selection: item(app, "zoom-selection", "Zoom to Selection", None)?,
    };
    let separator = || PredefinedMenuItem::separator(app);
    let submenu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &menu.rulers,
            &separator()?,
            &menu.ui,
            &menu.layers,
            &menu.agents,
            &separator()?,
            &menu.zoom[0],
            &menu.zoom[1],
            &menu.zoom[2],
            &menu.zoom[3],
            &menu.selection,
            &separator()?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    app.manage(menu);
    Ok(submenu)
}

/// Relays a View item to the page; any other menu id is ignored.
pub fn relay(app: &AppHandle, id: &str) {
    if let Some(command) = id.strip_prefix(PREFIX) {
        let _ = app.emit(EVENT, command);
    }
}

/// The page's view state, mirrored into the menu. `ui_toggle` is false
/// where ⌘. has nothing to hide (the board view, presenting).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn view_menu_state(
    app: AppHandle,
    canvas: bool,
    rulers: bool,
    ui: bool,
    ui_toggle: bool,
    layers: bool,
    agents: bool,
    selection: bool,
) {
    let Some(menu) = app.try_state::<ViewMenu>() else {
        return;
    };
    for (entry, checked, enabled) in [
        (&menu.rulers, rulers, canvas),
        (&menu.ui, ui, canvas && ui_toggle),
        (&menu.layers, layers, canvas),
        (&menu.agents, agents, canvas),
    ] {
        let _ = entry.set_checked(checked && canvas);
        let _ = entry.set_enabled(enabled);
    }
    for entry in &menu.zoom {
        let _ = entry.set_enabled(canvas);
    }
    let _ = menu.selection.set_enabled(canvas && selection);
}
