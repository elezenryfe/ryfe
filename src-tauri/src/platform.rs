//! The little that differs per operating system.
//!
//! One Windows-specific concern lives here: keeping the island out of the way.
//! It has to be done through the extended window style, and Tauri's own
//! click-through setter rewrites that style wholesale — so Ryfe owns the whole
//! of it in one function rather than sharing it with the framework.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::WebviewWindow;

/// True while a text field is deliberately holding the keyboard.
///
/// `set_accept_mouse` re-asserts `WS_EX_NOACTIVATE` on every call, which would
/// snatch the keyboard back the moment the cursor moved off an open chat. While
/// this is set it leaves the bit alone.
static ACTIVATING: AtomicBool = AtomicBool::new(false);

/// Lets the island hold the keyboard for as long as a text field needs it.
///
/// Clearing `WS_EX_NOACTIVATE` is the only way in, and the island never asks
/// unless the chat input is on screen.
#[cfg(windows)]
pub fn set_activating(window: &WebviewWindow, on: bool) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE,
    };

    ACTIVATING.store(on, Ordering::Relaxed);

    let raw = window
        .hwnd()
        .map_err(|e| format!("could not get the window handle: {e}"))?
        .0 as isize;
    let hwnd = HWND(raw as *mut core::ffi::c_void);

    unsafe {
        let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if current == 0 {
            return Err("GetWindowLongPtrW(GWL_EXSTYLE) returned 0".to_string());
        }
        let no_activate = WS_EX_NOACTIVATE.0 as isize;
        let next = if on { current & !no_activate } else { current | no_activate };
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
    }

    if on {
        let _ = window.set_focus();
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn set_activating(window: &WebviewWindow, on: bool) -> Result<(), String> {
    ACTIVATING.store(on, Ordering::Relaxed);
    if on {
        let _ = window.set_focus();
    }
    Ok(())
}

/// Hands the mouse to the island, or lets clicks fall through it.
///
/// This is also where `WS_EX_NOACTIVATE` and `WS_EX_TOOLWINDOW` are asserted,
/// which is why it is not simply `set_ignore_cursor_events`:
///
/// * Tauri's setter rewrites the extended style and takes those two bits with
///   it, so the first time the cursor left the island the window silently
///   became focus-stealing again.
/// * `WS_EX_NOACTIVATE` has to be set after the window exists but before it is
///   ever activated, which means the check has to live somewhere that runs on
///   every change.
///
/// `WS_EX_TRANSPARENT` is what makes a click pass through to whatever is behind.
#[cfg(windows)]
pub fn set_accept_mouse(window: &WebviewWindow, accept: bool) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, SWP_FRAMECHANGED,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
        WS_EX_TRANSPARENT,
    };

    // Re-wrap the raw pointer rather than using Tauri's HWND type directly: it
    // comes from whichever `windows` crate version Tauri resolved, which is not
    // necessarily ours, and the pointer is the one thing the two agree on.
    let raw = window
        .hwnd()
        .map_err(|e| format!("could not get the window handle: {e}"))?
        .0 as isize;
    let hwnd = HWND(raw as *mut core::ffi::c_void);

    unsafe {
        let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if current == 0 {
            return Err("GetWindowLongPtrW(GWL_EXSTYLE) returned 0".to_string());
        }

        let transparent = WS_EX_TRANSPARENT.0 as isize;
        let mut next = if accept {
            current & !transparent
        } else {
            current | transparent
        };
        next |= WS_EX_TOOLWINDOW.0 as isize;
        // Unless a text field is deliberately holding the keyboard, in which
        // case putting the bit back would take it away again.
        if !ACTIVATING.load(Ordering::Relaxed) {
            next |= WS_EX_NOACTIVATE.0 as isize;
        }

        if next == current {
            return Ok(());
        }
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);

        let after = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if after & (WS_EX_NOACTIVATE.0 as isize) == 0 && !ACTIVATING.load(Ordering::Relaxed) {
            return Err("the island lost WS_EX_NOACTIVATE".to_string());
        }

        // Style changes to a live window are not applied until the frame is
        // recalculated.
        SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        )
        .map_err(|e| format!("could not refresh the window frame: {e}"))?;
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn set_accept_mouse(window: &WebviewWindow, accept: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(!accept)
        .map_err(|e| e.to_string())
}

/// Hands a link to the user's own browser.
///
/// Narrow on purpose. Only http and https get through, and a quote or a newline
/// is refused: the URL is passed to `start` inside double quotes, so `&` and the
/// other cmd metacharacters are inert, but a quote would break out of them.
/// Opening a link is not a general-purpose way to launch a program.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    let looks_like_a_link = url.starts_with("https://") || url.starts_with("http://");
    let is_safe_to_quote = !url.contains(['"', '\n', '\r']);

    if !looks_like_a_link || !is_safe_to_quote {
        return Err("Ryfe will only open http and https links".to_string());
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("could not open the link: {e}"))?;
    }

    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("could not open the link: {e}"))?;
    }

    Ok(())
}
