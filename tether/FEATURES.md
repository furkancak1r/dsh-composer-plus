# Composer Plus features in Tether

Tether shows the Composer Plus features of the Mac on the iPhone. This table lists each id in `FEATURES` (`../client.js`) and its place in Tether.

`test/tether-parity.test.mjs` fails when a `FEATURES` id has no row here. When you add a feature to Composer Plus, add its row in the same change:

- `yes`: Tether has the feature. Write where the user finds it.
- `no`: the feature does not fit a phone. Write the reason.

A feature that uses a Host route (`/api/composer-plus.<name>`) also needs an entry in `PLUS` in `gateway/server.mjs`. Never add a switch route (`{on}`), the updater or the screenshots to `PLUS`.

While a Composer Plus action in this table waits for the Mac, Tether shows a wait indicator: the action's own spinner (Changes, Tree, Feature ideas, Improve prompt, Roll back, Redo), or "Waiting for your Mac…" at the top of the screen when the answer takes longer than 0.4 s. See "Mac'i beklerken" in `README.md`.

| id | Tether | Where in Tether, or why not |
|---|---|---|
| changesPanel | yes | Chat title menu → Changes: the **Mode** menu (Uncommitted, Unstaged, Staged, Branch, This chat: the files that the chat's file tools wrote, against the project before its first message, refreshed every 15 s), Hide whitespace (`git diff -w`, kept on the phone, for every mode and diff), files with +/−, tap a file for its diff. Refreshes every 4 s. The branch name or **Tree** opens **Branches**: local branches, then remote ones, each with its last commit (the current one marked); tap a branch for its commits, a commit for its files and diffs. Swipe a file (or touch and hold it) → Chats that changed this file: the chats of this repository whose write/edit tools changed it, newest first; tap one to open it at that request. |
| featureIdeas | yes | Chat title menu → Feature ideas: cards (swipe right or Plan, Build now, swipe left to skip, swipe down or Save for later), Later list (Plan, Build now, Plan all, Copy as checklist, Open GitHub issue: the Mac's gh opens the issue and its link Issue #N shows under the idea) and History (Forget, Forget all). A focus field with the six preset topics sits above the cards. |
| contentSearch | yes | Sessions search shows "Messages" hits from dsh's own message search. |
| turnRollback | yes | Touch and hold your message → Roll back to before this message: Chat only, or Chat and files. Withdrawn messages leave the chat. After a rollback, a Redo bar above the composer (while the chat is idle and nothing came after the rollback): Chat only, or Chat and files (a file changed since the rollback is marked; Also overwrite changed files is off by default). Redo opens a new chat from just before the rollback; the rolled-back chat stays as it is. |
| deleteChat | yes | Chat title menu, or touch and hold a chat in Sessions → Delete…. |
| projectName | yes | The folder name under the composer and in each chat row. |
| projectStatus | yes | Each project header in Sessions shows the waiting hand, the green dot or the spinner. The green dots come from the Mac: a chat opened in dsh or on another phone loses its dot here too. |
| sessionBranch | yes | Each chat row in Sessions shows the git branch of its folder at its last turn, next to the title (from the Mac; its switch stays on the Mac). |
| markProjectRead | yes | Sessions → the "…" button next to a project header → Mark all as read (shown while a chat of that project has a green dot). Clears the green dots of that project's chats on the phone and in the Mac's unread list (Tether's dots); the desktop's own dots clear when opened there. |
| activeProjectsFirst | yes | Sessions follows dsh's project order, which the desktop moves. |
| recentProjects | yes | Sessions filter menu → Active in the last 2 hours. |
| collapseProjects | yes | Sessions toolbar → Collapse all projects button, shown only while a project is open. |
| statusOrder | yes | Sessions filter menu → Order by status. |
| notifications | yes | Turn finished, approval and question notifications while Tether keeps its connection. |
| allowForChat | yes | Approval sheet → Allow for this chat; chat title menu → Revoke. The gateway also allows a granted tool when no window is open. A grant ends after the Mac's time limit (1 hour by default); the time limit is a Mac setting (the phone cannot change it). |
| continueButton | yes | After a stopped, failed or cut-off turn, the empty composer shows ▶ (Continue). |
| resumeAfterRestart | no | The Mac does it at dsh start, with no window. The switch stays on the Mac. |
| inputHistory | no | Needs ↑/↓ keys. Touch and hold your message → Edit or Resend does the same on a phone. |
| planToggle | yes | The plan button in the composer: adds or removes `/plan`, or leaves plan mode. |
| keepFocus | no | A desktop browser focus problem. The iPhone keyboard keeps its focus. |
| questionFit | no | A fix for dsh's question card in the desktop window. Tether shows a question in its own sheet (a scrolling form), where the question and every answer scroll. |
| queueReorder | yes | Queued message menu → Move up / Move down. Messages with images move too (the Mac's `queue-move` route). |
| queueEdit | yes | Queued message menu → Edit (a sheet): change the text, keep or remove its images and files, and add photos or files (Add photo or file → Photos / Files). The kept attachments stay as they are and the message keeps its place in the queue. Images and files go through the Mac's `queue-edit` route; with an older plugin, Edit shows only for messages without images or files. While a message is edited or saved, the queue does not move and that message cannot be sent now or removed. |
| copyDeeplink | yes | Chat title menu, or touch and hold a chat → Copy session link. |
| copyMessageLink | yes | Touch and hold a message (yours or an answer) → Copy message link. A message link in your message shows an Open message button: a tap opens that chat, scrolls to the message and marks it for 2 s. |
| exportMarkdown | yes | Chat title menu → Copy conversation or Share conversation: Markdown with the same section shape as the Mac's export (`## You` / `## Assistant`, code blocks kept, an open fence closed, no messages that Turn rollback or dsh-rewind-plugin withdrew), without the project and date line; Share sends it to another app. |
| copyProjectPath | yes | Sessions → the "…" button next to a project header → Copy path. |
| projectPicker | yes | New session (✎) → the projects show A–Z, the search box filters them (case and accents ignored), Return picks the first match. |
| defaultWorkspace | yes | New session (✎) → **Quick chat** opens in the default workspace that is set in Settings → Composer Plus on the Mac (switched off or an older Mac: DSH's own default folder). A project row still opens that project. The phone cannot change the setting. |
| findInChat | yes | Chat title menu → Find in chat: a find bar above the chat; the messages and answers on screen with a match are tinted (the current one more), n / total, ↑ ↓ (wrap around), Done. |
| nextPrediction | yes | After a finished turn, the guess for the next message shows above the empty composer; a tap puts it in the field. The switch and the model stay in the Mac's Settings. |
| typingCompletion | yes | While you type, after a short pause the rest of the message shows above the field; a tap adds it. The switch and its model stay in the Mac's Settings (by default the model of Next message prediction). |
| promptImprove | yes | The magic wand in the composer's button row: the Mac rewrites the typed message as a clearer prompt and it replaces the field (not sent); the button then undoes it, and a tap while it works cancels it. The model stays in the Mac's Settings. |
| goalCheck | no | The check runs on the Mac and also covers goals that the phone starts or resumes: a failed check shows in the chat as the `update_goal` result. Its row (own test command, limits, Run now) stays on the Mac, because a test command typed on a phone would run as a shell command on the Mac. |
| mobileConnect | yes | Tether itself. Settings → Privacy → Lock with Face ID locks the app (phone only). The paired iPhone list, Remove, Tailscale only and the access log are on the Mac's Mobile connect panel. |
| worktreeChats | yes | A line under the chat title shows the chat's git branch, its changes and `↑/↓` or `not pushed`; a tap opens Changes. The composer's `+` menu → **New branch**: the next message (text, photos and files) starts a new chat on a new branch that the Mac names from the text, in its own worktree folder, and the phone opens it. While the Mac makes the branch, the text field takes no text. |
| autoUpdate | no | Installs the plugin on the Mac. The iPhone app is built and installed separately. |
