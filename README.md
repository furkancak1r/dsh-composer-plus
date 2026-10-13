# dsh-composer-plus

[![npm](https://img.shields.io/npm/v/dsh-composer-plus)](https://www.npmjs.com/package/dsh-composer-plus)
[![test](https://github.com/furkancak1r/dsh-composer-plus/actions/workflows/test.yml/badge.svg)](https://github.com/furkancak1r/dsh-composer-plus/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Codex-style quality-of-life features for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) desktop and web UI: a Changes panel, input history, a plan-mode shortcut, one-click Continue, queue drag-and-drop, session deeplinks, per-chat Auto Review grants and background notifications.

Unofficial community plugin. No external network calls.

## Install

**Desktop app:** Settings → Plugins → **Add plugin** → enter `dsh-composer-plus` → **Enable now**.
You can also paste `https://github.com/furkancak1r/dsh-composer-plus` instead of the npm name.

**Web / CLI profile:**

```sh
dsh plugin --profile web add dsh-composer-plus
```

Then restart dsh. (The CLI can't install into the desktop profile; the app manages it.)

> dsh's pnpm skips versions younger than 24 hours. Right after a release, add the version: `dsh-composer-plus@0.6.2`.

## Features

| Feature | How to use it |
|---|---|
| **Changes panel** | Right sidebar → `+` → **Changes**. Pick **Uncommitted**, **Unstaged**, **Staged** or **Branch** to see changed files with `+/-` counts; click a file for its diff. **Last Turn** opens dsh's own review of the latest turn. |
| **Input history** | In an empty composer, press `↑` / `↓` to walk through messages you sent, like a terminal. |
| **Plan mode shortcut** | `Shift+Tab` adds `/plan ` to the start of the draft (press again to remove it). If the chat is already in plan mode, `Shift+Tab` leaves it. |
| **One-click Continue** | When a turn has stopped and the composer is empty, Send turns into **▶**. One click sends `continue`. |
| **Queue drag-and-drop** | Queued messages get a grip (⠿). Drag to reorder, or focus the grip and press `↑` / `↓`. `Esc` cancels. |
| **Copy deeplink** | Right-click a chat in the sidebar → **Copy deeplink**. Paste the `dsh-session:…` link into another chat to attach that chat as read-only context. |
| **Allow for this chat** | When Auto Review asks you, the approval card gets **Allow for this chat**: the same tool in the same chat is allowed from then on, with any arguments. A header chip lists the grants and revokes them. Grants survive a restart. |
| **Background notifications** | While dsh is in the background you get a notification when a turn finishes (first line of the reply), or when a chat needs an approval (tool name), an answer (the question) or a plan review. The Dock/taskbar badge counts waiting chats. Clicking opens that chat. |

Labels follow dsh's language (English or Chinese).

## Keyboard shortcuts

| Key | Where | Action |
|---|---|---|
| `↑` / `↓` | empty composer | previous / next sent message |
| `Shift+Tab` | composer | add/remove `/plan `, or leave plan mode |
| `↑` / `↓` | focused queue grip | move the queued message |
| `Esc` | while dragging | cancel the move |

An open `/` or `@` menu keeps these keys for itself.

## Compatibility

Tested on dsh `0.2.0-rc.2` (desktop and web) and `0.2.1-alpha.2` (web). CI runs the tests on every push.

## Privacy and security

- **Changes panel:** git runs read-only on your machine, in the chat's own folder, through dsh's authenticated `/api` channel. It never commits, stages or fetches, and only shows paths git itself listed.
- **Allow for this chat:** grants are stored in `$DSH_HOME/storages/dsh-composer-plus/grants.json` (owner-only permissions). A grant covers **one exact tool in one chat**. If that tool can write, the grant covers any write too. Revoke it from the header chip.
- Auto Review still runs on every call; review failures are never auto-allowed.

## Troubleshooting

- **No notifications on macOS:** System Settings → Notifications → DeepSeek Harness → allow. Choose **Alerts** to keep them on screen.
- **▶, queue grips, Allow for this chat or right-click missing after a dsh update:** these attach to dsh's current HTML because dsh has no slot for them yet. If dsh changes that markup they hide themselves; nothing else breaks. Please open an [issue](https://github.com/furkancak1r/dsh-composer-plus/issues).
- **Install fails right after a release:** add the version (`dsh-composer-plus@0.6.2`), see the install note above.

## Limits

- dsh's queue has no `move` action, so a reorder rewrites the affected rows' text. If the agent picks up a row mid-move, the move is undone and nothing is lost. Messages with images or files can't be moved.
- A deeplink works inside chats; clicking it does not open the chat.
- A notification sent before a restart only brings dsh to the front when clicked.
- Built-in support is requested upstream: queue `move` in [#773](https://github.com/deepseek-ai/deepseek-harness/discussions/773), a Continue state in [#9269](https://github.com/deepseek-ai/deepseek-harness/discussions/9269).

## Development

```sh
npm test
```

The tests run the real `client.js` against a fake React/DOM and the real `index.js` (Host half) against a temporary git repository. `node test/browser-history.mjs '<dsh web URL with ?token=…>'` checks input history in a real browser against a throwaway `dsh web` with its own `DSH_HOME`.

## License

MIT
