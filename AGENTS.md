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
4. Document it in `README.md` (feature table with the same image, limits, FAQ when useful) and in `llms.txt`. Make the same change in each translated `README.<id>.md` (zh and the 11 `locales` languages), in that language and with the app's own label texts from the language pack. `test/readme.test.mjs` fails when a translation has other pictures, code blocks or a different version note.
5. Add a unit test in `test/` and add it to the `test` script in `package.json`. When the feature touches dsh's markup or its agent lifecycle, also check it in a real isolated dsh on 0.2.0-rc.2 and 0.2.1-rc.2.
6. When the Host half reads project files (for a model prompt or a response), read only regular files that stay inside the chat's folder. Before you open a file, resolve it with `realpath` and check that the result is inside the folder's real path and is a regular file. Open it with `O_NOFOLLOW | O_NONBLOCK`, so a swapped-in symlink or FIFO cannot block or escape. Test it with a symlink to a file outside the folder and with a FIFO; make a red FIFO test end (open the FIFO for writing after a timeout) instead of hanging.
7. A client store that more than one async action can change at the same time must not overwrite a state that another action set. Merge the state, and block a new action that changes the same state while one is running. Check the guard in every entry point (button, key, pointer drag), not only in the UI.

## Release

- Bump `version` in `package.json` and the two `dsh-composer-plus@x.y.z` notes in `README.md` and in each `README.<id>.md`.
- Run `npm test`, then commit and push. CI must pass before you create the GitHub release `vX.Y.Z`.
- npm needs the owner's browser approval: run `npm publish --access public --auth-type=web` in a terminal (TTY).
- Live desktop copy: back it up first, and keep its module id `@local/dsh-composer-history`. Never restart dsh.
- The npm package ships only `tether/gateway/{server.mjs,admin.html,qr.swift}` from `tether/` (see `files` in `package.json`). Check with `npm pack --dry-run`.
