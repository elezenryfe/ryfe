/**
 * The island shell.
 *
 * Owns four things and nothing else: how big the island is, which view is in
 * front, where the character stands, and the animation loop that draws it.
 * Everything else lives in `island/views.ts` or in Rust.
 */

import './style.css';

import { clamp, lerp, Tracked } from './core/anim';
import {
  listen,
  setFocusable,
  setIslandOpenSize,
  setIslandRect,
  setIslandSize,
  getSettings,
  type Settings,
} from './core/bridge';
import { isBusy, loadModels, wireChat } from './core/chatstate';
import { git, loadRepos, setRoots } from './core/gitstate';
import { attentionCount, loadActivity, loadPulse } from './core/ghstate';
import {
  attachHost,
  attachReposition,
  attachTallToggle,
  setVisible,
} from './island/host';
import { settingsView, VIEWS, svg, type View } from './island/views';
import { PetEngine, type PetState } from './pet/pulsar';

const $ = <T extends HTMLElement>(sel: string) =>
  document.querySelector<T>(sel)!;

const island = $('#island');
const panel = $('#panel');
const cap = $('#cap');
const petCanvas = $('#pet') as unknown as HTMLCanvasElement;
const glow = $('#glow');
const tilesEl = $('#tiles');
const subEl = $('#capsub');
const wake = $('#wake');

type Mode = 'hidden' | 'compact' | 'open';

/**
 * The island's box in each mode.
 *
 * These are the window sizes Rust makes for the same mode, so in a settled
 * island the box fills the window exactly. The box is animated here rather than
 * by Rust because only the webview can draw a frame part-way through a resize.
 */
const BOX: Record<Mode, { w: number; h: number; r: number }> = {
  // A strip at the very top edge, small enough that the OS hands it no cursor
  // events — which is what lets Rust park its poll.
  hidden: { w: 240, h: 0, r: 14 },
  compact: { w: 460, h: 50, r: 14 },
  open: { w: 720, h: 344, r: 22 },
};

/** The header: 8pt of inset above a 34pt line. The content starts below it. */
const HEADER_BOTTOM = 42;

/**
 * Where the character stands. Small and on the header line while the island is
 * a strip; out in the gutter beside the content once it opens. The gutter is
 * sized to the body itself — 1.14R either side of the centre.
 */
const BOT = {
  compact: { cx: 40, cy: 25, d: 28 },
  open: { cx: 68, d: 58 },
};

/** The halo behind the character, per state: colour and how much of it shows. */
const GLOW: Record<PetState, [string, number]> = {
  idle: ['#FFFFFF', 0.15],
  working: ['#3B9EFF', 0.65],
  alert: ['#F5A524', 0.65],
  listening: ['#22D3EE', 0.65],
};

const pet = new PetEngine();
const ctx = petCanvas.getContext('2d')!;

let mode: Mode = 'compact';
let active: View = VIEWS[0];
let settings: Settings | null = null;

// The island's box, animated. Grows on a spring, shrinks on a timed curve.
const boxW = new Tracked(BOX.compact.w);
const boxH = new Tracked(BOX.compact.h);
const boxR = new Tracked(BOX.compact.r);

/** Cursor in island coordinates, plus whether it is over the island at all. */
let cursor = { x: -1e4, y: -1e4, over: false };
let awaySince = performance.now();

const order = (m: Mode) => (m === 'hidden' ? 0 : m === 'compact' ? 1 : 2);

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

/**
 * The window is a rectangle; the island is a rounded box inside it. Rust needs
 * to know where that box actually is, or clicks fall through the wrong parts.
 *
 * Runs every frame, and only crosses into Rust when the box has actually moved
 * — during a resize that is every frame, and the rest of the time, never.
 */
let pushed = { x: -1, y: -1, w: -1, h: -1 };

function pushRect() {
  const r = island.getBoundingClientRect();
  if (
    Math.abs(r.left - pushed.x) < 0.5 &&
    Math.abs(r.top - pushed.y) < 0.5 &&
    Math.abs(r.width - pushed.w) < 0.5 &&
    Math.abs(r.height - pushed.h) < 0.5
  ) {
    return;
  }
  pushed = { x: r.left, y: r.top, w: r.width, h: r.height };
  void setIslandRect(pushed);
}

async function setMode(next: Mode) {
  if (next === mode) return;
  const prev = mode;
  mode = next;
  island.dataset.mode = next;
  setVisible(next !== 'hidden');

  const target = BOX[next];
  if (order(next) > order(prev)) {
    // The window has to be the new size *before* the island grows into it, or
    // the growth is clipped by the window's edge.
    void setIslandSize(next);
    boxW.springTo(target.w);
    boxH.springTo(target.h);
    boxR.springTo(target.r);
  } else {
    boxW.curveTo(target.w);
    boxH.curveTo(target.h);
    boxR.curveTo(target.r);
    // And it may only shrink once the island has finished shrinking: taking the
    // window away first would cut the island off part-way through the move.
    window.setTimeout(() => {
      if (mode === next) void setIslandSize(next);
    }, 380);
  }
}

/** As tall as the open island may get: the screen, less room for its edges. */
const maxH = () => Math.min(1400, screen.availHeight - 80);

/**
 * How tall the ⤢ button makes the panel. Most of the screen, and inside the
 * bounds the grip drags within, because the two write the same window size.
 */
const tallH = () => clamp(Math.round(screen.availHeight * 0.8), 240, maxH());

/** What a tall panel comes back to: whatever the user last left it at. */
let restoreH = BOX.open.h;

/**
 * Tells Rust how big the open window now is — once a frame rather than once an
 * event, because the island is drawn inside the window and cannot grow past it.
 */
let sizeQueued = false;
function pushOpenSize() {
  if (sizeQueued) return;
  sizeQueued = true;
  requestAnimationFrame(() => {
    sizeQueued = false;
    if (mode === 'open') void setIslandOpenSize(BOX.open.w, BOX.open.h);
  });
}

/**
 * The ⤢ button: the same knob the grip drags, moved to a size worth having in
 * one click. Where it comes back to is wherever the user last put it, so the
 * button and the grip never disagree about what "normal" is.
 */
function toggleTall() {
  if (mode !== 'open') return;
  if (BOX.open.h >= tallH()) {
    // Coming back down: the window may only shrink once the island has, or its
    // bottom — the commit row — is cut off part-way through. As in setMode.
    BOX.open.h = restoreH;
    boxH.curveTo(BOX.open.h);
    window.setTimeout(() => {
      if (mode === 'open') pushOpenSize();
    }, 380);
  } else {
    // Growing: the window has to be tall first, or the island grows past it.
    restoreH = BOX.open.h;
    BOX.open.h = tallH();
    boxH.springTo(BOX.open.h);
    pushOpenSize();
  }
}

/**
 * Dragging the grip gives the open island a size of its own. The file list is
 * what grows: everything under it is a fixed height, and the list is what is
 * left.
 *
 * Bounded by the screen, since a panel taller than the display can never be
 * dragged back.
 */
function wireGrip() {
  const grip = $('#grip');

  grip.addEventListener('pointerdown', (e) => {
    if (mode !== 'open') return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const from = { x: e.clientX, y: e.clientY, w: BOX.open.w, h: BOX.open.h };

    const move = (ev: PointerEvent) => {
      BOX.open.w = clamp(
        from.w + ev.clientX - from.x,
        520,
        Math.min(1800, screen.availWidth - 40),
      );
      BOX.open.h = clamp(from.h + ev.clientY - from.y, 240, maxH());
      boxW.springTo(BOX.open.w);
      boxH.springTo(BOX.open.h);
      pushOpenSize();
    };

    const end = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
      pushOpenSize();
    };

    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  });
}

/**
 * Writes the island's box, and the character's place in it.
 *
 * The character has no spring of its own — how far open the island is is read
 * straight off its width. That way the two can never drift apart, settle out of
 * step, or disagree about where the middle is.
 */
function layout() {
  const W = boxW.value;
  const H = boxH.value;
  island.style.width = `${W}px`;
  island.style.height = `${H}px`;
  island.style.borderRadius = `0 0 ${boxR.value}px ${boxR.value}px`;

  const open = clamp((W - BOX.compact.w) / (BOX.open.w - BOX.compact.w), 0, 1);
  const d = lerp(BOT.compact.d, BOT.open.d, open);
  const cx = lerp(BOT.compact.cx, BOT.open.cx, open);
  const cy = lerp(BOT.compact.cy, HEADER_BOTTOM + (BOX.open.h - HEADER_BOTTOM) / 2, open);

  // The canvas is bigger than the body: 2R is 0.6 of it, and the rest is the
  // room the arms and the badge need to not be cut off.
  const size = d / 0.6;
  petCanvas.style.width = `${size}px`;
  petCanvas.style.height = `${size}px`;
  petCanvas.style.left = `${cx - size / 2}px`;
  petCanvas.style.top = `${cy - size / 2}px`;

  // The halo. It fades in with the island rather than switching on, and it is
  // only worth compositing once the island is big enough to hold it.
  const gr = d * 1.1;
  glow.style.display = open > 0.05 ? 'block' : 'none';
  glow.style.width = `${gr * 2}px`;
  glow.style.height = `${gr * 2}px`;
  glow.style.left = `${cx - gr}px`;
  glow.style.top = `${cy - gr}px`;
  glow.style.opacity = String(open * glowAlpha);

  pushRect();
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function renderTiles() {
  tilesEl.replaceChildren(
    ...VIEWS.filter((v) => v.tile !== false).map((v) => {
      const b = document.createElement('button');
      b.className = 'tile';
      b.type = 'button';
      b.dataset.view = v.id;
      b.setAttribute('aria-label', v.label);
      b.setAttribute('aria-pressed', String(v.id === active.id));
      b.innerHTML = svg(v.glyph, 15, v.box);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        setActive(v);
      });
      return b;
    }),
  );
}

/**
 * Swaps the panel's contents.
 *
 * `expand` is false for the first paint: the island starts as the bare capsule
 * and only opens when something asks it to, which is what makes it unobtrusive
 * on a screen it shares with other overlays.
 */
function setActive(v: View, expand = true) {
  active = v;
  renderTiles();
  subEl.textContent = v.subtitle();

  panel.style.setProperty('--acc', v.hue);
  panel.innerHTML = v.render();
  v.mount?.(panel);

  void loadFor(v);

  if (!expand) {
    requestAnimationFrame(pushRect);
  } else if (mode !== 'open') {
    void setMode('open');
  } else {
    requestAnimationFrame(pushRect);
  }
}

/** Each view knows what it needs; asking for it is the shell's job. */
async function loadFor(v: View) {
  if (v.id === 'git') {
    await loadRepos();
  } else if (v.id === 'gh') {
    await Promise.all([loadPulse(), loadActivity()]);
  } else if (v.id === 'ryfe') {
    await wireChat();
    await loadModels();
  }
}

/**
 * Re-renders the current view in place, keeping the scroll position. Views call
 * this when the data behind them changes; the screen does not jump.
 */
export function refresh() {
  const scroller = panel.querySelector('.scroll');
  const scrollTop = scroller?.scrollTop ?? 0;
  panel.innerHTML = active.render();
  active.mount?.(panel);
  const next = panel.querySelector('.scroll');
  if (next) next.scrollTop = scrollTop;
  subEl.textContent = active.subtitle();
  requestAnimationFrame(pushRect);
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

cap.addEventListener('click', toggleByHand);

/**
 * True after the user closes the island by hand, until the cursor leaves it.
 *
 * Without this, "open on hover" fights the close button: the island folds, the
 * cursor is still over it, and it opens again on the next frame — so the button
 * looks broken rather than the setting looking wrong.
 */
let hoverLocked = false;

function toggleByHand() {
  const next: Mode = mode === 'open' ? 'compact' : 'open';
  hoverLocked = next === 'compact';
  void setMode(next);
}

// The capsule is a div acting as a button, so it needs the keyboard path a real
// button would have given it for free.
cap.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    toggleByHand();
  }
});

document.querySelector('#capsettings')?.addEventListener('click', (e) => {
  e.stopPropagation();
  // Settings is a view like any other, so it opens in the panel rather than a
  // window of its own.
  setActive(settingsView, true);
});

document.querySelector('#capcaret')?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleByHand();
});

// While the island is hidden it is zero pixels tall, so there is nothing left to
// hover. This strip is what is left of it, and hovering it is the only thing
// that can bring the island back — Rust sends no cursor events at all while the
// poll is parked.
function wakeUp() {
  if (mode === 'hidden') void setMode('compact');
}
wake.addEventListener('mouseenter', wakeUp);
island.addEventListener('mouseenter', wakeUp);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && mode === 'open') void setMode('compact');
});

/**
 * True while a text field has the keyboard. Also tells the character to look
 * interested — a field the user is typing into is the thing they are looking at.
 */
let inputFocused = false;

/** Which fields need the island to hold the keyboard — everything but a button. */
const wantsKeyboard = (el: EventTarget | null) => {
  const node = el as HTMLElement | null;
  const tag = node?.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  return !['checkbox', 'radio', 'button', 'submit'].includes(
    (node as HTMLInputElement).type,
  );
};

/** ...and which of those mean the user is typing, so the character listens. */
const typing = (el: EventTarget | null) =>
  wantsKeyboard(el) && (el as HTMLElement).tagName !== 'SELECT';

/**
 * The island is a no-activate window, so it only holds the keyboard while a
 * field deliberately asks for it. Without this the click focuses the field in
 * the page and the keystrokes go to whatever is behind the island.
 *
 * Delegated rather than wired per view: every view renders its own inputs, and
 * a field added later must not have to remember to ask.
 */
document.addEventListener('focusin', (e) => {
  if (!wantsKeyboard(e.target)) return;
  inputFocused = typing(e.target);
  void setFocusable(true);
});

document.addEventListener('focusout', () => {
  // focusout lands before the next field has taken focus, so the decision waits
  // a tick — otherwise moving between two fields drops the keyboard in between.
  queueMicrotask(() => {
    const held = wantsKeyboard(document.activeElement);
    inputFocused = held && typing(document.activeElement);
    void setFocusable(held);
  });
});

/**
 * The character's state, in priority order. Listening beats working beats
 * alert, because a text field the user is typing into is the thing they are
 * looking at right now.
 */
function petState(): PetState {
  if (inputFocused) return 'listening';
  // Anything being run on your behalf — a model call, a git step — reads as
  // thinking, so a long push is never a frozen-looking character.
  if (isBusy() || git.running || git.connecting) return 'working';
  if (attentionCount() > 0) return 'alert';
  return 'idle';
}

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------

let last = performance.now();
let shownState: PetState = 'idle';
/** The last git success the character has already celebrated. */
let lastCheer = 0;
/** How strongly the halo shows in this state; `layout` fades it in and out. */
let glowAlpha = GLOW.idle[1];

/**
 * Matches the canvas bitmap to the size it is displayed at.
 *
 * Without this the bitmap keeps whatever the markup said, the drawing lands in
 * one corner of it, and the character comes out small and off-centre.
 */
function fitPet() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(petCanvas.clientWidth * dpr);
  const h = Math.round(petCanvas.clientHeight * dpr);
  if (petCanvas.width !== w || petCanvas.height !== h) {
    petCanvas.width = w;
    petCanvas.height = h;
  }
}

function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  // --- cursor-driven behaviour ---
  if (cursor.over) {
    awaySince = now;
    const r = petCanvas.getBoundingClientRect();
    pet.look(cursor.x - r.left - r.width / 2, cursor.y - r.top - r.height / 2);

    if (mode === 'compact' && settings?.open_on_hover && !hoverLocked) {
      void setMode('open');
    }
  } else {
    // The cursor has left, so a deliberate close no longer applies.
    hoverLocked = false;
    const away = (now - awaySince) / 1000;
    // Fold an open island that nobody is using, then put it away entirely.
    if (mode === 'open' && away > 6) void setMode('compact');
    if (mode === 'compact' && away > 90) void setMode('hidden');
  }

  const state = petState();
  if (state !== shownState) {
    shownState = state;
    pet.setState(state);
    const [colour, alpha] = GLOW[state];
    glow.style.background = `radial-gradient(circle, ${colour} 0%, transparent 62%)`;
    glowAlpha = alpha;
  }

  // Something finished: the same wave the character says hello with.
  if (git.cheer !== lastCheer) {
    lastCheer = git.cheer;
    pet.greet();
  }

  pet.update(dt);
  boxW.step(dt);
  boxH.step(dt);
  boxR.step(dt);
  layout();

  // Only redraw while there is something to see. This is what keeps a hidden
  // island at zero cost — note the check is on the *mode*, never on whether the
  // character happens to be animating, which is always.
  if (mode !== 'hidden') {
    fitPet();
    pet.draw(ctx, petCanvas.clientWidth, petCanvas.clientHeight);
  }

  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  // Let views ask for a redraw, or a re-placement, without importing this module.
  attachHost(refresh);
  attachReposition(() => void setIslandSize(mode));
  attachTallToggle(toggleTall);

  // The open island can be dragged to whatever size suits the view.
  wireGrip();

  settings = await getSettings();
  setRoots(settings.repo_roots);

  await listen<[number, number, boolean]>('cursor', ([x, y, over]) => {
    cursor = { x, y, over };
  });

  await listen('tray-open', () => {
    void setMode('open');
  });

  await listen('open-settings', () => {
    setActive(settingsView, true);
  });

  // Discovery walks the disk, so it starts now and lands whenever it lands.
  void loadRepos(true);

  island.dataset.mode = mode;
  glow.style.background = `radial-gradient(circle, ${GLOW.idle[0]} 0%, transparent 62%)`;
  pet.greet();

  // First paint stays collapsed: the island is a strip until the user asks for
  // more, and the window is created compact so it never flashes at full size
  // before the page has painted.
  setActive(active, false);
  layout();
  requestAnimationFrame(frame);
}

void boot();

// Keep the pushed rect honest when the window itself changes size.
addEventListener('resize', () => requestAnimationFrame(pushRect));
