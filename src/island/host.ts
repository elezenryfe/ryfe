/**
 * A tiny seam between "something changed" and "redraw the panel".
 *
 * Views need to re-render themselves when data arrives, but importing the
 * shell from a view would make a cycle. So the shell registers its redraw here
 * and views call `refresh()`.
 */

let redraw: (() => void) | null = null;

export function attachHost(fn: () => void) {
  redraw = fn;
}

/**
 * Re-render the active view in place, keeping the scroll position and leaving
 * the input the user is typing in alone.
 */
export function refresh() {
  redraw?.();
}

/** True while the panel is on screen — polling pauses when it is not. */
let visible = false;
export function setVisible(on: boolean) {
  visible = on;
}
export function isVisible() {
  return visible;
}

let reapply: (() => void) | null = null;

/** Lets the shell offer "re-run placement" without views importing the shell. */
export function attachReposition(fn: () => void) {
  reapply = fn;
}

/**
 * Re-runs the shell's sizing, which is what makes Rust re-read the island's
 * position. Saving a new position is otherwise invisible until the next resize.
 */
export function reposition() {
  reapply?.();
}
