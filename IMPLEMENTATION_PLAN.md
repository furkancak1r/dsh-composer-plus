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

## Feature screenshots in Settings (2026-10-13)
Objective: every feature row in Settings → Composer Plus has a small screenshot thumbnail; hover enlarges it, click opens it full size.
Invariants: screenshots come from an isolated throwaway dsh (fake model, synthetic demo projects such as `acme-web`, `weather-cli`); no personal names, paths, chats or accounts. Images ship inside the package (no network). Reuse dsh primitives (`HoverCard`, `ImageLightbox`); no new dependency. English UI in images (one set for all languages).
Phases:
1. Capture script `scripts/capture-screenshots.mjs` (Playwright + dsh bin + fake model) → `assets/features/<id>.webp` (cwebp, ≤ ~60 kB each). Check: files exist, sizes, visual review of each.
2. Host route `GET /api/composer-plus.shot?id=<feature>` serving only whitelisted files (no path input). Client `FeatureShot` thumbnail with HoverCard preview and ImageLightbox. Check: unit test (whitelist, 404, content-type), toggles test, real-dsh browser test (thumb visible, hover preview, click dialog, Esc closes, Settings stays open).
3. README feature table gets the same images. Check: links resolve in repo.
Risks: HoverCard/ImageLightbox props may change across dsh versions → fall back to a plain image link when absent.

## Recent projects filter (2026-10-14)
Objective: Sidebar → view options (sliders icon) gets "Active in the last 2 hours" under a "Filter projects" label. While it is selected, the sidebar shows only projects with chat activity in the last 2 hours. Select it again to show all projects.
Rule: a project stays when it was added in that time or holds the open chat, a running or waiting chat, or a chat updated in that time. Archived, blank and subagent chats do not count (same as Project status). Chats outside any project follow the same rule. A parent folder of a shown project stays (Workspace tree draws children inside it). "In one list" has no project rows, so it is not filtered; search results are not filtered either.
Invariants: client only, no new dependency, no dsh file changes. dsh's menu has no slot: the rows are portaled into dsh's open menu list (class `viewOptionsMenu`), and one style rule hides the sections (`--dsh-workspace-indent` + `data-row-key`). If dsh changes this markup, the option is not shown or all projects stay visible. The choice is kept per device in localStorage `dsh-composer-plus.recentProjects`; the Settings switch `recentProjects` removes the option.
Phases and checks:
1. [done] client.js, 13 languages, Settings row, README, llms.txt. Check: test/recent-projects.test.mjs, test/toggles.test.mjs, locale coverage, `npm test`.
2. [done] Real dsh web in an isolated home: test/browser-sidebar-projects.mjs (en + tr option, stale projects hidden, state announced, reload, deselect, native rows, no page errors). Screenshot assets/features/recentProjects.webp (SHOT=1).
3. [open] Live desktop copy only with the user's approval: back up first, never restart dsh; a desktop reload loads it.
Decision: selecting the option keeps dsh's menu open (dsh closes it on its own rows), so the result shows at once and the focus stays on the row.
Last checkpoint (2026-10-14): `npm test` passes (16 files, 12 shots). test/browser-sidebar-projects.mjs passes on dsh 0.2.0-rc.2 and 0.2.1-alpha.2; en/tr screenshots checked visually. Shipped in 1.3.0 (see the release section below).

## Copy project path + Collapse all projects (2026-10-14)
Objective: (1) Right-click a sidebar project row → a menu at the pointer with "Copy path"; a click copies the project's absolute folder path. (2) A "Collapse all projects" button in the Workspaces header, shown only while at least one project is open; a click closes every open project (example: 3 of 5 open → all 5 closed).
Decisions: (1) Own primitives.Menu at the pointer, not dsh's project "…" menu: that menu closes when the pointer leaves dsh's own React subtree (`closeOnPointerLeave`), so an injected row would close under the pointer. "Ungrouped" has no folder: the browser menu stays. (2) The button is the first child of dsh's header action group (dsh's buttons keep their places); visibility is CSS `body:has(open project row)`; the group's 60px max-width grows to 92px while the button is in it; a click calls `click()` on each open project row, innermost first (Workspace tree nests children), so dsh's own toggle and persisted store do the work. Keyboard activation moves focus to the next header button because the button hides itself.
Invariants: client only, no new dependency, no dsh file changes; each feature has its own Settings switch (`collapseProjects`, `copyProjectPath`) and removes its listener, observer, host and style when switched off.
Phases and checks:
1. client.js, 13 languages, Settings rows and shots, README, llms.txt. Check: test/project-tools.test.mjs, test/toggles.test.mjs, locale coverage, `npm test`.
2. Real dsh 0.2.0-rc.2 and 0.2.1-alpha.2 web, isolated home: test/browser-sidebar-projects.mjs (also covers the recent projects filter; renamed from test/browser-recent-projects.mjs): clipboard holds the path, 3 open → 0 open, button hidden then shown again, header buttons not clipped, Turkish labels, no page errors. Screenshots with SHOT=1.
3. Live desktop copy only with the user's approval.
Last checkpoint (2026-10-14): `npm test` passes (17 files, 14 shots). test/browser-sidebar-projects.mjs passes on dsh 0.2.0-rc.2 and 0.2.1-alpha.2 (clipboard = project folder, Esc copies nothing, 3 open → 0, closed state saved after reload, button hidden when none open, keyboard Enter moves focus to View options, Turkish labels, no page errors). en/tr screenshots checked visually.

## 1.3.0 release (2026-10-14)
- Shipped: GitHub main 3d5aa9e (CI green), release v1.3.0 (Latest). Semgrep: 0 findings.
- Live desktop copy installed: client, host, manifest and 14 shots; the module id stays `@local/dsh-composer-history`. Backup: `~/Documents/testdeepseekharness/backup-before-v130-20261014-135030`. dsh was not restarted; a desktop reload loads the new code.
- npm 1.3.0: published with npm's browser sign-in (`--auth-type=web`, the user approved it in the browser); `latest` = 1.3.0, shasum 61248ec (same tarball as tested). The first attempt failed with E404 because npm's sign-in request expired after 5 minutes without an approval. The update check of a 1.2.1 copy now reports 1.3.0 as newer.

## Recent filter fix + Order by status + screenshot rule (2026-10-14)
Objective: (1) "Active in the last 2 hours" showed projects without chats. (2) "Order by → By status" for "In one list": finished (dsh's done dot, also after an error) → running or waiting → active Schedule automation → rest; view only (user choices). (3) Every Settings feature row has a screenshot; future features follow AGENTS.md.
Root cause (1): staleProjects() kept a project that was added in the last 2 hours and every parent folder of a shown project. Live data had 9 projects with 0 chats; e.g. SDK (parent of PR_ADDON and promes) stayed. Fix: a project stays only with an open, running, waiting or recently updated chat. Check: test/recent-projects.test.mjs fails on 1.3.0 and passes now; the live data run hides all 9 empty projects.
Decisions (2): CSS `order` on the flat list's row wrappers (`[role="tree"][class*="_flatList"] > :has(> [data-row-key="session:<id>"])`), dsh's data and saved order are untouched. The item goes after dsh's "Last updated"; dsh's Manual/Last updated rows are marked, their check is hidden while By status is on, and a click on them turns By status off. Pinned and archived chats keep dsh's place. Automation = an active task in `remote.schedule.catalog()`, refreshed on `schedule/changed`; Schedule is optional (`ctx.inject(['remote.schedule'])`). Errors: dsh's list has no error flag; per the user's choice, a failed turn counts through dsh's done dot.
Decisions (3): `autoUpdate` gets the autoUpdate shot; test/shots.test.mjs fails when a FEATURES id has no SHOT_OF entry or shipped image (checked by removing one: it fails); test/browser-settings-shots.mjs checks the real page; AGENTS.md lists the rules.
Checks: `npm test` (18 files, 15 shots). Real dsh 0.2.0-rc.2 and 0.2.1-alpha.2: test/browser-status-order.mjs (fake model, schedule_create, finished → running → automated → plain, reload, Last updated restores), test/browser-sidebar-projects.mjs, test/browser-settings-shots.mjs (15 rows, all images load).
Last checkpoint: all checks above pass.

## Recent filter hid finished chats (2026-10-15)
Issue: with "Active in the last 2 hours" selected, a project disappeared when its chat finished more than 2 hours ago and the user did not open it yet, although dsh still showed the green done dot on that chat row.
Root cause: staleProjects() kept a project only for an open, recently updated, running or waiting chat. A finished, unread chat (dsh `completionUnread`, the done dot) did not count, so after 2 hours its project was hidden. The live desktop copy is 1.4.0 with this code; dsh 0.2.0-rc.2 and 0.2.1-alpha.2 have the same completionUnread logic.
Fix: a project stays while projectStatus() returns any state (waiting, running or done), so the filter follows the same dot as dsh's own chat row. When you open the chat, dsh clears the dot; after that the normal 2-hour rule applies.
Checks: test/recent-projects.test.mjs (a finished chat 3 h old keeps its project; a read one does not) fails on 1.4.0 and passes now. test/browser-recent-finished.mjs (real dsh web, fake model, page clock 2.5 h ahead from the first render) fails on 1.4.0 and passes now, on 0.2.0-rc.2 and 0.2.1-alpha.2. `npm test` passes.
Texts: the Settings description in 13 languages, README and llms.txt name the finished-chat rule. The screenshot is unchanged (the menu is the same).
Regression: test/browser-sidebar-projects.mjs passes on both dsh versions.

## 1.4.1 release (2026-10-15)
- Shipped: GitHub main d533877 (CI green), release v1.4.1. Semgrep: 0 findings.
- npm: release.yml (trusted publishing) published 1.4.1 from the release; `latest` = 1.4.1, shasum c8c06a2.
- Live desktop copy: only client.js (module id `@local/dsh-composer-history` kept) and the manifest version changed; index.js, locale files and shots are the same as 1.4.0. Backup: `~/Documents/testdeepseekharness/backup-before-v141-20261015-105124`. dsh not restarted; a desktop reload (Cmd+R) loads it.

## 1.4.0 release (2026-10-14)
- Shipped: GitHub main 387dcb4 (rebased on the remote release.yml commit 48b2f94; CI green), release v1.4.0 (Latest). Semgrep: 0 findings.
- release.yml (npm trusted publishing) was skipped: the repository variable NPM_TRUSTED_PUBLISHING is not "on" yet. npm 1.4.0 was published with the browser sign-in instead (`--auth-type=web`); `latest` = 1.4.0, shasum 94a93f5 (the tested tarball). A 1.3.0 copy now sees 1.4.0 as newer.
- Live desktop copy installed (client, host, manifest, 15 shots; module id `@local/dsh-composer-history`). Backup: `~/Documents/testdeepseekharness/backup-before-v140-20261014-163127`. dsh not restarted; a desktop reload loads it.

## Keep composer focus (2026-10-15)
Problem: macOS Hammerspoon hotkeys (F5 → `/gt`, F6, F7, F8, F11) type a skill command and press Enter. The command runs, but the next keys go nowhere: the cursor is not in the composer.
Root cause (dsh 0.2.0-rc.2 … 0.2.1-alpha.3, read in `dsh-client-ui-conversation`): Enter on a `/` line moves the input machine to `adjudicating`; InputBar sets `editable = !machineBusy`, so Lexical writes `contenteditable="false"` on the focused root and the browser moves the focus to `<body>`. dsh calls `focusDraftEditor` only when `locked`, `sessionId` or `editor` changes, so the focus never comes back. Evidence (real dsh, switch off): `focusout composer -> none | phase=adjudicating`, then `editable=true phase=plain` and no `focusin`.
Fix: feature `keepFocus` (own switch, `conversation.input.right` slot, no DOM markup dependency). When the phase leaves `adjudicating`/`submitting`, one frame later it calls dsh's public `conversation.input.for(actx).focus()` (Lexical restores the last caret), only if the focus is on `<body>`/none and no `[aria-modal="true"]`/`dialog[open]` is open. A new command or unmount cancels the frame.
Limits: keys pressed during the few milliseconds of adjudication are lost; an open `/` menu takes the first Enter (dsh picks the row).
Checks: `test/keep-focus.test.mjs` (phases, focused field, dialog, cancel, unmount, closed session); `npm test` (19 files, 16 shots); `test/browser-keep-focus.mjs` on dsh 0.2.0-rc.2 and 0.2.1-alpha.2 (switch off: focus on body after `/release-notes`; switch on: typing goes on in the composer in a blank and an open chat; `/permission` popup keeps its search field focused); `test/browser-settings-shots.mjs` (16 rows); Semgrep p/javascript + p/secrets: 0 findings. An isolated run also proved that dsh's client-hmr loads a rewritten `client.js` into an open page without a reload.
Live desktop copy installed (client, host, keepFocus shot; module id `@local/dsh-composer-history`). Backup: `~/Documents/testdeepseekharness/backup-before-keepfocus-20261015-115529`. dsh not restarted. Not released or published yet.
Commit gate: `semgrep --config auto` skips `client.js` (2.1 MB, over the 1 MB default). With `--max-target-bytes 0` it reported `unsafe-formatstring` (INFO) on the `installLanguages` warning. Fix: a constant `%s` format string. Both scans: 0 findings. The live desktop copy keeps the old log line (same behavior).

## Tether merge → 1.5.0 (2026-10-15)
Objective: merge the Tether repository (iPhone app, Mac gateway, `dsh-mobile-bridge` dsh plugin) into dsh-composer-plus. One plugin; dsh-composer-plus stays the main repository and npm package.
User decisions: move all of Tether, iOS app included; Mobile connect is off by default and the user switches it on in Settings; finish with commit + push, release 1.5.0 (GitHub release, npm by release.yml) and the live desktop copy (backup first, no dsh restart).
Invariants: the gateway code and its security model stay as tested in Tether (pinned TLS, LAN/tailnet only, one-time pairing code + approval on the Mac, hashed tokens, RPC allowlist); no new dependency; the iOS app is not in the npm package; the Tether repository on GitHub is not changed.
Layout: `tether/` holds the Tether history (git subtree, author e-mails changed to the GitHub noreply address); `tether/gateway/{server.mjs,admin.html,qr.swift}` ship in the npm package; `tether/ios/` is the app; gateway tests are `test/tether-gateway.test.mjs` (in `npm test`) and `test/tether-e2e.mjs` (manual, live dsh). `dsh-mobile-bridge` and the gateway's package.json are removed.
Design:
- Feature `mobileConnect` (own Settings row + screenshot). Its switch lives in the Host, because the gateway runs in the Host process: one state for every browser, kept in `$DSH_HOME/storages/dsh-composer-plus/mobile.json`, off until switched on.
- Host: `GET/POST /api/composer-plus.mobile` (dsh auth + host fence). While on: `createGateway({ upstreamUrl })` with the authenticated loopback URL from `connection.authenticatedUrl` + `webServer.port` (optional `ctx.inject(['webServer'])`, so a profile without a web server still loads). No `upstream.url` file is written (no token on disk). Switch off or unload: `gateway.close()`. Start/stop calls are serialized.
- Gateway data moves from `~/.dsh-mobile` to `$DSH_HOME/storages/dsh-composer-plus/mobile` (`DSH_MOBILE_DIR` still overrides). Admin port: `DSH_MOBILE_ADMIN_PORT` (default 19391); the Host reports the admin URL to the client.
- Client: the Tether "Mobile connect" sidebar-foot button (`sidebar.footer.action`), installed only while the Host says on; CSS inside the component; the admin reachability comes from the Host state (no `http://` fetch); the iframe height message is accepted only from the admin origin and frame.
- Standalone gateway mode (`DSH_MOBILE_STANDALONE`, `node server.mjs`) is removed: nothing writes `upstream.url` any more.
Phases / checks:
1. [done] Subtree import (local commit 728b9f9); files moved; Tether gateway tests pass before the move (16/16).
2. Host + client + texts (en, zh, 11 locales, plugin meta), README, llms.txt, AGENTS.md, tether/README.md, tether/AGENTS.md (agent-device rules from the user's uncommitted Tether work).
3. `npm test` (+ new `test/mobile-connect.test.mjs`); Semgrep (also `--max-target-bytes 0`); real isolated dsh 0.2.0-rc.2 and 0.2.1-alpha.2: `test/browser-mobile-connect.mjs` (switch on → button → popover → gateway connected to dsh → paired fake phone calls `session/list` → switch off → port closed) + screenshot; `test/browser-settings-shots.mjs`; iOS compile (`xcodebuild`, generic simulator).
4. Commit, push, CI; release v1.5.0; live desktop copy (backup, module id `@local/dsh-composer-history`, add `@deepseek-ai/dsh-client-ui-sidebar` to its client inject list).
Risks: fixed ports 19390/19391 (a second dsh with Mobile connect on reports "in use"); macOS only (en0, openssl, swift, dns-sd); paired phones from an old `~/.dsh-mobile` must pair again (new certificate).
Checkpoint (phases 2–3 done, 2026-10-15):
- Host: `mobileSwitch` (owner-only JSON), `mobileGateway` (serialized start/stop; an admin-port failure closes the gateway; a running gateway hides stale errors), `MOBILE_PATH` route (switch changes queued: save, then start/stop). Gateway gets `upstreamUrl` (function) instead of the `upstream.url` file; standalone `node server.mjs` mode removed; `close()` also closes kept-alive admin connections.
- Client: `createMobile` (newest answer wins; 404 = older Host half → "Restart dsh" and the switch goes back), `MobileConnect` button (CSS in the component, iframe height message only from the admin origin + frame), `MobileStatus` under the switch, `OFF_BY_DEFAULT`/`isOn`, the Host's state merged into the toggles snapshot.
- Self-review (the delegated reviewer stopped without a result): unload while a switch-on waits no longer starts a gateway (`close()` marks it closed); a failed save answers only its own request; the pairing page port is waited for about 3 s (EADDRINUSE) when a plugin reload overlaps the old gateway's close; README/release text names attachments and slash commands in the phone allowlist. Checked and unchanged: the dsh launch token stays in memory (not in logs, `/me` or `/state`); `/api/composer-plus.mobile` goes through dsh's auth and Host/Origin fence; an HTTPS listen failure leaves no open handle (measured).
- iOS texts: the "waiting for dsh-mobile-bridge" state is gone; the pairing footer names Settings → Composer Plus → Mobile connect.
- Checks: `npm test` 20 files (locale 2,917 strings × 11, mobile-connect, tether-gateway 16/16, 17 shots); `test/browser-mobile-connect.mjs` PASS on 0.2.0-rc.2 and 0.2.1-alpha.2 (off by default, switch on, popover + QR + "Ready", fake iPhone paired, `session/list` through the gateway, 403 allowlist, switch off closes both ports); `test/browser-settings-shots.mjs` PASS on both (17 rows); `mobileConnect.webp` 24.7 kB with demo address and demo QR (the test rewrites only the browser's view of the admin JSON/QR); iOS: `swiftc -typecheck` (iOS 17 simulator SDK) passes, full xcodebuild not possible here (Xcode has no iOS 26.5 platform installed); `npm pack --dry-run`: 41 files, only the 3 gateway files from `tether/`; Semgrep `--config auto` 0 findings, also with `--max-target-bytes 0` (one PartialParsing warning: Semgrep's Swift parser does not know `if let v = try? await …` in Core.swift; the Swift compiler accepts it).

## 1.5.0 release (2026-10-15)
- Shipped: GitHub main 6cffadd (after the subtree import 728b9f9; CI green), release v1.5.0 (Latest). Semgrep: 0 findings (also with `--max-target-bytes 0`).
- npm: release.yml (trusted publishing) published 1.5.0 from the release; `latest` = 1.5.0, shasum 0ca9130, 41 files. The update check of a 1.4.1 copy offers 1.5.0.
- Live desktop copy: client (module id `@local/dsh-composer-history` kept), host, locale meta, the mobileConnect shot, `tether/gateway/*`, and the manifest (version 1.5.0, client inject list + `@deepseek-ai/dsh-client-ui-sidebar`). Backup: `~/Documents/testdeepseekharness/backup-before-v150-20261015-143434`. dsh not restarted: the client half can load on a page reload, but the Host half (Mobile connect route and gateway) and the new inject list load only after a dsh restart; until then the Settings row says "Restart dsh to use Mobile connect".
- Not changed: the Tether repository on GitHub and its local working copy (its uncommitted README/AGENTS.md work was carried over into `tether/`).

## Resume after restart → 1.6.0 (2026-10-16)
Request (user): "Is there a dsh setting that continues running work after I quit dsh and open it again? If not, add it to the plugin."
Evidence that dsh has no such setting (0.2.0-rc.2, 0.2.1-alpha.2, 0.2.1-alpha.4):
- `dsh-session-persistence` README, Known limitations: "Synthetic closers are the only crash story … there is no partial-turn resume that continues an interrupted turn instead of closing it." On quit, `agent-loop` disposal cancels the running turn with `{ kind: 'disposed' }` (`turn/end { aborted, reason: disposed }`); after a crash, the next resume appends `turn/end { interrupted }`.
- `dsh-goal`: goal activation is process-local; every `agent/created` disarms it. `dsh-goal-round-driver`: "the driver never revives work on its own".
- No setting or config key with resume/restart semantics in any package (grep of both installs and alpha.4).
Design (feature `resumeAfterRestart`, Host half only does the work):
- Off by default (`OFF_BY_DEFAULT`): it starts model turns without a click. The switch lives in the Host (`$DSH_HOME/storages/dsh-composer-plus/resume.json`, `{ on, sessions: [] }`, 0600, atomic rename), like Mobile connect.
- Tracking (`resumeTracker`): Host listens to `agent/status` and `session/event` (`turn/start`, `turn/end`). A top-level chat (`ctx.agents.roots()`, header origin not `subagent`) that becomes `running` is saved at once (so a crash keeps it). When it becomes idle it leaves the list, except when its turn end was caused by dsh (`stoppedByDsh`: `aborted` + cause `disposed`/`parent`, or `interrupted`) or no turn end arrived for an open turn (the shutdown could not write it). Plugin unload stops all writes.
- Wake (`wakeSession`): after `ctx.appReady.onReady` (both versions; a 3 s timer without it), once per start, newest first, at most 20: forget the list, then for each chat `sessionController.resolveAgent` (dsh closes a crashed turn as `interrupted` here), skip archived/busy/unavailable chats, read the newest `turn/start|turn/end` through `sessionQuery.observeSession`, continue only when `stoppedByDsh`. A stopped goal round re-arms its goal with `ctx.goals.resume` (dsh's goal driver starts the next round, so the model can still complete the goal); any other turn gets the One-click Continue marker through `agent.steer` (the existing `agent/pre-step` hook swaps it for the hidden note). A goal is never armed for an ordinary turn (dsh does not keep whether it was armed).
- Never: a chat the user stopped (`aborted/user`), a completed or failed turn, archived chats, subagents, a chat that runs again before the wake. No age limit: the user wants a quit-and-open to continue, also after a long break.
Limits: a quit while a tool runs ends that tool call ("outcome unknown" result); the model is told to continue and not to repeat work, but a non-idempotent command may run again. Only Host shutdowns are seen: if the computer loses power, the list still holds the running chats (saved on every change), and their turns end as `interrupted`, so they continue too.
Phases / checks:
1. Host (`resumeStore`, `resumeTracker`, route `GET/POST /api/composer-plus.resume`) + `test/resume-restart.test.mjs` (fake agents/goals, restart simulation, user-stop, archived, stale, cap).
2. Client: switch via Host (like Mobile connect, 404 → "Restart dsh"), texts en/zh/11 locales, Settings row + screenshot, README/llms/meta.
3. `npm test`; Semgrep (also `--max-target-bytes 0`); real isolated dsh 0.2.0-rc.2 and 0.2.1-alpha.2 with a fake slow model: switch on → start a long turn → SIGTERM dsh → start dsh → the turn continues without a click (fake model sees the continue note) + screenshot; switch off → no continue.
4. Commit, push, CI, release v1.6.0 (npm via release.yml), live desktop copy (backup, module id `@local/dsh-composer-history`), no dsh restart.
Checkpoint (phases 1–3 done, 2026-10-16):
- Host: `resumeStore` (0600, ordered atomic writes), `resumeTracker`, `stoppedByDsh`, `wakeSession`, `installResume` (route `GET/POST /api/composer-plus.resume`, wake after `appReady`). Client: `createMobile(route)` reused for the Host switch, `MobileStatus` with a text prefix, `createToggles({ mobileConnect, resumeAfterRestart })`, `OFF_BY_DEFAULT` + `resumeAfterRestart`; texts en/zh + 11 locales (2,921 strings each); plugin meta in 13 languages.
- Found in the real run: dsh 0.2.0-rc.2 and 0.2.1-alpha.2 do not write `turn/end` at SIGTERM; the turn is closed as `interrupted` at the next resume. So an idle edge after an open turn without an end keeps the chat; `wakeSession` reads the log before it acts. dsh adds its runtime-context (and in 0.2.1 the sampled-time) note after the prompt, which the fake model skips.
- Checks: `npm test` 21 files (resume-restart: store, tracker rules, wake order/cap/once, goal rules, apply() quit → start cycle, off, missing services, client switch + 404); `test/browser-resume-restart.mjs` PASS on 0.2.0-rc.2 and 0.2.1-alpha.2 (switch on → a running chat and a `/goal` round → dsh Stop on a third chat → SIGTERM → start: the chat continues without a click with the hidden note (not shown in Chat), the goal goes on with round 2, the stopped chat does not; switch off → SIGTERM → start: nothing continues); `test/browser-settings-shots.mjs` PASS on both (18 rows); `resumeAfterRestart.webp` 7.0 kB (demo chat); `npm pack --dry-run` 42 files; Semgrep `--config auto` 0 findings (`--max-target-bytes 0` on the repo root too).

## 1.6.0 release (2026-10-16)
- Shipped: GitHub main 7ec003c (CI green), release v1.6.0 (Latest). npm (release.yml, trusted publishing): `latest` = 1.6.0, shasum f00816b, 42 files.
- Live desktop copy: client (module id `@local/dsh-composer-history` kept), host, locale meta, the resumeAfterRestart shot, manifest version 1.6.0. Backup: `~/Documents/testdeepseekharness/backup-before-v160-20261016-111722`. dsh not restarted: the Host half (the switch route and the tracking) loads only after a dsh restart; until then the Settings row says "Restart dsh to use Resume after restart". The feature starts off; the first quit that it can catch is a quit after the user switched it on with the new Host half loaded.

## Feature ideas (swipe cards) (2026-10-16)
Request (user): "a Tinder-like card system that suggests features" for the open project. No earlier session had started it (searched every dsh and Codex log). User choice: project feature ideas in dsh-composer-plus; swipe right starts a new chat that works on the idea, swipe left drops the card. Scope: commit + push; no release and no live desktop copy.
Design (feature `featureIdeas`):
- Right sidebar page, like Changes (`sidebarRightTabs` kind `composer-plus-ideas`, guide entry). Empty state: "Suggest features" button. Nothing calls a model until that click (so it can be on by default).
- Host route `POST /api/composer-plus.ideas {sessionId}`: the chat's own cwd (never a path from the browser) and model (newest `request/header` config, else `agentDefaultModel.currentSelection()`); a short read-only project brief (README head, package.json name/description/scripts, top-level entries, `git log --oneline -15`; bounded bytes, no secrets files); one `ctx.llm.stream` call (system prompt asks for strict JSON, maxTokens bounded, 60 s timeout, request signal); parse `[{title, summary, why, effort}]`, at most 8, text bounded. No chat message, nothing written to the project.
- Cards: a stack (top card + 2 behind). Pointer drag with rotation, release past 30 % width (or a fast flick) decides; buttons ✗ / ✓ and keys ← / → do the same; "Undo" brings the last card back. Accepted ideas stay in a short list on the page.
- Swipe right: the Host (`POST {sessionId, idea}`) creates the chat in the same project (the source chat's workspace, else its cwd) and runs `/plan <idea prompt>` through `commands.execute`, so the new chat plans first and the user approves before files change; the client opens it with `uiWorkspace.openSession`. Fallback when `/plan` is missing or fails: an ordinary queued prompt. (The client path was dropped: 0.2.0-rc.2's `startSession` takes no draft.)
- Deck kept per chat in memory for the dsh run (no new storage file).
Phases / checks:
1. Host: `projectBrief`, `parseIdeas`, `ideaPrompt`, route + `test/feature-ideas.test.mjs` (fake llm/sessionQuery/fs; JSON in code fences, junk, bounds, no cwd, model failure).
2. Client: `IdeasTab` deck, swipe math (`swipeDecision`), keyboard/buttons/undo, start chat; texts en/zh + 11 locales; FEATURES/SHOT_OF/SHOTS; README + llms.txt; unit test for deck logic and toggle.
3. `npm test`; Semgrep; real isolated dsh 0.2.0-rc.2 and 0.2.1-rc.2 with a fake model (`test/browser-feature-ideas.mjs`): open page → suggest → drag left drops → ✓ opens a new chat in plan mode with the idea; SHOT=1 writes `assets/features/featureIdeas.webp`.
4. `gt`: commit and push.
Checkpoint (phases 1–3 done, 2026-10-17; rebased on 4f544bf, the 0.2.1-rc.2 update and v1.6.1):
- Host: `projectBrief` (top-level names, README/AGENTS/manifest heads 6 kB each, `git log --oneline -15`, 16 kB total; skips `.env*`, key files, `node_modules`/build folders), `parseIdeas` (first JSON array, ≤ 8 ideas, cleaned and bounded), `suggestIdeas` (the chat's newest `request/header` route, else `agentDefaultModel`; `llm.prepareCall` + `stream`, lowest reasoning effort, output ≤ 4000 tokens and ≤ the model default, 90 s), `startIdeaChat`, route `POST /api/composer-plus.ideas`.
- Client: `featureIdeas` right-sidebar tab (guide entry "Feature ideas"), card stack with pointer drag (30 % or a flick), ✕/✓, ←/→, Z/Undo, "More ideas", started list; texts en/zh + 11 locales (28 keys each; es `ideas.title` = "Sugerencias"); plugin meta in 13 languages.
- Checks: `npm test` (all files, incl. `feature-ideas.test.mjs`, `feature-ideas-client.test.mjs`); `test/browser-feature-ideas.mjs` PASS on 0.2.0-rc.2, 0.2.1-alpha.2 and 0.2.1-rc.2; `test/browser-settings-shots.mjs` PASS on 0.2.0-rc.2 and 0.2.1-rc.2 (19 rows); `featureIdeas.webp` 15 kB.

## Issues found in Feature ideas (d014428, 2026-10-19) — fixed in 1.7.0
Found by review of d014428 (not released; no tag contains it). Each was reproduced on an extracted copy of `HEAD` = `origin/main` = d014428 with synthetic files under `$TMPDIR`.
- **F-01 (P1) Project brief follows symlinks out of the project — fixed in 1.7.0.** `head()` in `index.js` opens `README.md`, `package.json`, … with `open(path, 'r')`, which follows symlinks; `BRIEF_SKIP` checks only top-level names. A `README.md` symlink to a file outside the chat's folder puts that file's first 6 kB into the model request. Evidence: `README.md` → `../outside/secret.txt` made `projectBrief()` return the fake secret text (`true`). A symlink to a file inside the project is legitimate and is read today.
- **F-02 (P2) A FIFO named like a brief file blocks the ideas request — fixed in 1.7.0.** `head()` checks `isFile()` only after `open()` succeeds; opening a FIFO without a writer waits forever. The 90 s timeout starts after `projectBrief()`, so it does not cover this; the request never answers and the Host keeps the pending call. Each blocked `open()` also holds one libuv threadpool thread, and dsh does not set `UV_THREADPOOL_SIZE` (default 4). Evidence: `mkfifo package.json` → `projectBrief()` still pending after 2 s; the process did not exit. With 3 pending FIFO opens an unrelated `readFile` still finished; with 4 it was blocked (Node 26, macOS).
- **F-03 (P2) "More ideas" and a swipe right overlap and break the deck state — fixed in 1.7.0.** `suggestIdeas()` in `client.js` always writes `status: 'ready'` and `history: []`. It and `decideIdea()` each check only their own status, and the pointer drag checks only `starting`, so a load and a start can run at the same time. When the load ends during the start, `starting` is lost (a second swipe right sends a second start in parallel) and Undo history is cleared. Evidence: status `ready` (expected `starting`), history 0 (expected 1), 2 starts in flight (expected 1); a "More ideas" click during a start also sends a load.
Fix (tried on a throwaway copy of d014428, 2026-10-19: both probes red before, green after; `npm test` exit 0; `semgrep --config auto` 0 findings on `index.js` and `client.js`):
- F-01 + F-02, `index.js`: `projectBrief()` takes `realpath(cwd)` once (with a trailing separator). `head(path, max, prefix)` takes `realpath(path)`, returns `undefined` unless it starts with the prefix and `stat()` says regular file, then opens the real path with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` (each `?? 0`) and keeps the `isFile()` check on the handle. A symlink inside the folder is still read.
- F-03, `client.js`: one `deckBusy(deck)` (`loading` or `starting`) guards `suggestIdeas()`, `decideIdea()`, the pointer-drag start and the `busy` flag; `suggestIdeas()` no longer resets `history`.
- Tests: `test/feature-ideas.test.mjs` gets a symlink-out, symlink-in and FIFO case (skip on win32); when `projectBrief()` is still pending after 2 s, the test opens the FIFO for writing so a red run ends instead of hanging. `test/feature-ideas-client.test.mjs` gets the overlap cases with gated fake `fetch` replies. Then README "Privacy and security" says symlinks out of the folder, FIFOs and devices are skipped.
Resolved (2026-10-19): the new cases in `test/feature-ideas.test.mjs` and `test/feature-ideas-client.test.mjs` failed on d014428 (FIFO wait, symlink read; start during a load, lost history, second start) and pass with the fix; `npm test` exit 0.

## 1.7.0 — Feature ideas fixes, session link next to dsh's Copy Session ID (2026-10-19)
- dsh 0.2.1 added its own session-menu item "Copy Session ID" (`workspace` `menu.sessionId`, order 450). It copies the plain id. Our item copies a `dsh-session:` link, which dsh turns into a read-only reference when pasted in a chat; a plain id is not a reference (`parseSessionReferenceText` reads only `dsh-session:` URIs). So the features are not the same, and ours stays on. Changes: the item moves from order 350 (between Fork and Archive) to 460, right after "Copy Session ID"; its name is now "Copy session link" (en), "复制会话链接" (zh) and the matching "session" word of each of the 11 locales (tr "Oturum bağlantısını kopyala", same word as dsh's "Oturum kimliğini kopyala"). The feature id `copyDeeplink`, the slot id and the screenshot file name stay.
- `scripts/capture-screenshots.mjs`: the fake model skips dsh 0.2.1's "Time sampled …" user message, and Settings opens through the account menu when there is no Settings button (as in `test/browser-settings-shots.mjs`). New `copyDeeplink.webp` from the demo dsh 0.2.1-rc.2.
- dsh: no new version (check: seen 0.2.1-rc.2); npm `latest` 0.2.0-rc.2, `next` 0.2.1-rc.2.
- Shipped (2026-10-19): GitHub main 9d8293d + 118e0b2 (CI green; the first CI run failed in `test/resume-restart.test.mjs`, a timing race that also fails on d014428 under parallel load: the test now waits for the saved list instead of one fixed tick, and deletes its temp folder). Release v1.7.0 (Latest). npm (release.yml, trusted publishing): `latest` = 1.7.0, shasum 3df7e99, 43 files. Checks: `npm test`, Semgrep 0 findings, the full screenshot run and 9 real-app tests on 0.2.0-rc.2 and 0.2.1-rc.2; `test/browser-mobile-connect.mjs` did not run (the local dsh uses ports 19390/19391).
- Live desktop copy: client (module id `@local/dsh-composer-history` kept), host, locale meta, the copyDeeplink and featureIdeas shots, manifest version 1.7.0. Backup: `~/Documents/testdeepseekharness/backup-before-v170-20261019-103200`. dsh not restarted: the new client and Host halves load after a dsh restart.

## 1.7.1 — Feature ideas cards in the UI language, buttons fly the card (2026-10-19)
Request (user, after 1.7.0): the cards came in English while dsh was in Turkish: "the card language must follow the plugin's language". Also: "clicking the buttons must show the same left/right swipe movement".
- Cause: the prompt said "Write the text values in the language of the project brief", so an English README gave English cards whatever the UI language.
- Client: "Suggest features" / "More ideas" sends `locale` = `ctx.locale.getLocale().active` (dsh's active UI language, the same one the plugin's texts use) at the click. Cards already on the deck keep their language.
- Host: `ideasLanguage(locale)` adds one line to the system prompt: write title, summary and why in that language (English name from `Intl.DisplayNames` + the id). Only a locale id (`/^[a-z]{2,3}(-[a-z0-9]{2,8}){0,3}$/i`) is used; any other value falls back to the brief's language, so no free browser text reaches the prompt. `effort` stays English (the client translates it).
- Client: ✕/✓ and ←/→ now use the drag's fly-off (`fling`): the card moves off to its side for 180 ms, then the decision runs. A ref blocks a second fling or a drag during the flight. `prefers-reduced-motion` turns the card transition off.
- Checks: `test/feature-ideas.test.mjs` (UI language line, bad values, route passes `locale`), `test/feature-ideas-client.test.mjs` (request carries `locale`, the button sends the active language, ←/✕/✓ fly first and decide one card), `test/browser-feature-ideas.mjs` (prompt has "in English (en)", ✕ moves the card left first).
- Shipped (2026-10-19): GitHub main aea3c35 (CI green), release v1.7.1 (release.yml green), npm `latest` = 1.7.1, shasum 128892f, 43 files. Checks: `npm test` exit 0; `test/browser-feature-ideas.mjs` PASS on 0.2.0-rc.2 and 0.2.1-rc.2; Semgrep: only the old `eval` test-harness finding in `test/feature-ideas-client.test.mjs` (present before this change, same as the other client tests).
- Live desktop copy: client (module id `@local/dsh-composer-history` kept), host, manifest version 1.7.1. Backup: `~/Documents/testdeepseekharness/backup-before-v171-20261019-110907`. The user chose a dsh restart so the new halves load.

## Save ideas for later (per project) (2026-10-19)
Request (user): in the Feature ideas deck, "Later" on a card saves the idea in a list that belongs to the project. The list opens from the panel, and a click starts a plan-mode chat from it. Why: a good idea that is not for now does not get lost.
Scope: code, tests, docs and real-app checks. No commit, push, release or live desktop copy without a separate request.
Decisions:
- Part of `featureIdeas` (same switch): no model call, no port, so no new switch and no new screenshot id; `featureIdeas.webp` is captured again with the new button.
- Host keeps the list: `$DSH_HOME/storages/dsh-composer-plus/later.json`, `{ [cwd]: [{ id, title, summary, why?, effort?, at }] }`, 0600, ordered atomic writes (like `resumeStore`). Key = the chat's `cwd` from its header (the browser never sends a path). ponytail: the same folder through a symlink is a different list.
- Route `/api/composer-plus.later`: `GET ?sessionId`, `POST {sessionId, add}` / `{remove}` / `{start}`. `start` uses the stored idea text, runs `startIdeaChat` and removes the idea only after the chat starts; a second start of the same id while one runs gets 409.
- At most 50 ideas per project: a full list refuses (409), it never drops old ideas. Same title (case-insensitive) is not added twice. A broken file is never overwritten (500, file kept).
- Client: ↓ button and `ArrowDown` fly the top card down, then save; a failed save puts the card back. Pointer drag stays left/right only. "Later (N)" in the head opens the list; Plan / Remove per idea. One network action per deck (`deckBusy` also covers `saving`); a stale GET never overwrites a newer POST answer.
Phases / checks:
1. Host `laterStore`, route; `test/feature-ideas.test.mjs` (store rules, 0600, broken file kept, route 400/409, start uses stored text and removes only on success, double start).
2. Client actions + UI + texts (en, zh, 11 locales, `npm run build:locales`); `test/feature-ideas-client.test.mjs` (↓ flies then saves, failure restores, busy guards, stale GET, list open/plan/remove). New cases red on HEAD, green after; `npm test` exit 0.
3. README, llms.txt, this section.
4. `test/browser-feature-ideas.mjs` on dsh 0.2.0-rc.2 and 0.2.1-rc.2 (↓ saves, file 0600 under the project path, reload keeps "Later (1)", Plan starts a plan-mode chat, list empties); SHOT=1 `featureIdeas.webp` ≤ 60 kB; Semgrep; `npm pack --dry-run`.
Checkpoint (phases 1–4 done, 2026-10-19; not committed):
- Host: `laterStore` (ENOENT = empty, broken file throws and is kept, absolute-path keys only, ≤ 50, case-insensitive title dedupe, 0600, ordered atomic writes), `chatFolder` (shared with `startIdeaChat`, now also needs an absolute cwd), `ideaFrom` (shared cleaning for model and browser input), route `GET/POST /api/composer-plus.later` (start: stored text, in-process `starting` guard, removes only after the chat starts).
- Client: `hostJson`, `loadLater` (seq: a read that overlaps a change is ignored), `changeLater`/`laterIdea`/`startLater`/`removeLater` (one action per deck, `saving` counts as busy), ↓ button and `ArrowDown` fly the card down (fade), "Later (N)" head button, list view (Plan / Remove, back to cards, empty list goes back). Texts: 9 new keys + `ideas.hint` + description in en, zh and 11 locales (3,106 strings each).
- Checks: new cases in `test/feature-ideas.test.mjs` and `test/feature-ideas-client.test.mjs` fail on HEAD (missing exports / helpers) and pass now; `npm test` exit 0; `test/browser-feature-ideas.mjs` PASS on dsh 0.2.0-rc.2 and 0.2.1-rc.2 (↓ flies down, `later.json` 0600 under the project path, reload keeps "Later (1)" in another chat of the project, Plan starts a plan-mode chat with "Pantry tracker", list empty, no page errors); `featureIdeas.webp` 15.4 kB with the ↓ button (checked visually); Semgrep `--max-target-bytes 0`: only the old `eval` test-harness finding; `npm pack --dry-run` 43 files.
- Known limit: if the list file breaks between start and remove, the chat starts but the answer is 500 and the idea stays (the user can remove it).

## Tether: more than one Mac (2026-10-19)
Request (user): "2 PCs, I must connect to both; select the PC at the top" → then "not only 2: dynamic, unlimited".
Scope: the iPhone app keeps any number of pairings and shows one at a time; a Mac picker at the top of every tab switches it. One gateway per Mac stays as it is (each dsh with Mobile connect on is one Mac).
Invariants:
- Each Mac keeps its own certificate pin, token, addresses and Tailscale address. A switch never sends one Mac's token to another Mac.
- Per-Mac phone state (unread dots, last seen list, drafts) is keyed by the Mac: a session id of Mac A never marks a row of Mac B.
- The old single pairing (Keychain account "pairing") migrates once to the new list, so an existing iPhone stays paired.
- No new dependency; gateway stays Node stdlib.
Design:
- Gateway: `/pair` and `/me` also return `mac` (the computer name, `scutil --get ComputerName`, else `os.hostname()`); Bonjour advertises that name instead of "Tether". The phone uses it as the default label; the user can rename.
- iOS Core: `Keychain` stores `[Pairing]` (account "pairings") plus the active fingerprint (`UserDefaults` "activeMac"). `Client.pairing` stays the active one (all existing code keeps working); `pairings` holds all. `switchMac(fp)` closes the socket, clears the screen state, loads that Mac's per-Mac defaults and connects. Pairing a new Mac adds it (same fingerprint replaces). `forget()` removes only the active Mac and switches to the next one.
- iOS UI: `MacPicker` (menu in the leading toolbar slot of Sessions, Agents and Settings, next to the connection badge): every Mac with a check on the active one, "Add a Mac…" (opens the pair sheet). Settings gets a "Macs" section: rename, remove. `PairView` becomes a sheet when at least one Mac is paired.
Phases:
1. Gateway `mac` name + Bonjour name + test (`test/tether-gateway.test.mjs`).
2. iOS Core: storage, migration, switch, per-Mac keys + unit tests in `Tests.swift`.
3. iOS UI: picker, add/rename/remove.
4. Checks: `npm test`; iOS build for device (`xcodebuild … -sdk iphoneos`); unit tests need a simulator runtime (none installed on this Mac: report it); docs (`tether/README.md`, README Mobile connect row, llms.txt).
Allowed paths: `tether/**`, `test/tether-gateway.test.mjs`, `README.md`, `llms.txt`, `IMPLEMENTATION_PLAN.md`, `package.json` (version).
Risks: the iPhone app is installed by hand (Xcode / devicectl); the user must update it. A gateway older than this change sends no `mac`: the phone falls back to the Bonjour name or the host address.
Work happens on branch `feat/tether-multi-mac` in `/tmp/cp-multi-mac` (another session commits on main in parallel).
Result (2026-10-19): all 4 phases done on `feat/tether-multi-mac`.
- Checks: `npm test` exit 0 (gateway 17/17 incl. the new Mac-name test); iOS `swiftc -typecheck` for iOS 17 passes; the whole iOS XCTest suite (24 tests, incl. `testManyMacs`, `testSwitchMacClearsScreen`) runs and passes when built for Mac Catalyst (`-target arm64-apple-ios17.0-macabi`): this Mac has no iOS simulator runtime and no iOS 26.5 device platform, so `xcodebuild` for the iPhone or a simulator cannot run here. Semgrep: only the 4 old `bypass-tls-verification` findings in `test/tether-gateway.test.mjs` (the pin tests; same count before the change).
- Late replies after a Mac switch: `call()` stops before each address try and after the reply when `activeFp` changed (CancellationError, ignored by `run()`); a 401 unpairs only the Mac that answered; `refreshMe`, `drop`'s retry and the `/me` probe in `connect` check the Mac before they write or reconnect.
- Not done: the iPhone app on the user's phone must be rebuilt and installed from Xcode (needs Xcode > Settings > Components > iOS 26.5).

## Content search in dsh's own sidebar search (2026-10-19)
Request (user): the built-in search icon in the sidebar (magnifier next to Workspaces, Cmd+K) must also find chats by the text of their messages, not only by title. No new button, panel or second search box.
Evidence (dsh 0.2.0-rc.2 and 0.2.1-rc.2 source, and the desktop app's asar = 0.2.1-rc.2):
- The sidebar already calls `sessions.search` (debounce 250 ms) → `dsh-api-session-controller` → `ctx.sessionQuery.searchSessions` (filters: `user/message` + `assistant/message`, surface `current`) → `dsh-session-query-sqlite` (FTS5, `unicode61`). `deriveSearchResults` merges the hits with title/Workspace matches and shows `snippet` (≤ 240 code points).
- `dsh-base` and `dsh-web-app` set `session-query-sqlite` to `path: ':memory:'`, `openAt: never`, so `_assertSearchEnabled()` throws `SESSION_QUERY_SEARCH_DISABLED`, the client catches it and shows title/Workspace matches only. Both comments say: "a deployment enabling content search overrides `openAt` … in a later patch layer, typically with a durable `path`".
- Patch order (`dsh-app-boot`): bundle patches apply in `dsh.profile.bundles` order, then the profile's own `cordis.patch.yml`, then `--patch`. A patch replaces the row's whole `config`. A patch whose id is missing only warns. The Plugins page appends a new bundle at the end (`dsh-plugin-manager` `bundles.push`), and the live desktop profile lists `@local/dsh-composer-history` after `@deepseek-ai/dsh-web-app`.
- `!!js` values are evaluated by the Loader with `with (ctx) eval(expr)`; `dshHomePath` is a root service on both versions (the base row already uses `!!js dshHomePath('sessions')`).
- `dsh-experimental-session-search` (official, off by default) adds model tools with its own isolated in-memory index; it does not change the sidebar ("Sidebar search keeps its existing behavior"). Not used.
Design (feature `contentSearch`; least code: no search code of our own):
- `cordis.patch.yml` adds one row patch for `session-query-sqlite`: `path: !!js dshHomePath('cache', 'composer-plus', 'session-search.db')`, `openAt: !!js <reads the switch file>` → `first-search`, or `never` when the file says `{ "on": false }`. A missing or broken file counts as on.
- Index path: a durable file under `$DSH_HOME/cache/` (a derived, disposable index: deleting it only makes the next first search rebuild it). dsh creates missing folders 0700 and the file 0600. Not `:memory:` (rebuilt at each start, held in RAM).
- Switch: the Host keeps it (like Mobile connect / Resume after restart): `$DSH_HOME/storages/dsh-composer-plus/content-search.json` (0600, atomic), route `GET/POST /api/composer-plus.content-search {on}`; the answer also has `active` (the running index's `openAt` is not `never`). Client: `createMobile(route)` store, `createToggles({ …, contentSearch })`; Settings row text says the change applies after a dsh restart, and a status line shows "restart dsh" while `on !== active`.
- Default: ON. Reasons: no port, no server, no model call and no network (the AGENTS.md off-by-default reasons do not apply); `first-search` opens nothing until the user searches; the user asked for this. The measured cost decides: if the first search blocks the Host too long, the default changes to off (see Measurements).
Out of scope: tool output search, user/assistant/tool filters, result grouping. dsh searches only user and assistant messages (`MESSAGE_TYPES`); README states it as a limit.
Phases / checks:
0. Isolated dsh 0.2.1-rc.2 and 0.2.0-rc.2: `--dump-config` shows our values after `dsh-web-app`; a real sidebar search finds a word that is only in a message, with a snippet; index file 0600 under `cache/composer-plus/`. If this holds, no search code.
1. Host switch + route, client switch/status, texts (en, zh, 11 locales, `npm run build:locales`), Settings row + `contentSearch.webp`, README + llms.txt; `test/content-search.test.mjs` (patch expressions: missing/on/off/broken file, path under the home; route default on, off write 0600, bad body 400, `active`; client row, default on, Host store, status line) in `npm test`; `test/toggles.test.mjs` counts.
2. `test/browser-content-search.mjs` on 0.2.0-rc.2 and 0.2.1-rc.2: Cmd+K / search icon → a message-only word finds the chat and shows the snippet; Turkish folding (`seker` → `şeker`); switch off → restart → title-only again; SHOT=1 screenshot.
3. Measurements on a copy of the real `~/.dsh/sessions` (236 chats, 155 MB) in a throwaway DSH_HOME, dsh 0.2.1-rc.2: first-search build time, index file size (+ WAL), Host RSS before/after, longest Host stall during the build (poll a cheap Host route). Delete the copy afterwards.
4. `npm test`, Semgrep, `npm pack --dry-run`; merge to main, release (version bump, CI, GitHub release; npm by release.yml, else the command for the owner); live desktop copy (backup, module id `@local/dsh-composer-history`, its own `cordis.patch.yml` too). No dsh restart.
Allowed paths: `cordis.patch.yml`, `index.js`, `client.js`, `locales/*.json`, `assets/features/contentSearch.webp`, `test/content-search.test.mjs`, `test/browser-content-search.mjs`, `test/toggles.test.mjs`, `package.json`, `README.md`, `llms.txt`, `IMPLEMENTATION_PLAN.md`.
Risks: dsh changes the row id `session-query-sqlite` (the patch only warns, search stays title-only); `DatabaseSync` runs on the Host thread, so the first build can stall other chats' streaming (measured below); one index path per DSH_HOME: two dsh processes on the same home with this plugin share it (dsh says one owner per path).
Work happens on branch `feat/content-search` in `/tmp/cp-content-search`.
Checkpoint phase 0 (done, 2026-10-19): the patch alone is enough; no search code.
- `dsh --profile web --dump-config` on 0.2.0-rc.2 and 0.2.1-rc.2 (bundles base → web-app → dsh-composer-plus): the composed `session-query-sqlite` row has our `path`/`openAt` expressions (our layer comes after `dsh-web-app`).
- `test/browser-content-search.mjs` steps 1–2 PASS on both versions: no index file before the first search; the search button and Cmd+K find "kumquat" (only in a user message) with the snippet "…kumquat tart…"; "seker" finds the chat whose answer has "şeker"; index `$DSH_HOME/cache/composer-plus/session-search.db` mode 0600, folder 0700. Step 3 waits for the switch (phase 1).
Checkpoint phases 1–2 (done, 2026-10-19):
- Host: `mobileSwitch(file, fallback)` (Content search reads a missing/broken file as on), `installContentSearch` (route `GET/POST /api/composer-plus.content-search` → `{ on, active }`; `active` = `ctx.sessionQuery.config.openAt !== 'never'`; saves in order). `SHOTS` + `contentSearch`.
- Client: `contentSearch` in `FEATURES` (on by default, not in `OFF_BY_DEFAULT`), `SHOT_OF`, `createMobile(CONTENT_SEARCH_ROUTE)`, `createToggles` now copies a Host switch's `on` both ways (true and false), `MobileStatus` shows `<prefix>.pending` when `on !== active`. Texts: 5 keys in en, zh and the 11 locales.
- Found in the real run: in a browser, dsh's search shortcut is Cmd/Ctrl+Alt+K (Cmd+K in the desktop app); dsh 0.2.0-rc.2 titles a chat with its first 5 words until the model title arrives.
- Checks: `test/content-search.test.mjs` (patch expressions with dsh's own `with (ctx) eval` rule: missing/on/off/broken/null file; path under the home; switch file 0600; route default on, 400s, ordered saves, failed save 500; `active` true/false/missing; client row default on, Host POST, pending note, 404 → restart note) and the updated `test/toggles.test.mjs` (20 rows, 17 on); `npm test` exit 0 (shots: 20 images). `test/browser-content-search.mjs` PASS on 0.2.0-rc.2 and 0.2.1-rc.2 (button and shortcut; snippet; ş → s; 0600/0700; switch off → "Restart dsh to apply this change." → restart → `{on:false, active:false}`, no note, titles only). `contentSearch.webp` 5.5 kB (search box with "kumquat" and the snippet; checked visually).
Checkpoint phase 3 (done, 2026-10-19), measured with `/tmp/cs-measure.mjs` (not shipped) on a copy of the real `~/.dsh/sessions` (247 chat logs, 159 MB, lock files left out) in a throwaway DSH_HOME, dsh 0.2.1-rc.2 web, through dsh's own sidebar search in Chrome; the copy was deleted after each run. Mac: Apple Silicon, 32 GB.
- First search after a start (index build): 14.6–15.6 s over 4 runs. Host stall: one block of 6.2–6.9 s (a cheap Host route polled every 50 ms got no answer), starting about 8 s in; the page itself kept drawing (longest frame gap 17 ms). Results: 6 chats, all with a snippet.
- Later searches: about 0.54 s, Host stall ≤ 40 ms. After a dsh restart, the first search: about 1.04 s, stall about 0.2 s, +70 MB RSS (the durable index is reused; only changed chats are read).
- Host RSS: 387–417 MB before; peak 1.53–1.57 GB during the build (+1.1 GB); +706–749 MB 2 s later; 938–968 MB after 30–60 s (+0.53–0.58 GB) and it stays there.
- Index file: 165 MB, 0600. With dsh's default `journalMode: wal` a 166 MB `-wal` file stayed next to it until dsh quit; with `delete` there is none and the timing is the same (14.6 s). Decision: the patch sets `journalMode: delete`.
- Default stays ON: the cost is paid only on the first search after a start (the index file survives restarts, so later starts pay about 1 s); README Limits gives the numbers and says to switch it off on a computer with little memory. Not hidden: other chats pause their streaming for about 7 s during the first build.
- Also fixed: `test/browser-settings-shots.mjs` waited for `loading="lazy"` thumbnails below the fold that never started; with the 20th row this hung. It now sets `loading = 'eager'` before it waits. PASS on 0.2.0-rc.2 and 0.2.1-rc.2 (20 rows).
Checkpoint phase 4 (in progress): `npm test` exit 0 (24 suites); `npm pack --dry-run` 44 files (+ contentSearch.webp; cordis.patch.yml 1.1 kB); Semgrep p/javascript + p/secrets (`--max-target-bytes 0`) on index.js, client.js, cordis.patch.yml and the two new tests: 0 findings. README (row, Settings, privacy, troubleshooting, limits, FAQ, dev command), llms.txt, package description/keywords, plugin meta in 13 languages updated.

## 1.8.0 release (2026-10-19)
- Contents since v1.7.1: Content search (this section above), Save ideas for later (b1c730d), Tether more than one Mac (d76bedb; the gateway part ships in npm, the iPhone app is built by hand).
- Version 1.8.0 in `package.json` and the two README install notes.
- Shipped (2026-10-19): GitHub main 1349cec (branch CI 39254857434 and main CI 39255067380 green), release v1.8.0 (Latest). npm (release.yml, trusted publishing, run 39255172241): `latest` = 1.8.0, shasum 87248fd, 44 files. npm publish needed no browser approval (trusted publishing).
- Live desktop copy: client (module id `@local/dsh-composer-history` kept; otherwise equal to the repo), index.js, the 20 shots, locale meta, `tether/gateway/*`, manifest (version, description, client inject list), and its own `cordis.patch.yml` (own `insert` row kept + the `session-query-sqlite` row). Backup: `~/Documents/testdeepseekharness/backup-before-v180-20261019-155416`. A temp profile with the desktop's bundle order (base → web-app → experimental-auto-review → @local/dsh-composer-history) composes our `path`/`openAt` (`--dump-config` does not run on the managed desktop profile itself). dsh not restarted: Content search starts after the user's next dsh restart.
