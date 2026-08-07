# API Notes — installed versions, verified against `node_modules/`

Ground truth = the installed source/`.d.ts` in this repo, plus code actually executed with `bun`.
Anything not verified is marked **UNVERIFIED**.

Versions confirmed from each `node_modules/<pkg>/package.json`:

| package | installed | `engines.node` |
|---|---|---|
| `zod` | **4.4.3** | none |
| `@modelcontextprotocol/sdk` | **1.30.0** | `>=18` |
| `sql.js` | **1.14.1** | none |
| `@types/sql.js` | 1.4.11 | — |
| `cron-parser` | **5.7.0** | `>=18` |
| `chokidar` | **5.0.0** | `>= 20.19.0` |
| `readdirp` (chokidar dep) | 5.1.1 | `>= 20.19.0` |
| `lucide-react` | **1.30.0** | none |
| `@tanstack/react-virtual` | **3.14.9** | none |
| `electron` | **22.3.27** | `>= 12.20.55` |

> There is no `node` on PATH in this environment — only `bun` (`~/.bun/bin`). All verification scripts were run with `bun`.

---

## TOP 4 THINGS THAT WILL BITE YOU

1. **`sql.js@1.14.1` has NO FTS5.** Verified empirically. `CREATE VIRTUAL TABLE … USING fts5` → `Error: no such module: fts5`. **FTS4 works.** See §3.
2. **`z.toJSONSchema()` defaults to `io: "output"`**, which marks every `.default()` field as `required` — wrong for MCP tool input schemas. Always pass `{ io: "input" }`. See §1a.
3. **Electron 22 bundles Node 16.17.1**, below the `engines` floor of the MCP SDK (18), cron-parser (18) and chokidar (**20.19**). See §10.
4. **`claude --max-turns <turns>` exists but is hidden from `--help`.** Verified by probing. See §8.

---

## 1. zod 4.4.3

`import { z } from 'zod'` resolves to v4 classic (`index.js` / `index.d.cts`). Verified: `z.prefault`, `z.toJSONSchema`, and `.prefault()` on instances are all present via both ESM and CJS entry points.

### Basics

```ts
import { z } from 'zod';

const S = z.object({
  name: z.string().min(1).max(80),
  count: z.number().int().nonnegative().default(0),
  kind: z.enum(['a', 'b', 'c']),                  // z.enum over a string union
  either: z.union([z.string(), z.number()]),
  note: z.string().optional(),                     // -> string | undefined
  tags: z.array(z.string()).default([]),
});

type S = z.infer<typeof S>;      // OUTPUT type (defaults applied, non-optional)
type SIn = z.input<typeof S>;    // INPUT type (defaulted fields optional)

const v = S.parse(raw);                       // throws z.ZodError
const r = S.safeParse(raw);                   // { success: true, data } | { success: false, error }
```

`z.enum` also accepts a `readonly` tuple: `z.enum(['welcome','engine'] as const)` — this is what `src/shared/settings.ts` does with `ONBOARDING_STEPS`.

### Error shape (verified output)

`error` is a `z.ZodError`. The v3 `.errors` alias is gone in favour of `.issues`; formatting helpers are now **free functions**, not methods.

```ts
const r = S.safeParse({ limit: 0 });
if (!r.success) {
  r.error.issues;          // Array<{ code, path: (string|number)[], message, ...extras }>
  z.prettifyError(r.error);  // human string, "✖ msg\n  → at path"
  z.treeifyError(r.error);   // { errors: string[], properties: { field: { errors: [...] } } }
  z.flattenError(r.error);   // { formErrors: string[], fieldErrors: Record<string, string[]> }
}
```

Real issue objects produced by 4.4.3:

```json
[
  { "expected": "string", "code": "invalid_type", "path": ["path"],
    "message": "Invalid input: expected string, received undefined" },
  { "origin": "number", "code": "too_small", "minimum": 1, "inclusive": true,
    "path": ["limit"], "message": "Too small: expected number to be >=1" }
]
```

Note `code: "invalid_type"` carries `expected` but **no `received` field** (v3 had one).

### 1a. `z.toJSONSchema()` — LOAD-BEARING for MCP

```ts
z.toJSONSchema(schema, params?)   // free function
schema.toJSONSchema(params?)      // equivalent instance method (also present)
```

Options (from `zod/v4/core/to-json-schema.d.cts`, `ToJSONSchemaParams`):

| option | values | default | notes |
|---|---|---|---|
| `target` | `"draft-2020-12"` \| `"draft-07"` \| `"draft-04"` \| `"openapi-3.0"` | `"draft-2020-12"` | sets `$schema` |
| `io` | `"input"` \| `"output"` | **`"output"`** | **see warning below** |
| `unrepresentable` | `"throw"` \| `"any"` | `"throw"` | `z.date()` throws unless `"any"` |
| `override` | `(ctx:{zodSchema,jsonSchema,path}) => void` | — | mutate `ctx.jsonSchema` in place |
| `cycles` | `"ref"` \| `"throw"` | `"ref"` | |
| `reused` | `"ref"` \| `"inline"` | `"inline"` | |
| `metadata` | `$ZodRegistry` | `z.globalRegistry` | schemas with an `id` become `$defs` |

**The `io` trap — verified.** For `z.object({ path: z.string(), limit: z.number().int().min(1).max(100).default(20), mode: z.enum(['fuzzy','exact']).optional(), tags: z.array(z.string()).default([]) })`:

```jsonc
// io: "output"  (THE DEFAULT — wrong for tool inputs)
"required": ["path", "limit", "tags"],  "additionalProperties": false

// io: "input"   (correct for tool inputs)
"required": ["path"]                    // note: no additionalProperties emitted
```

With the default, a caller omitting `limit` fails validation even though the schema supplies a default. **For any MCP `inputSchema`, use `io: "input"`.**

```ts
// canonical MCP tool input schema
const inputSchema = z.toJSONSchema(ArgsSchema, { io: 'input' });
```

`.describe()` maps to `description` on both properties and the root object. `.min`/`.max` on ints map to `minimum`/`maximum` with `type: "integer"`. `z.date()` under `unrepresentable: 'any'` becomes `{}`.

### 1b. `.default()` vs `.prefault()` — CONFIRMED, and the fix for `src/shared/settings.ts`

Exact signatures from `zod/v4/classic/schemas.d.cts` (lines 46-49):

```ts
default(def: util.NoUndefined<core.output<this>>): ZodDefault<this>;
default(def: () => util.NoUndefined<core.output<this>>): ZodDefault<this>;
prefault(def: core.input<this>): ZodPrefault<this>;
prefault(def: () => core.input<this>): ZodPrefault<this>;
```

- `.default(v)` — `v` must be the **OUTPUT** type. Used when input is `undefined`; the value **bypasses parsing**.
- `.prefault(v)` — `v` must be the **INPUT** type. It is substituted for `undefined` and then **run through the schema**, so nested `.default()`s fill in.

**`.prefault({})` is the correct v4 idiom for "input-side default".** Verified two ways:

- *Typecheck* (`tsc --strict`, zod path-mapped to the installed `index.d.cts`): `Inner.default({})` errors — a `@ts-expect-error` over it was **consumed**, i.e. TS really rejects it. `Inner.prefault({})` compiles clean.
- *Runtime*: `z.object({ root: z.string().default(''), inner: Inner.prefault({}) }).parse({})` → `{"root":"","inner":{"a":"x","b":3}}`.

`z.input<>` of the prefault version is `{}`-compatible, so `SettingsInput` keeps working.

#### Canonical settings pattern (apply this to `src/shared/settings.ts`)

Every leaf has a `.default(...)`, every nested object is attached with **`.prefault({})`**, and the whole thing parses from `{}`:

```ts
import { z } from 'zod';

export const EngineSettingsSchema = z.object({
  preferred: z.string().default('claude-code'),
  binaryPath: z.string().default(''),
  maxTurnsPerStep: z.number().int().positive().default(20),
});
export type EngineSettings = z.infer<typeof EngineSettingsSchema>;

export const SettingsSchema = z.object({
  workspaceRoot: z.string().default(''),
  engine: EngineSettingsSchema.prefault({}),        // <-- NOT .default({})
  ui: z
    .object({
      theme: z.enum(['system', 'light', 'dark']).default('system'),
      showCosts: z.boolean().default(true),
    })
    .prefault({}),                                   // <-- inline objects too
});

export type Settings = z.infer<typeof SettingsSchema>;
export type SettingsInput = z.input<typeof SettingsSchema>;
export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});
```

**Every `.default({})` in the current `src/shared/settings.ts` must become `.prefault({})`** — that is `engine`, `approvals`, `memory`, `schedule`, `ui`, `notifications`, `logging` (7 call sites). Leaf `.default(...)` calls with real scalar values are already correct; leave them alone.

Equally valid but more verbose alternative (also verified to compile and run): `EngineSettingsSchema.default(EngineSettingsSchema.parse({}))` — computes the output object eagerly. Prefer `.prefault({})`.

`.partial()` on these object schemas (used by `SettingsPatchSchema`) is unaffected and still works.

---

## 2. @modelcontextprotocol/sdk 1.30.0

Subpath exports are real (`./server`, `./client`, plus a `./*` wildcard). **Deep imports must include the `.js` extension** — they map through `"./*": { "import": "./dist/esm/*" }`.

```ts
import { McpServer }            from '@modelcontextprotocol/sdk/server/mcp.js';
import { Server }               from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client }               from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema,
         type CallToolResult }  from '@modelcontextprotocol/sdk/types.js';
import type { Transport, TransportSendOptions }
                                from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, MessageExtraInfo }
                                from '@modelcontextprotocol/sdk/types.js';
```

> `Server` carries an explicit `@deprecated Use McpServer instead for the high-level API. Only use Server for advanced use cases.` It is **not removed** and `setRequestHandler` works fine (verified end-to-end below). Use `McpServer` for new code unless you need raw handlers.

### 2a. `Transport` — the exact interface for the custom unix-socket transport

Verbatim from `dist/esm/shared/transport.d.ts`. **Three required methods, four optional properties.**

```ts
export interface Transport {
  start(): Promise<void>;
  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void>;
  close(): Promise<void>;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  sessionId?: string;
  setProtocolVersion?: (version: string) => void;
}

export type TransportSendOptions = {
  relatedRequestId?: RequestId;
  resumptionToken?: string;
  onresumptiontoken?: (token: string) => void;
};
```

Contract details that matter:

- `start()` — **do not call it yourself.** `Server.connect()` / `Client.connect()` install the callbacks and then call `start()`. Calling it early loses messages. Make it idempotent / throw if already started (that is what `StdioServerTransport` does via a `_started` flag).
- `close()` — **must invoke `this.onclose?.()`**, including when called explicitly. The docstring is explicit about this.
- `onerror` — non-fatal, out-of-band error reporting. Wire socket `'error'` events here.
- `onmessage` — the `extra` (`MessageExtraInfo`) arg is optional; a socket transport can omit it entirely.
- `sessionId` / `setProtocolVersion` are optional — safe to skip for a unix socket.

**Message framing: newline-delimited JSON (NDJSON), UTF-8. No Content-Length headers.** From `dist/esm/shared/stdio.js`:

```js
export function serializeMessage(message) { return JSON.stringify(message) + '\n'; }
export function deserializeMessage(line)  { return JSONRPCMessageSchema.parse(JSON.parse(line)); }
```

`ReadBuffer.readMessage()` splits on `'\n'` and strips a trailing `\r` (`line.replace(/\r$/, '')`), so CRLF is tolerated. Default max buffer is `STDIO_DEFAULT_MAX_BUFFER_SIZE = 10 * 1024 * 1024`; exceeding it clears the buffer and throws.

**Reuse the SDK's buffer instead of writing your own** — it is exported and framing-correct:

```ts
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
```

Skeleton for a unix-socket transport:

```ts
import type { Socket } from 'node:net';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export class UnixSocketTransport implements Transport {
  private _readBuffer = new ReadBuffer();
  private _started = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(private socket: Socket) {}

  async start(): Promise<void> {
    if (this._started) throw new Error('already started');
    this._started = true;
    this.socket.on('data', (chunk: Buffer) => {
      this._readBuffer.append(chunk);
      for (;;) {
        let msg: JSONRPCMessage | null;
        try { msg = this._readBuffer.readMessage(); }
        catch (e) { this.onerror?.(e as Error); return; }
        if (!msg) return;
        this.onmessage?.(msg);
      }
    });
    this.socket.on('error', (e) => this.onerror?.(e));
    this.socket.on('close', () => this.onclose?.());
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.write(serializeMessage(message), (err) => (err ? reject(err) : resolve()));
    });
  }

  async close(): Promise<void> {
    this._readBuffer.clear();
    this.socket.end();
    this.onclose?.();          // required, even on explicit close
  }
}
```

**Verified end-to-end.** A minimal custom transport implementing *only* `start`/`send`/`close` + `onmessage` (an in-memory pair, no framing) completed the full `initialize` handshake, `tools/list`, and `tools/call` against a real `Server` + `Client`. Output:

```
connected. serverCaps= {"tools":{}}
listTools: {"tools":[{"name":"echo","description":"echo back","inputSchema":{...}}]}
callTool ok:  {"content":[{"type":"text","text":"hello socket"}]}
callTool err: {"content":[{"type":"text","text":"unknown tool"}],"isError":true}
```

So: `onclose`/`onerror`/`sessionId`/`setProtocolVersion` are genuinely optional for a working transport.

### 2b. Server + `setRequestHandler` (low-level)

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const server = new Server(
  { name: 'assistant', version: '0.1.0' },     // Implementation
  { capabilities: { tools: {} } },             // ServerOptions — must declare tools
);

const ArgsSchema = z.object({ text: z.string(), loud: z.boolean().default(false) });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'echo',
    description: 'echo back',
    inputSchema: z.toJSONSchema(ArgsSchema, { io: 'input' }),   // io:'input' — see §1a
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  if (req.params.name !== 'echo') {
    return { content: [{ type: 'text', text: 'unknown tool' }], isError: true };
  }
  const args = ArgsSchema.parse(req.params.arguments ?? {});
  return { content: [{ type: 'text', text: args.text }] };
});

await server.connect(new StdioServerTransport());
```

Signature (`shared/protocol.d.ts:389`):

```ts
setRequestHandler<T extends AnyObjectSchema>(
  requestSchema: T,
  handler: (request: SchemaOutput<T>, extra: RequestHandlerExtra<...>) => SendResultT | Promise<SendResultT>
): void;
```

`extra` keys observed at runtime: `signal, sessionId, _meta, sendNotification, sendRequest, authInfo, requestId, requestInfo, taskId, taskStore, taskRequestedTtl, closeSSEStream, closeStandaloneSSEStream`. `extra.signal` is an `AbortSignal` — thread it into long-running work.

`ServerOptions` also accepts `instructions?: string` and `jsonSchemaValidator?` (defaults to Ajv).

### 2c. McpServer + `registerTool` (high-level, preferred)

Exact signature (`server/mcp.d.ts:150`):

```ts
registerTool<OutputArgs, InputArgs>(
  name: string,
  config: {
    title?: string;
    description?: string;
    inputSchema?: InputArgs;      // ZodRawShape (plain object of zod schemas) OR a schema
    outputSchema?: OutputArgs;
    annotations?: ToolAnnotations;
    _meta?: Record<string, unknown>;
  },
  cb: ToolCallback<InputArgs>,
): RegisteredTool;
```

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const mcp = new McpServer({ name: 'assistant', version: '0.1.0' });

mcp.registerTool(
  'memory_search',
  {
    title: 'Search memory',
    description: 'Full-text search the memory vault',
    inputSchema: { query: z.string(), limit: z.number().int().default(20) },  // RAW SHAPE, not z.object(...)
  },
  async ({ query, limit }, extra) => ({
    content: [{ type: 'text', text: `${limit} results for ${query}` }],
  }),
);

await mcp.connect(transport);
```

`inputSchema` here is a **raw shape** (`{ k: zodSchema }`), *not* `z.object({...})` — the SDK builds the JSON Schema for you. `mcp.server` exposes the underlying `Server` for notifications / custom handlers. `RegisteredTool` has `.enable() / .disable() / .update({...}) / .remove()` for dynamic tool sets.

### 2d. Tool result shape

```ts
type CallToolResult = {
  content?: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string } | ...>;
  structuredContent?: unknown;   // return this instead when outputSchema is set
  isError?: boolean;
  _meta?: Record<string, unknown>;
};
```

Errors are **in-band**: return `{ content: [{ type: 'text', text: msg }], isError: true }` rather than throwing, so the model can see the failure. Verified round-trip preserves `isError: true` exactly.

### 2e. Stdio transports

```ts
// server side — defaults to process.stdin/stdout
new StdioServerTransport(stdin?: Readable, stdout?: Writable, options?: { maxBufferSize?: number })

// client side — spawns a child process
new StdioClientTransport({
  command: 'claude',
  args: ['mcp', 'serve'],
  env?: Record<string, string>,   // omit -> getDefaultEnvironment() (safe-to-inherit allowlist)
  stderr?: IOType | Stream | number,   // default "inherit"; use 'pipe' to read transport.stderr
  cwd?: string,
  maxBufferSize?: number,              // default 10 MB
});
```

`StdioClientTransport` exposes `get stderr(): Stream | null` and `get pid(): number | null`. With `stderr: 'pipe'` the PassThrough is returned *immediately* so you can attach listeners before `start()` — useful for capturing early crash output.

**A stdio MCP server must never write anything but JSON-RPC to stdout.** Log to stderr or a file.

---

## 3. sql.js 1.14.1 — ⚠️ NO FTS5

### 🚨 FTS5 IS NOT COMPILED IN — VERIFIED EMPIRICALLY

Ran against the shipped `dist/sql-wasm.wasm`:

```
fts5: FAIL -> no such module: fts5
fts4: CREATE OK
fts3: CREATE OK
rtree FAIL: no such module: rtree
```

`PRAGMA compile_options` on the shipped build (SQLite **3.49.1**) contains `ENABLE_FTS3` and `ENABLE_FTS3_PARENTHESIS` — and **no `ENABLE_FTS5`, no `ENABLE_RTREE`**. Also note `OMIT_LOAD_EXTENSION` and `THREADSAFE=0`, so you cannot load an FTS5 extension at runtime either. `json1` **is** available (`json_extract` works).

**Recommendation: use FTS4 for memory search.** Verified working, including phrase matching, `snippet()`, `offsets()`, `matchinfo()`, and the `unicode61` and `porter` tokenizers:

```ts
db.run(`CREATE VIRTUAL TABLE mem USING fts4(path, body, tokenize=unicode61);`);
db.run('INSERT INTO mem(path, body) VALUES (?,?)', ['a.md', 'hello world memory search engine']);

db.exec(`SELECT path FROM mem WHERE mem MATCH 'memory';`);
// -> [{ columns:['path'], values:[['a.md']] }]

db.exec(`SELECT snippet(mem,'[',']','...') FROM mem WHERE mem MATCH 'memory';`);
// -> 'hello world [memory] search engine'
```

FTS4 vs FTS5 differences to plan for:
- **No `bm25()`.** Use `matchinfo(mem, 'pcx')` (returns a blob — decode it) and rank in JS, or rank by a simpler heuristic. FTS5's built-in `rank` column does not exist.
- `snippet()` argument order differs: FTS4 is `snippet(tbl, start, end, ellipsis)`; FTS5 is `snippet(tbl, colIdx, start, end, ellipsis, tokens)`.
- No `content=` external-content tables with FTS5 semantics, no `columnsize`/`detail=` options.
- FTS4 lacks the FTS5 query syntax extensions; stick to `AND`/`OR`/`NOT`/`NEAR`/phrases/prefix `*`.

Escalation options if FTS4 ranking proves insufficient:
1. `LIKE`/`instr` scan + JS-side scoring (fine at small vault sizes).
2. Swap `sql.js` for `better-sqlite3` (native, FTS5 included) — but that needs `electron-rebuild` and native ABI management.
3. Build a custom sql.js wasm with `-DSQLITE_ENABLE_FTS5`. Heavy.

### Init + wasm location

The `.wasm` lives at **`node_modules/sql.js/dist/sql-wasm.wasm`** (659,730 bytes). Siblings in the same dir: `sql-wasm-debug.wasm`, `sql-wasm-browser.wasm`, `sql-wasm-browser-debug.wasm`. The pure-JS asm.js fallbacks (`sql-asm.js`, no wasm needed) are also there.

`package.json` exports: `"."` → `browser: ./dist/sql-wasm-browser.js`, `default: ./dist/sql-wasm.js`; plus `"./dist/*"`.

```ts
import initSqlJs from 'sql.js';              // module is a function; `default` self-reference exists
import path from 'node:path';

const SQL = await initSqlJs({
  locateFile: (file: string) =>
    path.join(require.resolve('sql.js/package.json'), '..', 'dist', file),
});
```

`locateFile` receives the bare filename (`'sql-wasm.wasm'`) and must return a resolvable path/URL. Alternatives also supported by the emscripten glue: `wasmBinary` (pass the bytes directly — most robust inside an asar) and `instantiateWasm`.

For Electron packaging, `dist/sql-wasm.wasm` must be copied into the build output (or `asarUnpack`ed) — the current `build.files` (`dist`, `node_modules`, `package.json`) will include it inside the asar, so `wasmBinary` with an `fs.readFileSync` is the safer pattern than `locateFile`.

### Database / Statement API (types from `@types/sql.js@1.4.11`, installed; depends on `@types/emscripten`, also installed)

```ts
type SqlValue = number | string | Uint8Array | null;
type ParamsObject = Record<string, SqlValue>;
type BindParams = SqlValue[] | ParamsObject | null;
interface QueryExecResult { columns: string[]; values: SqlValue[][]; }
```

```ts
const db = new SQL.Database();                 // new empty db
const db2 = new SQL.Database(bytes);           // load from Uint8Array

db.run('CREATE TABLE t (a, b);');
db.run('INSERT INTO t VALUES (?,?)', ['x', 1]);        // returns Database (chainable)
const res: QueryExecResult[] = db.exec('SELECT * FROM t;');   // [] when no rows

const stmt = db.prepare('SELECT a, b FROM t WHERE a = $a');
stmt.bind({ $a: 'x' });                        // or stmt.bind(['x'])
while (stmt.step()) {
  const row = stmt.getAsObject();              // ParamsObject
}
stmt.free();                                   // ALWAYS free

const bytes: Uint8Array = db.export();         // serialize
db.getRowsModified();                          // rows changed by last INSERT/UPDATE/DELETE
db.close();
```

Verified: `export()` → `Uint8Array` (53,248 bytes for a small FTS4 db), and `new SQL.Database(bytes)` round-trips content intact including virtual tables.

---

## 4. cron-parser 5.7.0

**v5 export shape:** named export `CronExpressionParser` with a static `.parse()`. The v3/v4 `parseExpression()` free function is gone. (`export default` is also `CronExpressionParser` itself — verified `m.default === m.CronExpressionParser` is `true`.)

```ts
import { CronExpressionParser } from 'cron-parser';

const interval = CronExpressionParser.parse('*/15 9-17 * * 1-5', {
  tz: 'Asia/Kolkata',                     // IANA tz — the option is `tz`, NOT `timezone`
  currentDate: new Date(),                // anchor
  // endDate, startDate, strict, hashSeed also accepted
});

const next = interval.next();             // -> CronDate (NOT a JS Date)
next.toDate();                            // -> Date          e.g. 2026-08-07T03:30:00.000Z
next.toString();                          // -> 'Fri Aug 07 2026 03:30:00 GMT+0000 (...)'
interval.next().toDate();                 // advances the iterator each call
```

Other verified members: `hasNext()`, `prev()`, `reset()`, `take(n)` (iterable of `CronDate`), `stringify()` (round-trips the expression), `fields`.

Six-field (seconds) expressions work: `CronExpressionParser.parse('0 0 3 * * *')`.

**Invalid expressions throw a plain `Error`** (not a custom subclass) at `parse()` time — verified:

```
'not a cron'   -> Error: Invalid characters, got value: a
'99 * * * *'   -> Error: Constraint error, got value 99 expected range 0-59
```

So wrap in try/catch and surface `e.message`; there is no error `code` to switch on.

Other named exports: `CronDate`, `CronExpression`, `CronFieldCollection`, `CronFileParser`, `CronSecond/Minute/Hour/DayOfMonth/Month/DayOfWeek`, `CronField`.

---

## 5. chokidar 5.0.0

**Glob support was removed in v4 and is still gone in v5.** `watch('src/**/*.ts')` will not work — watch a directory and filter with `ignored`.

```ts
import { watch, type FSWatcher, type ChokidarOptions } from 'chokidar';

const w: FSWatcher = watch('/abs/path/to/memory', {
  ignored: (p, stats) => !!stats?.isFile() && !p.endsWith('.md'),  // function matcher
  ignoreInitial: true,
  persistent: true,
  awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  depth: undefined,
  followSymlinks: true,
  usePolling: false,
  cwd: undefined,
  atomic: true,
});
```

`watch(paths: string | string[], options?: ChokidarOptions): FSWatcher` — also available as `default.watch`.

`ignored` accepts `Matcher | Matcher[]` where
`Matcher = string | RegExp | ((val: string, stats?: Stats) => boolean) | { path: string; recursive?: boolean }`.
The function form receives `(path, stats?)` and is the replacement for globs.

**Event names** (from `handler.d.ts` `EVENTS`): `'all' | 'ready' | 'add' | 'change' | 'addDir' | 'unlink' | 'unlinkDir' | 'raw' | 'error'`.

```ts
w.on('add',    (path, stats) => {});
w.on('change', (path, stats) => {});
w.on('unlink', (path) => {});
w.on('all',    (event, path, stats) => {});
w.on('ready',  () => {});
w.on('error',  (err) => {});

w.add(paths);            // -> FSWatcher
w.unwatch(paths);        // -> FSWatcher
w.getWatched();          // -> Record<string, string[]>
await w.close();         // -> Promise<void>
```

`FSWatcher extends EventEmitter<FSWatcherEventMap>` — the event map is typed, so handler args are inferred.

⚠️ `engines.node: ">= 20.19.0"` (and its dep `readdirp@5.1.1` likewise). See §10.

---

## 6. lucide-react 1.30.0

Named imports, tree-shaken (`sideEffects: false`). Peer: `react ^16.5.1 || ^17 || ^18 || ^19` — fine with React 19.

```tsx
import { Search, Settings, ChevronRight, type LucideIcon } from 'lucide-react';

<Search size={16} strokeWidth={2} className="text-muted-foreground" />
```

Both the bare name and an `Icon`-suffixed alias are exported for every icon (`export { Search, Search as SearchIcon, ... }`) — pick one convention and stick to it; `Search` is the shorter form.

```ts
interface LucideProps extends RefAttributes<SVGSVGElement>, Partial<SVGProps<SVGSVGElement>> {
  size?: string | number;          // default 24
  absoluteStrokeWidth?: boolean;
}
type LucideIcon = ForwardRefExoticComponent<Omit<LucideProps, 'ref'> & RefAttributes<SVGSVGElement>>;
```

`color` and `strokeWidth` come from the SVG props (default `stroke="currentColor"`, `strokeWidth={2}`), so Tailwind text colors work directly.

Also exported: `createLucideIcon`, a generic `Icon` component, and type `IconNode`.

Use `LucideIcon` when passing icons as props:

```ts
type NavItem = { label: string; icon: LucideIcon };
```

Avoid `import * as Icons from 'lucide-react'` — it defeats tree-shaking across ~1600 icons.

---

## 7. @tanstack/react-virtual 3.14.9

```tsx
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual';
import { useRef } from 'react';

function RunList({ items }: { items: Run[] }) {
  const parentRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48,
    overscan: 8,
    // getItemKey: (i) => items[i].id,
  });

  return (
    <div ref={parentRef} className="h-full overflow-auto">
      <div style={{ height: rowVirtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
        {rowVirtualizer.getVirtualItems().map((v: VirtualItem) => (
          <div
            key={v.key}
            data-index={v.index}
            ref={rowVirtualizer.measureElement}     // omit for fixed-height rows
            style={{ position: 'absolute', top: 0, left: 0, width: '100%',
                     transform: `translateY(${v.start}px)` }}
          >
            {items[v.index].title}
          </div>
        ))}
      </div>
    </div>
  );
}
```

`VirtualItem = { key: Key; index: number; start: number; end: number; size: number; lane: number }`.

Required options: `count`, `getScrollElement`, `estimateSize`. Common optional: `overscan`, `getItemKey`, `measureElement`, `initialMeasurementsCache`, `scrollMargin`, `horizontal` (**UNVERIFIED** — not read out of `virtual-core`'s d.ts; check before use).

Instance methods confirmed present: `getVirtualItems()`, `getTotalSize()`, `measureElement(node)`, `scrollToIndex(index, { align, behavior })`, `getVirtualItemForOffset(offset)`, `takeSnapshot()`.

Also exported: `useWindowVirtualizer`, `Virtualizer`, `measureElement`, `elementScroll`, `defaultRangeExtractor`, `notUndefined`.

3.14.9 adds a React-specific `directDomUpdates?: boolean` + `directDomUpdatesMode?: 'position' | 'transform'` option (skips React re-renders on scroll) and a `virtualizer.containerRef` callback that goes with it. It has strict layout requirements documented in the d.ts — **don't enable it unless you read them**; the default path above is safe.

---

## 8. Claude Code CLI headless surface

Binary: `/home/kartikkhorwal/.bun/bin/claude` — version **2.1.224 (Claude Code)**.
(No `claude -p "<prompt>"` was executed; help output and argument-arity probes only.)

### Flags that matter for headless orchestration

| purpose | flag |
|---|---|
| non-interactive / print mode | `-p`, `--print` |
| output format | `--output-format <text\|json\|stream-json>` (only with `--print`) |
| input format | `--input-format <text\|stream-json>` (only with `--print`) |
| **verbose** | `--verbose` |
| partial/streaming deltas | `--include-partial-messages` (needs `--print` + `--output-format=stream-json`) |
| hook events in stream | `--include-hook-events` (needs `--output-format=stream-json`) |
| subagent text in stream | `--forward-subagent-text` (needs `--print` + `--output-format=stream-json`) |
| resume by id | `-r`, `--resume [sessionId]` |
| continue latest in cwd | `-c`, `--continue` |
| pin a session id | `--session-id <uuid>` |
| new id on resume | `--fork-session` |
| disable session persistence | `--no-session-persistence` (only with `--print`) |
| **max turns** | `--max-turns <turns>` — **exists but is NOT listed in `--help`** |
| cost ceiling | `--max-budget-usd <amount>` (only with `--print`) |
| model | `--model <model>` (alias `opus`/`sonnet`/`fable`, or full name) |
| fallback model | `--fallback-model <model[,model]>` (only with `--print`) |
| MCP config file | `--mcp-config <configs...>` (JSON **files or strings**, space-separated) |
| ignore all other MCP config | `--strict-mcp-config` |
| tool allowlist | `--allowedTools` / `--allowed-tools <tools...>` (comma or space separated, e.g. `"Bash(git *) Edit"`) |
| tool denylist | `--disallowedTools` / `--disallowed-tools <tools...>` |
| restrict built-in tool set | `--tools <tools...>` (`""` = none, `"default"` = all, or `"Bash,Edit,Read"`) |
| permission mode | `--permission-mode <acceptEdits\|auto\|bypassPermissions\|manual\|dontAsk\|plan>` |
| bypass all permissions | `--dangerously-skip-permissions` |
| allow bypass as an option | `--allow-dangerously-skip-permissions` |
| extra readable dirs | `--add-dir <directories...>` |
| system prompt | `--system-prompt <prompt>` / `--append-system-prompt <prompt>` |
| settings | `--settings <file-or-json>`, `--setting-sources <user,project,local>` |
| custom agents | `--agents <json>`, `--agent <agent>` |
| structured output | `--json-schema <schema>` |
| effort | `--effort <low\|medium\|high\|xhigh\|max>` |
| minimal/hermetic mode | `--bare` |

**`--max-turns` verification.** It is absent from `--help` but real — probing with a missing argument:

```
$ claude --max-turns
error: option '--max-turns <turns>' argument missing
```

(compare: an unknown option produces `unknown option`, not `argument missing`). Treat the arity as `<turns>` = one integer. Because it is undocumented in this build, **fail soft**: don't let a rejected `--max-turns` kill a run.

**`--verbose` is the flag referred to as "the verbose flag it requires."** In this build `--verbose` is described only as "Override verbose mode setting from config"; the historical `-p --output-format=stream-json` requirement to also pass `--verbose` is **UNVERIFIED for 2.1.224** — the help text does not state it. Pass `--verbose` alongside `stream-json` anyway; it is harmless.

Canonical headless invocation:

```bash
claude -p "<prompt>" \
  --output-format stream-json --verbose \
  --model sonnet \
  --max-turns 20 \
  --max-budget-usd 2 \
  --mcp-config /path/to/mcp.json --strict-mcp-config \
  --allowed-tools "Read Edit Bash(git *)" \
  --permission-mode acceptEdits \
  --session-id "$UUID"
```

Resume: `claude -p "<next>" --resume "$SESSION_ID" --output-format stream-json --verbose`.

### `claude mcp` subcommands (verbatim list)

`add`, `add-from-claude-desktop`, `add-json <name> <json>`, `get <name>`, `help`, `list`, `login <name>`, `logout <name>`, `remove <name>`, `reset-project-choices`, `serve`.

`claude mcp add` examples from its own help:

```bash
claude mcp add --transport http sentry https://mcp.sentry.dev/mcp
claude mcp add --transport http corridor https://app.corridor.dev/api/mcp --header "Authorization: Bearer ..."
claude mcp add my-server -e API_KEY=xxx -- npx my-mcp-server
claude mcp add my-server -- my-command --some-flag arg1
```

`claude mcp serve` runs Claude Code *itself* as an MCP server — useful as a `StdioClientTransport` target.

For our own server, prefer writing a config file and passing `--mcp-config <file> --strict-mcp-config` so the app never mutates the user's global MCP registry. The `.mcp.json` server-entry schema was not dumped here — **UNVERIFIED**; the standard `{ "mcpServers": { "<name>": { "command", "args", "env" } } }` shape is the safe assumption, confirmable with `claude mcp add-json --help`.

Other top-level commands present: `agents`, `auth`, `auto-mode`, `doctor`, `gateway`, `import`, `install`, `plugin`, `project`, `setup-token`, `ultrareview`, `update`.

---

## 9. codex

**ABSENT.** `which codex` → not found on PATH (with `~/.bun/bin` on PATH). Any codex engine adapter must detect-and-degrade, not assume presence.

---

## 10. Electron / Node version conflict — ACTION REQUIRED

Installed **electron 22.3.27**. Bundled Node: **v16.17.1** (extracted from the shipped binary: `node.js/v16.17.1`). Chromium 108-era.

| package | `engines.node` | satisfied by Node 16.17.1? |
|---|---|---|
| `@modelcontextprotocol/sdk@1.30.0` | `>=18` | ❌ |
| `cron-parser@5.7.0` | `>=18` | ❌ |
| `chokidar@5.0.0` | `>= 20.19.0` | ❌ |
| `readdirp@5.1.1` (chokidar dep) | `>= 20.19.0` | ❌ |
| `sql.js`, `zod`, `lucide-react`, `@tanstack/react-virtual` | none | ✅ |

**Three of the core main-process dependencies declare a Node floor above what Electron 22 ships.** These are declarations, not always hard runtime failures — but chokidar 5 / readdirp 5 requiring **20.19** specifically signals use of modern syntax and APIs, and the MCP SDK at 18+ assumes `fetch`, `AbortSignal`, and web-streams globals that Node 16 lacks or has only behind flags.

### Recommendation

**Upgrade to Electron 32 or newer; target Electron 33 (Node 20.18) at minimum, and prefer Electron 38+ (Node 22).**

Rationale — Electron→Node pairings (**UNVERIFIED**, from general release history, not read from this repo; confirm against the Electron releases page before pinning):

- Electron 28 → Node 18.x — clears the MCP SDK and cron-parser, **not** chokidar.
- Electron 31 → Node 20.14 — still below chokidar's 20.19.
- Electron 32/33 → Node 20.16 / 20.18 — **clears all four** (≥ 20.19 needs verification for 32; 33 is safe).
- Electron 38+ → Node 22.x — comfortable margin.

Concrete: **bump `devDependencies.electron` to `^33.0.0` or later.** Also worth noting the jump from 22 to 33 crosses many Chromium majors — expect renderer-side and `electron-builder` config churn, and re-check `@electron/rebuild` usage.

Interim workaround if the upgrade must be deferred: pin `chokidar@^3.6.0` (Node 8+, and it still has glob support) and keep MCP SDK / cron-parser on the newer versions while testing them against Node 16 — but this is a stopgap, not a fix.

---

## Appendix — verification method

- Versions and `engines` read directly from each `node_modules/<pkg>/package.json`.
- Signatures quoted from installed `.d.ts` / `.d.cts` files (paths cited inline).
- Executed with `bun` in a scratch dir: sql.js FTS3/4/5 + rtree + json1 probe and `PRAGMA compile_options`; sql.js prepare/bind/step/getAsObject/free/export round-trip; zod `toJSONSchema` across `io`/`target`/`unrepresentable` and full error-shape dump; cron-parser parse/next/take/stringify + two invalid-expression cases; MCP `Server`+`Client` end-to-end over a hand-written custom `Transport`.
- Typechecked with `bun x tsc --strict` (zod path-mapped to the installed `index.d.cts`) to prove `.default({})` fails and `.prefault({})` compiles.
- Electron's bundled Node read out of the shipped binary via `strings`.
- `claude` CLI: `--help`, `mcp --help`, `--version`, and zero-argument arity probes only. **No prompt was ever sent.**
