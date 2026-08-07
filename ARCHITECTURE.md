# Architecture

This is the binding contract between modules. Read it before writing code. If you deviate, note why in your summary.

## The core idea

The app owns orchestration. The agent CLI executes. MCP is the seam.

A tool call physically terminates inside our process, so policy is unbypassable — the agent cannot route around a gate that lives on the other side of the protocol. We control the **step boundary**, not the inner loop.

## Runtime constraints (this machine)

- Package manager is **bun**. There is **no `node` on PATH**. Never write a script that assumes `node`.
- **No native modules.** SQLite is `sql.js` (WASM). If you think you need a native dep, you don't — find a pure-JS path.
- Dev machine is **Linux**; the product targets **macOS**. macOS-only code must be written so it reports itself unavailable on other platforms rather than throwing.
- Electron bundles its own Node. Spawn helper processes through `process.execPath` with `ELECTRON_RUN_AS_NODE=1`, never a bare `node`.

## Verified environment facts

These were established empirically. `docs/API-NOTES.md` has the detail and code snippets — read it before writing against any of these libraries.

- **sql.js has no FTS5.** Verified: `CREATE VIRTUAL TABLE … USING fts5` → `no such module: fts5`, and `OMIT_LOAD_EXTENSION` means it cannot be loaded at runtime. **FTS4 works fully** (MATCH, `snippet()`, `unicode61`, `porter`). Memory search uses FTS4. There is no `bm25()` — rank in JS from `matchinfo(tbl,'pcx')`. `snippet()` takes different argument order than FTS5.
- **zod v4: use `.prefault({})`, not `.default({})`,** for a nested object whose leaves all have defaults. `.default()` takes the *output* type; `.prefault()` takes the *input* type.
- **Every MCP `inputSchema` must be generated with `z.toJSONSchema(schema, { io: 'input' })`.** The default `io:"output"` marks defaulted fields as `required`, which is silently wrong for tool inputs.
- **MCP custom transport:** only `start` / `send` / `close` / `onmessage` are actually required. Framing is newline-delimited JSON with **no Content-Length headers**. Reuse the SDK's own `ReadBuffer` / `serializeMessage` from `shared/stdio.js` rather than hand-rolling framing. Never call `start()` yourself — `connect()` does it after installing callbacks. `close()` must fire `onclose?.()` even when called explicitly.
- **`McpServer.registerTool`'s `inputSchema` takes a raw shape** (`{k: z.string()}`), not `z.object({...})`. `Server` is deprecated in favour of `McpServer`, though `setRequestHandler` still works.
- **Electron must be ≥33.** Electron 22 bundles Node 16.17; MCP SDK and cron-parser need ≥18, chokidar 5 needs ≥20.19.
- **cron-parser v5:** `CronExpressionParser.parse()`, timezone option is **`tz`** (not `timezone`), returns a `CronDate` (call `.toDate()`). Invalid expressions throw a plain `Error` with no `code`.
- **chokidar v5:** globs are gone. `ignored` takes a `(path, stats) => boolean` matcher.
- **Claude Code CLI:** `--max-turns <turns>` exists but is hidden from `--help`. Fail soft on it. `codex` is not installed on this machine.

## Layering — dependencies point one direction

```
shared/            types + zod schemas + IPC contracts. Imports nothing from main/ or renderer/.
  ^
main/infra/        wraps external deps: db, fs, logger, event bus, paths, process spawning.
  ^
main/modules/*/    self-contained domain modules. MUST NOT import each other.
  ^
main/services/     coordinates across modules: registry, orchestrator, mcp server, engines.
  ^
main/main.ts       electron shell.

renderer/          depends only on shared/. Never imports from main/.
```

Enforced mechanically by `import/no-restricted-paths` in `.eslintrc.js`. It is a lint error, not a convention.

**Cross-module communication goes through the event bus or a service.** If `memory` imports `tasks`, neither can be replaced independently. This is the rule most likely to be broken under pressure and the one to be rigid about.

## Module contract

Every domain module in `src/main/modules/<name>/` default-exports an object:

```ts
{
  id: string
  migrations: Migration[]        // owns its own tables
  tools?: ToolDefinition[]       // its slice of the MCP surface
  ipc?: IpcHandlerMap            // its slice of the IPC surface
  start?(ctx): Promise<void>     // long-lived work (watchers, timers)
  stop?(): Promise<void>
}
```

Adding a capability = build the module, add it to the registry list. If it requires editing unrelated files, a boundary has been broken.

`ctx` gives a module its scoped db handle, logger, event bus, and paths. Nothing else.

## Storage

Structured state in SQLite. Content in plain files a human can open. Nothing a user might reasonably want to read gets locked in an opaque store.

Workspace root: `~/.assistant/` (override via settings)

```
~/.assistant/
  assistant.db          sql.js database, persisted on a debounce
  memory/               *.md — the memory vault, human-editable
  runs/<runId>/         transcript.jsonl, stderr.log
  logs/
  runtime/              socket + token, 0700, cleared on launch
```

## MCP server

- **Unix domain socket**, `0600`, in `runtime/`. **Never a TCP port** — a loopback port is reachable by every process on the machine and by browser tabs via DNS rebinding, and this server exposes mail and filesystem operations.
- Per-launch token, regenerated each start, compared with `timingSafeEqual`, never logged.
- The CLI spawns a **shim** (`src/shim/`) that relays stdio ↔ socket. The shim handshakes with a step id, and the server scopes that connection's tool list to what the step may use — independently of whatever allowlist the CLI was given. Two gates that fail independently.
- MCP config is generated per invocation into a temp dir and deleted after. **Never** write to the user's global or project CLI config.

### What we expose

We do **not** reimplement file read/edit/search/shell. Claude Code ships better versions, and exposing duplicates causes tool-choice confusion — the model picks the native one and bypasses our gate.

Native tools own code and filesystem work, scoped per step. Our server owns the personal-assistant surface: memory, tasks, goals, scheduling, notifications, macOS.

**Never expose:** a generic shell tool, or an arbitrary-AppleScript tool. Both are arbitrary code execution wearing a friendly schema.

Keep results compact — truncate lists, return counts, offer fetch-by-id.

## Approval gate

The most important mechanism in the product.

1. Side-effecting tool call arrives.
2. Check standing grants (`once` / `run` / `always`). Hit → proceed.
3. Miss → persist a pending approval, emit to UI, and **return a pending handle immediately**. Never hold the MCP response open waiting for a human — that reliably hits client timeouts. The agent polls; the orchestrator re-dispatches on resolve.
4. Log every decision with full arguments. Trust feature and primary debugging tool at once.

All three scopes ship from the start. Without `always`, users quit around the fortieth calendar-read approval.

## Engine adapter

One interface: `detect()`, `run(prompt, opts) -> AsyncIterable<Event>`, `resume(sessionId)`.

- Streaming JSON needs the verbose flag. The final result carries session id, turns, duration and per-model cost — persist all of it, that is the cost meter for free.
- Set turn and budget limits on **every** step. Cheaper than building loop detection.
- Avoid bare/API-key modes — they invert the subscription premise. Detect a stray `ANTHROPIC_API_KEY` at startup and say so plainly, because it silently burns credit.
- Control the working directory; a prior session in cwd can trigger an interactive resume prompt that hangs an unattended spawn forever.
- stdout is the event stream. **stderr is a log, never control flow.** Batch events before IPC or per-token traffic pins a core.
- Track spawned pids; kill the tree on cancel and on quit.

## Background work

**Never put a CLI invocation on an unconditional timer.** Check a deterministic condition first — file mtime changed, unread count moved, time window open — and only then spawn. An unconditional 5-minute heartbeat exhausts a weekly quota by Tuesday.

## UI surfaces that matter

1. **Run timeline** — not a chat log. Collapsible steps with tool name, arguments, output, duration, cost. Highest-value surface in the product.
2. **Approval card** — plain language, raw command on expand, three buttons.
3. **Scheduled jobs table** — schedule in English, next run, last status, toggle, run-now. One screen.
4. **Memory browser** — show it as files, because it is files. Provenance on every chunk.

## Dependencies

Low count. Reach for platform capabilities first: `node:crypto` for tokens and constant-time compare, `node:net` for the socket, Electron's `safeStorage` and `Notification`, `Intl` for dates.

Approved: `zod` (single source of truth for types), `@modelcontextprotocol/sdk`, `sql.js`, `cron-parser`, `chokidar`, `@tanstack/react-virtual`, `lucide-react`, plus the existing react/zustand/tailwind stack.

**Not** approved: any AppleScript wrapper library (thin, unmaintained, highest-risk path — own it), any natural-language date parser (have the agent emit cron, validate it, echo it back in English).

Anything else needs a note on what was tried first.

## No external services

No telemetry, no crash reporting, no license check, no backend of ours. The only network traffic is the user's CLI talking to its own vendor.
