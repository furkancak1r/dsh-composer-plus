# Composer Plus features in Tether

Tether shows the Composer Plus features of the Mac on the iPhone. This table lists each id in `FEATURES` (`../client.js`) and its place in Tether.

`test/tether-parity.test.mjs` fails when a `FEATURES` id has no row here. When you add a feature to Composer Plus, add its row in the same change:

- `yes`: Tether has the feature. Write where the user finds it.
- `no`: the feature does not fit a phone. Write the reason.

A feature that uses a Host route (`/api/composer-plus.<name>`) also needs an entry in `PLUS` in `gateway/server.mjs`. Never add a switch route (`{on}`), the updater or the screenshots to `PLUS`.

While a Composer Plus action in this table waits for the Mac, Tether shows a wait indicator: the action's own spinner (Changes, Tree, Feature ideas, Improve prompt, Roll back, Redo), or "Waiting for your Mac…" at the top of the screen when the answer takes longer than 0.4 s. See "Mac'i beklerken" in `README.md`.

| id | Tether | Where in Tether, or why not |
|---|---|---|
| changesPanel | yes | Chat title menu → Changes: the **Mode** menu (Uncommitted, Unstaged, Staged, Branch, This chat: the files that the chat's file tools wrote, against the project before its first message, refreshed every 15 s), Hide whitespace (`git diff -w`, kept on the phone, for every mode and diff), files with +/−, tap a file for its diff. Refreshes every 4 s. Changes opens on the **Branch map** (Back shows the modes; the branch name or **Tree** opens the map again): three count cards (Total branches, Merged, Waiting to merge; tap one to show only those branches, tap it again for all), then a box for each branch with its last commit, the main branch first and each branch under its target, indented by its level (blue: main branch, green: in the main branch, orange: not in the main branch yet), an arrow to its target and a **✅ Merged** or **⏳ Waiting** pill, a legend, and a note when the history is too long for exact arrows. Tap a box for the branch's commits, a commit for its files and diffs; **✅ Merged** for the merge commit's files and diffs (a fast-forward has none); **⏳ Waiting** for the files that the branch brings into its target, each with its diff. A Mac without the map shows **Branches**: local branches, then remote ones. Swipe a file (or touch and hold it) → Chats that changed this file: the chats of this repository whose write/edit tools changed it, newest first; tap one to open it at that request. |
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
| notifications | yes | Settings → Notifications → Send notifications, off by default (kept on the phone). When you switch it on, iOS asks for the permission; Tether asks nothing before that. Then Turn finished, approval, question and error notifications come while Tether keeps its connection (no push service). Below it, Only between these hours (off by default) limits them to the From–To time; To before From goes past midnight, the same time for both is all day. The Mac's switch does not change the phone's. |
| idleSwitch | no | It watches the Mac's own keyboard and mouse and opens a waiting chat in dsh on the Mac. On the phone, the approval and question notifications and the waiting hand in Sessions already lead to that chat, and a phone app that changes the open chat by itself while you hold it would interrupt you. |
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
| projectMemory | no | The memory works on the Mac, also for the chats that the phone starts: the Mac adds the notes to the prompt and reviews each finished turn. The switch stays in the Mac's Settings. |
| mobileConnect | yes | Tether itself. Settings → Privacy → Lock with Face ID locks the app (phone only). The paired iPhone list, Remove, Tailscale only and the access log are on the Mac's Mobile connect panel. |
| worktreeChats | yes | A line under the chat title shows the chat's git branch, its changes and `↑/↓` or `not pushed`; a tap opens Changes. The composer's `+` menu → **New branch**: the next message (text, photos and files) starts a new chat on a new branch that the Mac names from the text, in its own worktree folder, and the phone opens it. A chat made on the phone (New session) starts with **New branch** on when its folder is the main folder of a git repository with a commit; switch it off in the same menu to stay on the current branch. While the Mac makes the branch, the text field takes no text. When a chat's branch is deleted, the Mac moves the chat (Ungrouped, the main folder); the phone needs nothing for it. The switch stays on the Mac. |
| branchTree | no | The Mac does it (git, projects, the chat move). The phone already shows the branch projects and the moved chat as dsh projects and chats; the switch stays on the Mac. |
| autoUpdate | no | Installs the plugin on the Mac. The iPhone app is built and installed separately. |
| backup | no | Backups read and write the Mac's dsh home and its backup folder; they run on the Mac (Settings → Composer Plus → Backup), not from a phone. |
| autoBackup | no | A schedule on the Mac; its switch is a Host switch, which the phone never changes. |
| sessionDoctor | no | The check and the repair read and replace the Mac's session logs; they run on the Mac (Settings → Composer Plus → Session log check, or the rescue console). |
| rescueConsole | no | A terminal menu in the Mac's backup folder for when dsh is closed or cannot start; a phone cannot reach dsh then. |
