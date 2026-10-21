# Composer Plus features in Tether

Tether shows the Composer Plus features of the Mac on the iPhone. This table lists each id in `FEATURES` (`../client.js`) and its place in Tether.

`test/tether-parity.test.mjs` fails when a `FEATURES` id has no row here. When you add a feature to Composer Plus, add its row in the same change:

- `yes`: Tether has the feature. Write where the user finds it.
- `no`: the feature does not fit a phone. Write the reason.

A feature that uses a Host route (`/api/composer-plus.<name>`) also needs an entry in `PLUS` in `gateway/server.mjs`. Never add a switch route (`{on}`), the updater or the screenshots to `PLUS`.

| id | Tether | Where in Tether, or why not |
|---|---|---|
| changesPanel | yes | Chat title menu → Changes: mode, files with +/−, tap a file for its diff. Refreshes every 4 s. |
| featureIdeas | yes | Chat title menu → Feature ideas: cards (swipe right or Plan, Build now, swipe left to skip, swipe down or Save for later), Later list (Plan, Build now, Plan all) and History (Forget, Forget all). |
| contentSearch | yes | Sessions search shows "Messages" hits from dsh's own message search. |
| turnRollback | yes | Touch and hold your message → Roll back to before this message: Chat only, or Chat and files. Withdrawn messages leave the chat. |
| deleteChat | yes | Chat title menu, or touch and hold a chat in Sessions → Delete…. |
| projectName | yes | The folder name under the composer and in each chat row. |
| projectStatus | yes | Each project header in Sessions shows the waiting hand, the green dot or the spinner. |
| activeProjectsFirst | yes | Sessions follows dsh's project order, which the desktop moves. |
| recentProjects | yes | Sessions filter menu → Active in the last 2 hours. |
| collapseProjects | yes | Sessions filter menu → Collapse all projects. |
| statusOrder | yes | Sessions filter menu → Order by status. |
| notifications | yes | Turn finished, approval and question notifications while Tether keeps its connection. |
| allowForChat | yes | Approval sheet → Allow for this chat; chat title menu → Revoke. The gateway also allows a granted tool when no window is open. |
| continueButton | yes | After a stopped, failed or cut-off turn, the empty composer shows ▶ (Continue). |
| resumeAfterRestart | no | The Mac does it at dsh start, with no window. The switch stays on the Mac. |
| inputHistory | no | Needs ↑/↓ keys. Touch and hold your message → Edit or Resend does the same on a phone. |
| planToggle | yes | The plan button in the composer: adds or removes `/plan`, or leaves plan mode. |
| keepFocus | no | A desktop browser focus problem. The iPhone keyboard keeps its focus. |
| queueReorder | yes | Queued message menu → Move up / Move down. Messages with images move too (the Mac's `queue-move` route). |
| copyDeeplink | yes | Chat title menu, or touch and hold a chat → Copy session link. |
| copyProjectPath | yes | Touch and hold a project header in Sessions → Copy path. |
| projectPicker | yes | New session (✎) → the projects show A–Z, the search box filters them (case and accents ignored), Return picks the first match. |
| mobileConnect | yes | Tether itself. |
| autoUpdate | no | Installs the plugin on the Mac. The iPhone app is built and installed separately. |
