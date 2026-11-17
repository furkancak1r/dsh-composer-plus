# Hermes Agent as the Composer Plus assistant (design)

Status: implemented as **Assistant on Hermes** (`assistantHermes`, off by default). Hermes Agent v0.23.2 (MIT),
DSH 0.2.2-rc.3, Composer Plus 1.30.0.

## Goal

The assistant chat (Damon) keeps its place, its UI and its abilities, but the agent that thinks and acts is
[Hermes Agent](https://github.com/NousResearch/hermes-agent), not DSH's own agent loop. Composer Plus checks Hermes,
starts it, watches it and connects the assistant chat to it. Hermes adds what Damon did not have: Telegram and WhatsApp,
self-improving skills, search over past sessions, remote and sandboxed terminals. Switched off, the assistant chat uses
DSH's own agent loop again (user decision 2026-11-17).

## Architecture

```
DSH Web UI / Tether ──> assistant chat (DSH session, same UI, same log)
                           │  llm/stream waterfall: the assistant chat's own model calls
                           ▼
              installHermes  ── POST /v1/chat/completions (stream, X-Hermes-Session-Id)
                           │                         ▼
                           │               hermes gateway (child process, API on 127.0.0.1)
                           │                 ├─ Telegram / WhatsApp (same process)
                           │                 ├─ skills, session_search, cron, delegate_task, terminal backends
                           │                 ├─ MCP client ───────────────┐
                           │                 └─ model calls ──────────┐   │
                           ▼                                          ▼   ▼
              Composer Plus loopback server (127.0.0.1, random port, Bearer token per start)
                 /v1/chat/completions: dsh's llm service (the chat's model as `dsh`, `<provider>/<model>`)
                 /mcp: the assistant's tools through dsh's tool pipeline (approval card, Auto review stay)
```

### Surface choice

| Surface | Fit | Decision |
|---|---|---|
| OpenAI API (`/v1/chat/completions`, stream), entered through dsh's `llm/stream` waterfall for the assistant chat's session id | The assistant chat stays a normal DSH chat: log, rollback, Tether, `onay` button, status panel, Auto review, queue and news turns keep working. The chat's model selection stays as it is, so switching off needs no undo. One `hermes gateway` process also serves Telegram, WhatsApp and cron. Streaming chat completions carry `approval.request` and stop when the request is aborted. | **Chosen** |
| A DSH LLM adapter (`registerAdapter(['hermes'])`) plus a model switch of the chat | Same wire, but the chat's model selection must change and be put back. | Not needed |
| ACP (stdio, `hermes acp`) | DSH has no ACP chat client; Telegram still needs the gateway (two processes). | Rejected |
| Damon's tools as client tools | Hermes ignores client `tools`. | Not possible: MCP instead |

## Damon ability → Hermes

| Damon ability | With Hermes |
|---|---|
| Chat stays free | Hermes `delegate_task` with `background: true` (the API session id is sent, so Hermes runs it in the background and wakes the session). Composer Plus reads the Hermes session every 20 s while the chat is idle and shows new replies with a hidden note and a replay turn (no model call). |
| To-do list, status panel | MCP `todo_list_add`, `todo_list_remove`, `status_summary_set` (same Host store). The panel's task list shows dsh subagents only. |
| Approve button, callouts, news rule, reply form | The Composer Plus sections of dsh's system prompt go to Hermes as the system message of each turn (without Assistant always free and Planned steps); `HERMES_SECTION` maps tool names. Hermes' text is the dsh reply, so the client draws the button and the boxes. |
| Approval for `chat_send/new/stop/archive` | MCP calls run through `tools.execute` in the assistant agent's scope: the existing `tools/pre-execute` gate (approval card, Auto review, relayed-approval check). Outside a dsh turn (Telegram, cron) the approval seam has no open turn and the call fails closed. |
| Hermes' risky commands | `approval.request` in the stream → dsh's approval service → `POST /v1/runs/{id}/approval` (`once` or `deny`). |
| Memory (Obsidian vault) | MCP `memory_remember/recall/forget`; Hermes' own memory is off in the managed overlay. |
| Reminders, morning summary | MCP dsh `schedule_*` tools (target the assistant chat); the morning summary is a dsh turn, so it goes through Hermes. Hermes cron only for Telegram/WhatsApp reminders (user decision 2026-11-17). |
| Other chats, visible project chats | MCP `chats_list`, `chat_read`, `chat_send`, `chat_new` (`branch: true`), `chat_stop`, `chat_archive`. |
| DeepSeek subagents | `delegation` in the managed overlay: the first allowed model of dsh's subagent model setting through the bridge (for this user `opencode-go-v41/deepseek-v4.1-flash`), at the model's highest effort. |
| Main model | The bridge's `dsh` model = the assistant chat's model and effort in dsh (user decision 2026-11-17: no extra key). |
| Telegram / WhatsApp, skills, session search, remote terminals | Hermes' own features in the same gateway (`hermes gateway setup`, pairing by default). |

## Lifecycle (Host half)

1. Find `hermes`: dsh's PATH lookup, then Hermes' install folders. Missing: the Settings row shows the install command.
2. Write the managed overlay `storages/dsh-composer-plus/hermes-managed/config.yaml` (JSON; `${VAR}` from the env);
   the user's Hermes `config.yaml` and `.env` are never written.
3. Make sure the assistant chat exists, then start `hermes gateway` (cwd `~/Assistant`) with `HERMES_MANAGED_DIR`,
   `API_SERVER_*` (127.0.0.1, free port, random key) and the loopback URL and token.
4. Health every 15 s; a crash restarts after 5 s, 30 s, 2 min, then stays failed (Settings → **Start again**).
5. Off, dsh quit or plugin dispose: abort the process (dsh's subprocess service) and close the loopback server.

## Security

- Loopback only, a random Bearer token per start (constant-time compare), body limit 8 MB, only `HERMES_TOOLS`.
- Changing tools keep dsh's approval path; no open dsh turn means refusal.
- No secret is written by Composer Plus. Telegram/WhatsApp tokens stay in Hermes' `.env`; Hermes' pairing rule decides
  who may write.
- Web, e-mail and chat text stays data (the assistant's existing rule reaches Hermes).

## Tests

- `test/hermes.test.mjs` (in `test:all`): prompt sections, turn text, SSE parsing (CRLF, split frames, approval, error,
  cut stream), the bridge both ways, MCP JSON-RPC, the managed overlay, and `installHermes` with a fake gateway: the
  switch, the env, the turn, the token, MCP through `tools.execute`, the bridge (stream and not), off.
- `test/browser-assistant-hermes.mjs`: a real dsh and the real Hermes with a fake model (a throwaway Hermes profile):
  Settings switch, a turn through Hermes whose MCP tool call adds a to-do in the status panel, off.

## Risks and limits

- Text only to Hermes (images and files are named). dsh's own tools do not run in the assistant chat while it is on.
- The status panel lists dsh subagents, not Hermes' background helpers.
- A Hermes gateway that already runs with the same Telegram bot conflicts; one dsh per computer.
- Hermes API changes (`/v1/runs` approvals, session messages) break the matching part with a clear error line.
- A Hermes profile other than the default needs `gateway.standalone: true` in its own config (multiplexing).
