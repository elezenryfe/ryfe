/**
 * The four things in the island.
 *
 * A view is data, not a class: an id, a colour, a glyph, and two functions that
 * return HTML. The shell swaps one in and calls `mount` to wire its events.
 * Keeping them this flat means adding a fifth later is a few lines rather than
 * a new module.
 */

import { openExternal, setFocusable } from '../core/bridge';
import {
  approveProposal,
  chat,
  commitAndPush,
  declineProposal,
  send as sendMessage,
  type Message,
  type Proposal,
} from '../core/chatstate';
import {
  backToRepo,
  backToRepos,
  connect,
  dirtyCount,
  git,
  loadRepos,
  openConnect,
  openDiff,
  openRepo,
  previewAction,
  runAction,
} from '../core/gitstate';
import {
  ciChip,
  gh,
  loadActivity,
  loadPulse,
  subtitle,
  type PullRequest,
} from '../core/ghstate';
import { refresh } from './host';
import {
  GEAR,
  loadSettingsView,
  settingsViewHtml,
  settingsViewMount,
} from './settings-view';

export interface View {
  id: string;
  label: string;
  /** Used for the tile colour and the panel's accent dot. */
  hue: string;
  /** Inner SVG markup, drawn in `box`. */
  glyph: string;
  /** A viewBox for `glyph` other than the default 20x20. */
  box?: string;
  /** Settings is reached from the gear, not a tile. */
  tile?: boolean;
  /** The line under the character's name in the collapsed capsule. */
  subtitle(): string;
  render(): string;
  /** Called after `render`'s HTML is in the DOM. */
  mount?(root: HTMLElement): void;
}

const GLYPH = {
  git: '<circle cx="5" cy="4.4" r="1.9"/><circle cx="5" cy="14.6" r="1.9"/><circle cx="14" cy="7.4" r="1.9"/><path d="M5 6.3v6.4M6.9 4.4h3.6a2.5 2.5 0 0 1 2.5 2.5v.5"/>',
  gh: '<path d="M10 2.2A7.3 7.3 0 0 0 7.7 16.4c.36.06.5-.16.5-.35v-1.3c-2 .44-2.44-.96-2.44-.96-.33-.84-.8-1.06-.8-1.06-.66-.45.05-.44.05-.44.73.05 1.1.75 1.1.75.65 1.1 1.7.78 2.1.6.07-.47.26-.79.46-.97-1.6-.18-3.3-.8-3.3-3.58 0-.79.29-1.44.75-1.94-.08-.19-.33-.93.07-1.93 0 0 .61-.2 2 .75a6.9 6.9 0 0 1 3.64 0c1.39-.95 2-.75 2-.75.4 1 .15 1.74.08 1.93.47.5.75 1.15.75 1.94 0 2.79-1.7 3.4-3.32 3.57.26.23.5.67.5 1.36v2c0 .2.13.42.5.35A7.3 7.3 0 0 0 10 2.2Z"/>',
  cal: '<rect x="2.5" y="4" width="15" height="13.5" rx="2.5"/><path d="M2.5 8h15M6 2.2v3.4M14 2.2v3.4M6.2 11.6h2.2M11.6 11.6h2.2"/>',
  ryfe: '<circle cx="10" cy="10" r="3.2"/><ellipse cx="10" cy="10" rx="8.2" ry="2.6" transform="rotate(-22 10 10)"/>',
};

export function svg(glyph: string, size = 17, box = '0 0 20 20'): string {
  return (
    `<svg width="${size}" height="${size}" viewBox="${box}" fill="none" ` +
    `stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ` +
    `stroke-linejoin="round">${glyph}</svg>`
  );
}

export function emptyState(title: string, ...lines: string[]): string {
  return (
    `<div class="empty"><strong>${title}</strong>` +
    lines.map((l) => `<span>${l}</span>`).join('') +
    `</div>`
  );
}

export function head(title: string, meta: string): string {
  return (
    `<div class="bodyhead"><span class="bodytitle"><span class="disc"></span>${title}</span>` +
    `<span class="bodymeta">${meta}</span></div>`
  );
}

export function row(opts: {
  lead?: string;
  title: string;
  sub?: string;
  chip?: string;
  chipKind?: '' | 'hot' | 'good' | 'bad';
  clickable?: boolean;
  attrs?: string;
}): string {
  const { lead, title, sub, chip, chipKind, clickable, attrs } = opts;
  return (
    `<div class="row${clickable ? ' clickable' : ''}"${attrs ? ' ' + attrs : ''}>` +
    (lead ? `<span class="lead">${lead}</span>` : '') +
    `<span class="grow"><span class="t1">${title}</span>` +
    (sub ? `<span class="t2">${sub}</span>` : '') +
    `</span>` +
    (chip ? `<span class="chip ${chipKind ?? ''}">${chip}</span>` : '') +
    `</div>`
  );
}

/** Escapes text that came from git, GitHub or a model before it goes in the DOM. */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

export const gitView: View = {
  id: 'git',
  label: 'Git',
  hue: 'var(--c-git)',
  glyph: GLYPH.git,

  subtitle() {
    if (git.selected && git.status) {
      const n = git.status.files.length;
      return n === 0
        ? `${git.selected.name} · clean`
        : `${git.selected.name} · ${n} changed`;
    }
    if (git.loading) return 'reading your repositories…';
    const dirty = dirtyCount();
    const repos = git.repos.filter((r) => r.has_git).length;
    if (repos === 0) return 'no repositories found';
    return dirty === 0
      ? `${repos} repos · all clean`
      : `${repos} repos · ${dirty} with changes`;
  },

  render() {
    if (git.pane === 'diff') return renderDiff();
    if (git.pane === 'connect' && git.selected) return renderConnect();
    if (git.pane === 'repo' && git.selected) return renderRepo();
    return renderRepoList();
  },

  mount(root) {
    // --- repository list ---
    root.querySelectorAll<HTMLElement>('[data-repo]').forEach((el) => {
      el.addEventListener('click', () => {
        const repo = git.repos.find((r) => r.path === el.dataset.repo);
        if (repo) void openRepo(repo);
      });
    });

    root.querySelector('#git-back')?.addEventListener('click', backToRepos);
    root
      .querySelector('#git-back-diff')
      ?.addEventListener('click', backToRepo);
    root.querySelector('#git-refresh')?.addEventListener('click', () => {
      void loadRepos(true);
    });

    // --- file rows open their diff ---
    root.querySelectorAll<HTMLElement>('[data-file]').forEach((el) => {
      el.addEventListener('click', () => {
        void openDiff(el.dataset.file!, el.dataset.staged === '1');
      });
    });

    // --- staging: one file per box, or all of them at once ---
    root.querySelectorAll<HTMLInputElement>('[data-stage]').forEach((box) => {
      // The row underneath opens the diff; the box is not the row.
      box.addEventListener('click', (e) => e.stopPropagation());
      box.addEventListener('change', () => {
        const path = box.dataset.stage!;
        if (box.checked) {
          void runAction('stage_file', [path]);
        } else {
          // Unstaging restores from HEAD, and a repository with no commits has
          // none — there the files come back out of the index instead.
          void runAction(
            git.status?.has_commits ? 'unstage_file' : 'unstage_new',
            [path],
          );
        }
      });
    });

    const all = root.querySelector<HTMLInputElement>('#git-all');
    if (all) {
      all.addEventListener('change', () => {
        void runAction(
          all.checked
            ? 'stage_all'
            : git.status?.has_commits
              ? 'unstage_all'
              : 'unstage_new',
        );
      });
    }

    // --- the commit message is the user's; it is only ever read on click ---
    const msg = root.querySelector<HTMLInputElement>('#git-msg');
    if (msg) {
      msg.value = git.message;
      msg.addEventListener('input', () => {
        git.message = msg.value;
        // Commit is the next step in the chain, so it lights up as soon as
        // there is something staged and something to say about it. Set here
        // rather than by re-rendering, which would take the caret with it.
        const btn = root.querySelector<HTMLButtonElement>('#git-commit');
        if (btn) btn.disabled = !committable();
        updatePreview(root);
      });
      msg.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && committable()) {
          void runAction('commit', [git.message]);
        }
      });
    }

    const confirm = root.querySelector<HTMLInputElement>('#git-confirm');
    if (confirm) {
      confirm.value = git.confirm;
      confirm.addEventListener('input', () => {
        git.confirm = confirm.value;
        const btn = root.querySelector<HTMLButtonElement>('#git-force');
        if (btn) btn.disabled = git.confirm.trim() !== git.selected?.name;
      });
    }

    const wire = (sel: string, fn: () => void) =>
      root.querySelector(sel)?.addEventListener('click', fn);

    wire('#git-commit', () => void runAction('commit', [git.message]));
    wire('#git-push', () => {
      const st = git.status;
      if (!st) return;
      // A branch with no upstream has to be told where to go, or git stops with
      // "The current branch has no upstream branch".
      void runAction(
        st.upstream ? 'push' : 'push_upstream',
        st.upstream ? [] : [st.branch],
      );
    });
    wire('#git-pull', () => void runAction('pull'));
    wire('#git-fetch', () => void runAction('fetch'));
    wire('#git-stash', () => void runAction('stash_push'));
    wire('#git-force', () => void runAction('push_force', [], true));
    wire('#git-reset', () => void runAction('reset_hard', [], true));
    wire('#git-connect', () => {
      if (git.selected) openConnect(git.selected);
    });

    // --- the connect form: values live in git state, because refresh() swaps
    // the DOM out from under a half-filled form ---
    const name = root.querySelector<HTMLInputElement>('#connect-name');
    if (name) {
      name.value = git.connectName;
      name.addEventListener('input', () => {
        git.connectName = name.value;
      });
      name.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void connect();
      });
    }
    const priv = root.querySelector<HTMLInputElement>('#connect-private');
    if (priv) {
      priv.checked = git.connectPrivate;
      priv.addEventListener('change', () => {
        git.connectPrivate = priv.checked;
      });
    }
    wire('#connect-back', backToRepos);
    wire('#connect-go', () => void connect());

    updatePreview(root);
  },
};

// ---------------------------------------------------------------------------
// Git panel rendering
// ---------------------------------------------------------------------------

function renderRepoList(): string {
  if (git.loading && git.repos.length === 0) {
    return head('Git', '') + emptyState('Looking for repositories', 'One moment.');
  }
  // Only when there is nothing else to show: a failure inside one repository
  // must not take the list down with it.
  if (git.error && git.repos.length === 0) {
    return head('Git', '') + emptyState('Could not read your repositories', esc(git.error));
  }
  if (git.repos.length === 0) {
    return (
      head('Git', 'none found') +
      emptyState(
        'No repositories found',
        'Ryfe scanned the folders in Settings → Repositories.',
        'Add one there if your code lives somewhere else.',
      )
    );
  }

  const repos = git.repos.filter((r) => r.has_git);
  const plain = git.repos.filter((r) => !r.has_git);
  const dirty = dirtyCount();
  return (
    head(
      'Git',
      repos.length ? `${repos.length} found · ${dirty} with changes` : 'none on git yet',
    ) +
    `<div class="scroll">` +
    repos
      .map((r) =>
        row({
          title: esc(r.name),
          sub: esc(r.root),
          chip:
            r.dirty === null
              ? '?'
              : r.dirty === 0
                ? 'clean'
                : `${r.dirty} changed`,
          chipKind: (r.dirty ?? 0) > 0 ? 'hot' : r.dirty === null ? 'bad' : '',
          clickable: true,
          attrs: `data-repo="${esc(r.path)}"`,
        }),
      )
      .join('') +
    (plain.length
      ? sectionLabel('Not on git', plain.length) +
        plain
          .map((r) =>
            row({
              title: esc(r.name),
              sub: esc(r.root),
              chip: 'not on git',
              clickable: true,
              attrs: `data-repo="${esc(r.path)}"`,
            }),
          )
          .join('')
      : '') +
    `</div>` +
    (git.error
      ? `<div class="hintline" style="color:var(--bad)">${esc(git.error)}</div>`
      : '') +
    `<div class="hintline">${esc(git.roots.join('  ·  '))}</div>`
  );
}

/** How many of the changed files are staged — what Commit waits on. */
function stagedCount(): number {
  return (git.status?.files ?? []).filter((f) => f.staged).length;
}

/** Commit needs something staged, and something to say about it. */
function committable(): boolean {
  return stagedCount() > 0 && git.message.trim() !== '';
}

/** A button's face: its label, or a spinner while that exact action is running. */
function face(text: string, action: string): string {
  return git.runningAction === action ? `<span class="spin"></span>` : text;
}

/** A collapsed group, for the buttons that are not the next step. */
function fold(title: string, content: string): string {
  return (
    `<details style="flex:none">` +
    `<summary style="cursor:pointer;font-size:11.5px;color:var(--i-fg-3);font-family:var(--font-mono)">` +
    `${esc(title)}</summary>` +
    content +
    `</details>`
  );
}

function renderRepo(): string {
  const repo = git.selected!;
  const st = git.status;

  const bar =
    `<div class="gitbar">` +
    `<button class="btn ghost" id="git-back" style="padding:5px 10px">‹ Repos</button>` +
    `<span class="repo">${esc(repo.name)}</span>` +
    (st ? `<span class="chip">${esc(st.branch || 'detached')}</span>` : '') +
    (st && st.ahead > 0 ? `<span class="chip hot">↑${st.ahead}</span>` : '') +
    (st && st.behind > 0 ? `<span class="chip hot">↓${st.behind}</span>` : '') +
    `<span style="flex:1"></span>` +
    `<button class="btn ghost" id="git-refresh" style="padding:5px 10px">Refresh</button>` +
    `</div>`;

  if (!st) {
    return (
      head('Git', '') +
      bar +
      emptyState('Reading the repository…', git.error ? esc(git.error) : '')
    );
  }

  // While one action runs every control is off, so a second one cannot land on
  // top of it.
  const off = git.running ? 'disabled' : '';

  const files = st.files.length
    ? st.files
        .map((f) =>
          row({
            // The box stages this one file; the row behind it opens the diff.
            lead: `<input type="checkbox" data-stage="${esc(f.path)}" ${f.staged ? 'checked' : ''} ${off}>`,
            title: esc(f.path),
            sub: f.kind,
            chip:
              f.add || f.del
                ? `<span class="add">+${f.add}</span> <span class="del">−${f.del}</span>`
                : '',
            clickable: true,
            attrs: `data-file="${esc(f.path)}" data-staged="${f.staged ? '1' : '0'}"`,
          }),
        )
        .join('')
    : emptyState('Nothing to commit', 'The working tree is clean.');

  const body = git.output
    ? `<div class="hintline">$ ${esc(git.output.command)}</div>` +
      (git.output.stdout
        ? `<div class="hintline" style="color:var(--ok)">${esc(git.output.stdout.trim().slice(0, 400))}</div>`
        : '') +
      (git.output.stderr
        ? `<div class="hintline" style="color:var(--bad)">${esc(git.output.stderr.trim().slice(0, 400))}</div>`
        : '')
    : git.error
      ? `<div class="hintline" style="color:var(--bad)">${esc(git.error)}</div>`
      : '';

  // One step at a time: stage, commit, push. A step the repository is not ready
  // for is greyed out and says why, so the only button that ever looks wrong is
  // the one that is not the next move.
  const staged = stagedCount();
  const allStaged = st.files.length > 0 && staged === st.files.length;
  const canPush = st.upstream ? st.ahead > 0 : st.has_commits;

  // The list's own select-all: one box that stages everything or takes it all
  // back, sitting next to the files it acts on.
  const selectAll =
    st.files.length > 0
      ? `<div class="commitrow"><label class="hintline" style="display:flex;align-items:center;gap:6px;cursor:pointer">` +
        `<input type="checkbox" id="git-all" ${allStaged ? 'checked' : ''} ${off}>` +
        `Select all · ${staged} of ${st.files.length} staged</label></div>`
      : '';

  // Push only means something with a remote, and a branch to put on it. With no
  // remote at all the useful action is the one that makes one.
  const pushBtn = !st.remote
    ? `<button class="btn ghost" id="git-connect" ${off}>Connect to GitHub</button>`
    : st.branch && st.branch !== '(detached)'
      ? `<button class="btn ghost" id="git-push" ${canPush ? off : 'disabled'} ` +
        `title="${
          canPush
            ? 'send your commits'
            : st.has_commits
              ? 'nothing to send — everything is pushed'
              : 'nothing committed yet'
        }">${face('Push', st.upstream ? 'push' : 'push_upstream')}</button>`
      : '';

  return (
    head('Git', st.upstream ? esc(st.upstream) : st.remote ? 'no upstream' : 'no remote') +
    bar +
    selectAll +
    `<div class="scroll">${files}</div>` +
    `<div class="commitrow">` +
    `<input type="text" id="git-msg" autocomplete="off" ` +
    `placeholder="Commit message — it never writes one for you yet">` +
    `</div>` +
    `<div class="commitrow">` +
    `<button class="btn ghost" id="git-commit" ${committable() ? off : 'disabled'} ` +
    `title="${
      staged === 0
        ? 'stage something first'
        : git.message.trim() === ''
          ? 'write a commit message first'
          : 'commit what is staged'
    }">${face('Commit', 'commit')}</button>` +
    pushBtn +
    `</div>` +
    `<div class="hintline" id="git-preview"></div>` +
    fold(
      'Sync and stash',
      `<div class="commitrow" style="margin-top:8px">` +
        `<button class="btn ghost" id="git-pull" ${st.upstream ? off : 'disabled'} ` +
        `title="${st.upstream ? 'bring in what the remote has' : 'no upstream to pull from'}">${face('Pull', 'pull')}</button>` +
        `<button class="btn ghost" id="git-fetch" ${off}>${face('Fetch', 'fetch')}</button>` +
        `<button class="btn ghost" id="git-stash" ${st.files.length > 0 ? off : 'disabled'} ` +
        `title="${st.files.length > 0 ? 'put the changes aside' : 'nothing to stash'}">${face('Stash', 'stash_push')}</button>` +
        `</div>`,
    ) +
    fold(
      'These can lose work',
      `<div class="commitrow" style="margin-top:8px">` +
        `<input type="text" id="git-confirm" autocomplete="off" ` +
        `placeholder="type ${esc(repo.name)} to unlock">` +
        `<button class="btn ghost" id="git-force" disabled>Force push</button>` +
        `<button class="btn ghost" id="git-reset" disabled>Reset --hard</button>` +
        `</div>`,
    ) +
    body
  );
}

/**
 * The one button that turns a folder into a GitHub repository. Deliberately a
 * form rather than a single click: the repository name and whether the world
 * can see it are the user's to decide, not Ryfe's.
 */
function renderConnect(): string {
  const repo = git.selected!;

  const body = git.output
    ? `<div class="hintline">$ ${esc(git.output.command)}</div>` +
      (git.output.stdout
        ? `<div class="hintline" style="color:var(--ok)">${esc(git.output.stdout.trim().slice(0, 400))}</div>`
        : '') +
      (git.output.stderr
        ? `<div class="hintline" style="color:var(--bad)">${esc(git.output.stderr.trim().slice(0, 400))}</div>`
        : '')
    : git.error
      ? `<div class="hintline" style="color:var(--bad)">${esc(git.error)}</div>`
      : '';

  return (
    head('Git', repo.has_git ? 'no remote' : 'not on git yet') +
    `<div class="gitbar">` +
    `<button class="btn ghost" id="connect-back" style="padding:5px 10px">‹ Repos</button>` +
    `<span class="repo">${esc(repo.name)}</span>` +
    `</div>` +
    `<div class="scroll">` +
    emptyState(
      repo.has_git ? 'This repository has no GitHub remote' : 'This folder is not under git yet',
      repo.has_git
        ? 'Ryfe creates the repository on your account, adds it as origin and pushes.'
        : 'Ryfe runs git init, commits, creates the repository on your account and pushes.',
      'Otherwise nothing is created — a folder holding a .env or a pile of dependencies is refused.',
    ) +
    `</div>` +
    `<div class="commitrow">` +
    `<input type="text" id="connect-name" autocomplete="off" placeholder="repository name" ${git.connecting ? 'disabled' : ''}>` +
    `<label class="hintline" style="display:flex;align-items:center;gap:6px;cursor:pointer">` +
    `<input type="checkbox" id="connect-private" ${git.connectPrivate ? 'checked' : ''} ${git.connecting ? 'disabled' : ''}>` +
    `private</label>` +
    `<button class="btn" id="connect-go" ${git.connecting ? 'disabled' : ''}>` +
    `${git.connecting ? '<span class="spin"></span> Working…' : 'Create repo & push'}</button>` +
    `</div>` +
    body
  );
}

function renderDiff(): string {
  const body = git.diff === null
    ? emptyState('Reading the diff…')
    : `<pre class="diff">${esc(git.diff)}</pre>`;

  return (
    head('Git', esc(git.diffPath ?? '')) +
    `<div class="gitbar">` +
    `<button class="btn ghost" id="git-back-diff" style="padding:5px 10px">‹ Back</button>` +
    `</div>` +
    body
  );
}

/**
 * Shows the exact command the button will run, asked of Rust rather than
 * assembled here — so what the user reads and what actually runs cannot drift.
 */
function updatePreview(root: HTMLElement) {
  const el = root.querySelector<HTMLElement>('#git-preview');
  if (!el) return;
  void previewAction('commit', [git.message || '…']).then((res) => {
    if (!res) return;
    const [command] = res;
    el.textContent = `Will run: ${command}`;
  });
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export const githubView: View = {
  id: 'gh',
  label: 'GitHub',
  hue: 'var(--c-gh)',
  glyph: GLYPH.gh,

  subtitle,

  render() {
    if (gh.error) {
      return (
        head('GitHub', 'not connected') +
        emptyState('GitHub is not connected', esc(gh.error))
      );
    }
    if (!gh.pulse) {
      return head('GitHub', '') + emptyState('Reading your pull requests…');
    }

    const p = gh.pulse;
    const parts: string[] = [];
    parts.push(sparkline());

    parts.push(sectionLabel('Yours', p.authored.length));
    parts.push(
      p.authored.length
        ? p.authored.map(prRow).join('')
        : `<div class="row"><span class="grow"><span class="t2">Nothing open.</span></span></div>`,
    );

    parts.push(sectionLabel('Waiting on your review', p.reviewing.length));
    parts.push(
      p.reviewing.length
        ? p.reviewing.map(prRow).join('')
        : `<div class="row"><span class="grow"><span class="t2">Nothing waiting.</span></span></div>`,
    );

    if (gh.activity && gh.activity.repos.length) {
      parts.push(sectionLabel('Default branch', gh.activity.repos.length));
      parts.push(
        gh.activity.repos
          .map((r) => {
            const chip = ciChip(r.ci);
            return row({
              title: esc(r.repo),
              sub: esc(r.branch),
              chip: chip.text,
              chipKind: chip.kind,
            });
          })
          .join(''),
      );
    }

    return (
      head('GitHub', `@${esc(p.login)} · ${gh.activity?.total ?? 0} contributions`) +
      `<div class="scroll">${parts.join('')}</div>` +
      `<div class="commitrow">` +
      `<button class="btn ghost" id="gh-refresh">Refresh</button>` +
      `<span class="hintline">Pull requests refresh every minute; contributions every five.</span>` +
      `</div>`
    );
  },

  mount(root) {
    root.querySelector('#gh-refresh')?.addEventListener('click', () => {
      void loadPulse(true);
      void loadActivity(true);
    });
    root.querySelectorAll<HTMLElement>('[data-url]').forEach((el) => {
      el.addEventListener('click', () => {
        void openExternal(el.dataset.url!);
      });
    });
  },
};

function sectionLabel(text: string, n: number): string {
  return (
    `<div style="flex:none;padding:6px 2px 1px;font-size:11px;letter-spacing:.08em;` +
    `text-transform:uppercase;color:var(--i-fg-3);font-weight:600">` +
    `${esc(text)} <span style="color:var(--i-fg-3);font-weight:400">${n}</span></div>`
  );
}

function prRow(pr: PullRequest): string {
  const chip = ciChip(pr.ci);
  const needsReview = pr.review === 'REVIEW_REQUIRED';
  return row({
    title: `${esc(pr.repo.split('/').pop() ?? '')} #${pr.number} — ${esc(pr.title)}`,
    sub: pr.author ? `by ${esc(pr.author)}` : '',
    chip: needsReview ? 'review' : chip.text,
    chipKind: needsReview ? 'hot' : chip.kind,
    clickable: true,
    attrs: `data-url="${esc(pr.url)}"`,
  });
}

/**
 * The contribution graph, as 23 weeks of seven days. Each cell is tinted by
 * its count, so the shape of a working month is visible at a glance.
 */
function sparkline(): string {
  const days = gh.activity?.days ?? [];
  if (days.length === 0) return '';
  const peak = Math.max(1, ...days);
  const cells = days
    .map((n) => {
      const level = n === 0 ? 0 : Math.ceil((n / peak) * 4);
      const pct = [0, 22, 44, 70, 100][level];
      return `<i style="background:color-mix(in oklab, var(--acc) ${pct}%, var(--i-2))" title="${n}"></i>`;
    })
    .join('');
  return `<div class="spark">${cells}</div>`;
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export const calendarView: View = {
  id: 'cal',
  label: 'Calendar',
  hue: 'var(--c-cal)',
  glyph: GLYPH.cal,
  subtitle: () => 'not connected',
  render: () =>
    head('Calendar', 'not connected') +
    emptyState(
      'Google Calendar is not connected yet',
      'It needs a Desktop OAuth client on your own Google Cloud project —',
      'the client you already have is a Web one and cannot work here.',
      'Settings → Calendar walks through it.',
    ),
};

// ---------------------------------------------------------------------------
// The assistant
// ---------------------------------------------------------------------------

/**
 * What the model did on the way to its reply, folded into one line.
 *
 * Reading a repository runs a dozen tool calls, and a dozen chips stacked above
 * every answer buries the answer. The line says what happened and unfolds on a
 * click; whether it is unfolded lives on the message, so the redraw that comes
 * with every streamed word cannot shut it again.
 */
function steps(m: Message, i: number): string {
  if (!m.used?.length) return '';
  const names = m.used.map((t) => t.replace(/_/g, ' '));
  // Repeats are counted rather than listed: five `read file` chips are noise.
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  const summary = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(', ');
  const head =
    `<button class="stepshead" data-steps="${i}" aria-expanded="${m.open === true}" ` +
    `title="${esc(summary)}">${m.open ? '▾' : '▸'} ` +
    `${names.length} step${names.length === 1 ? '' : 's'} · ${esc(summary)}</button>`;
  if (!m.open) return head;
  return (
    `<div class="steps">${head}` +
    names.map((t) => `<span class="tool"><span class="dot"></span>${esc(t)}</span>`).join('') +
    `</div>`
  );
}

/**
 * The card a proposed file arrives on.
 *
 * It shows the file itself rather than a description of it: approving is the
 * only thing that writes anything, so what is being approved has to be visible.
 */
function proposalCard(p: Proposal, i: number): string {
  // A long README would fill the panel; the rest is still written in full.
  const preview =
    p.content.length > 1200 ? p.content.slice(0, 1200) + '\n…' : p.content;
  const head =
    `<div class="prophead"><span>${esc(p.path)}</span>` +
    `<span class="chip${p.existingBytes != null ? ' hot' : ''}">` +
    `${p.existingBytes != null ? 'replaces an existing file' : 'new file'}</span></div>`;

  if (p.state === 'pending') {
    return (
      `<div class="prop">${head}<pre class="propbody">${esc(preview)}</pre>` +
      `<div class="commitrow">` +
      `<button class="btn" data-prop="write" data-i="${i}">` +
      `${p.existingBytes != null ? 'Replace it' : 'Create it'}</button>` +
      `<button class="btn ghost" data-prop="cancel" data-i="${i}">Cancel</button>` +
      `</div></div>`
    );
  }

  const note = p.note
    ? `<div class="hintline${p.state === 'failed' ? ' bad' : ''}">${esc(p.note)}</div>`
    : '';
  const offer =
    p.state === 'done' && p.offer
      ? `<div class="commitrow">` +
        `<button class="btn" data-prop="push" data-i="${i}">Commit and push it</button>` +
        `<button class="btn ghost" data-prop="later" data-i="${i}">Not now</button>` +
        `</div>`
      : '';
  return `<div class="prop">${head}${note}${offer}</div>`;
}

export const chatView: View = {
  id: 'ryfe',
  label: 'Ryfe',
  // The accent's own value, not `var(--acc)`: the shell writes the hue into
  // `--acc` on the panel, so that would be a cycle and every button in here
  // would come out with no background at all.
  hue: 'var(--acc-b)',
  glyph: GLYPH.ryfe,

  subtitle() {
    if (chat.busy) {
      return chat.tools.length
        ? `${chat.tools[chat.tools.length - 1].replace(/_/g, ' ')}…`
        : 'thinking…';
    }
    return chat.messages.length
      ? `${chat.messages.length} message${chat.messages.length === 1 ? '' : 's'}`
      : 'ask about your repos';
  },

  render() {
    const bubbles = chat.messages
      .map((m, i) => {
        const tools = steps(m, i);
        // A proposal is the card itself, not a bubble with words in it.
        if (m.proposal) return tools + proposalCard(m.proposal, i);
        return (
          tools +
          `<span class="bub ${m.role === 'me' ? 'me' : m.role === 'err' ? 'err' : 'bot'}">` +
          `${esc(m.text)}</span>`
        );
      })
      .join('');

    const live = chat.busy
      ? `<span class="tool busy"><span class="dot"></span>` +
        `${chat.tools.length ? esc(chat.tools[chat.tools.length - 1].replace(/_/g, ' ')) : 'thinking'}</span>` +
        (chat.streaming
          ? `<span class="bub bot">${esc(chat.streaming)}</span>`
          : '')
      : '';

    const body = chat.messages.length || chat.busy
      ? bubbles + live
      : emptyState(
          'Nothing asked yet',
          'With a DeepSeek key set, this can read your repositories and pull',
          'requests, and write files you approve. Nothing is created, committed',
          'or pushed until you say so on the card it shows you.',
        );

    return (
      head('Ryfe', esc(chat.models[0] ?? 'deepseek')) +
      `<div class="scroll" id="chatlog">${body}</div>` +
      `<div class="commitrow">` +
      `<input type="text" id="chatin" autocomplete="off" ` +
      `placeholder="Ask, or say what to do…">` +
      `<button class="btn" id="chatsend" ${chat.busy ? 'disabled' : ''}>Send</button>` +
      `<button class="btn ghost" id="chatthink" title="Let the model reason before answering. Slower, and it cannot use certain tools.">` +
      `${chat.think ? 'Thinking on' : 'Think harder'}</button>` +
      `</div>` +
      `<div class="hintline" id="chathint">${chat.models.length ? '' : 'No model list yet — check the key in Settings → DeepSeek.'}</div>`
    );
  },

  mount(root) {
    const input = root.querySelector<HTMLInputElement>('#chatin');
    const send = root.querySelector<HTMLButtonElement>('#chatsend');
    if (!input || !send) return;

    // Focus is the only thing that lets the island hold the keyboard, and it is
    // handed straight back when the field loses it.
    input.addEventListener('focus', () => void setFocusable(true));
    input.addEventListener('blur', () => void setFocusable(false));

    const submit = () => {
      const text = input.value;
      input.value = '';
      void sendMessage(text);
    };
    send.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    });

    root.querySelector('#chatthink')?.addEventListener('click', () => {
      chat.think = !chat.think;
      refresh();
    });

    // Unfolding what the model did to get to a reply.
    root.querySelectorAll<HTMLButtonElement>('[data-steps]').forEach((b) => {
      b.addEventListener('click', () => {
        const m = chat.messages[Number(b.dataset.steps ?? -1)];
        if (!m) return;
        m.open = !m.open;
        refresh();
      });
    });

    // The proposal cards' buttons, re-bound on every render like the rest of
    // the panel. The index is what finds the proposal the button belongs to.
    root.querySelectorAll<HTMLButtonElement>('[data-prop]').forEach((b) => {
      b.addEventListener('click', () => {
        const p = chat.messages[Number(b.dataset.i ?? -1)]?.proposal;
        if (!p) return;
        if (b.dataset.prop === 'write') void approveProposal(p);
        else if (b.dataset.prop === 'push') void commitAndPush(p);
        else if (b.dataset.prop === 'cancel') declineProposal(p);
        else {
          p.offer = false;
          refresh();
        }
      });
    });

    // Keep the newest message in view without stealing the scroll position the
    // user set by hand.
    const log = root.querySelector<HTMLElement>('#chatlog');
    if (log) log.scrollTop = log.scrollHeight;

    if (!chat.busy) input.focus({ preventScroll: true });
  },
};

/**
 * Settings lives here with the others so the shell can swap it in the same way,
 * but it has no tile — the gear in the capsule opens it.
 */
export const settingsView: View = {
  id: 'settings',
  label: 'Settings',
  hue: 'var(--i-fg-2)',
  glyph: GEAR,
  box: '0 0 24 24',
  tile: false,
  subtitle: () => 'settings',
  render: settingsViewHtml,
  mount(root) {
    settingsViewMount(root);
    void loadSettingsView();
  },
};

export const VIEWS: View[] = [gitView, githubView, calendarView, chatView];

/** Everything the shell can show, including the views with no tile. */
export const ALL_VIEWS: View[] = [...VIEWS, settingsView];
