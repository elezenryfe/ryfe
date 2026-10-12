//! Where the island sits, how big it is, and whether a click belongs to it.
//!
//! The OS window is a rectangle. The island inside it is a rounded box drawn by
//! the front end, and everything around that box is transparent. Two things have
//! to line up for that illusion to hold:
//!
//! 1. The window is sized and positioned so the box lands where we want it.
//! 2. Clicks outside the box fall through to whatever is behind, which means
//!    polling the cursor and toggling `set_ignore_cursor_events`.
//!
//! The poll is the only thing here that costs anything, so it parks on a
//! condition variable whenever the island is hidden — a collapsed island does
//! no work at all.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize};

/// Window sizes in logical pixels. The front end draws an island that fills
/// exactly this box, so these are the front end's `BOX` sizes — a strip glued to
/// the top edge when compact, the full panel when open.
pub const COMPACT_W: f64 = 460.0;
pub const COMPACT_H: f64 = 50.0;
pub const OPEN_W: f64 = 720.0;
pub const OPEN_H: f64 = 344.0;
/// Collapsed: a thin strip at the very top edge. Small enough that the OS
/// delivers no cursor events over it, which is what lets the poll thread park.
pub const HIDDEN_W: f64 = 240.0;
pub const HIDDEN_H: f64 = 6.0;

/// How far outside the island's own box the cursor still counts as "on" it.
/// Deliberately generous: a click landing a pixel outside the rounded corner
/// should not fall through to whatever is behind.
const HIT_MARGIN: f64 = 14.0;

/// How often the cursor is sampled while the island is visible. 16 ms is one
/// frame at 60 Hz — any faster is invisible, any slower and a quick click can
/// slip through the gap.
const POLL_INTERVAL: Duration = Duration::from_millis(16);

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Default for Rect {
    fn default() -> Self {
        Rect { x: 0.0, y: 0.0, w: COMPACT_W, h: COMPACT_H }
    }
}

/// The three sizes the island can be. The front end drives transitions; Rust
/// only knows how big to make the window.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Size {
    Hidden,
    Compact,
    Open,
}

/// The open panel's size. It starts at the constant above, and the front end can
/// move it: the file list under the panel is only as tall as what is left of it.
static OPEN_SIZE: Mutex<(f64, f64)> = Mutex::new((OPEN_W, OPEN_H));

/// What a dragged panel may be. Kept here as well as in the page, because a
/// panel dragged to nothing, or past the edge of the screen, is very hard to get
/// back.
const MIN_OPEN_W: f64 = 520.0;
const MAX_OPEN_W: f64 = 1800.0;
const MIN_OPEN_H: f64 = 240.0;
const MAX_OPEN_H: f64 = 1400.0;

/// Remembers a size the user dragged to, so the next resize uses it.
pub fn set_open_size(w: f64, h: f64) {
    if let Ok(mut size) = OPEN_SIZE.lock() {
        *size = (
            w.clamp(MIN_OPEN_W, MAX_OPEN_W),
            h.clamp(MIN_OPEN_H, MAX_OPEN_H),
        );
    }
}

impl Size {
    fn logical(self) -> (f64, f64) {
        match self {
            Size::Hidden => (HIDDEN_W, HIDDEN_H),
            Size::Compact => (COMPACT_W, COMPACT_H),
            Size::Open => OPEN_SIZE.lock().map(|s| *s).unwrap_or((OPEN_W, OPEN_H)),
        }
    }
}

/// A gate the poll thread waits on. Closed means "nothing to do, sleep for
/// free"; opening it wakes the thread immediately.
struct Gate {
    open: Mutex<bool>,
    cv: Condvar,
}

impl Gate {
    fn new(open: bool) -> Self {
        Gate { open: Mutex::new(open), cv: Condvar::new() }
    }

    fn set(&self, open: bool) {
        let mut guard = match self.open.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        *guard = open;
        if open {
            self.cv.notify_all();
        }
    }

    fn wait(&self) {
        let mut guard = match self.open.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        while !*guard {
            guard = match self.cv.wait(guard) {
                Ok(g) => g,
                Err(poisoned) => poisoned.into_inner(),
            };
        }
    }
}

/// Shared between the front end, the poll thread and the command handlers.
pub struct Hit {
    /// The island box in window-logical coordinates, pushed by the front end
    /// after every layout change. Rust needs it to decide what is clickable.
    rect: Mutex<Rect>,
    gate: Gate,
    /// Whether the *window* is currently taking the mouse.
    accepting: AtomicBool,
}

impl Hit {
    pub fn new() -> Self {
        Hit {
            rect: Mutex::new(Rect::default()),
            gate: Gate::new(true),
            accepting: AtomicBool::new(true),
        }
    }

    pub fn set_rect(&self, rect: Rect) {
        let mut guard = match self.rect.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        *guard = rect;
    }

    fn rect(&self) -> Rect {
        match self.rect.lock() {
            Ok(g) => *g,
            Err(poisoned) => *poisoned.into_inner(),
        }
    }
}

impl Default for Hit {
    fn default() -> Self {
        Self::new()
    }
}

/// Sizes and places the island window at the top-centre of the primary monitor.
///
/// Sizes are computed in physical pixels from logical ones, and always-on-top is
/// re-asserted afterwards: moving a window between displays, or resizing it, can
/// quietly drop the flag on Windows.
pub fn place(app: &AppHandle, size: Size) -> tauri::Result<()> {
    let Some(win) = app.get_webview_window("island") else {
        return Ok(());
    };

    let (lw, lh) = size.logical();
    let scale = win.scale_factor()?;

    // Prefer the monitor the island is already on so it does not jump displays
    // when a second screen is plugged in.
    let monitor = match win.current_monitor()? {
        Some(m) => Some(m),
        None => win.primary_monitor()?,
    };

    let pw = (lw * scale).round().max(1.0) as u32;
    let ph = (lh * scale).round().max(1.0) as u32;

    // How far the island sits from the screen edge when it is not centred.
    const MARGIN: f64 = 14.0;
    let inset = (MARGIN * scale).round() as i64;

    let position = crate::settings::current().island_position;
    let (x, y) = match monitor {
        Some(m) => {
            let mw = m.size().width as i64;
            let mx = m.position().x as i64;
            let my = m.position().y as i64;
            let x = match position.as_str() {
                "left" => mx + inset,
                "right" => mx + mw - pw as i64 - inset,
                _ => mx + (mw - pw as i64) / 2,
            };
            (x, my)
        }
        None => (0, 0),
    };

    win.set_size(PhysicalSize::new(pw, ph))?;
    win.set_position(PhysicalPosition::new(x as i32, y as i32))?;
    let _ = win.set_always_on_top(true);

    // While hidden the poll is parked, so nothing would ever turn click-through
    // back on. Clear it here instead: the wake strip is 240x6 and has to receive
    // the hover that brings the island back, and it is far too small to get in
    // the way of anything behind it.
    if size == Size::Hidden {
        let _ = crate::platform::set_accept_mouse(&win, true);
    }
    Ok(())
}

/// Samples the cursor and hands the mouse to the island only when the cursor is
/// actually over it. Parks on the gate while the island is hidden.
pub fn spawn_cursor_poll(app: AppHandle, hit: Arc<Hit>) {
    std::thread::spawn(move || loop {
        hit.gate.wait();
        std::thread::sleep(POLL_INTERVAL);

        let Some(win) = app.get_webview_window("island") else {
            continue;
        };

        // Any of these failing means the window is mid-teardown or the OS
        // refused; skip this tick rather than killing the thread.
        let (Ok(cursor), Ok(origin), Ok(scale)) =
            (win.cursor_position(), win.outer_position(), win.scale_factor())
        else {
            continue;
        };

        let rel_x = (cursor.x - origin.x as f64) / scale;
        let rel_y = (cursor.y - origin.y as f64) / scale;
        let r = hit.rect();

        let over = rel_x >= r.x - HIT_MARGIN
            && rel_x <= r.x + r.w + HIT_MARGIN
            && rel_y >= r.y - HIT_MARGIN
            && rel_y <= r.y + r.h + HIT_MARGIN;

        if over != hit.accepting.load(Ordering::Relaxed) {
            hit.accepting.store(over, Ordering::Relaxed);
            // Through `platform`, not Tauri's own setter: that one rewrites the
            // extended style and drops the bits that stop the island taking
            // focus. See `platform::set_accept_mouse`.
            let _ = crate::platform::set_accept_mouse(&win, over);
        }

        // The front end needs the cursor for hover states and eye tracking —
        // the webview gets no pointer events once the window is click-through,
        // so it is forwarded explicitly.
        let _ = win.emit_to("island", "cursor", (rel_x, rel_y, over));
    });
}

/// Opens or closes the gate. Closing it is what makes a hidden island free.
pub fn set_polling(hit: &Hit, on: bool) {
    hit.gate.set(on);
}
