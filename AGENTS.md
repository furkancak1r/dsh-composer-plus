# dsh-composer-plus: rules for every change

The Tether iPhone app and its Mac gateway are in `tether/` (Mobile connect). Read `tether/AGENTS.md` before you work there.

## Each new or changed feature

1. Give it its own switch: add the id to `FEATURES` in `client.js` and install it with `feature(id, setup)`. Switching it off must remove every listener, observer, DOM host and style it added. A feature that opens a network port, runs a server or starts model turns without a click stays off until the user switches it on (`OFF_BY_DEFAULT`). When its work runs in the Host half (Mobile connect, Resume after restart), the Host keeps the switch: a `GET/POST {on}` route, the client's `createMobile(route)` store, and an entry in `createToggles({ ... })`.
2. Give it a Settings screenshot. This rule has no exceptions:
   - add `<id>: '<shot>'` to `SHOT_OF` in `client.js`;
   - add `<shot>` to `SHOTS` in `index.js`;
   - ship `assets/features/<shot>.webp`, about 60 kB or less.
   - Take the image from a throwaway demo dsh with the English UI and made-up projects only (`scripts/capture-screenshots.mjs` or `SHOT=1` in a `test/browser-*.mjs` check). Never use personal names, paths, chats or accounts.
   - `test/shots.test.mjs` fails when a feature has no screenshot.
3. Add its texts to `en` and `zh` in `client.js` and to all 11 files in `locales/<id>.json`. Then run `npm run build:locales`.
4. Document it. The feature table of the 13 READMEs and the feature list of `llms.txt` come from one file:
   - Edit the feature's entry in `docs/features.json` (`how` in all 13 languages, `llms`, `shot`). The row name is the `feature.<id>` label of each language pack.
   - Run `npm run build:readme`. Do not edit the text between the `GENERATED FEATURES` markers by hand: `npm test` runs `--check`.
   - Write the limits and the FAQ by hand in `README.md` and in each translated `README.<id>.md` (zh and the 11 `locales` languages), in that language.
   - A bold button or menu name must be the app's own label text from the language pack. `test/readme-labels.test.mjs` fails on a label that the app does not have.
   - `test/feature-docs.test.mjs` fails when a `FEATURES` id has no README row or `llms.txt` entry. `test/readme.test.mjs` fails when a translation has other pictures, code blocks or a different version note.
   - A new Host route gets an entry in `routes` in `docs/features.json` (method, body, feature). `npm run build:readme` writes `docs/ROUTES.md`, and `test/routes.test.mjs` fails on an undocumented route.
   - When you change the table layout in `scripts/build-docs.mjs`, run `test/browser-readme-anchors.mjs` (headless, needs github.com). It fails when a `#feature-…` link (the Settings `?` link) does not show the start of its row.
5. Add a unit test in `test/` and add it to the `test` script in `package.json`. When the feature touches dsh's markup or its agent lifecycle, also check it in a real isolated dsh on 0.2.0-rc.2 and 0.2.1-rc.2.
6. When the Host half reads project files (for a model prompt or a response), read only regular files that stay inside the chat's folder. Before you open a file, resolve it with `realpath` and check that the result is inside the folder's real path and is a regular file. Open it with `O_NOFOLLOW | O_NONBLOCK`, so a swapped-in symlink or FIFO cannot block or escape. Test it with a symlink to a file outside the folder and with a FIFO; make a red FIFO test end (open the FIFO for writing after a timeout) instead of hanging.
7. A client store that more than one async action can change at the same time must not overwrite a state that another action set. Merge the state, and block a new action that changes the same state while one is running. Check the guard in every entry point (button, key, pointer drag), not only in the UI.
8. Add it to Tether (the iPhone app in `tether/`) in the same change, when it fits a phone. Then add its row to `tether/FEATURES.md`: `yes` and where the user finds it, or `no` and why a phone does not need it. `test/tether-parity.test.mjs` fails when a `FEATURES` id has no row. When the phone calls a new Host route, add it to `PLUS` in `tether/gateway/server.mjs` (never a `{on}` switch route). Read `tether/AGENTS.md` first.
9. When code reads a chat's log to show, export or copy its messages, leave out the messages that a rollback withdrew. Two plugins write a withdraw marker:
   - Composer Plus Turn rollback: `source.kind: 'composer-plus-rollback'`;
   - dsh-rewind-plugin: `source.kind: 'dsh-rewind'`.
   Each marker is a `user/message` that hides `[min(sourceEventSeqs), marker seq]`. Test both kinds. dsh's `/compact` also writes a `surfaceOp: replace` marker (`compact-checkpoint`), but the user did not withdraw those messages: keep them.

## Threads: tell the user what happens

When you start threads (subagents, forks, workflow agents, background jobs), send the user a short update in Turkish at each of these points. Do not keep the updates for the final answer.

- Start: the task of the thread.
- Blocked: the cause (approval, missing input or prerequisite, failed check) and what it needs to continue.
- Finished: the result in one line, and each part that failed or that it did not do.
- Important progress or a change of direction while it runs.

## Release

- Bump `version` in `package.json` and the two `dsh-composer-plus@x.y.z` notes in `README.md` and in each `README.<id>.md`.
- Run `npm test`, then commit and push. CI must pass before you create the GitHub release `vX.Y.Z`.
- npm needs the owner's browser approval: run `npm publish --access public --auth-type=web` in a terminal (TTY).
- Live desktop copy: back it up first, and keep its module id `@local/dsh-composer-history`. Never restart dsh.
- The npm package ships only `tether/gateway/{server.mjs,admin.html,qr.swift}` from `tether/` (see `files` in `package.json`). Check with `npm pack --dry-run`.
