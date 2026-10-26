# Composer Plus features in Tether

Tether shows the Composer Plus features of the Mac on the iPhone. This table lists each id in `FEATURES` (`../client.js`) and its place in Tether.

`test/tether-parity.test.mjs` fails when a `FEATURES` id has no row here. When you add a feature to Composer Plus, add its row in the same change:

- `yes`: Tether has the feature. Write where the user finds it.
- `no`: the feature does not fit a phone. Write the reason.

A feature that uses a Host route (`/api/composer-plus.<name>`) also needs an entry in `PLUS` in `gateway/server.mjs`. Never add a switch route (`{on}`), the updater or the screenshots to `PLUS`.

| id | Tether | Where in Tether, or why not |
|---|---|---|
| changesPanel | yes | Chat title menu → Changes: mode, files with +/−, tap a file for its diff. Refreshes every 4 s. The branch name or **Tree** opens the branch tree: **Branches** scrolls to a branch, tap a commit for its files and diffs. |
| featureIdeas | yes | Chat title menu → Feature ideas: cards (swipe right or Plan, Build now, swipe left to skip, swipe down or Save for later), Later list (Plan, Build now, Plan all, Copy as checklist) and History (Forget, Forget all). A focus field with the six preset topics sits above the cards. |
| contentSearch | yes | Sessions search shows "Messages" hits from dsh's own message search. |
| turnRollback | yes | Touch and hold your message → Roll back to before this message: Chat only, or Chat and files. Withdrawn messages leave the chat. |
| deleteChat | yes | Chat title menu, or touch and hold a chat in Sessions → Delete…. |
| projectName | yes | The folder name under the composer and in each chat row. |
| projectStatus | yes | Each project header in Sessions shows the waiting hand, the green dot or the spinner. The green dots come from the Mac: a chat opened in dsh or on another phone loses its dot here too. |
| activeProjectsFirst | yes | Sessions follows dsh's project order, which the desktop moves. |
| recentProjects | yes | Sessions filter menu → Active in the last 2 hours. |
| collapseProjects | yes | Sessions toolbar → Collapse all projects button, shown only while a project is open. |
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
| exportMarkdown | yes | Chat title menu → Copy conversation or Share conversation: Markdown with the same section shape as the Mac's export (`## You` / `## Assistant`, code blocks kept, an open fence closed, no messages that Turn rollback or dsh-rewind-plugin withdrew), without the project and date line; Share sends it to another app. |
| copyProjectPath | yes | Touch and hold a project header in Sessions → Copy path. |
| projectPicker | yes | New session (✎) → the projects show A–Z, the search box filters them (case and accents ignored), Return picks the first match. |
| nextPrediction | yes | After a finished turn, the guess for the next message shows above the empty composer; a tap puts it in the field. The switch and the model stay in the Mac's Settings. |
| typingCompletion | yes | While you type, after a short pause the rest of the message shows above the field; a tap adds it. The switch and its model stay in the Mac's Settings (by default the model of Next message prediction). |
| promptImprove | yes | The magic wand in the composer's button row: the Mac rewrites the typed message as a clearer prompt and it replaces the field (not sent); the button then undoes it, and a tap while it works cancels it. The model stays in the Mac's Settings. |
| mobileConnect | yes | Tether itself. |
| autoUpdate | no | Installs the plugin on the Mac. The iPhone app is built and installed separately. |
