/**
 * Settings, as a view inside the island rather than a window of its own.
 *
 * Two rules carry over from when this was a separate window:
 *
 * * **Keys are write-only.** A field starts empty and reports whether a key is
 *   saved. Nothing anywhere reads one back into the page.
 * * **Every change says what it did.** A save either lands, or the reason it did
 *   not is on screen next to the control.
 *
 * It does not import from `views.ts` — that file imports this one, and a cycle
 * between them would be resolved differently depending on which loaded first.
 */

import {
  getSettings,
  saveSettings,
  secretClear,
  secretSet,
  secretStatus,
  type Settings,
} from '../core/bridge';
import { loadRepos, setRoots } from '../core/gitstate';
import { refresh, reposition } from './host';

export const GEAR =
  '<circle cx="12" cy="12" r="3"/>' +
  '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let values: Settings | null = null;
const keys = new Map<string, boolean>();

/**
 * Relaxes a stored path so the field shows a plain Windows path rather than the
 * forward-slash form the app uses internally.
 */
const shownPath = (p: string) => p.replace(/\//g, '\\');

function field(
  key: string,
  label: string,
  note: string,
  kind: 'password' | 'text' = 'password',
): string {
  const isSet = keys.get(key) ?? false;
  const placeholder =
    kind === 'password'
      ? isSet
        ? '•••••••• saved — type to replace'
        : 'not set'
      : '';
  return `
    <div class="setfield">
      <label for="${key}">${esc(label)}</label>
      <div class="setrow">
        <input type="${kind}" id="${key}" spellcheck="false" autocomplete="off"
               placeholder="${esc(placeholder)}">
        <button class="btn ghost" data-save="${key}">Save</button>
        ${isSet ? `<button class="btn ghost" data-clear="${key}">Remove</button>` : ''}
      </div>
      <span class="setnote">${esc(note)}</span>
      <div class="setstatus ${isSet ? 'ok' : ''}" id="${key}-status">${
        isSet ? 'saved in Windows Credential Manager' : 'not set'
      }</div>
    </div>`;
}

function render() {
  if (!values) return '<div class="empty"><strong>Loading settings…</strong></div>';
  const v = values;

  // The sections go inside `.scroll`, or everything past the panel's height is
  // clipped with no way to reach it.
  return (
    `<div class="scroll">` +
    `<div class="set">` +
    `<h3>General</h3>` +
    `<label class="settoggle"><input type="checkbox" id="set-hover" ${
      v.open_on_hover ? 'checked' : ''
    }> Open the island when the pointer rests on it</label>` +
    `<label class="settoggle"><input type="checkbox" id="set-autostart" ${
      v.autostart ? 'checked' : ''
    }> Start Ryfe when Windows starts</label>` +
    `<span class="setnote">Turning that on writes a registry entry so Ryfe is running when you log in.</span>` +
    `<div class="setfield">` +
    `<label for="set-position">Position along the top of the screen</label>` +
    `<div class="setrow">` +
    `<select id="set-position">` +
    ['left', 'center', 'right']
      .map(
        (p) =>
          `<option value="${p}" ${
            (v.island_position ?? 'right') === p ? 'selected' : ''
          }>${p[0].toUpperCase() + p.slice(1)}</option>`,
      )
      .join('') +
    `</select>` +
    `<button class="btn ghost" data-save-position>Move</button>` +
    `</div>` +
    `<span class="setnote">Coucou occupies the whole top-centre of this screen and swallows clicks aimed at anything under it, which is why Right is the default. Anything else that parks itself at the top will do the same.</span>` +
    `<div class="setstatus" id="position-status"></div>` +
    `</div>` +
    `<div class="setstatus" id="general-status"></div>` +
    `</div>` +

    `<div class="set">` +
    `<h3>Repositories</h3>` +
    `<div class="setfield">` +
    `<label for="set-roots">Folders to look in</label>` +
    `<textarea id="set-roots" rows="3" spellcheck="false">${esc(
      v.repo_roots.map(shownPath).join('\n'),
    )}</textarea>` +
    `<span class="setnote">One per line. Ryfe walks these recursively, including nested repositories, and skips build folders.</span>` +
    `</div>` +
    `<div class="setrow"><button class="btn" data-save-roots>Save folders</button>` +
    `<div class="setstatus" id="roots-status"></div></div>` +
    `</div>` +

    `<div class="set">` +
    `<h3>GitHub</h3>` +
    field(
      'github-token',
      'Personal access token',
      'A classic token with the repo scope — creating a repository needs it. A fine-grained one can only read; it cannot reach a repository that does not exist yet.',
    ) +
    `</div>` +

    `<div class="set">` +
    `<h3>DeepSeek</h3>` +
    field(
      'deepseek-api-key',
      'API key',
      'Used for anything that has to reason: reading a repository, drafting a commit message, answering a question.',
    ) +
    `<div class="setfield">` +
    `<label for="set-base">API base URL</label>` +
    `<input type="text" id="set-base" spellcheck="false" value="${esc(v.deepseek_base_url)}">` +
    `<span class="setnote">Leave this alone unless you are routing through your own gateway.</span>` +
    `</div>` +
    `<div class="setfield">` +
    `<label for="set-model">Model</label>` +
    `<input type="text" id="set-model" spellcheck="false" value="${esc(v.deepseek_model)}">` +
    `<span class="setnote">DeepSeek retires model names quickly — deepseek-chat and deepseek-reasoner are already gone. Ryfe reads the live list from the API.</span>` +
    `</div>` +
    `<div class="setrow"><button class="btn" data-save-ai>Save</button>` +
    `<div class="setstatus" id="ai-status"></div></div>` +
    `</div>` +

    `<div class="set">` +
    `<h3>Google Calendar</h3>` +
    `<span class="setnote">Not connected yet, and it needs one thing from you first: a <strong>Desktop app</strong> OAuth client on your own Google Cloud project. The client already in your .env is a Web one, and Google will not let a web client use the loopback redirect this needs.</span>` +
    `<span class="setnote">Two things to get right when you make it: publish the app to <strong>In production</strong> without submitting it for verification — staying in Testing makes Google expire your login every seven days — and do not upload a logo, which would put you in the review queue.</span>` +
    `</div>` +
    `</div>`
  );
}

function mount(root: HTMLElement) {
  const status = (id: string, text: string, kind: 'ok' | 'err' | '' = '') => {
    const el = root.querySelector<HTMLElement>(`#${id}`);
    if (!el) return;
    el.className = `setstatus ${kind}`;
    el.textContent = text;
  };

  const persist = async (next: Settings, id: string) => {
    values = next;
    try {
      await saveSettings(next);
      status(id, 'saved', 'ok');
    } catch (e) {
      status(id, String(e), 'err');
    }
  };

  // --- secrets ---
  root.querySelectorAll<HTMLButtonElement>('[data-save]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.save!;
      const input = root.querySelector<HTMLInputElement>(`#${key}`)!;
      const value = input.value.trim();
      if (!value) {
        status(`${key}-status`, 'nothing to save — the field is empty', 'err');
        return;
      }
      try {
        await secretSet(key, value);
        // Never leave the key sitting in the DOM after it has been stored.
        input.value = '';
        input.placeholder = '•••••••• saved — type to replace';
        keys.set(key, true);
        status(`${key}-status`, 'saved in Windows Credential Manager', 'ok');
      } catch (e) {
        status(`${key}-status`, String(e), 'err');
      }
    });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-clear]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.clear!;
      try {
        await secretClear(key);
        keys.set(key, false);
        const input = root.querySelector<HTMLInputElement>(`#${key}`);
        if (input) input.placeholder = 'not set';
        status(`${key}-status`, 'removed');
      } catch (e) {
        status(`${key}-status`, String(e), 'err');
      }
    });
  });

  // --- toggles ---
  for (const [id, key] of [
    ['set-hover', 'open_on_hover'],
    ['set-autostart', 'autostart'],
  ] as const) {
    const box = root.querySelector<HTMLInputElement>(`#${id}`);
    box?.addEventListener('change', () => {
      void persist({ ...values!, [key]: box.checked }, 'general-status');
    });
  }

  // --- position ---
  root.querySelector('[data-save-position]')?.addEventListener('click', async () => {
    const next = root.querySelector<HTMLSelectElement>('#set-position')!.value;
    await persist({ ...values!, island_position: next }, 'position-status');
    // Rust reads the position when it places the window, so ask it to place again.
    reposition();
  });

  // --- repositories ---
  root.querySelector('[data-save-roots]')?.addEventListener('click', async () => {
    const raw = root.querySelector<HTMLTextAreaElement>('#set-roots')!.value;
    const roots = raw
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    await persist({ ...values!, repo_roots: roots }, 'roots-status');
    // The git view scans its own copy of the roots; hand it the new ones now
    // rather than leaving a folder the user just added invisible until restart.
    setRoots(roots);
    void loadRepos(true);
  });

  // --- assistant ---
  root.querySelector('[data-save-ai]')?.addEventListener('click', () => {
    void persist(
      {
        ...values!,
        deepseek_base_url: root.querySelector<HTMLInputElement>('#set-base')!.value.trim(),
        deepseek_model: root.querySelector<HTMLInputElement>('#set-model')!.value.trim(),
      },
      'ai-status',
    );
  });
}

/** Loads once, then re-renders. Safe to call every time the view opens. */
export async function loadSettingsView() {
  if (!values) {
    values = await getSettings();
    const pairs = await secretStatus();
    for (const [k, present] of pairs ?? []) keys.set(k, present);
    refresh();
  }
}

export const settingsViewHtml = render;
export const settingsViewMount = mount;
