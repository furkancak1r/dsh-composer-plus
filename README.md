# dsh-composer-plus

Small composer helpers for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (web / desktop UI). Client-only plugin, no Host state, no network calls.

- **Input history** – in an empty composer, `↑` / `↓` walk your previously sent messages, like a terminal. An open `/` menu or an edited draft keeps the normal keys.
- **`/plan` toggle** – `Shift+Tab` adds `/plan ` to the start of the draft, even when it already has text; press it again to remove that leading `/plan`. The rest of the draft, file references and attachments stay intact, and the caret ends up at the end. It never sends. An open `/` or `@` menu keeps `Shift+Tab` for closing itself.
- **One-click Continue** – when a turn has stopped and the composer is empty, the Send button becomes **▶**; one click sends `continue`. Hidden on a blank chat, while running, in subagent views, or once you type or attach something.
- **Copy deeplink** – right-click a session in the sidebar (or use its `…` menu) and pick **Copy deeplink** (label follows dsh's language: English or Chinese). You get a link like `dsh-session:InNlc3Npb24t…`; paste it into another chat and dsh attaches that session as read-only context.
- **Allow for this chat (Auto Review)** – when Auto Review denies a call and asks you, the approval card gets an **Allow for this chat** button next to Reject / Allow once. It allows this call and every later Auto Review ask for the **same exact tool in the same chat**, with any arguments (e.g. any read-only SQL query on one database tool). Other tools, other chats and non-Auto-Review approvals still ask. A header chip (“N tool(s) allowed · Revoke”) lists the grants and revokes them in one click. Grants live in memory: restarting dsh or removing the plugin forgets them. If the tool can write, the grant covers any write too.
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
- “Allow for this chat” answers the existing approval request with dsh's own `allowed-once` outcome; Auto Review still runs on every call, and review failures are never auto-allowed. The button is portaled into the approval card's button row (no slot exists); if dsh changes that markup, the button disappears and Allow once / Reject keep working.
- A native `move` action is requested in [#773](https://github.com/deepseek-ai/deepseek-harness/discussions/773); a built-in Continue state in [#9269](https://github.com/deepseek-ai/deepseek-harness/discussions/9269).

## Tests

```sh
npm test
```

Runs the real `client.js` against a fake React/DOM: the `/plan` toggle edit, the deeplink format (checked with dsh's own decoder when installed) and row right-click, Continue visibility and click, drag order, keyboard moves, `Esc`, revert on failure, image rows, chat tool grants (same tool/other args auto-allowed, other tool/chat still asks, no double answer, revoke, cancelled request, unload).

`node test/browser-history.mjs '<dsh web URL with ?token=…>'` checks ↑/↓ history in a real browser against a throwaway `dsh web` (it sends test messages, so use a separate `DSH_HOME`). The `/plan` toggle (empty, multi-line, references, attachments, caret position), Continue and drag-and-drop were also checked by hand-scripted browser runs against a slow fake model.

MIT License. Unofficial community plugin.
