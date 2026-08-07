# Integration notes

Wiring each module needs in `src/main/main.ts`. Collected from the agents that built them; `main.ts` is wired last, in one pass, so nothing else edits it.

## approvals

```ts
import approvals from './modules/approvals';
```

1. Add to the registry module list.
2. **After `registry.start()`** — not optional; without it every tool is treated as side-effecting:
   ```ts
   const gate = getApprovalGate();
   gate.registerTools(registry.tools());
   mcpServer.setApprovalGate(gate);
   ```
3. Forward `approval:requested` / `approval:resolved` from the event bus to the renderer over `IPC_PUSH.approvalRequested` / `.approvalResolved`. The module emits on the bus; nothing bridges bus → `webContents.send` yet.
4. Whoever owns runs **must emit `run:finished`** — the approvals module subscribes to it to expire `run`-scoped grants. Without it, run grants linger in the grants UI (they still cannot match another run, since the grant row carries its run id).

Gate shape (three-way, matches `services/mcp/approvals.ts` with no adapter):

```ts
check(toolName, args, ctx?): Promise<'allow' | {pending, pollAfterMs, message, ...} | {denied, approvalId, approval}>
```

Accessors: `getApprovalGate()` (throws before start), `tryGetApprovalGate()`, `whenApprovalGateReady()`.

## mcp (services/mcp)

```ts
const mcp = createMcpSocketServer({ paths, tools: registry, logger: getLogger('mcp') });
await mcp.start();   // binds <workspace>/runtime/mcp.sock 0600, writes runtime/mcp-token 0600
```

1. `await ensureWorkspace(paths)` → create → `await mcp.start()` **after** `registry.start()`.
2. After the approvals module starts: `mcp.setApprovalGate(getApprovalGate())`. Composes with no adapter — shapes were cross-checked between the two agents.
3. `before-quit`: `await mcp.stop()` **before** `killAllTracked()`.
4. Hand the `mcp` instance to the orchestrator — it needs `registerStep` / `writeConfigForStep`.

Step API: `mcp.registerStep({stepId, runId, allowedTools})` → `step.env()` / `step.revoke()`; `mcp.writeConfigForStep(stepId)` → `cfg.path`, `cfg.toolIds()`, `cfg.cleanup()`, or `withMcpConfigFile(opts, fn)`.

Default gate is `allowAllApprovalGate`; `start()` warns if it's still installed while side-effecting tools exist. A gate that throws fails closed.

Verified: `.mcp.json` entry shape is `{"mcpServers":{"<name>":{"type":"stdio","command","args","env"}}}` (confirmed via `claude mcp add-json` in a throwaway dir; nothing written to the user's config).

## schedule

1. `import scheduleModule from './modules/schedule'` → registry list. Nothing else required for it to run.
2. **The orchestrator must subscribe to `schedule:due`** (`{jobId}`) and create the run. If it can return a run id, inject it as `dispatch` via `createScheduleModule`; otherwise `lastRunId` stays null (the module already updates `lastStatus` from `run:finished` by matching `last_run_id`).
3. `settings.schedule` isn't readable from a module ctx — pass `createScheduleModule({ enabled, defaultTimezone })`. `tickMs` is unused by design: this is not a poller.
4. `counter-changed` conditions need a producer — a service should call `recordCounterReading(db, 'mail:unread', n)` or inject `counterReader`. With no reading the condition **fails closed**.

Conditions: `always`, `file-changed`, `counter-changed`, `time-window`. All are cheap, deterministic, fail closed, and record a human sentence in history. Baselines seed at create/update so a new job doesn't fire on a year-old file.

One timer armed for the soonest `nextRunAt`, clamped to 15 min so suspend/clock-jump can't strand it. `catch-up` dispatches **once** with `missedCount`, not N times.

**Bug found and fixed, worth remembering:** `fs.stat().mtimeMs` is a float but `lastSeenMtimeMs` is `z.number().int()`. Storing it raw made the condition fail re-parse on read and silently degrade to `always` — a gated job quietly becoming an unconditional heartbeat. Now floored, and an unparseable condition reads as **disabled** rather than falling back to `always`.

### Deferred shared/ gaps
- `ScheduledJobSchema` has no `missedRunPolicy` field; it's authoritative in the module's own column and surfaced through `metadata.missedRunPolicy`. Promote it.
- No shared type for run history and **no `schedule:history` IPC channel** — history is MCP-only today. The jobs screen will want one.

## tasks + goals

Add both to the registry list. Forward `tasks:changed` / `goals:changed` to `IPC_PUSH.tasksChanged` / `goalsChanged` (a generic forwarder covers it). For per-turn goal injection call `goalStore.compact()` — pre-capped and measured.

Tools: `tasks_list`, `tasks_get` (read); `tasks_create`, `tasks_update` (side-effecting); `goals_read` (read); `goals_propose_edit` (side-effecting). Destructive board ops (`clearBoard`/`removeMany`/`replaceBoard`) require `confirmDestructive: true` and are deliberately **not** on the MCP surface.

`GOALS.md` carries a `<!-- next-id: gN -->` marker so ids are never recycled — without it, deleting `g2` hands the next goal `g2` and every earlier transcript silently re-points.

### Deferred shared/ gaps
- **`TaskStatus` vocabulary mismatch.** Shared: `inbox|todo|doing|blocked|done|cancelled`. Card lifecycle: `todo|in_progress|awaiting_approval|ready|blocked|done|rejected`. The module stores `cardStatus` as canonical and derives `status` on read. If shared adopts the richer enum the mapping collapses to identity.
- **`Task` has no card fields and no board.** `objective`, `desiredOutcome`, `plan`, `acceptanceCriteria`, `assignedAgent`, `approvalMode`, `blockerReason`, `evidence`, `description`, `board`, `conversationId` are module-side extensions. A renderer typed only against `Task` cannot see them. `TaskQuery` likewise lacks `board`/`conversationId`/`assignedAgent`.
- **`GoalWriteSchema` / `TaskUpdateSchema` are unsafe as patch schemas.** Both are `.partial()` over fields carrying `.default(...)`, and **zod v4 still applies those defaults** — `GoalWriteSchema.parse({title:'x'})` returns `description:''`, `status:'active'`, `order:0`, so parsing a patch blanks the description and reorders the goal. This was hit as a live bug. Fix shared to use a no-defaults patch variant; the module currently works around it locally.

## engines (services/engines)

- `const engines = createEngineRegistry({ logger })`; call `engines.detectAll()` at startup and on the environment-status IPC channel.
- Surface `report.status.apiKeyEnvDetected` / `warnings[0]` in onboarding — the stray-key case is already first in the list.
- `killAllTracked()` on `before-quit`.
- The orchestrator owns `runId`/`seq`: consume `run.batches()`, pass each batch through `toRunEvents(batch, ctx, index)` with one long-lived ctx + `ToolCallIndex` per run, then emit `runFinishedEvent()` itself.
- Callers must pass `transcriptPath: runs/<runId>/transcript.jsonl` and `stderrLogPath: runs/<runId>/stderr.log` — the adapter writes both but invents no paths.

`EngineRunOptions` makes `maxTurns`, `maxCostUsd` and `cwd` **required** — the circuit breakers cannot be forgotten because it won't compile without them.

Observed: `claude --version` → `2.1.224`. `--max-turns` confirmed present by arity probe despite being absent from `--help`; adapter fails soft and retries without it.

**New free capability worth using: `claude auth status --json`** → `{loggedIn, authMethod, apiProvider, email, orgId, orgName, subscriptionType}`. This is what makes auth a structured status rather than a guess. Not in API-NOTES §8.

### Deferred shared/ gaps
- `EngineInfoSchema` has no `auth` field, so `detectAll()` returns a sidecar `auth: Record<engineId, EngineAuthStatus>`. Either add optional `auth` to the schema or keep the sidecar.
- `EnvironmentStatus.providers` comes from elsewhere; `detectAll()` returns `Omit<EnvironmentStatus,'providers'>` to merge.

## memory

1. `import memory from './modules/memory'` → add to the `modules: []` array.
2. Forward `events.on('memory:indexed', ({status}) => send(IPC_PUSH.memoryIndexed, {status}))`.
3. `ensureWorkspace(paths)` before `registry.start()`.

Tools: `memory_search`, `memory_get`, `memory_store` (side-effecting). Storage is FTS4 with BM25 computed in JS from `matchinfo`. Index is fully rebuildable from the markdown files alone — verified byte-identical including chunk ids.

Gotcha for anyone else touching chokidar: **chokidar 5 is ESM-only** and tsconfig is `module: node16`, so a static import is a hard type error. `watcher.ts` uses dynamic import + a type-only `resolution-mode: 'import'`.

### Deferred shared/ gaps (reconcile in the integration pass)
- `IPC_PUSH` has `memoryIndexed` but nothing for the `memory:doc-changed` bus event. Without a `push:memory-doc-changed` channel the memory browser can only invalidate wholesale.
- `MemorySearchHit` carries `docTitle` but not doc tags; search filters on tags but cannot return them, so the UI can't show tag chips on results.

## approvals (continued)

Known gap: the module reads `settings.json` directly at start because modules cannot import each other. If a settings *service* appears, swapping `readApprovalSettings()` is a two-line change in `index.ts`.
