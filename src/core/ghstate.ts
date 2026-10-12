/**
 * GitHub data, and how fresh it is.
 *
 * The two halves move at completely different speeds, so they are loaded and
 * aged separately: pull requests go stale in a minute, a contribution graph in
 * five. Asking for both together would either hammer the API or leave the pull
 * requests wrong.
 */

import { invoke } from './bridge';
import { refresh } from '../island/host';

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  repo: string;
  author: string;
  draft: boolean;
  ci: string;
  review: string;
}

export interface Pulse {
  login: string;
  authored: PullRequest[];
  reviewing: PullRequest[];
}

export interface RepoCi {
  repo: string;
  branch: string;
  ci: string;
}

export interface Activity {
  login: string;
  total: number;
  /** One contribution count per day, oldest first. */
  days: number[];
  from: string;
  repos: RepoCi[];
}

interface State {
  pulse: Pulse | null;
  activity: Activity | null;
  loading: boolean;
  error: string | null;
  at: number;
}

export const gh: State = {
  pulse: null,
  activity: null,
  loading: false,
  error: null,
  at: 0,
};

/** How many pull requests need you: failing CI, or waiting on your review. */
export function attentionCount(): number {
  if (!gh.pulse) return 0;
  const failing = gh.pulse.authored.filter((p) => p.ci === 'failure' || p.ci === 'error');
  return failing.length + gh.pulse.reviewing.length;
}

export function subtitle(): string {
  if (gh.error) return 'not connected';
  if (!gh.pulse) return 'reading your pull requests…';
  const n = attentionCount();
  if (n > 0) return `${n} need${n === 1 ? 's' : ''} you`;
  const total = gh.pulse.authored.length + gh.pulse.reviewing.length;
  return total === 0 ? 'nothing open' : `${total} open · all quiet`;
}

export async function loadPulse(force = false) {
  // Re-asking under a minute old is pointless; Rust enforces the same window.
  if (!force && gh.pulse && Date.now() - gh.at < 60_000) return;

  gh.error = null;
  try {
    gh.pulse = await invoke<Pulse>('gh_pulse', { force });
    gh.at = Date.now();
  } catch (e) {
    gh.error = String(e);
  }
  refresh();
}

export async function loadActivity(force = false) {
  try {
    gh.activity = await invoke<Activity>('gh_activity', { force });
  } catch (e) {
    // A missing token is already reported by the pulse call; do not shout twice.
    if (!gh.error) gh.error = String(e);
  }
  refresh();
}

/** Called when the token changes, so one account never sees another's data. */
export async function forget() {
  gh.pulse = null;
  gh.activity = null;
  gh.at = 0;
  await invoke<void>('gh_forget');
}

/** A short label and tone for a CI state. */
export function ciChip(ci: string): { text: string; kind: '' | 'hot' | 'good' | 'bad' } {
  switch (ci) {
    case 'success':
      return { text: 'passing', kind: 'good' };
    case 'failure':
      return { text: 'failing', kind: 'bad' };
    case 'error':
      return { text: 'errored', kind: 'bad' };
    case 'pending':
    case 'expected':
      return { text: 'running', kind: 'hot' };
    default:
      return { text: 'no checks', kind: '' };
  }
}
