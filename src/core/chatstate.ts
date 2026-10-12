/**
 * The conversation with DeepSeek.
 *
 * The transcript lives in Rust — this is a view of it, plus the streaming
 * state. Deltas arrive as events while a reply is being written, so the panel
 * can show words as they land instead of waiting for the whole answer.
 */

import { invoke, listen } from './bridge';
import { refresh } from '../island/host';
import { unsafeToPublish } from './gitstate';

export interface Message {
  role: 'me' | 'bot' | 'err';
  text: string;
  /** Tool names that ran while producing this reply. */
  used?: string[];
  /** True once the user has unfolded that list. Kept here so a redraw, and the
   *  one that happens on every streamed word, does not shut it again. */
  open?: boolean;
  /** A card waiting for the user to approve it. */
  proposal?: Proposal;
}

/** A file the model wants to write, and what came of it. */
export interface Proposal {
  repo: string;
  path: string;
  content: string;
  /** Set by Rust when something is already at that path. */
  existingBytes?: number;
  state: 'pending' | 'done' | 'declined' | 'failed';
  /** What happened, or why it did not. */
  note?: string;
  /** True while the commit-and-push offer is still on the table. */
  offer?: boolean;
}

interface State {
  messages: Message[];
  /** Text arriving right now, not yet committed to a message. */
  streaming: string;
  /** True between sending and the reply finishing. */
  busy: boolean;
  /** The model is mid-tool-call; the names so far. */
  tools: string[];
  think: boolean;
  error: string | null;
  models: string[];
}

export const chat: State = {
  messages: [],
  streaming: '',
  busy: false,
  tools: [],
  think: false,
  error: null,
  models: [],
};

/** True while a reply is streaming, used to keep the pet in its working state. */
export function isBusy() {
  return chat.busy;
}

let wired = false;

/** Subscribes to the streaming events. Safe to call more than once. */
export async function wireChat() {
  if (wired) return;
  wired = true;

  await listen<string>('ai-delta', (piece) => {
    chat.streaming += piece;
    refresh();
  });

  // A proposal is not an action — it is a card the user has to approve.
  await listen<{ tool: string; args: Record<string, unknown> }>(
    'ai-proposal',
    (p) => {
      if (p.tool === 'propose_create_file') {
        const a = p.args;
        chat.messages.push({
          role: 'bot',
          text: '',
          used: [p.tool],
          proposal: {
            repo: String(a.repo ?? ''),
            path: String(a.path ?? ''),
            content: String(a.content ?? ''),
            existingBytes:
              typeof a.existing_bytes === 'number' ? a.existing_bytes : undefined,
            state: 'pending',
          },
        });
      } else {
        chat.messages.push({
          role: 'bot',
          text: `Proposal: ${p.tool.replace('propose_', '').replace('_', ' ')}`,
          used: [p.tool],
        });
      }
      refresh();
    },
  );
}

const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

/** Writes the proposed file, once the user has said yes. */
export async function approveProposal(p: Proposal) {
  if (p.state !== 'pending') return;
  // Out of 'pending' before the write starts, so the button cannot be pressed
  // twice while it runs.
  p.state = 'failed';
  p.note = 'Writing…';
  refresh();

  try {
    const out = await invoke<{ bytes: number; replaced: boolean }>('file_write', {
      repo: p.repo,
      path: p.path,
      content: p.content,
    });
    p.state = 'done';
    p.offer = true;
    p.note = `${out.replaced ? 'Replaced' : 'Created'} ${p.path} · ${kb(out.bytes)}`;
  } catch (e) {
    p.state = 'failed';
    p.note = String(e);
  }
  refresh();
}

export function declineProposal(p: Proposal) {
  p.state = 'declined';
  p.note = 'Not written.';
  refresh();
}

/**
 * The next step after a file lands: stage that one file, commit it, push it.
 *
 * Only that path is ever staged — never `-A` — and the commit names it as a
 * pathspec, so a dependency tree or a `.env` the user happens to have staged
 * cannot be swept in. The push is the same one the Git tab offers, and it is
 * put past the same publish check first.
 */
export async function commitAndPush(p: Proposal) {
  if (!p.offer) return;
  p.offer = false;

  const say = (text: string, role: Message['role'] = 'bot') => {
    chat.messages.push({ role, text });
    refresh();
  };
  const why = (out: { stderr: string; stdout: string }) =>
    out.stderr.trim() || out.stdout.trim() || 'git failed';

  try {
    const st = await invoke<{ branch: string; upstream: string; remote: string }>(
      'git_status',
      { repo: p.repo },
    );
    const run = (action: string, args: string[]) =>
      invoke<{ ok: boolean; stderr: string; stdout: string }>('git_run', {
        repo: p.repo,
        action,
        args,
        confirm: '',
      });

    const staged = await run('stage_file', [p.path]);
    if (!staged.ok) return say(`Could not stage ${p.path}: ${why(staged)}`, 'err');

    const committed = await run('commit_file', [`Add ${p.path}`, p.path]);
    if (!committed.ok) return say(`Could not commit ${p.path}: ${why(committed)}`, 'err');

    if (!st.remote) {
      return say(
        `Committed ${p.path}. There is no remote to push to — connect the folder in the Git tab.`,
      );
    }
    const refused = await unsafeToPublish(p.repo);
    if (refused) return say(`Committed ${p.path}, but I did not push it. ${refused}`);

    const pushed = st.upstream
      ? await run('push', [])
      : await run('push_upstream', [st.branch]);
    if (!pushed.ok) {
      return say(`Committed ${p.path}, but the push failed: ${why(pushed)}`, 'err');
    }
    say(`Committed and pushed ${p.path}.`);
  } catch (e) {
    say(String(e), 'err');
  }
}

export async function loadModels() {
  try {
    const models = await invoke<{ id: string }[]>('ai_models');
    chat.models = models.map((m) => m.id);
  } catch {
    // A missing or bad key is reported when a message is actually sent; the
    // picker just stays empty.
    chat.models = [];
  }
  refresh();
}

export async function send(text: string) {
  const trimmed = text.trim();
  if (!trimmed || chat.busy) return;

  chat.messages.push({ role: 'me', text: trimmed });
  chat.busy = true;
  chat.streaming = '';
  chat.tools = [];
  chat.error = null;
  refresh();

  try {
    const reply = await invoke<{ text: string; used: string[] }>('ai_send', {
      text: trimmed,
      think: chat.think,
    });
    chat.messages.push({ role: 'bot', text: reply.text, used: reply.used });
  } catch (e) {
    // Replace whatever streamed in with the reason it stopped.
    chat.messages.push({ role: 'err', text: String(e) });
  } finally {
    chat.streaming = '';
    chat.busy = false;
    refresh();
  }
}

export async function reset() {
  chat.messages = [];
  chat.streaming = '';
  chat.error = null;
  await invoke<void>('ai_reset');
  refresh();
}
