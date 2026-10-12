//! API keys, in the OS credential store.
//!
//! The webview can ask whether a key exists, write one, or delete one. It can
//! never read one back: a compromised renderer should not be able to exfiltrate
//! a key, and nothing in the UI has a legitimate reason to display one.

use keyring::Entry;

const SERVICE: &str = "ryfe";

/// The complete set of keys Ryfe will ever store. Anything else is refused, so
/// a bug (or a hostile page) cannot use this as a general-purpose credential
/// reader for the rest of the machine.
const ALLOWED: &[&str] = &[
    "deepseek-api-key",
    "github-token",
    "google-client-id",
    "google-client-secret",
    "google-refresh-token",
];

fn entry(key: &str) -> Result<Entry, String> {
    if !ALLOWED.contains(&key) {
        return Err(format!("'{key}' is not a key Ryfe stores"));
    }
    Entry::new(SERVICE, key).map_err(|e| format!("credential store unavailable: {e}"))
}

/// Reads a key. Deliberately NOT exposed as a command — Rust calls this, the
/// front end cannot.
pub fn get(key: &str) -> Option<String> {
    let entry = entry(key).ok()?;
    match entry.get_password() {
        Ok(v) if !v.is_empty() => Some(v),
        _ => None,
    }
}

pub fn present(key: &str) -> bool {
    get(key).is_some()
}

pub fn set(key: &str, value: &str) -> Result<(), String> {
    let entry = entry(key)?;
    if value.is_empty() {
        return entry.delete_credential().or(Ok(()));
    }
    entry
        .set_password(value)
        .map_err(|e| format!("could not save: {e}"))
}

pub fn clear(key: &str) -> Result<(), String> {
    let entry = entry(key)?;
    // Deleting something that was never there is not an error.
    entry.delete_credential().or(Ok(()))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Whether a key is set. The only read the front end gets.
#[tauri::command]
pub fn secret_present(key: String) -> bool {
    present(&key)
}

#[tauri::command]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    set(&key, &value)
}

#[tauri::command]
pub fn secret_clear(key: String) -> Result<(), String> {
    clear(&key)
}

/// Which of the known keys are set, so a settings page can render in one call.
#[tauri::command]
pub fn secret_status() -> Vec<(String, bool)> {
    ALLOWED.iter().map(|k| ((*k).to_string(), present(k))).collect()
}
