# dsh-composer-plus

Small composer helpers for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (web / desktop UI). Client-only plugin, no Host state, no network calls.

- **Input history** – in an empty composer, `↑` / `↓` walk your previously sent messages, like a terminal. An open `/` menu or an edited draft keeps the normal keys.
- **`/plan` toggle** – `Shift+Tab` adds `/plan ` to the start of the draft, even when it already has text; press it again to remove that leading `/plan`. The rest of the draft, file references and attachments stay intact, and the caret ends up at the end. It never sends. An open `/` or `@` menu keeps `Shift+Tab` for closing itself.
- **One-click Continue** – when a turn has stopped and the composer is empty, the Send button becomes **▶**; one click sends `continue`. Hidden on a blank chat, while running, in subagent views, or once you type or attach something.
- **Copy deeplink** – right-click a session in the sidebar (or use its `…` menu) and pick **Copy deeplink** (label follows dsh's language: English or Chinese). You get a link like `dsh-session:InNlc3Npb24t…`; paste it into another chat and dsh attaches that session as read-only context.
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
- A deeplink uses dsh's `dsh-session:` reference format. It references a session inside chats; clicking it does not open the session (dsh's `dsh://` handler only focuses the app today).
- Session rows have no context-menu slot, so right-click finds the row's own `…` button in the DOM. If dsh changes that markup, right-click shows the normal menu again; the `…` menu item keeps working.
- The Send button and queue rows are not slots, so ▶ and the grips are portaled into the existing DOM. If a dsh update changes that markup, they simply stop appearing; nothing else breaks.
- A native `move` action is requested in [#773](https://github.com/deepseek-ai/deepseek-harness/discussions/773); a built-in Continue state in [#9269](https://github.com/deepseek-ai/deepseek-harness/discussions/9269).

## Tests

```sh
npm test
```

Runs the real `client.js` against a fake React/DOM: the `/plan` toggle edit, the deeplink format (checked with dsh's own decoder when installed) and row right-click, Continue visibility and click, drag order, keyboard moves, `Esc`, revert on failure, image rows.

`node test/browser-history.mjs '<dsh web URL with ?token=…>'` checks ↑/↓ history in a real browser against a throwaway `dsh web` (it sends test messages, so use a separate `DSH_HOME`). The `/plan` toggle (empty, multi-line, references, attachments, caret position), Continue and drag-and-drop were also checked by hand-scripted browser runs against a slow fake model.

MIT License. Unofficial community plugin.
