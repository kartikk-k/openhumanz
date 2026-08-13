# Bots — Multi-Agent Architecture Plan

Turning scheduled workflows into a roster of named agents you can talk to. Every
workflow becomes a **Bot** with its own persistent thread; results land as chat
messages, not notifications; bots run in the background and can message each other.

---

## Locked decisions

| #   | Decision                                                | Rationale                                                                                                                                          |
| --- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Bots and Jobs stay separate concepts**                | A Job may _optionally_ post its result into a Bot's thread, but scheduling stays its own primitive.                                                |
| 2   | **Bot-to-bot via `message_bot(name, prompt)` MCP tool** | Thin tool over the existing background-run primitive; no new messaging subsystem.                                                                  |
| 3   | **Background-first runs**                               | A bot turn must keep running when you switch/close its thread. Uses the run/orchestrator path (already detached), never the interactive chat path. |
| 4   | **Main = the home chat**                                | The existing Home chat is promoted to the `Main` bot. Keeps multi-session; can call `message_bot`.                                                 |
| 5   | **File I/O via AppleScript-backed MCP tools**           | Real `file_create/read/move/delete/list` tools agents call directly — fast, reusable.                                                              |
| 6   | **Build all phases now**                                | One push across all subsystems, built by a team of agents.                                                                                         |

---

## 1. The problem

Scheduled **agent** jobs run the engine and produce real content (e.g. "top 10
Hacker News threads"). Today that output goes only into a run transcript in the
Runs/Schedule tab, and the user gets a **notification**. Neither is a place to
_read_ or _act on_ the content.

**Core insight:** a notification is a poke, not a payload. Workflow output is a
**conversation** — it wants a thread you can scroll, reply to, and return to. So
each recurring workflow gets a durable home: a **Bot** with its own chat.

The end state is "Slack for your agents," local: a list of Bots on the left,
each a persistent thread on the right. **Main** is one bot; scraper/workflow bots
(Hacker News, Sales Outbound, Invoice Chaser) are others. New results show an
**unread dot**. Bots can talk to each other.

---

## 2. The architectural decision everything hinges on

The codebase has **two disjoint transcript systems**:

- **System A — Chat transcripts:** Claude Code CLI's own JSONL on disk, keyed by
  `sessionId`. The CLI owns the file. Single active session, one watcher, one
  shared system prompt.
- **System B — Run transcripts:** app-owned `runs/<id>/transcript.jsonl` + SQLite.
  Fire-and-forget, survives independent of any open view. Per-run tool scope
  already works.

**Decision:** A **Bot thread is a new, app-owned message store** — not the CLI's
JSONL. We do _not_ fight the CLI for its transcript file. Both user turns and
scheduled/bot-to-bot runs append **messages** into this store. The engine we use
for a bot turn is the **run/orchestrator path (System B)**, because it already
runs in the background detached from any open view — exactly the "keep running
when I switch bots" requirement.

**Why not "post runs into the chat JSONL":** the chat UI only reads the CLI file,
and the CLI owns writes to it — injecting run output there fights the tool's
design. A dedicated bot-thread store is simpler, background-native, and merges
user messages, run summaries, and bot-to-bot messages in one clean stream.

**Rendering:** runs already write a Claude Code `transcript.jsonl` via
`store.append`. There is **no** `RunEvent → ChatBlock[]` reducer, so a bot-run's
output is reduced to `ChatBlock[]` by reusing the existing
`foldTranscript(records)` from `src/shared/claudeTranscript.fold.ts` — the same
fold the chat UI already uses.

---

## 3. Data model

### Bot (new)

```
Bot {
  id            string          // 'bot_main' is seeded, non-deletable
  name          string          // "Hacker News", "Main"
  avatarColor   string          // the colored orb
  systemPrompt  string          // the bot's identity/instructions
  allowedTools  string[]        // this bot's tool surface
  workspaceDir  string          // its own folder for file output
  archived      boolean
  createdAt / updatedAt
}
```

### BotMessage (new) — the thread

```
BotMessage {
  id          string
  botId       string            // which thread
  role        'user' | 'bot' | 'system'
  author      string            // 'you' | bot name | source bot name (bot-to-bot)
  blocks      ChatBlock[]       // reuse the fold: text, tool calls, thinking, subagents
  runId?      string            // link to the background run that produced it
  source      'chat' | 'schedule' | 'bot-to-bot'
  createdAt
}
```

### Extend, don't replace (reuse)

- **Jobs stay separate.** A `ScheduledJob` gains an optional `botId`: "when this
  agent job fires, post its result into this bot's thread" instead of a bare
  notification.
- **Run** gains an optional `botId` / `botMessageId` so a background run knows
  which thread to stream into.
- **Unread**: per-bot `lastReadAt` (or unread count) → the dot in the list.

---

## 4. How a bot turn runs (background-first)

Every way a bot "does something" is the same primitive: **spawn a background run
against the bot, stream its output into the bot's thread.** Three triggers, one
path:

```
  TRIGGER                          ENGINE (background run)              THREAD
  ───────                          ─────────────────────               ──────
  ① you type in a bot   ─┐
  ② scheduled job fires ─┼──►  orchestrator.startIfCondition({    ──►  append BotMessage
  ③ message_bot(other)  ─┘         request: { prompt = botPrompt       (role='bot')
                                     + userPrompt, allowedTools =       stream deltas via
                                     bot's, cwd = workspaceDir },       push:bot-thread
                                     condition: () => true })                │
                                        │                                    │
                                    runs detached from UI  ◄── survives bot switch / close
                                        │
                                    on finish → mark thread unread if not focused
```

**Background requirement — designed in, not bolted on:** bot turns use the
**run/orchestrator path, never the interactive chat path**. Runs already outlive
any open view. Switching bots, closing the thread, or navigating away never
pauses or cancels an in-flight turn. Multiple bots run concurrently.

### Reuse vs. add

| Piece                  | Status      | Note                                                                                                                     |
| ---------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| Background run engine  | **have**    | `orchestrator.startIfCondition` / run store — already detached, streams events.                                          |
| Per-run tool scope     | **have**    | Job→run→MCP step scope. Give each bot its own `allowedTools`.                                                            |
| Per-run system prompt  | **1-field** | `EngineInvocation` has no systemPrompt field; simplest correct approach is prepend the bot's prompt into the run prompt. |
| Run → thread streaming | **new**     | Reduce the run's transcript into `ChatBlock[]` via `foldTranscript`, append/patch a `BotMessage`, push to renderer.      |

---

## 5. Bot-to-bot messaging

MCP tools every bot's agent can call:

```
list_bots()                 → [{ id, name, description }]   // the roster
message_bot(name, prompt)   → spawns the TARGET bot's background run with `prompt`,
                              posts into the target's thread (author = calling bot),
                              delivers/acks the reply back to the CALLER's thread.
```

**Why it's tractable:** same background-run primitive from §4 with the caller
identified as author. No new messaging subsystem. The roster is `list_bots` over
the Bot table, injected into every bot's system prompt so it _knows_ who exists.

**Guardrails:** depth/hop cap (a bot-to-bot call can't infinitely fan out), no
self-messaging loops, same approval gate as any other tool.

---

## 6. File I/O for bots (new)

New AppleScript-backed MCP tools in the macOS module, mirroring the
`reminders_create` 5-layer pattern (script file → `SCRIPT_SPECS` →
`OsascriptRunner.runScript` → provider op → `defineTool` + `MACOS_TOOL_NAMES`):

- `file_create(path, content?)` — create a file, make parent dirs
- `file_read(path, maxChars?)` — bounded text read
- `file_move(from, to)` — move/rename
- `file_delete(path)` — **move to Trash**, not hard delete (respect the module's safety instinct)
- `file_list(dir)` — list a directory
- `file_make_folder(path)` — create a folder

Paths go through `buildArgv`, never interpolated into script source. macOS tool
names in `MACOS_TOOL_NAMES` are auto force-allowed by the approval gate. This
deliberately reverses the module's old "no file writes" policy (comment updated).

---

## 7. Navigation & screens

- **Chat tab → the Bot roster.** Left: list of bots (avatar, name, last-message
  preview, unread dot, timestamp). Right: selected bot's thread + composer.
- **Main** is the first bot in the list, mapped to the existing home chat.
- **Sessions tab (new):** today's ad-hoc home chat sessions move here.
- Reuse existing rendering (`MessageList`, `HomeAssistantBlocks`, the transcript
  fold) to render `BotMessage.blocks` — tool calls, thinking, subagents as now.

---

## 8. Build phases (all this session)

### Phase 1 — Foundation: Bots as background threads

- `bots` module: Bot + BotMessage stores (SQLite), migrations, IPC + `push:bot-thread`.
- Seed the **Main** bot. Chat tab lists bots; selecting one opens its thread.
- Typing in a bot → **background run** with the bot's prompt + tools → stream
  events reduced into a `BotMessage`, pushed live; **survives switching bots**.
- Per-bot unread dot (lastReadAt); mark read on focus.

### Phase 2 — Scheduled results post to a bot thread

- Optional `botId` on `ScheduledJob`. Agent job with a `botId` streams into that
  bot's thread instead of a bare notification (still notify: "New from Hacker News").
- Schedule dialog: pick/create the bot a job posts to.

### Phase 3 — Bot-to-bot messaging

- `list_bots` + `message_bot` MCP tools; roster injected into every bot's prompt;
  depth/loop guards.

### Phase 4 — Sessions tab + file workspaces + polish

- Move ad-hoc home chat into a Sessions tab. Per-bot `workspaceDir` + file tools.
  Archive/delete/rename bots. Avatars/colors.

---

## 9. Key integration points (verified against the code)

| Area                     | Anchor                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Launch background run    | `orchestrator.startIfCondition({ request: RunStartRequestInput, condition: () => true })` — `src/main/services/orchestrator/index.ts:131` |
| Run request shape        | `RunStartRequestSchema` — `src/shared/runs.ts:322`                                                                                        |
| Transcript → blocks      | `foldTranscript(records)` — `src/shared/claudeTranscript.fold.ts:176`                                                                     |
| Module contract          | `defineModule({ id, migrations, tools?, ipc?, start?, stop? })` — `src/main/modules/types.ts:186`                                         |
| Module registration      | modules array — `src/main/bootstrap.ts:214`                                                                                               |
| IPC contract             | `IpcContract` / `IPC_PUSH` / `IpcPushContract` — `src/shared/ipc.ts`                                                                      |
| Push bridge (main)       | `bridgeEventsToRenderer` — `src/main/bootstrap.ts:149`                                                                                    |
| Push receive (renderer)  | `connectPushChannels` — `src/renderer/store/bootstrap.ts:38`                                                                              |
| Routes / nav             | `ROUTES`, `NAV_ITEMS` — `src/renderer/routes.ts`                                                                                          |
| Route registration       | `<Route element={<AppShell/>}>` — `src/renderer/App.tsx:47`                                                                               |
| AppleScript tool pattern | `reminders_create` — `src/main/modules/macos/tools.ts:825` (+ `scripts.ts`, provider, `MACOS_TOOL_NAMES`)                                 |

---

## 10. Known risks

- **Run→thread streaming bridge** and the **Main-bot ↔ home-chat mapping** are the
  two spots most likely to need hands-on integration after the parallel build,
  not just name-matching.
- Parallel agents guess at each other's exported names; an integration-review
  pass reconciles the seams (IPC channel names, thread-runner method names,
  module registration, push bridging) and applies fixes before the final
  typecheck + runtime smoke.

---

_Status: plan approved; build in progress via a multi-agent workflow. No git
operations performed — all changes stay in the working tree for review._
