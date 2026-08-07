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
