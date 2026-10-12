//! Ryfe — a small machine that lives at the top of the screen.
//!
//! Four things live in this process, and they are deliberately kept apart:
//!
//! * the **island** window (`island.rs`) — an always-on-top capsule that never
//!   takes focus and costs nothing while it is collapsed;
//! * **credentials** (`secrets.rs`) — in the OS store, never on disk, and with
//!   no read path exposed to the webview;
//! * **preferences** (`settings.rs`) — a salvaged JSON file;
//! * the **integrations** (git, GitHub, DeepSeek) — each in its own module,
//!   reached only through commands.

mod ai;
mod git;
mod github;
mod island;
mod platform;
mod secrets;
mod settings;

use std::sync::Arc;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use island::{Hit, Rect, Size};

// ---------------------------------------------------------------------------
// Island commands
// ---------------------------------------------------------------------------

/// The front end tells us where the island's visible box is after every layout
/// change. Rust needs it to decide what is clickable and what falls through.
#[tauri::command]
fn island_set_rect(hit: tauri::State<'_, Arc<Hit>>, rect: Rect) {
    hit.set_rect(rect);
}

/// Resizes the window to fit a state, and parks the cursor poll when hidden.
#[tauri::command]
fn island_set_size(
    app: AppHandle,
    hit: tauri::State<'_, Arc<Hit>>,
    size: Size,
) -> Result<(), String> {
    island::place(&app, size).map_err(|e| e.to_string())?;
    island::set_polling(&hit, size != Size::Hidden);
    Ok(())
}

/// The user dragged the island to a size of their own. Only ever called while it
/// is open, and it resizes the window at the same time — the island cannot grow
/// past the window it is drawn in.
#[tauri::command]
fn island_set_open_size(app: AppHandle, w: f64, h: f64) -> Result<(), String> {
    island::set_open_size(w, h);
    island::place(&app, Size::Open).map_err(|e| e.to_string())
}

/// Lets the island hold the keyboard while a text field is on screen, and gives
/// it straight back. Nothing else can make the island steal focus.
#[tauri::command]
fn focus_window(window: WebviewWindow, focused: bool) -> Result<(), String> {
    platform::set_activating(&window, focused).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

/// Settings is a view inside the island, not a window of its own, so the tray
/// just asks the island to bring it up.
fn show_settings(app: &AppHandle) {
    let _ = app.emit("open-settings", ());
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Ryfe", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Ryfe", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &settings_item, &quit])?;

    let mut tray = TrayIconBuilder::with_id("ryfe").tooltip("Ryfe").menu(&menu);

    // The icon comes from the bundle. If it is somehow missing, still build the
    // tray rather than refusing to start over a cosmetic problem.
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }

    tray.on_menu_event(|app, event| match event.id.as_ref() {
        "quit" => app.exit(0),
        "open" => {
            let _ = app.emit("tray-open", ());
        }
        "settings" => show_settings(app),
        _ => {}
    })
    .build(app)?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

pub fn run() {
    let hit = Arc::new(Hit::new());
    let hit_for_setup = hit.clone();

    tauri::Builder::default()
        // A second launch just reopens the island instead of starting a rival
        // copy that would fight over the tray icon and the cursor poll.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let _ = app.emit("tray-open", ());
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(hit)
        .invoke_handler(tauri::generate_handler![
            island_set_rect,
            island_set_size,
            island_set_open_size,
            focus_window,
            platform::open_url,
            settings::settings_get,
            settings::settings_set,
            secrets::secret_present,
            secrets::secret_set,
            secrets::secret_clear,
            secrets::secret_status,
            git::git_repos,
            git::git_status,
            git::git_diff,
            git::git_preview,
            git::git_publish_check,
            git::git_run,
            git::file_write,
            github::gh_pulse,
            github::gh_activity,
            github::gh_create_repo,
            github::gh_forget,
            ai::ai_models,
            ai::ai_send,
            ai::ai_reset,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();

            settings::init(app.handle());

            // The island is created hidden for exactly this reason: applying
            // WS_EX_NOACTIVATE to a window that is already on screen does not
            // take effect, and the island would keep stealing focus from
            // whatever the user is typing into. Style first, then show.
            // Asserts WS_EX_NOACTIVATE and WS_EX_TOOLWINDOW once at startup; the
            // cursor poll re-asserts them on every click-through change, so they
            // cannot drift. The window itself is shown by Tauri from the config —
            // showing it by hand leaves the webview's geometry out of step and it
            // stops receiving clicks entirely.
            if let Some(win) = app.get_webview_window("island") {
                platform::set_accept_mouse(&win, true).map_err(std::io::Error::other)?;
            }

            build_tray(&handle)?;
            island::place(&handle, Size::Compact)?;
            island::spawn_cursor_poll(handle.clone(), hit_for_setup.clone());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Ryfe failed to start");
}
