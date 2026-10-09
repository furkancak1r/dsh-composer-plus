# dsh-composer-plus

Small composer helpers for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (web / desktop UI). Client-only plugin, no Host state, no network calls.

- **Input history** – in an empty composer, `↑` / `↓` walk your previously sent messages, like a terminal. An open `/` menu or an edited draft keeps the normal keys.
- **One-click Continue** – when a turn has stopped and the composer is empty, the Send button becomes **▶**; one click sends `continue`. Hidden on a blank chat, while running, in subagent views, or once you type or attach something.
- **Drag-and-drop queue reordering** – queued messages get a grip (⠿) at the left. Drag a row to a new position (drop line shown, `Esc` cancels), or focus the grip and press `↑` / `↓`.

Tested on dsh `0.2.0-rc.2` (desktop and web).

## Install

```sh
dsh plugin --profile web add github:furkancak1r/dsh-composer-plus
```

This adds the dependency and the profile bundle. Restart dsh. For the desktop app use `--profile desktop`.

## How it works / limits

- dsh's `session.updateQueue` has no `move` action, so a reorder rotates the affected rows' text with `edit` calls (tail → head). If the agent claims a row mid-move, the applied edits are reverted and a notice is shown; nothing is lost or duplicated.
- Rows with images/files can't be moved or crossed (queue `edit` is text-only).
- The Send button and queue rows are not slots, so ▶ and the grips are portaled into the existing DOM. If a dsh update changes that markup, they simply stop appearing; nothing else breaks.
- A native `move` action is requested in [#773](https://github.com/deepseek-ai/deepseek-harness/discussions/773); a built-in Continue state in [#9269](https://github.com/deepseek-ai/deepseek-harness/discussions/9269).

## Tests

```sh
npm test
```

Runs the real `client.js` against a fake React/DOM: Continue visibility and click, drag order, keyboard moves, `Esc`, revert on failure, image rows.

MIT License. Unofficial community plugin.
