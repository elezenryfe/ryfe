//! Ryfe's own preferences.
//!
//! Two rules, both learned from watching a config file go wrong:
//!
//! * **Salvage field by field.** If the file parses but one value is the wrong
//!   shape, only that field falls back to its default. Losing every other
//!   setting because one number arrived as a string is not acceptable.
//! * **Never overwrite what could not be read.** A file we failed to parse is
//!   copied aside before anything writes, so a hand-edit is never silently lost.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Folders to look for git repositories under, recursively.
    pub repo_roots: Vec<String>,
    /// The GitHub account to show in the pull-request panel. Filled from the
    /// token on first successful call if left empty.
    pub github_login: String,
    pub deepseek_base_url: String,
    /// Read from the API at startup; this is only the remembered choice.
    pub deepseek_model: String,
    /// Open the island when the pointer rests on it, rather than requiring a click.
    pub open_on_hover: bool,
    /// Start Ryfe when Windows starts. Off until asked for — it writes a
    /// registry entry, which is not something to do behind someone's back.
    pub autostart: bool,
    pub sound: bool,
    /// Which character is animating in the island.
    pub pet: String,
    /// Where the island sits along the top edge: "left", "center" or "right".
    ///
    /// Defaults to "right" because Coucou — the app this one learned from —
    /// occupies the entire top-centre and swallows clicks aimed at anything
    /// underneath it. Two always-on-top overlays cannot share that spot.
    pub island_position: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            repo_roots: vec!["C:\\elezen_ryfe-github".to_string()],
            github_login: String::new(),
            deepseek_base_url: "https://api.deepseek.com".to_string(),
            deepseek_model: "deepseek-flash".to_string(),
            open_on_hover: false,
            autostart: false,
            sound: true,
            pet: "pulsar".to_string(),
            island_position: "right".to_string(),
        }
    }
}

static DIR: OnceLock<PathBuf> = OnceLock::new();
static CACHE: OnceLock<Mutex<Settings>> = OnceLock::new();
/// Set when the file on disk could not be read, so `save` refuses to clobber it.
static UNREADABLE: OnceLock<bool> = OnceLock::new();

fn dir() -> PathBuf {
    DIR.get().cloned().unwrap_or_else(|| PathBuf::from("."))
}

fn file() -> PathBuf {
    dir().join("settings.json")
}

fn cache() -> &'static Mutex<Settings> {
    CACHE.get_or_init(|| Mutex::new(Settings::default()))
}

/// Loads settings from disk and remembers the config directory.
pub fn init(app: &AppHandle) {
    let resolved = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&resolved);
    let _ = DIR.set(resolved);
    let _ = UNREADABLE.set(false);

    let loaded = read_from_disk();

    if let Ok(mut guard) = cache().lock() {
        *guard = loaded;
    }
}

fn read_from_disk() -> Settings {
    let path = file();
    let Ok(text) = std::fs::read_to_string(&path) else {
        // No file yet is the normal first run, not a problem.
        return Settings::default();
    };

    match serde_json::from_str::<Value>(&text) {
        Ok(value) => salvage(&value),
        Err(err) => {
            // Unreadable. Keep a copy so nothing is lost, and mark the file as
            // untouchable so a later save cannot overwrite it.
            let backup = path.with_extension(format!("corrupt-{}.json", stamp()));
            let _ = std::fs::copy(&path, &backup);
            let _ = UNREADABLE.set(true);
            eprintln!("ryfe: settings.json could not be read ({err}); kept a copy at {backup:?}");
            Settings::default()
        }
    }
}

/// Reads each field on its own, so one bad value costs one setting.
fn salvage(value: &Value) -> Settings {
    let defaults = Settings::default();

    let field = |name: &str| value.get(name).cloned();

    let string_field = |name: &str, fallback: String| -> String {
        field(name)
            .and_then(|v| serde_json::from_value::<String>(v).ok())
            .unwrap_or(fallback)
    };
    let bool_field = |name: &str, fallback: bool| -> bool {
        field(name)
            .and_then(|v| serde_json::from_value::<bool>(v).ok())
            .unwrap_or(fallback)
    };
    let list_field = |name: &str, fallback: Vec<String>| -> Vec<String> {
        field(name)
            .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
            .filter(|v| !v.is_empty())
            .unwrap_or(fallback)
    };

    Settings {
        repo_roots: list_field("repo_roots", defaults.repo_roots.clone()),
        github_login: string_field("github_login", defaults.github_login.clone()),
        deepseek_base_url: string_field("deepseek_base_url", defaults.deepseek_base_url.clone()),
        deepseek_model: string_field("deepseek_model", defaults.deepseek_model.clone()),
        open_on_hover: bool_field("open_on_hover", defaults.open_on_hover),
        autostart: bool_field("autostart", defaults.autostart),
        sound: bool_field("sound", defaults.sound),
        pet: string_field("pet", defaults.pet.clone()),
        island_position: string_field("island_position", defaults.island_position.clone()),
    }
}

fn stamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn current() -> Settings {
    cache().lock().map(|g| g.clone()).unwrap_or_default()
}

/// Writes settings, atomically, unless the file on disk was unreadable.
pub fn save(next: Settings) -> Result<(), String> {
    if UNREADABLE.get().copied().unwrap_or(false) {
        return Err(
            "settings.json could not be read when Ryfe started, so it has not been overwritten. \
             Fix or delete it, then restart."
                .to_string(),
        );
    }

    let path = file();
    let text = serde_json::to_string_pretty(&next).map_err(|e| e.to_string())?;

    // Write beside the real file and rename, so an interrupted write cannot
    // leave a half-file behind.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("could not write settings: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("could not replace settings: {e}"))?;

    if let Ok(mut guard) = cache().lock() {
        *guard = next;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn settings_get() -> Settings {
    current()
}

#[tauri::command]
pub fn settings_set(next: Settings) -> Result<(), String> {
    save(next)
}
