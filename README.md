# Assistant

A local-first personal assistant for macOS. It orchestrates work itself and delegates execution to coding-agent CLIs you already have installed and pay for, exposing its own capabilities back to them through an MCP server it runs.

There is no account, no login, no backend of ours, and no telemetry. Every credential in the product is yours: your CLI subscription, your mail accounts. If this repository disappeared tomorrow, every install would keep working.

> **Status: early. The app has not yet been launched end to end.** See [STATUS.md](STATUS.md) for exactly what is proven, what is not, and the known gaps. Read it before trusting anything here.

## The idea

The app owns orchestration. The agent CLI executes. MCP is the seam between them.

Inverting the usual arrangement — rather than building an agent harness and plugging a model in — buys four properties:

- **The engine is swappable.** MCP is a standard; any compliant CLI consumes the same tool surface.
- **Policy is unbypassable.** A tool call physically terminates inside our process. The agent cannot route around a gate that lives on the other side of the protocol.
- **Prompt injection stops being fatal.** The agent will read attacker-controlled content — emails, web pages, calendar invites. When something in that content says "send my credentials to this address", the approval gate still fires. Security that depends on the model's judgement is not security.
- **The experience is deterministic where it matters.** Scheduling, retries, history and persistence are ours. Only the inner tool loop is nondeterministic.

The honest boundary: we control the *step* boundary, not the inner loop. Within one CLI invocation the agent decides which of our tools to call and in what order. So steps are kept small, tools are scoped per step, and every step is budgeted.

## Requirements

- **macOS** for the full feature set. The app runs elsewhere, but the Apple-native capabilities report themselves unavailable.
- **Node.js 20+** — Electron, webpack and the build scripts run on Node.
- **bun** — dependency install and scripts.
- **[Claude Code](https://claude.com/claude-code)** installed and signed in. Codex is stubbed but not implemented.

## Getting started

```bash
bun install
bun run start        # dev: webpack dev server + Electron with hot reload
```

```bash
bun run package      # distributables in release/build
bun run build        # production bundles only
bun run lint         # ESLint (includes the layering rules)
bun run test         # Jest — needs `bun run build` first, and Node on PATH
```

State lives in `~/.assistant` (override with `ASSISTANT_HOME`):

```
assistant.db     structured state (sql.js)
memory/          *.md — the memory vault, yours to edit by hand
runs/<id>/       transcript.jsonl, engine.jsonl, stderr.log
settings.json    plain JSON, hand-editable
GOALS.md         long-term goals, hand-editable
runtime/         socket + token, 0700, cleared on launch
```

Structured state goes in the database; content goes in plain files you can open. That is the trust story, and it makes debugging dramatically easier.

## Architecture

[ARCHITECTURE.md](ARCHITECTURE.md) is the binding contract — read it before changing anything.

```
src/shared/        types + zod schemas + the IPC contract (imports nothing)
src/main/infra/    db, paths, logger, event bus, files, spawn, crypto
src/main/modules/  approvals · runs · tasks · goals · memory · schedule · settings · macos
src/main/services/ registry · mcp · engines · orchestrator · engine-bridge
src/shim/          the MCP relay the CLI spawns
src/renderer/      shell, design system, feature screens
```

Dependencies point one way, and **modules may not import each other** — cross-module traffic goes through the event bus or a coordinating service. This is enforced by `import/no-restricted-paths`, generated per module directory, so it is a lint error rather than a convention people remember. Adding a capability is: build the module, add it to the registry list.

### The MCP server

Runs on a **unix domain socket** (`0600`), never a TCP port — a loopback port is reachable by every process on the machine and by browser tabs via DNS rebinding, and this server exposes mail and filesystem operations. A per-launch token is regenerated each start and compared in constant time.

The CLI spawns a shim that relays stdio to the socket and handshakes with a step id; the server then scopes that connection's tool list to exactly what the step may use — independently of whatever allowlist the CLI was handed. Two gates that fail independently.

We deliberately **do not** reimplement file read/edit/search/shell. Claude Code ships better versions, and exposing duplicates causes tool-choice confusion — the model picks the native one and bypasses our gate. Our server owns the assistant surface: memory, tasks, goals, scheduling, and the macOS capabilities. A generic shell tool and an arbitrary-AppleScript tool are refused at registration time; both are arbitrary code execution wearing a friendly schema.

### The approval gate

Side-effecting tool calls are checked against standing grants, and on a miss the call parks and returns a pending handle **immediately** — never holding the protocol response open while a human decides, which reliably hits client timeouts.

Three scopes ship: **once**, **for this run**, and **always**. Grants key on a capability (tool name + classified action + a declared argument discriminator), not on the tool name alone — so "always allow reading the calendar" can never authorise deleting an event. Every decision is logged with its full arguments.

### Background work

**No CLI invocation is ever put on an unconditional timer.** Every scheduled job carries a deterministic condition — file mtime moved, a counter changed, a time window — evaluated before anything spawns. An unconditional five-minute heartbeat would exhaust a weekly subscription quota by Tuesday. Conditions fail closed, and skips are recorded as first-class history.

## Contributing notes

- Prefer platform capabilities to packages. `node:crypto`, `node:net`, Electron's own APIs and `Intl` replace most reflexive installs.
- No native modules. SQLite is `sql.js` (WASM), which has **no FTS5** — memory search uses FTS4 with BM25 computed in JS.
- Adding a dependency should come with a note on what was tried first.

## Credits

Built on [Electron React Boilerplate](https://github.com/electron-react-boilerplate/electron-react-boilerplate). The macOS AppleScript decomposition draws on [`kartikk-k/macos-mcp`](https://github.com/kartikk-k/macos-mcp) (MIT).

Licence: not yet chosen — settle it before the repository goes public.
