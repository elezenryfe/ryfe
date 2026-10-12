/**
 * The only place that talks to Rust.
 *
 * Every call is short-circuited when Ryfe is not running inside Tauri, so
 * `npm run dev` serves a fully interactive island in an ordinary browser. That
 * is the fastest way to work on how the thing looks, and it means a broken
 * Rust command shows up as an empty panel rather than a blank window.
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';

export const IS_TAURI =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!IS_TAURI) return undefined as unknown as T;
  return tauriInvoke<T>(cmd, args);
}

/** Subscribes to a Rust event. Returns an unsubscribe function. */
export async function listen<T = unknown>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  if (!IS_TAURI) return () => {};
  return tauriListen<T>(event, (e) => handler(e.payload as T));
}

// ---------------------------------------------------------------------------
// Typed wrappers
// ---------------------------------------------------------------------------

export type IslandSize = 'hidden' | 'compact' | 'open';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Tells Rust where the visible island is, so it knows what is clickable. */
export const setIslandRect = (rect: Rect) =>
  invoke<void>('island_set_rect', { rect });

/** Resizes the window and parks or wakes the cursor poll. */
export const setIslandSize = (size: IslandSize) =>
  invoke<void>('island_set_size', { size });

/** Remembers a size the island was dragged to, and moves the window to it. */
export const setIslandOpenSize = (w: number, h: number) =>
  invoke<void>('island_set_open_size', { w, h });

/**
 * Lets the island hold the keyboard while a text field is on screen.
 * Nothing else can make the island steal focus.
 */
export const setFocusable = (focused: boolean) =>
  invoke<void>('focus_window', { focused });

export interface Settings {
  repo_roots: string[];
  github_login: string;
  deepseek_base_url: string;
  deepseek_model: string;
  open_on_hover: boolean;
  autostart: boolean;
  sound: boolean;
  pet: string;
  /** "left" | "center" | "right" along the top edge. */
  island_position: string;
}

export const getSettings = () => invoke<Settings>('settings_get');

export const saveSettings = (next: Settings) =>
  invoke<void>('settings_set', { next });

export const secretPresent = (key: string) =>
  invoke<boolean>('secret_present', { key });

export const secretSet = (key: string, value: string) =>
  invoke<void>('secret_set', { key, value });

export const secretClear = (key: string) =>
  invoke<void>('secret_clear', { key });

export const secretStatus = () =>
  invoke<[string, boolean][]>('secret_status');

/**
 * Opens a link in the user's own browser.
 *
 * Deliberately not `window.open`: the island is a frameless always-on-top
 * overlay, and a page opened inside it would have no chrome to close it with.
 * Rust hands the URL to the shell instead.
 */
export const openExternal = (url: string) => invoke<void>('open_url', { url });

/** The cursor position Rust forwards while the island is visible, in island coordinates. */
export interface CursorEvent {
  0: number;
  1: number;
  2: boolean;
}
