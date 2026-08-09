/**
 * An OpenAI-compatible LLM shim, backed by the Claude Code CLI.
 *
 * supermemory's self-hosted server needs a model provider for its fact-extraction
 * pipeline — it speaks the OpenAI `/v1/chat/completions` protocol. Rather than
 * ask the user for a cloud key, we stand up this tiny local endpoint and answer
 * every request with `claude -p` (headless print mode, no chat, no UI). The
 * server thinks it is talking to OpenAI; behind the socket it is the Claude Code
 * the user already runs. No external key, and the memory text never leaves the
 * machine except to the same Claude the chat already uses.
 *
 * The one hard part is function-calling. supermemory's "memory agent" is an
 * agentic loop: it sends the document plus a set of `tools` (searchMemories,
 * CreateMemory, forgetMemory, …) and expects OpenAI `tool_calls` back, executes
 * them, and loops. So this shim cannot be a prompt passthrough — it flattens the
 * whole conversation + tool schemas into one instruction, tells Claude to reply
 * with a strict JSON envelope, and translates that envelope back into the OpenAI
 * `tool_calls` / message shape. Verified end to end against server v0.0.7-rc.2:
 * facts are extracted and a contradiction ("pizza" → "burgers") supersedes via
 * a CreateMemory with an `updates` parent relation.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { runProcess, whichSync } from '../../infra/spawn';
import { childEnvOverrides, CLAUDE_BINARY } from './env';
import type { Logger } from '../../infra/logger';

/** Haiku is fast and cheap; fact extraction does not need a frontier model. */
export const DEFAULT_SHIM_MODEL = 'claude-haiku-4-5-20251001';

export interface LlmShimOptions {
  logger: Logger;
  /** Claude model for extraction. Defaults to {@link DEFAULT_SHIM_MODEL}. */
  model?: string;
  /** Fixed port, or 0 to let the OS choose (then read {@link LlmShim.port}). */
  port?: number;
  /** Per-call ceiling for the `claude` subprocess. Default 90s. */
  callTimeoutMs?: number;
}

export interface LlmShim {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** The port it is listening on. Valid after `start()`. */
  readonly port: number;
  /** Base URL the server should be pointed at, e.g. `http://127.0.0.1:PORT/v1`. */
  readonly baseUrl: string;
}

/* ------------------------------------------------------------------ */
/* OpenAI <-> Claude translation                                       */
/* ------------------------------------------------------------------ */

interface OpenAiMessage {
  role: string;
  content?: unknown;
  tool_calls?: {
    id?: string;
    function?: { name?: string; arguments?: string };
  }[];
  tool_call_id?: string;
  name?: string;
}

interface OpenAiTool {
  function?: { name?: string; description?: string; parameters?: unknown };
  name?: string;
  description?: string;
  parameters?: unknown;
}

interface ChatRequest {
  messages?: OpenAiMessage[];
  tools?: OpenAiTool[];
  response_format?: unknown;
}

/** The JSON envelope we ask Claude to return. */
interface ClaudeEnvelope {
  tool_calls?: { name: string; arguments?: Record<string, unknown> }[];
  content?: unknown;
}

/** Flatten an OpenAI chat request into one instruction prompt for `claude -p`. */
export function buildPrompt(body: ChatRequest): string {
  const messages = body.messages ?? [];
  const tools = body.tools ?? [];
  const lines: string[] = [];

  lines.push(
    'You are the backend of an OpenAI-compatible API. Read the conversation ' +
      'below and respond by emitting exactly ONE JSON object and nothing else — ' +
      'no prose, no explanation, no markdown code fences.',
  );

  if (tools.length > 0) {
    lines.push(
      '\nYou may call these functions (name → JSON Schema of params):',
    );
    for (const tool of tools) {
      const fn = tool.function ?? tool;
      lines.push(
        `- ${fn.name}: ${fn.description ?? ''}\n  params: ${JSON.stringify(
          fn.parameters ?? {},
        )}`,
      );
    }
    lines.push(
      '\nTo CALL one or more functions, reply exactly:\n' +
        '{"tool_calls":[{"name":"<fn>","arguments":{ ... }}]}\n' +
        'You may include several calls in the array. Follow each function’s ' +
        'schema exactly.',
    );
    lines.push(
      'When you have no more calls to make and are finished, reply:\n' +
        '{"content":"<a short final message>"}',
    );
  } else if (body.response_format) {
    lines.push(
      '\nReply with a single JSON object that satisfies the requested output ' +
        'format described in the conversation. Wrap it as {"content": <object>} ' +
        'where <object> is that JSON object.',
    );
  } else {
    lines.push('\nReply as {"content":"<your answer>"}.');
  }

  lines.push('\n--- CONVERSATION ---');
  for (const message of messages) {
    if (message.role === 'tool') {
      const label = message.tool_call_id ?? message.name ?? 'result';
      lines.push(`[tool result ${label}]: ${stringify(message.content)}`);
    } else if (message.role === 'assistant' && message.tool_calls) {
      const calls = message.tool_calls.map((call) => ({
        name: call.function?.name,
        arguments: safeParse(call.function?.arguments),
      }));
      lines.push(`[assistant called]: ${JSON.stringify(calls)}`);
    } else {
      lines.push(`[${message.role}]: ${stringify(message.content)}`);
    }
  }
  return lines.join('\n');
}

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}

function safeParse(text: string | undefined): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Pull the JSON envelope out of Claude's reply. Claude sometimes wraps JSON in a
 * ```json fence or adds a stray sentence; we take the outermost `{...}`.
 */
export function extractEnvelope(text: string): ClaudeEnvelope {
  let trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) trimmed = fence[1].trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    // No JSON at all — treat the whole reply as the final content.
    return { content: text };
  }
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as ClaudeEnvelope;
  } catch {
    return { content: text };
  }
}

let responseCounter = 0;

/** Translate a Claude envelope into an OpenAI chat.completion response. */
export function toOpenAiResponse(envelope: ClaudeEnvelope): unknown {
  responseCounter += 1;
  const id = `chatcmpl-shim-${responseCounter}`;
  const base = {
    id,
    object: 'chat.completion',
    created: Math.floor(responseCounter),
    model: 'gpt-4o-mini',
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };

  if (Array.isArray(envelope.tool_calls) && envelope.tool_calls.length > 0) {
    return {
      ...base,
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: envelope.tool_calls.map((call, i) => ({
              id: `call_${id}_${i}`,
              type: 'function',
              function: {
                name: call.name,
                arguments: JSON.stringify(call.arguments ?? {}),
              },
            })),
          },
        },
      ],
    };
  }

  let content = envelope.content;
  if (content !== undefined && typeof content !== 'string') {
    content = JSON.stringify(content);
  }
  return {
    ...base,
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: content ?? '' },
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* The server                                                          */
/* ------------------------------------------------------------------ */

export function createLlmShim(options: LlmShimOptions): LlmShim {
  const { logger } = options;
  const model = options.model ?? DEFAULT_SHIM_MODEL;
  const callTimeoutMs = options.callTimeoutMs ?? 90_000;
  let server: http.Server | null = null;
  let boundPort = options.port ?? 0;

  /** Ask Claude and return its raw text (the `result` of the JSON envelope). */
  const askClaude = async (prompt: string): Promise<string> => {
    const bin = whichSync(CLAUDE_BINARY);
    if (!bin) throw new Error('claude CLI not found on PATH');
    const result = await runProcess(
      bin,
      ['-p', prompt, '--model', model, '--output-format', 'json'],
      {
        // Strip the app's dev loader (NODE_OPTIONS/ts-node) so the CLI runs
        // clean, exactly as the engine adapter does. No API key env needed —
        // the user's own Claude auth is used.
        env: childEnvOverrides({ allowApiKeyEnv: false }),
        timeoutMs: callTimeoutMs,
        label: 'supermemory-llm-shim',
      },
    );
    if (result.code !== 0) {
      throw new Error(
        `claude exited ${result.code}: ${result.stderrTail.slice(-200)}`,
      );
    }
    try {
      const parsed = JSON.parse(result.stdout) as { result?: string };
      return parsed.result ?? '';
    } catch {
      throw new Error(
        `unparseable claude output: ${result.stdout.slice(0, 200)}`,
      );
    }
  };

  const handle = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> => {
    const url = req.url ?? '';

    // Minimal /v1/models so a client that probes it is satisfied.
    if (url.endsWith('/models') || url.endsWith('/models/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'gpt-4o-mini', object: 'model' }],
        }),
      );
      return;
    }

    if (!url.includes('chat/completions')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }

    const body = await readBody(req);
    let parsed: ChatRequest;
    try {
      parsed = JSON.parse(body || '{}') as ChatRequest;
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid JSON body' } }));
      return;
    }

    try {
      const raw = await askClaude(buildPrompt(parsed));
      const envelope = extractEnvelope(raw);
      const response = toOpenAiResponse(envelope);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      logger.warn('llm shim call failed', { message });
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message } }));
    }
  };

  return {
    get port() {
      return boundPort;
    },
    get baseUrl() {
      return `http://127.0.0.1:${boundPort}/v1`;
    },

    async start() {
      if (server) return;
      server = http.createServer((req, res) => {
        void handle(req, res).catch((cause) => {
          logger.error('llm shim handler crashed', {
            error: cause instanceof Error ? cause.message : String(cause),
          });
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      });
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => reject(err);
        server!.once('error', onError);
        // Bind to loopback only — this endpoint must never be reachable off-box.
        server!.listen(options.port ?? 0, '127.0.0.1', () => {
          server!.off('error', onError);
          boundPort = (server!.address() as AddressInfo).port;
          logger.info('llm shim listening', { port: boundPort, model });
          resolve();
        });
      });
    },

    async stop() {
      if (!server) return;
      await new Promise<void>((resolve) => {
        server!.close(() => resolve());
      });
      server = null;
    },
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(data));
  });
}
