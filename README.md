# dsh-composer-plus

Small composer helpers for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (web / desktop UI). The client half adds the UI; a small Host half serves read-only git changes and saves Auto Review grants. No external network calls.

- **Input history** – in an empty composer, `↑` / `↓` walk your previously sent messages, like a terminal. An open `/` menu or an edited draft keeps the normal keys.
- **`/plan` toggle** – `Shift+Tab` adds `/plan ` to the start of the draft, even when it already has text; press it again to remove that leading `/plan`. The rest of the draft, file references and attachments stay intact, and the caret ends up at the end. It never sends. An open `/` or `@` menu keeps `Shift+Tab` for closing itself.
- **One-click Continue** – when a turn has stopped and the composer is empty, the Send button becomes **▶**; one click sends `continue`. Hidden on a blank chat, while running, in subagent views, or once you type or attach something.
- **Copy deeplink** – right-click a session in the sidebar (or use its `…` menu) and pick **Copy deeplink** (label follows dsh's language: English or Chinese). You get a link like `dsh-session:InNlc3Npb24t…`; paste it into another chat and dsh attaches that session as read-only context.
- **Allow for this chat (Auto Review)** – when Auto Review denies a call and asks you, the approval card gets an **Allow for this chat** button next to Reject / Allow once. It allows this call and every later Auto Review ask for the **same exact tool in the same chat**, with any arguments (e.g. any read-only SQL query on one database tool). Other tools, other chats and non-Auto-Review approvals still ask. A header chip (“N tool(s) allowed · Revoke”) lists the grants and revokes them in one click. Grants are saved by the plugin's Host half (`$DSH_HOME/storages/dsh-composer-plus/grants.json`, user-only permissions), so they survive a restart until you revoke them. If the tool can write, the grant covers any write too.
- **Changes panel** – a Codex-style **Changes** page in the right sidebar (open it from the sidebar's `+` guide). Pick **Uncommitted**, **Unstaged**, **Staged** or **Branch** (your branch vs. its upstream, from their merge base) to list changed files with `+/-` counts and expand any file for its diff; **Last Turn** opens dsh's own review of the latest turn. It refreshes while visible. Git runs read-only on the Host in the chat's own folder.
- **Background notifications** – while the dsh window is not focused, you get an OS notification titled with the chat name when a turn finishes (with the reply's first line), or when a chat waits for an approval (names the tool), a question (shows it) or a plan review. The Dock/taskbar badge counts chats waiting for you. Clicking it brings dsh to the front and opens that chat. Notifications stay in Notification Center until clicked; a newer one for the same chat replaces the older. Subagent chats don't notify on their own (the parent chat does). Text follows dsh's language (English or Chinese).
- **Drag-and-drop queue reordering** – queued messages get a grip (⠿) at the left. Drag a row to a new position (drop line shown, `Esc` cancels), or focus the grip and press `↑` / `↓`.

Tested on dsh `0.2.0-rc.2` (desktop and web) and `0.2.1-alpha.2` (web). CI runs the tests on every push.

## Install

**Desktop app:** Settings → Plugins → **Add plugin**, paste

```
https://github.com/furkancak1r/dsh-composer-plus
```

then **Enable now** (or restart dsh). (The desktop profile is managed by the app, so the CLI cannot install into it.)

**Web / CLI profiles:**

```sh
dsh plugin --profile web add https://github.com/furkancak1r/dsh-composer-plus
```

This adds the dependency and the profile bundle. Restart dsh.

## How it works / limits

- dsh's `session.updateQueue` has no `move` action, so a reorder rotates the affected rows' text with `edit` calls (tail → head). If the agent claims a row mid-move, the applied edits are reverted and a notice is shown; nothing is lost or duplicated.
- Rows with images/files can't be moved or crossed (queue `edit` is text-only).
- A deeplink uses dsh's `dsh-session:` reference format. It references a session inside chats; clicking it does not open the session (dsh's `dsh://` handler only focuses the app today).
- Session rows have no context-menu slot, so right-click finds the row's own `…` button in the DOM. If dsh changes that markup, right-click shows the normal menu again; the `…` menu item keeps working.
- The Send button and queue rows are not slots, so ▶ and the grips are portaled into the existing DOM. If a dsh update changes that markup, they simply stop appearing; nothing else breaks.
- “Allow for this chat” answers the existing approval request with dsh's own `allowed-once` outcome; Auto Review still runs on every call, and review failures are never auto-allowed. The button is portaled into the approval card's button row (no slot exists); if dsh changes that markup, the button disappears and Allow once / Reject keep working.
- Notifications use the web `Notification` API, which the desktop app allows; macOS asks for permission on the first one. Banners disappear after a few seconds by default; set the app's style to **Alerts** in System Settings → Notifications to keep them on screen. A notification sent before a restart only brings dsh to the front when clicked.
- A native `move` action is requested in [#773](https://github.com/deepseek-ai/deepseek-harness/discussions/773); a built-in Continue state in [#9269](https://github.com/deepseek-ai/deepseek-harness/discussions/9269).

## Tests

```sh
npm test
```

CI runs the same tests on every push.

Runs the real `client.js` against a fake React/DOM (/plan toggle, deeplink format and right-click, Continue, queue drag, Auto Review grants including persistence across a restart, notification bodies and Dock badge) and the real `index.js` against a temporary git repository (every Changes mode, rename parsing, untracked files, refusal of paths git did not list, grants file).

`node test/browser-history.mjs '<dsh web URL with ?token=…>'` checks ↑/↓ history in a real browser against a throwaway `dsh web` (it sends test messages, so use a separate `DSH_HOME`). The `/plan` toggle (empty, multi-line, references, attachments, caret position), Continue and drag-and-drop were also checked by hand-scripted browser runs against a slow fake model.

MIT License. Unofficial community plugin.
