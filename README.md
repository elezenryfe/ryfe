# Ryfe

A small machine that lives at the top of your screen on Windows.

Ryfe is a frameless, always-on-top capsule — an "island" — that stays out of the
way until you need it. It knows about your local git repositories, your GitHub
pull requests, and it has a model that can read both.

## What it does

- **Your repositories.** Point it at one or more folders and it lists the git
  projects inside them, with how many files each has changed. You can see the
  branch, how far ahead or behind the remote you are, the changed files with
  their line counts, and the diff for any one of them.
- **Your pull requests.** Open PRs you wrote and PRs waiting on your review, each
  with its CI state, plus a contribution sparkline and the CI status of your most
  recently pushed repositories.
- **An assistant.** A model that can call tools to read your repos, your files
  and your PRs, so it answers questions about your actual code rather than
  guessing.

## How it behaves

The island is a single window that resizes between three states — hidden,
compact, and open. It never takes focus unless a text field is on screen, and it
is click-through everywhere except the part of it that is actually drawn. Rust
polls the cursor and decides what is clickable from the rectangle the front end
reports after every layout change.

## Nothing acts on its own

This is the rule the whole thing is built around. Tools that could change
something — committing, writing a file, pushing — do not run. They put a card on
screen describing exactly what they would do, and the user approves it. The
assistant is told this explicitly and is never allowed to claim it did something.

The same instinct shapes the git layer: there is no "run this git command"
command. The front end picks from a fixed catalogue of actions, each with its
argv written out in Rust. A value from the UI is only ever slotted into a slot
that already exists, and anything starting with `-` is rejected so it cannot turn
into a flag. Destructive actions additionally require the caller to echo back the
repository's own folder name, and that check lives in Rust rather than the UI.

## Layout

```
src/                 the front end (TypeScript, no framework)
  core/bridge.ts     the only place that talks to Rust
  core/              chat, git and GitHub state
  island/            the island's views and its host
  pet/               the little character that sits in it
src-tauri/src/
  lib.rs             window setup, tray, command registration
  island.rs          window geometry, click-through, cursor polling
  git.rs             local git, with the leash described above
  github.rs          GitHub over GraphQL
  ai.rs              the model, its tools, and the conversation
  secrets.rs         credentials, in the OS store
  settings.rs        preferences, as JSON
  platform.rs        the Windows-specific window styles
```

## Running it

```bash
npm install
npm run tauri dev
```

`npm run dev` on its own serves the island in an ordinary browser with every Rust
call stubbed out, which is the fastest way to work on how it looks.

To build an installer:

```bash
npm run tauri build
```

## Setup

Ryfe needs a GitHub personal access token for the pull request panel, and a
DeepSeek API key for the assistant. Both go in Settings and are kept in the
Windows credential store — never on disk, and with no read path exposed to the
webview. The model list is read from the API rather than hard-coded, because
DeepSeek retires model names quickly.
