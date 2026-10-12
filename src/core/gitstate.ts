/**
 * What the git panel is looking at, and everything it knows about it.
 *
 * Kept apart from the drawing so the panel is a pure function of this state,
 * and so a slow `git status` can land without the UI having to guess what is
 * stale.
 */

import { invoke } from './bridge';
import { refresh } from '../island/host';

export interface Repo {
  path: string;
  name: string;
  root: string;
  dirty: number | null;
  /** False for a folder listed only because it is not under git yet. */
  has_git: boolean;
}

export interface FileChange {
  path: string;
  kind: string;
  staged: boolean;
  add: number;
  del: number;
}

export interface RepoStatus {
  branch: string;
  upstream: string;
  /** The origin URL, or empty when there is no remote at all. */
  remote: string;
  /** False on a branch with nothing committed yet. */
  has_commits: boolean;
  ahead: number;
  behind: number;
  files: FileChange[];
}

export interface GitOutput {
  command: string;
  /** Whether git exited 0. A failure still arrives here, with it in stderr. */
  ok: boolean;
  stdout: string;
  stderr: string;
}

type Pane = 'repos' | 'repo' | 'diff' | 'connect';

interface State {
  pane: Pane;
  repos: Repo[];
  selected: Repo | null;
  status: RepoStatus | null;
  diff: string | null;
  diffPath: string | null;
  loading: boolean;
  running: boolean;
  /** Which action is running, so its own button can say so. */
  runningAction: string | null;
  /** Bumped when an action succeeds, so the island can react to it. */
  cheer: number;
  error: string | null;
  /** The last command's result, shown under the commit box. */
  output: GitOutput | null;
  /** Typed by the user. Only ever sent when they press the button. */
  message: string;
  /** Required to enable a destructive action. */
  confirm: string;
  roots: string[];
  /** The name the new GitHub repository will get. */
  connectName: string;
  /** Private unless the user says otherwise. */
  connectPrivate: boolean;
  /** Its own guard: runAction gives up silently while it is set. */
  connecting: boolean;
  /** Filled once the repository exists, so a retry does not create a second. */
  createdUrl: string | null;
}

export const git: State = {
  pane: 'repos',
  repos: [],
  selected: null,
  status: null,
  diff: null,
  diffPath: null,
  loading: false,
  running: false,
  runningAction: null,
  cheer: 0,
  error: null,
  output: null,
  message: '',
  confirm: '',
  roots: [],
  connectName: '',
  connectPrivate: true,
  connecting: false,
  createdUrl: null,
};

export function setRoots(roots: string[]) {
  git.roots = roots;
}

/** Whether any repository has uncommitted changes. Drives the tile badge. */
export function dirtyCount(): number {
  return git.repos.filter((r) => (r.dirty ?? 0) > 0).length;
}

export async function loadRepos(force = false) {
  if (git.loading) return;
  // Discovery walks the disk; it is not worth repeating on every redraw.
  if (!force && git.repos.length > 0) return;

  git.loading = true;
  git.error = null;
  refresh();
  try {
    git.repos = await invoke<Repo[]>('git_repos', { roots: git.roots });
  } catch (e) {
    git.error = String(e);
  } finally {
    git.loading = false;
    refresh();
  }
}

export async function openRepo(repo: Repo) {
  if (!repo.has_git) return openConnect(repo);
  git.selected = repo;
  git.pane = 'repo';
  git.status = null;
  git.output = null;
  git.diff = null;
  git.confirm = '';
  refresh();
  await reloadStatus();
}

export async function reloadStatus() {
  const repo = git.selected;
  if (!repo) return;
  try {
    git.status = await invoke<RepoStatus>('git_status', { repo: repo.path });
    git.error = null;
    // Keep the list's dirty counts honest with what we just saw.
    repo.dirty = git.status.files.length;
  } catch (e) {
    git.error = String(e);
  }
  refresh();
}

export function backToRepos() {
  git.pane = 'repos';
  git.selected = null;
  git.status = null;
  git.diff = null;
  git.output = null;
  // A failure inside one repository is not a failure of the list.
  git.error = null;
  refresh();
}

export function backToRepo() {
  git.pane = 'repo';
  git.diff = null;
  git.diffPath = null;
  refresh();
}

export async function openDiff(path: string, staged: boolean) {
  const repo = git.selected;
  if (!repo) return;
  git.diffPath = path;
  git.diff = null;
  git.pane = 'diff';
  refresh();
  try {
    git.diff = await invoke<string>('git_diff', {
      repo: repo.path,
      path,
      staged,
    });
  } catch (e) {
    git.diff = `Could not read the diff.\n\n${e}`;
  }
  refresh();
}

/**
 * Runs one action from the catalogue.
 *
 * `confirm` is only filled in for destructive actions, where Rust refuses
 * anything that does not match the repository's own folder name.
 */
export async function runAction(
  action: string,
  args: string[] = [],
  needsConfirm = false,
): Promise<GitOutput | null> {
  const repo = git.selected;
  if (!repo || git.running) return null;

  git.running = true;
  git.runningAction = action;
  git.output = null;
  git.error = null;
  refresh();

  try {
    const out = await invoke<GitOutput>('git_run', {
      repo: repo.path,
      action,
      args,
      confirm: needsConfirm ? git.confirm : '',
    });
    git.output = out;
    git.message = '';
    git.confirm = '';
    if (out.ok) git.cheer += 1;
    // A folder that is not a repository yet has no status to read; `init` makes
    // it one, and the actions after it reload normally.
    if (repo.has_git) await reloadStatus();
    return out;
  } catch (e) {
    git.error = String(e);
    return null;
  } finally {
    git.running = false;
    git.runningAction = null;
    refresh();
  }
}

/** Runs one step of the connect flow. False means it failed and the flow stopped. */
async function step(action: string, args: string[] = []): Promise<boolean> {
  const out = await runAction(action, args);
  return out?.ok === true;
}

interface PublishCheck {
  files: number;
  conflicts: number;
  env_files: string[];
  heaviest: string;
  embedded: string[];
}

/**
 * Refuses to publish a folder that would clearly go wrong: an unresolved merge,
 * a `.env` committed for good, or a whole dependency tree with no .gitignore.
 *
 * Asked of Rust, which counts with `-uall` — the page only ever sees `git
 * status`, which collapses a folder of dependencies into a single line.
 */
async function unsafeToPublish(repo: Repo): Promise<string | null> {
  const check = await invoke<PublishCheck>('git_publish_check', { repo: repo.path });
  if (check.conflicts > 0) {
    return 'There are unresolved conflicts in this folder — sort those out first.';
  }
  if (check.embedded.length > 0) {
    const which = check.embedded.slice(0, 3).join(', ');
    const more = check.embedded.length > 3 ? ` (and ${check.embedded.length - 3} more)` : '';
    return `There is a .git in ${which}${more} — publishing this folder would record a pointer to it, not its files. Remove that .git to fold it in, or add it to a .gitignore to keep it separate.`;
  }
  if (check.env_files.length > 0) {
    return `This folder holds ${check.env_files.slice(0, 3).join(', ')} — secrets a commit would keep for good. Move them out or ignore them, then try again.`;
  }
  if (check.files > 2000) {
    const where = check.heaviest ? `, most of them under ${check.heaviest}/` : '';
    return `This folder has ${check.files} files to publish${where}. Add a .gitignore, then try again.`;
  }
  return null;
}

/** The setup pane for a folder that is not on GitHub yet. */
export function openConnect(repo: Repo) {
  // Coming back to the same folder keeps the URL of the repository already made.
  if (git.selected?.path !== repo.path) git.createdUrl = null;
  git.selected = repo;
  git.pane = 'connect';
  git.status = null;
  git.output = null;
  git.error = null;
  git.confirm = '';
  git.connectName = repo.name;
  refresh();
}

/**
 * Puts the selected folder on GitHub: git if it is not one yet, a first commit
 * if it has none, the repository itself, then the remote and the first push.
 *
 * The local steps run first, so a step that fails never leaves a repository on
 * GitHub that nothing on this machine points at.
 */
export async function connect() {
  const repo = git.selected;
  if (!repo || git.connecting || git.running) return;

  git.connectName = git.connectName.trim();
  if (!git.connectName) {
    git.error = 'Give the repository a name first.';
    refresh();
    return;
  }

  git.connecting = true;
  git.error = null;
  git.output = null;
  refresh();

  try {
    if (!repo.has_git) {
      if (!(await step('init'))) return;
      repo.has_git = true; // it is one now, and a status read needs that to be true
    }

    // What would be published is decided before anything is staged, committed
    // or created: a folder that fails this is left exactly as it was.
    await reloadStatus();
    const files = git.status?.files ?? [];
    const refused = await unsafeToPublish(repo);
    if (refused) {
      git.error = refused;
      return;
    }

    if (!(await step('log'))) {
      // No commits yet: make the first one, or there is nothing to push.
      if (files.length === 0) {
        git.error = 'This folder is empty — there is nothing to push yet.';
        return;
      }
      if (!(await step('stage_all'))) return;
      if (!(await step('commit', ['Initial commit']))) return;
    }

    if (!git.createdUrl) {
      // Rust answers with the clone URL itself, not an object around it.
      const url = await invoke<string>('gh_create_repo', {
        name: git.connectName,
        private: git.connectPrivate,
      });
      if (typeof url !== 'string' || !url) {
        git.error = 'GitHub did not say where the repository lives.';
        return;
      }
      git.createdUrl = url;
    }

    if (!(await step('remote_add', [git.createdUrl]))) return;

    const branch = git.status?.branch ?? '';
    if (!branch || branch === '(detached)') {
      git.error = 'Ryfe could not tell which branch to push.';
      return;
    }
    if (!(await step('push_upstream', [branch]))) return;

    git.connectName = '';
    git.createdUrl = null;
    await loadRepos(true);
    await openRepo(git.repos.find((r) => r.path === repo.path) ?? repo);
  } catch (e) {
    git.error = String(e);
  } finally {
    git.connecting = false;
    refresh();
  }
}

export async function previewAction(action: string, args: string[] = []) {
  const repo = git.selected;
  if (!repo) return null;
  try {
    return await invoke<[string, 'read' | 'write' | 'destructive']>('git_preview', {
      repo: repo.path,
      action,
      args,
    });
  } catch {
    return null;
  }
}
