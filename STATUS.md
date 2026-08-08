# Build status

Written at the end of the overnight build. Honest about what is proven and what is not.

## What exists

An Electron + React + TypeScript desktop app that orchestrates work itself and delegates execution to the Claude Code CLI, exposing its own capabilities back through an MCP server it runs over a unix socket. No account, no backend, no telemetry. 8 domain modules, 35 agent-facing tools, 41 IPC channels.

```
src/shared/        types + zod schemas + the IPC contract (the floor)
src/main/infra/    db (sql.js), paths, logger, event bus, files, spawn, crypto
src/main/modules/  approvals, runs, tasks, goals, memory, schedule, settings, macos
src/main/services/ registry, mcp, engines, orchestrator, engine-bridge
src/shim/          the MCP relay the CLI spawns
src/renderer/      shell, design system, 7 feature screens
```

Layering is enforced by `import/no-restricted-paths` in `.eslintrc.js`, generated per module directory — a module importing another module is a lint error, not a convention. Verified by deliberately writing violations and watching each one fail.

## Verified

Every number below was produced by a real run, not asserted.

| Area | Evidence |
|---|---|
| Whole backend boots | 95 ms, 8 modules, 35 tools, MCP listening, clean shutdown |
| Approval gate | 86/86 — `once` doesn't cover the next call, `run` dies with the run, `always` survives a real close/reopen, a grant on "create" cannot authorise "delete", audit log round-trips full arguments |
| Feature screens | 7 screens; SSR/jsdom checks per screen (runs 13, approvals 8+28, memory 63, settings 12, schedule 6, tasks 7) |
| MCP server + shim | 51/51 — real MCP client over the socket, bad token dropped with no reply, out-of-scope tool rejected, real shim round-trip |
| Engine adapter | 146/146 against a fake CLI; stray `ANTHROPIC_API_KEY` provably stripped from the child |
| Engine↔orchestrator bridge | 89/89 — cancel kills the grandchild, quota ≠ our budget ceiling |
| Runs + orchestrator | per-step tool scope and budget reach the engine and MCP; cancel leaves coherent state; history reloads after restart |
| Memory | 80 checks — BM25 over FTS4, index rebuilds byte-identical from files alone, 15 hostile queries survive |
| Scheduler | 105/105 with an injected fake clock; gated jobs provably don't dispatch |
| Tasks / goals | 51 + 47 — hand-mangled `GOALS.md` parses without data loss |
| Settings | 67/67 — a corrupt `settings.json` degrades per-field instead of wiping config |
| Patch schemas | 50/50 — parsing a patch never invents a key the caller didn't send |
| Dev start chain | `bun run start` runs end to end with no Node/npm: port check → main bundle → dev server "Project is running" → preload builder → main process → Electron. Zero compile errors; it stops only at Electron needing a GUI |
| Typecheck / lint / build | all clean, whole repo |

## Not verified — read this first

1. **The app window has never opened.** Electron dies here on `libasound.so.2` — this container has no audio/X11 libraries and no root to install them. Everything up to that point is verified: the dev chain builds and spawns correctly, and the backend was booted headlessly with `electron` stubbed. What remains untested is the window itself, the preload bridge inside a real renderer, and IPC round-trips through actual Electron. **First thing to run: `bun run start`.**
2. **No billed CLI call was ever made.** Everything about the engine is proven against a fake CLI that replays recorded `stream-json`. Real detection (`claude --version` → 2.1.224) works; a real `claude -p` run does not exist yet. **The subscription-vs-API billing question the plan flags as premise-critical is still open** — test it on a real account early.
3. **The macOS layer has never executed.** Written, typechecked, and correctly reporting unavailable on Linux, but no AppleScript has ever run. Its escaping corpus and error mapping are unit-tested; everything touching a real Apple Event is not.
4. **Jest cannot run here** (no `node`; Bun's runtime can't execute it). `src/__tests__/App.test.tsx` is valid but unexecuted. The suites above are standalone Bun scripts in the session scratchpad, not committed — port the valuable ones into the repo.

## Known gaps

- **No directory-picker IPC channel**, so onboarding cannot browse for a workspace or notes folder — paths must be typed. This is the biggest gap against "if someone has to open a terminal, you've lost the argument".
- No reveal-in-OS / open-in-editor channel; the memory browser shows a copyable absolute path instead.
- No rename/delete for memory notes (`memory:write` only).
- Settings rejections are logged but not surfaced to the UI — a `settings:diagnostics` channel would close it.
- `MAX_GOALS` (8) and `MAX_GOAL_TOKENS` (500) live in the goals module and are mirrored as constants in the renderer; they belong in `src/shared/tasks.ts`.
- `BridgeNotice` is duplicated in the schedule and tasks features (features may not import each other). It is the most-used component in the app — promote it to the design system.
- No `ScheduledJob` field for a last-output preview; the schedule table infers it from run history.
- No `onboarding:changed` broadcast (fine with one window).
- A note consisting **only** of a heading produces no body chunk and is therefore unsearchable. Minor, but real.
- `ONBOARDING_STEPS` in shared still reads `permissions | done` where the flow now means "data source" and "first run".
- The MCP server exposes no per-tool-call observer, so timeline rows lack `sideEffecting`/`approvalId`. The orchestrator documents the ~12-line instrumenting proxy that would close it.

## Deliberately not built

Composio, general MCP client support, the workflow canvas, local voice, messaging channels, the memory tree's sealing cascade, meeting agents, the mascot. All P2/P3 in the plan. Memory is intentionally the simple version — files plus FTS plus a watcher — per the plan's instruction to add complexity only when flat search demonstrably fails.

## Three bugs worth remembering

Each was a silent correctness failure, not a crash:

1. **`.partial()` still applies zod defaults.** Four schemas were affected. Renaming a scheduled job silently replaced its condition with `{kind:'always'}` — turning a gated job into exactly the unconditional heartbeat that exhausts a weekly quota by Tuesday. Fixed with `patchSchema()` and pinned by a regression test that also asserts zod still behaves this way, so the test fails loudly if that ever changes.
2. **`fs.stat().mtimeMs` is a float**, but the condition schema demanded an int. The condition failed to re-parse on read and degraded to `always` — same quota-burning outcome, different cause. Now floored, and an unparseable condition reads as *disabled* rather than falling back to `always`.
3. **`shell.openExternal` was unguarded** in the main process while the renderer displays notes that may have arrived from an email. Now a scheme whitelist plus a navigation guard.
