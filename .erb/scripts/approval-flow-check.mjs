/* eslint-disable no-console */
/**
 * Approval-flow check — proves the in-chat approval mechanism end to end,
 * against the REAL MCP socket server and the REAL approval gate, without
 * launching the desktop app or the `claude` CLI.
 *
 * Run:  bun run approval:check
 *
 * It boots the app backend (`bootstrap()`), then connects to the MCP socket the
 * exact way the shim does — handshake frame, then MCP JSON-RPC over the unix
 * socket — as an MCP client. It registers an INTERACTIVE step (like chat), calls
 * a side-effecting tool, and asserts the whole behaviour the rework promises:
 *
 *   1. an interactive tool call BLOCKS (does not return a "pending" handle) and
 *      fires `approval:requested`; resolving it "allow once" lets the SAME call
 *      complete and return the tool's real result;
 *   2. "deny" makes the held call return an error, not a hang;
 *   3. "always allow" on a tool means a LATER call with DIFFERENT arguments runs
 *      with no new approval prompt — approval is per tool, not per argument;
 *   4. a NON-interactive step still returns the "pending_approval" handle
 *      immediately (runs must never block on a human).
 *
 * Exit code is non-zero if any assertion fails, so this is CI-able.
 */
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.chdir(ROOT);
require('ts-node/register/transpile-only');

const { bootstrap } = require('./src/main/bootstrap.ts');
const { getApprovalGate } = require('./src/main/modules/approvals/index.ts');
const { UnixSocketTransport } = require('./src/main/services/mcp/transport.ts');
const { appEvents } = require('./src/main/infra/events.ts');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

let failures = 0;
function assert(ok, label, detail) {
  if (ok) {
    console.log(`  ${c.green('✓')} ${label}`);
  } else {
    failures += 1;
    console.log(`  ${c.red('✗')} ${label}${detail ? c.dim(`\n      ${detail}`) : ''}`);
  }
}

/** Connect to the MCP socket exactly as the shim does, return an MCP Client. */
async function connectClient(mcp, stepId) {
  const status = mcp.status();
  const env = mcp.stepEnv(stepId); // ASSISTANT_MCP_SOCKET / _TOKEN / _STEP_ID
  const socketPath = env.ASSISTANT_MCP_SOCKET ?? status.socketPath;
  const token = env.ASSISTANT_MCP_TOKEN;

  const socket = await new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath, () => resolve(s));
    s.once('error', reject);
  });
  // Handshake: one line of newline-delimited JSON, then MCP framing.
  socket.write(`${JSON.stringify({ v: 1, stepId, token })}\n`);

  // The server replies with a one-line ACK before switching to MCP framing.
  // The real shim reads and discards that line; if we hand the raw socket to
  // the MCP transport it treats the ACK as a JSON-RPC frame and desyncs. So
  // consume exactly the ACK line here, keeping any bytes that followed it.
  const leftover = await new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl === -1) return;
      socket.off('data', onData);
      resolve(buf.subarray(nl + 1));
    };
    socket.on('data', onData);
  });

  const transport = new UnixSocketTransport(socket, {
    initialData: leftover.length > 0 ? leftover : undefined,
  });
  const client = new Client({ name: 'approval-check', version: '0.0.0' });
  await client.connect(transport);
  return { client, socket };
}

/**
 * Call options for an interactive tool call. Passing `onprogress` makes the SDK
 * attach a `progressToken` to the request, which is what lets the server's
 * heartbeat reach us; `resetTimeoutOnProgress` makes each heartbeat push the
 * deadline out. This mirrors what a well-behaved MCP client (and the CLI, when
 * it opts in) must do for a long human-approval wait to survive. The generous
 * `timeout` is the fallback ceiling if no progress arrived.
 */
const CALL_OPTS = {
  onprogress: () => {},
  resetTimeoutOnProgress: true,
  timeout: 30_000,
};

/** The tool result's text payload as a string. */
function resultText(result) {
  const block = (result?.content ?? []).find((b) => b.type === 'text');
  return block?.text ?? '';
}

async function main() {
  console.log(c.bold('\n🔐 Approval-flow check — booting backend…\n'));
  const services = await bootstrap();
  const { mcp, registry } = services;
  const gate = getApprovalGate();

  // Pick a real side-effecting tool the gate will stop on. `memory_write` is a
  // built-in write; fall back to any side-effecting tool if it is renamed.
  const tools = registry.tools();
  const sideEffecting =
    tools.find((t) => t.name === 'memory_store') ??
    tools.find((t) => t.sideEffecting);
  if (!sideEffecting) {
    console.log(c.red('No side-effecting tool found; cannot test approvals.'));
    await services.shutdown();
    process.exit(1);
  }
  const toolName = sideEffecting.name;
  // Over the raw MCP protocol the server exposes tools by their BARE name; the
  // `mcp__assistant__` prefix is added by the CLI on its side, not on the wire.
  // A direct MCP client (this script) calls the bare name.
  const mcpName = toolName;
  console.log(`  using side-effecting tool: ${c.cyan(toolName)}\n`);

  // Make the gate actually require approval for this run of the check.
  gate.applySettings?.({
    ...gate.settings?.(),
    requireForSideEffecting: true,
    allowAlwaysScope: true,
  });

  // Clean slate: the gate's grants persist in the workspace DB, so a prior run
  // (or a real use of this tool) could leave a standing "always" grant that
  // would auto-allow and hide the approval prompt. Revoke any grant on our test
  // tool before starting.
  for (const grant of gate.listGrants({ toolName, includeInactive: false })) {
    gate.revokeGrant(grant.id);
  }

  /* ---- 1. interactive call BLOCKS, then completes on approve ---- */
  console.log(c.bold('1) Interactive call waits for approval, then continues'));
  const runId = 'chat:approval-check';
  const stepId = `chat-approval-check-${Date.now()}`;
  mcp.registerStep({
    stepId,
    runId,
    allowedTools: tools.map((t) => t.name),
    interactive: true,
  });
  const { client, socket } = await connectClient(mcp, stepId);

  // Watch for the approval to be requested; when it is, approve it "once".
  let requestedId = null;
  let returnedBeforeApproval = false;
  const onRequested = ({ approval }) => {
    if (approval.toolName !== toolName) return;
    requestedId = approval.id;
    // Give the call a beat to prove it is still open, then approve.
    setTimeout(() => {
      gate.resolve({ approvalId: approval.id, decision: 'approve', scope: 'once' });
    }, 300);
  };
  appEvents.on('approval:requested', onRequested);

  const args1 = { path: 'approval-check/one.md', content: 'first' };
  const callPromise = client
    .callTool({ name: mcpName, arguments: args1 }, undefined, CALL_OPTS)
    .then((r) => ({ r }))
    .catch((e) => ({ e }));

  // If the call resolves before the approval fires, it did NOT block.
  const raced = await Promise.race([
    callPromise.then(() => 'call'),
    new Promise((res) => setTimeout(() => res('waited'), 200)),
  ]);
  returnedBeforeApproval = raced === 'call' && requestedId === null;

  const { r: result1, e: error1 } = await callPromise;
  appEvents.off('approval:requested', onRequested);

  assert(requestedId !== null, 'approval:requested fired for the tool call');
  assert(!returnedBeforeApproval, 'the call blocked (did not return a pending handle)');
  const text1 = result1 ? resultText(result1) : '';
  assert(
    Boolean(result1) && !result1.isError && !/pending_approval/.test(text1),
    'after approve, the SAME call returned a real result (not pending)',
    error1 ? String(error1) : text1.slice(0, 120),
  );

  /* ---- 2. deny makes the held call return an error ---- */
  console.log(c.bold('\n2) Deny makes the held call fail cleanly'));
  let denyId = null;
  const onDeny = ({ approval }) => {
    if (approval.toolName !== toolName) return;
    denyId = approval.id;
    setTimeout(() => {
      gate.resolve({ approvalId: approval.id, decision: 'deny', scope: 'once' });
    }, 200);
  };
  appEvents.on('approval:requested', onDeny);
  const denyRes = await client
    .callTool(
      { name: mcpName, arguments: { path: 'approval-check/deny.md', content: 'x' } },
      undefined,
      CALL_OPTS,
    )
    .then((r) => ({ r }))
    .catch((e) => ({ e }));
  appEvents.off('approval:requested', onDeny);
  const denyText = denyRes.r ? resultText(denyRes.r) : String(denyRes.e ?? '');
  assert(denyId !== null, 'approval:requested fired for the denied call');
  assert(
    /(denied|declined)/i.test(denyText) || denyRes.r?.isError === true,
    'denied call returned an error to the agent (did not hang)',
    denyText.slice(0, 120),
  );

  /* ---- 3. "always allow" is per-tool: a later call w/ different args runs ---- */
  console.log(c.bold('\n3) "Always allow" covers later calls with different args'));
  let alwaysAsks = 0;
  const onAlways = ({ approval }) => {
    if (approval.toolName !== toolName) return;
    alwaysAsks += 1;
    setTimeout(() => {
      gate.resolve({ approvalId: approval.id, decision: 'approve', scope: 'always' });
    }, 150);
  };
  appEvents.on('approval:requested', onAlways);
  const alwaysFirst = await client
    .callTool(
      { name: mcpName, arguments: { path: 'approval-check/always-A.md', content: 'A' } },
      undefined,
      CALL_OPTS,
    )
    .then((r) => ({ r }))
    .catch((e) => ({ e }));
  appEvents.off('approval:requested', onAlways);
  assert(alwaysAsks === 1, 'first call prompted once and was granted "always"');
  assert(
    Boolean(alwaysFirst.r) && !alwaysFirst.r.isError,
    'first "always" call succeeded',
  );

  // Second call: DIFFERENT args. Must NOT prompt again.
  let promptedAgain = false;
  const onSecond = ({ approval }) => {
    if (approval.toolName === toolName) promptedAgain = true;
  };
  appEvents.on('approval:requested', onSecond);
  const alwaysSecond = await client
    .callTool(
      {
        name: mcpName,
        // Different path AND content — a per-argument grant would re-ask.
        arguments: {
          path: 'approval-check/always-B-different.md',
          content: 'B totally different',
        },
      },
      undefined,
      CALL_OPTS,
    )
    .then((r) => ({ r }))
    .catch((e) => ({ e }));
  // Give any stray approval a moment to surface.
  await new Promise((res) => setTimeout(res, 200));
  appEvents.off('approval:requested', onSecond);
  assert(
    !promptedAgain,
    'a later call with DIFFERENT args did NOT re-prompt (per-tool, not per-arg)',
  );
  assert(
    Boolean(alwaysSecond.r) && !alwaysSecond.r.isError,
    'the second call ran under the standing grant',
  );

  await client.close().catch(() => {});
  socket.destroy();
  mcp.revokeStep(stepId);

  // Test 3 left a standing "always" grant on this tool. Revoke it so test 4
  // actually reaches the gate rather than being auto-allowed by the grant.
  for (const grant of gate.listGrants({ toolName })) {
    gate.revokeGrant(grant.id);
  }

  /* ---- 4. non-interactive step returns pending immediately (runs) ---- */
  console.log(c.bold('\n4) Non-interactive (run) call returns a pending handle immediately'));
  const runStep = `run-approval-check-${Date.now()}`;
  mcp.registerStep({
    stepId: runStep,
    runId: 'run-approval-check',
    allowedTools: tools.map((t) => t.name),
    interactive: false,
  });
  const runClient = await connectClient(mcp, runStep);
  let runPromptFired = false;
  const onRun = ({ approval }) => {
    if (approval.toolName === toolName) runPromptFired = true;
  };
  appEvents.on('approval:requested', onRun);
  const runRes = await runClient.client
    .callTool({ name: mcpName, arguments: { path: 'approval-check/run.md', content: 'r' } })
    .then((r) => ({ r }))
    .catch((e) => ({ e }));
  appEvents.off('approval:requested', onRun);
  const runText = runRes.r ? resultText(runRes.r) : String(runRes.e ?? '');
  assert(runPromptFired, 'run call still creates an approval');
  assert(
    /pending_approval/.test(runText),
    'run call returned the pending handle immediately (did NOT block)',
    runText.slice(0, 120),
  );
  await runClient.client.close().catch(() => {});
  runClient.socket.destroy();
  mcp.revokeStep(runStep);

  /* ---- done ---- */
  console.log('');
  if (failures === 0) {
    console.log(c.green(c.bold('All approval-flow checks passed ✓\n')));
  } else {
    console.log(c.red(c.bold(`${failures} check(s) failed ✗\n`)));
  }
  await services.shutdown().catch(() => {});
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(c.red(`\n${error?.stack ?? error}`));
  process.exit(1);
});
