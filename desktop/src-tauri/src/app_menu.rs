//! The macOS menu bar, built by the page from its action registry
//! (src/lib/appMenu.ts), as Figma's desktop app mirrors its menus: File,
//! Edit, View, Object, Text, Arrange and Help, each command with its label in
//! the page's language and its chord as the key equivalent.
//!
//! The page sends the menus through `app_menu_set` (on load, and again when
//! its language changes) and afterwards only the items whose enabled or
//! checked state moved, through `app_menu_state`. The shell keeps what is its
//! own around them: the app menu, Close Tab, the system's Undo / Redo / Cut /
//! Copy / Paste / Select All (what makes those keys reach a text field), Full
//! Screen and Window. A picked item is relayed as an `app-menu` event,
//! `{ id, key }`, `key` saying a key equivalent fired it rather than a click,
//! so the page can keep its keyboard's rules for it (nothing while typing in
//! a field, for one).
//!
//! The webview sees a key before the menu does: the menu only gets the key
//! equivalents the page left unhandled, so a chord the canvas takes runs
//! once, and a key typed into a field still types.
//!
//! Until the page calls `app_menu_set` the bar is `build_menu`'s, with the
//! fixed View menu (src/view_menu.rs) an older page still drives. Windows and
//! Linux have no menu bar; there the commands find nothing to do.

#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::menu::{CheckMenuItem, MenuItem};
#[cfg(target_os = "macos")]
use tauri::menu::{IsMenuItem, Menu, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager};

use crate::ShellRuntime;

pub const EVENT: &str = "app-menu";
const PREFIX: &str = "action:";

/// One menu as the page describes it; a `null` item is a separator.
#[derive(Deserialize)]
pub struct MenuSpec {
    id: String,
    label: String,
    items: Vec<Option<ItemSpec>>,
}

#[derive(Deserialize)]
struct ItemSpec {
    id: String,
    label: String,
    /// a Tauri accelerator such as "Alt+Cmd+KeyG"
    accelerator: Option<String>,
    checkable: bool,
}

/// An item's state as the page reports it: id, enabled, checked (null for an
/// item that is not a toggle).
type ItemState = (String, bool, Option<bool>);

#[derive(Serialize, Clone)]
struct Picked<'a> {
    id: &'a str,
    key: bool,
}

enum Item {
    Plain(MenuItem<ShellRuntime>),
    Check(CheckMenuItem<ShellRuntime>),
}

/// The page's items in the bar, by action id.
#[derive(Default)]
pub struct AppMenu(Mutex<HashMap<String, Item>>);

/// An item the page asked for. An accelerator the menu cannot parse leaves
/// the item without one rather than the bar without the menu.
#[cfg(target_os = "macos")]
fn page_item(
    app: &AppHandle,
    spec: &ItemSpec,
) -> tauri::Result<(Box<dyn IsMenuItem<ShellRuntime>>, Item)> {
    let id = format!("{PREFIX}{}", spec.id);
    let id = id.as_str();
    let accelerator = spec.accelerator.as_deref();
    if spec.checkable {
        let item = CheckMenuItem::with_id(app, id, &spec.label, false, false, accelerator)
            .or_else(|_| {
                CheckMenuItem::with_id(app, id, &spec.label, false, false, None::<&str>)
            })?;
        Ok((Box::new(item.clone()), Item::Check(item)))
    } else {
        let item = MenuItem::with_id(app, id, &spec.label, false, accelerator)
            .or_else(|_| MenuItem::with_id(app, id, &spec.label, false, None::<&str>))?;
        Ok((Box::new(item.clone()), Item::Plain(item)))
    }
}

/// One of the page's menus, with the shell's own rows where they belong.
#[cfg(target_os = "macos")]
fn submenu(
    app: &AppHandle,
    spec: &MenuSpec,
    items: &mut HashMap<String, Item>,
) -> tauri::Result<Submenu<ShellRuntime>> {
    let mut rows: Vec<Box<dyn IsMenuItem<ShellRuntime>>> = Vec::new();
    if spec.id == "edit" {
        rows.extend(crate::text_edit_items(app)?.0);
        rows.push(Box::new(PredefinedMenuItem::separator(app)?));
    }
    for entry in &spec.items {
        match entry {
            Some(item) => {
                let (row, handle) = page_item(app, item)?;
                rows.push(row);
                items.insert(item.id.clone(), handle);
            }
            None => rows.push(Box::new(PredefinedMenuItem::separator(app)?)),
        }
    }
    match spec.id.as_str() {
        "file" => {
            rows.push(Box::new(PredefinedMenuItem::separator(app)?));
            rows.push(Box::new(crate::close_tab_item(app)?));
        }
        "view" => {
            rows.push(Box::new(PredefinedMenuItem::separator(app)?));
            rows.push(Box::new(PredefinedMenuItem::fullscreen(app, None)?));
        }
        _ => {}
    }
    let refs: Vec<&dyn IsMenuItem<ShellRuntime>> = rows.iter().map(|row| row.as_ref()).collect();
    Submenu::with_items(app, &spec.label, true, &refs)
}

/// The whole bar: the app menu, the page's menus, and Window before Help.
#[cfg(target_os = "macos")]
fn build(
    app: &AppHandle,
    menus: &[MenuSpec],
) -> tauri::Result<(Menu<ShellRuntime>, HashMap<String, Item>)> {
    let mut items = HashMap::new();
    let mut bar = vec![crate::app_submenu(app)?];
    let mut window = Some(crate::window_submenu(app)?);
    for spec in menus {
        let menu = submenu(app, spec, &mut items)?;
        if spec.id == "help" {
            bar.extend(window.take());
            menu.set_as_help_menu_for_nsapp()?;
        }
        bar.push(menu);
    }
    bar.extend(window);
    let refs: Vec<&dyn IsMenuItem<ShellRuntime>> = bar
        .iter()
        .map(|menu| menu as &dyn IsMenuItem<ShellRuntime>)
        .collect();
    Ok((Menu::with_items(app, &refs)?, items))
}

/// The page's menus become the bar.
#[tauri::command]
pub fn app_menu_set(app: AppHandle, menus: Vec<MenuSpec>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let (menu, items) = build(&app, &menus).map_err(|e| e.to_string())?;
        app.set_menu(menu).map_err(|e| e.to_string())?;
        let state = app.state::<AppMenu>();
        *state.0.lock().unwrap_or_else(|e| e.into_inner()) = items;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, menus);
    Ok(())
}

/// What the page's items show now; ids the bar does not hold are skipped.
#[tauri::command]
pub fn app_menu_state(app: AppHandle, items: Vec<ItemState>) {
    let state = app.state::<AppMenu>();
    let menu = state.0.lock().unwrap_or_else(|e| e.into_inner());
    for (id, enabled, checked) in items {
        match menu.get(&id) {
            Some(Item::Plain(item)) => {
                let _ = item.set_enabled(enabled);
            }
            Some(Item::Check(item)) => {
                let _ = item.set_enabled(enabled);
                let _ = item.set_checked(checked.unwrap_or(false));
            }
            None => {}
        }
    }
}

/// Relays one of the page's items to it; any other menu id is ignored.
pub fn relay(app: &AppHandle, id: &str) {
    if let Some(id) = id.strip_prefix(PREFIX) {
        let _ = app.emit(
            EVENT,
            Picked {
                id,
                key: fired_by_key(),
            },
        );
    }
}

/// Whether the event AppKit is handling is a key press: a key equivalent
/// picked the item, not the pointer.
#[cfg(target_os = "macos")]
fn fired_by_key() -> bool {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSEventType};

    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };
    NSApplication::sharedApplication(mtm)
        .currentEvent()
        .is_some_and(|event| event.r#type() == NSEventType::KeyDown)
}

#[cfg(not(target_os = "macos"))]
fn fired_by_key() -> bool {
    false
}
