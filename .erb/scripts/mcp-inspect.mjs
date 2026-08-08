/* eslint-disable no-console */
/**
 * MCP inspector — the one place to see and test the app's internal MCP end to
 * end, without launching the whole desktop app.
 *
 * Run:  bun run mcp:inspect
 *
 * It boots the same backend the app boots (`bootstrap()`), which stands up the
 * real MCP socket server and registers every module's tools. Then it drives the
 * exact same path the chat/runs use — write a per-step `--mcp-config`, spawn the
 * `claude` CLI against it — and reports:
 *
 *   1. the MCP server: socket, tool count, connection status as the CLI sees it,
 *   2. every tool, grouped by module, with its description and input schema,
 *   3. an interactive picker (arrow keys) to inspect a tool or call it live.
 *
 * This is the ground truth for "is the internal MCP solid?". If a tool shows
 * here and the CLI reports `assistant: connected`, the plumbing works.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.chdir(ROOT);

// The app's modules are TypeScript; register ts-node so we can import them.
require('ts-node/register/transpile-only');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { bootstrap } = require('./src/main/bootstrap.ts');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { engineEnvOverrides } = require('./src/main/services/engines/environment.ts');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const prompts = require('prompts');

const CLAUDE =
  process.env.CLAUDE_CODE_EXECPATH?.replace(/\/[^/]*$/, '/claude') ??
  '/opt/homebrew/bin/claude';

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

/** Find a real `node` binary on PATH for the shim (not bun/electron). */
function findNode() {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const candidate = path.join(dir, 'node');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** Build the CLI env the same way the adapter does, with the dev loader stripped. */
function cliEnv(stepEnv) {
  const overrides = engineEnvOverrides({ allowApiKeyEnv: false, extra: stepEnv });
  const env = { ...process.env };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/** Run the CLI with an MCP config and return its stream-json `system` init. */
async function cliInit(configPath, env, cwd) {
  const args = [
    '--print',
    'ready',
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-turns',
    '1',
    '--permission-mode',
    'acceptEdits',
    '--mcp-config',
    configPath,
    '--strict-mcp-config',
  ];
  const child = spawn(CLAUDE, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  await new Promise((r) => {
    const t = setTimeout(() => {
      child.kill();
      r();
    }, 45000);
    child.on('exit', () => {
      clearTimeout(t);
      r();
    });
  });
  for (const line of out.split('\n')) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'system') return obj;
    } catch {
      /* not json */
    }
  }
  return null;
}

async function main() {
  console.log(c.bold('\n🔌 MCP inspector — booting the app backend…\n'));
  const services = await bootstrap();
  const { mcp, registry } = services;

  const cleanup = async () => {
    await services.shutdown().catch(() => {});
  };
  process.on('SIGINT', async () => {
    await cleanup();
    process.exit(0);
  });

  const tools = registry.tools();
  const status = mcp.status();

  // Register a scope with every tool and write the config, exactly like a run.
  const stepId = `inspect-${Date.now()}`;
  mcp.registerStep({ stepId, runId: 'inspect', allowedTools: tools.map((t) => t.name) });
  const written = await mcp.writeConfigForStep(stepId);
  const cwd = path.join(os.homedir(), '.assistant', 'claude-chats');
  fs.mkdirSync(cwd, { recursive: true });
  const env = cliEnv(mcp.stepEnv(stepId));

  // In the real app the shim runs through Electron-as-node. Under this script
  // `process.execPath` is bun/node, which the config would (wrongly) reuse as
  // the shim command. Point it at a real `node` + the built shim so the
  // inspector faithfully exercises the same connection the app makes.
  const nodeBin = findNode();
  if (nodeBin) {
    const cfg = JSON.parse(fs.readFileSync(written.path, 'utf8'));
    for (const server of Object.values(cfg.mcpServers)) {
      server.command = nodeBin;
      server.args = [path.join(ROOT, '.erb', 'dll', 'shim.js')];
      if (server.env) delete server.env.ELECTRON_RUN_AS_NODE;
    }
    fs.writeFileSync(written.path, JSON.stringify(cfg, null, 2));
  }

  console.log(c.bold('── MCP server ──'));
  console.log(`  socket        ${c.dim(status.socketPath ?? '(none)')}`);
  console.log(`  tools         ${c.cyan(String(tools.length))}`);
  console.log(`  config        ${c.dim(written.path)}`);
  console.log(`  probing the CLI connection…`);
  const init = await cliInit(written.path, env, cwd);
  const server = (init?.mcp_servers ?? []).find((s) => s.name === 'assistant');
  const connected = server?.status === 'connected';
  console.log(
    `  CLI sees      ${connected ? c.green('assistant: connected ✓') : c.red(`assistant: ${server?.status ?? 'not reported'} ✗`)}`,
  );
  const mcpToolsSeen = (init?.tools ?? []).filter((t) => t.startsWith('mcp__assistant__'));
  console.log(`  tools loaded  ${c.cyan(String(mcpToolsSeen.length))} of ${tools.length}\n`);

  // Group tools by module prefix (first segment of the name).
  const byGroup = new Map();
  for (const tool of tools) {
    const group = tool.name.split('_')[0];
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push(tool);
  }

  console.log(c.bold('── Tools by module ──'));
  for (const [group, list] of [...byGroup.entries()].sort()) {
    console.log(`  ${c.yellow(group)} ${c.dim(`(${list.length})`)}`);
  }
  console.log('');

  // Interactive loop: pick a tool, inspect its schema, optionally call it.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { toolName } = await prompts(
      {
        type: 'autocomplete',
        name: 'toolName',
        message: 'Inspect a tool (type to filter, ↑↓ to navigate, Esc to quit)',
        choices: [
          { title: '⏻  quit', value: '__quit__' },
          ...tools.map((t) => ({
            title: t.name,
            description: t.description?.slice(0, 60),
            value: t.name,
          })),
        ],
      },
      { onCancel: () => ({ toolName: '__quit__' }) },
    );

    if (!toolName || toolName === '__quit__') break;

    const tool = tools.find((t) => t.name === toolName);
    console.log(`\n${c.bold(c.cyan(tool.name))}`);
    console.log(`  ${tool.description ?? ''}`);
    console.log(
      `  side-effecting: ${tool.sideEffecting ? c.yellow('yes (needs approval)') : c.green('no')}`,
    );
    const seen = mcpToolsSeen.includes(`mcp__assistant__${tool.name}`);
    console.log(`  visible to CLI: ${seen ? c.green('yes ✓') : c.red('no ✗')}`);
    console.log(c.dim('  input schema:'));
    console.log(
      JSON.stringify(tool.inputSchema, null, 2)
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n'),
    );

    const { action } = await prompts({
      type: 'select',
      name: 'action',
      message: 'Then?',
      choices: [
        { title: 'Back to list', value: 'back' },
        { title: 'Call it now (via registry, with JSON args)', value: 'call' },
      ],
    });

    if (action === 'call') {
      const { argsJson } = await prompts({
        type: 'text',
        name: 'argsJson',
        message: 'Arguments as JSON',
        initial: '{}',
      });
      try {
        const parsed = JSON.parse(argsJson || '{}');
        const result = await registry.invokeTool(tool.name, parsed);
        console.log(c.green('\n  result:'));
        console.log(
          JSON.stringify(result, null, 2)
            .split('\n')
            .map((l) => `    ${l}`)
            .join('\n'),
        );
      } catch (error) {
        console.log(c.red(`  error: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
    console.log('');
  }

  await written.cleanup().catch(() => {});
  mcp.revokeStep(stepId);
  await cleanup();
  console.log(c.dim('\nbye.\n'));
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
