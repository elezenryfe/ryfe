/**
 * The conversation with DeepSeek.
 *
 * The transcript lives in Rust — this is a view of it, plus the streaming
 * state. Deltas arrive as events while a reply is being written, so the panel
 * can show words as they land instead of waiting for the whole answer.
 */

import { invoke, listen } from './bridge';
import { refresh } from '../island/host';

export interface Message {
  role: 'me' | 'bot' | 'err';
  text: string;
  /** Tool names that ran while producing this reply. */
  used?: string[];
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
      chat.messages.push({
        role: 'bot',
        text: `Proposal: ${p.tool.replace('propose_', '').replace('_', ' ')}`,
        used: [p.tool],
      });
      refresh();
    },
  );
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
