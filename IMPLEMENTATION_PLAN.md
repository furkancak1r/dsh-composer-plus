# dsh-composer-plus — next release (0.6.0)

## Objective
1. Codex-style **Changes** panel in dsh's right sidebar: Uncommitted / Unstaged / Staged / Branch (vs upstream) / Last turn, with per-file diffs.
2. Publish to **npm** so the Plugins page installs it by name.
3. **dsh 0.2.1** compatibility check + GitHub Actions CI running `npm test` on every push.
4. **Richer notifications**: approval names the tool, question shows its first line, finish shows a short reply preview; Dock unread badge.
5. **Persist Auto Review "Allow for this chat" grants** across restarts (opt-in per grant, revocable).

Out of scope (user decision): Interrupt-and-send, edit-last-message.

## Invariants
- Client-only features stay client-only; the Host half adds git/grant endpoints and authenticated, message-free Continue.
- No shell interpolation: git runs through dsh's `subprocess` capability with argv arrays, a scrubbed env, a timeout and bounded output (same as dsh-workspace-changes). Read-only git commands only.
- Endpoints are registered through `ctx.connection.fetch.register` (auth + host fence are applied by dsh).
- Never edit live dsh files mid-turn; back up before install; never restart dsh.
- Public repo: no local paths, emails, tokens or real DB names.

## Phases & checks
| Phase | Work | Check |
|---|---|---|
| A | Host: `/api/composer-plus.changes` (git status/diff for a session cwd, modes uncommitted/unstaged/staged/branch) | node test with a temp git repo |
| B | Client: right-sidebar tab kind `composer-plus-changes`, mode menu, file list, diff view; guide entry | browser test in isolated profile |
| C | Notifications detail + badge | unit test + browser e2e with fake model |
| D | Persisted grants (host file under DSH_HOME, per session+tool) | unit test |
| E | dsh 0.2.1 run + CI workflow + npm publish | CI green, `npm view` |

## Decisions
- Last turn reuses dsh's own `changes-review` tab (opens it for the latest `workspace/changes` event); no duplicate recorder.
- Branch mode diffs `merge-base(HEAD, @{upstream})..worktree`; falls back to `origin/HEAD` then shows "no upstream".
- Grants persist in `$DSH_HOME/storages/dsh-composer-plus/grants.json` keyed by session id; revoke deletes them.

## Last checkpoint
- Phase A done: host git/grants endpoints + test/changes.test.mjs (temp repo, routes, path refusal).
- Phase B done: Changes tab verified in isolated dsh web (list, diff, Staged empty state, menu incl. Last Turn).
- Phase C done (unit): richer notification bodies + dock badge in test/notify.test.mjs.
- Phase D done (unit): grants persisted via host endpoint.
- Phase E: CI green on GitHub (5bf543e). dsh 0.2.1-alpha.2 verified in an isolated install: Changes, Continue, right-click deeplink, /plan, queue grips, Auto Review card button, grants surviving a restart. npm publish blocked: this machine has no npm login (web login not completed).

## Issues found in 1.0.0 (2026-10-13)
- **F-01 (P1) Service features couldn't be switched off — fixed in 1.0.1.** `injectScope` returned the Cordis fiber from `ctx.inject` as a disposer, so `apply()` threw `TypeError: off is not a function` for notifications, activeProjectsFirst, changesPanel and allowForChat (switch off and plugin unload). Fix: `injectScope` returns `() => fiber.dispose()`. Verified: `npm test` (10 files pass); isolated dsh 0.2.1 and 0.2.0-rc.2 switch all four off and back on with no page errors.
- **F-02 (P2) Tests hid F-01 — fixed in 1.0.1.** Fake `ctx.inject` in `test/toggles.test.mjs`, `test/chat-grant.test.mjs`, `test/notify.test.mjs` now returns `{dispose}` like Cordis. `toggles.test.mjs` fails on 1.0.0 client.js and passes with the fix.
- **F-03 (P3) Order change is permanent — documented in 1.0.1.** Setting description (en/zh) and README now say moves are saved and switching off keeps the current order.
- Needs evidence (open): project-status `MutationObserver` watches all of `document.body`; measure cost during a streaming reply before narrowing it.


## Message-free Continue (2026-10-13)

Objective: resume a stopped/failed turn without editing the draft or adding a user message.

Invariants: use public agent/pre-step, agent/request and steer APIs; never bypass approval hooks;
reject busy, completed, stale, unknown and child sessions; do not lose other queued input;
prevent duplicate clicks; keep localized errors and existing visibility/feature toggles.
No added dependency, private driver methods or transcript deletion.

Scope: client.js, index.js, Continue tests, host route fixtures, package test script, README.
Live files: back up first, install only after DSH_IDLE, do not restart the desktop app.

Phases:
1. [done] Authenticated resume endpoint and client; unit checks for visibility,
   no prompt/draft writes, errors, duplicate requests and other pre-step messages.
2. [done] Isolated dsh 0.2.0-rc.2 and 0.2.1-alpha.2 stop/error -> resume -> complete;
   assert model is called again without a new user message; run npm test.
3. [done] Inspect diff, back up and install live while idle; document desktop reload need.

Decision: send an empty, plugin-owned wake marker through the public agent inbox;
retain the final message batch from the outermost agent/pre-step listener, then
remove only that marker at agent/request, before it reaches history or the model.
An empty first step is skipped by dsh, so removal must follow step entry.
Use steer while idle so queued user messages remain in their original order
and no extra empty turn is appended after them.
Preserve downstream rejection and every other message. Resume requests carry the
latest turn event seq so a delayed/repeated click cannot reopen a completed turn.

Last checkpoint: npm test passes. Isolated 0.2.0-rc.2 and 0.2.1-alpha.2 both
passed stop -> resume and HTTP 400 -> resume -> complete. Each resume made a
second model request with identical history, unchanged draft, no Continue
bubble and no browser exceptions. Native completed state hides the button.
Live installation is waiting for the currently running desktop turn to finish.


## Application language pack (2026-10-13)

Objective: native application-wide Turkish UI plus System / Türkçe / English / 中文 selection in Composer Plus settings. Use dsh's public locale registry and durable `locale.preference`, not DOM text replacement or a separate language preference. No restart, GitHub/npm publication or additional languages in this task.

Invariants: preserve existing explicit locale preference; no preference means OS/browser language (native resolution). Language changes do not touch messages, prompts, tools, attachments, permissions or secrets. Unload removes dictionaries/catalog definition and safely falls back. Preserve previous uncommitted Continue work. Never deploy mid-turn.

Inventory: 60 native namespaces, 2,766 English keys in the union of dsh 0.2.0-rc.2 and 0.2.1-alpha.2. Native shell strings and third-party plugin metadata not using locale.register require separate coverage investigation; do not claim their translation without evidence.

Phases / allowed paths:
1. [done] Inspect locale/configForms API and inventory; fixture `test/fixtures/locale-en.json`.
2. [done] Translate `locales/tr-chat-settings.json` (worker A) and `locales/tr-panels.json` (worker B), each owns only its file. Main owns `client.js`, `scripts/build-locales.mjs`, `locales/tr-composer.json`, `package.json`, tests/docs. Workers cannot spawn workers.
3. [done] Native language registration and settings selector; generated dictionary block bundled in client.js; no new dependency. Keep placeholders and key coverage exact.
4. [done] `npm test`, locale coverage + placeholder assertions, generated bundle check, isolated dsh/browser on both versions: system tr/en/unsupported, explicit override, clear preference, switching/reload/unload, existing features unaffected.
5. [done] Inspect diff, verify old Continue installer stopped/completed, back up live files and install only after DSH_IDLE; verify delivered hashes. No application restart.

Acceptance: all inventoried namespace keys have Turkish strings; app/sidebar/chat/settings/approval surfaces switch immediately, explicit choice persists, system choice clears override. Report hard-coded native/third-party boundaries.
Risks: new upstream keys fall back to English; language catalogs are single-owner (do not compete with another Turkish pack); desktop shell may not accept external locales. No translation of user/model content.
Last checkpoint: 2,766 native UI keys + composer keys translated, exact coverage/placeholders/line-break tests and all existing tests passed. Real isolated dsh 0.2.0-rc.2 and 0.2.1-alpha.2 passed native OS vs browser language, tr/en/zh/unsupported fallback, live switch, explicit preference surviving reload and a different browser locale, and clearing the override. Settings/sidebar screenshots visually checked; native General and Models navigation assertions also passed. Browser-history fixture now pins English because system-Turkish correctly localizes its otherwise English-only selectors. Package dry run passed. Combined message-free Continue E2E also passed on both versions after pinning the English-only test selectors to an English browser. Native desktop shell menus/update dialogs and provider-owned raw labels (e.g. reasoning effort High) cannot be translated by the public locale registry; documented rather than patched. Previous Continue installer timed out without changes. The bounded 5-minute live installer timed out without changes: the desktop turn remained running. Hashes of all three live files still match the pre-install baseline. Tested client/host/manifest are staged for a later idle install; no background installer remains and no application restart, GitHub push or npm publish was performed.

Live install (2026-10-13): installed after DSH_IDLE with backup; live client/index/package match the tested stage; module id and syntax verified. Desktop app not restarted; a reload is needed to load it.

## 1.1.0 — 11 languages, Continue fix, compact selector (2026-10-13)

- Languages: tr, es, pt-BR, fr, de, ru, ja, ko, id, vi, hi in `locales/<id>.json`; build embeds them; one failing language is rolled back and skipped. Coverage = union of dsh 0.2.0-rc.2 (incl. the packaged desktop runtime), 0.2.1-alpha.2 and dsh-rewind 0.15.3: 2,872 strings. Tests: every pack has every key, identical placeholders and line breaks. Real-app sweep in all 11 languages: no untranslated UI text except slash-command tokens, URLs and same-spelled loanwords.
- Continue fix: the wake marker is replaced in agent/pre-step by a fresh, hidden context message ("continue from where it stopped"). Root cause of the live 400: the stopped turn ended on an assistant message, so the request sent to Claude ended with an assistant turn, which Claude rejects. Typing "devam et" worked because it adds a user turn. E2E with a provider that rejects assistant-last requests: stop, HTTP error and mid-stream stop all resume, nothing shown in Chat.
- Language selector: 30px pill, 13px text.
- Shipped: GitHub main 4d64883 (CI green); live desktop plugin installed after DSH_IDLE (backup work/backup-before-v110-20261013-163213; desktop restart needed). npm 1.1.0 publish blocked on the account's one-time password (EOTP); package is ready (540 kB, 7 files).

## 1.1.1 — notify only when the user is really needed (2026-10-13)
- Cause: the notifier fired the moment an approval appeared. With Auto Review + "Allow for this chat", the reviewer denies, dsh shows the card, and the grant answers it within milliseconds (live logs: 18 of 31 approvals decided in 0.0 s). The user got "Approve …?" but found nothing in dsh.
- Fix: a request notifies only if it is still open and answerable 1.5 s later (same request = same `key`); a delivered request notification is closed and its badge cleared once the request is answered or replaced.
- Checks: test/notify.test.mjs (grace period, auto-answered silent, answerable=false silent, withdrawal, badge); real dsh 0.2.0-rc.2 + 0.2.1-alpha.2 with Auto Review and a denying fake reviewer: real wait notifies once and is withdrawn, granted repeat is silent. The same E2E fails on 1.1.0.

## 1.2.0 — automatic updates (2026-10-13)
- Host: `GET /api/composer-plus.update` compares the latest GitHub release tag (x.y.z only) with this copy's version and offers it only when npm already serves that exact version. A renamed/linked copy reports `managed: false` (manual update).
- Client: Settings → Composer Plus → updates row (version, status, release notes, Check for updates / Update now); `autoUpdate` switch (on by default) checks 15 s after start and installs through dsh's `remote.pluginManager.installBundle('dsh-composer-plus@<version>')`, then notifies. Success = Remote `ok` and application `applied`/`restart-required`; the installed version is remembered so it is not reinstalled before the restart. dsh is never restarted by the plugin.
- Bug found by E2E and fixed before release: Client remotes answer `{ ok, value }`; reading `application` directly treated a failed pnpm run as success.
- Checks: test/update.test.mjs (version compare, npm gate, no downgrade, unmanaged copy, transport/pnpm failure, remembered install, switch off); real dsh 0.2.0-rc.2 web, isolated profile with 1.1.0 from a tarball: auto-installed 1.1.1 from npm in ~14 s, package.json updated, bundle stays enabled, notification sent.
- Plugins page identity: dsh's `readPluginMeta` shows the raw package name unless the package exports `package.json` (with `icon`) and `locale/<id>.json` files with `meta.title/description`. Added `assets/icon.svg`, 13 `locale/*.json` meta files and the two exports. Checks: test/meta.test.mjs; real dsh web (tr-TR): row shows "Composer Plus", Turkish description and the icon.
