/* eslint-disable no-console */
/**
 * Memory engine check — proves the supermemory + Claude-Code-shim pipeline works
 * end to end using the app's REAL module code, no external key, no desktop app.
 *
 * Run:  bun run memory:check
 *
 * It builds the actual LLM shim, supervisor, and client the app ships, starts a
 * local supermemory server pointed at the shim (Claude Code does the extraction),
 * then:
 *   1. adds "I love pizza…", asserts atomic memories get created;
 *   2. adds a contradiction ("burgers, not pizza"), asserts the pizza preference
 *      is superseded (a memory with version > 1), not just duplicated.
 *
 * First run downloads the server binary (~200MB) + the local embedding model
 * (~106MB); later runs reuse them. Requires the `claude` CLI on PATH and `npx`
 * for the one-time server install.
 */
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
process.chdir(ROOT);
require('ts-node/register/transpile-only');

const { createLlmShim } = require('./src/main/modules/supermemory/shim.ts');
const {
  createSupervisor,
} = require('./src/main/modules/supermemory/supervisor.ts');
const {
  createSupermemoryClient,
} = require('./src/main/modules/supermemory/client.ts');
const { killAllTracked } = require('./src/main/infra/spawn.ts');

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

// A quiet logger so the pipeline's internals don't drown the check output.
const logger = {
  info: (m, x) => console.log(c.dim(`  · ${m} ${x ? JSON.stringify(x) : ''}`)),
  warn: (m, x) => console.log(c.dim(`  ! ${m} ${x ? JSON.stringify(x) : ''}`)),
  error: (m, x) => console.log(c.red(`  ✗ ${m} ${x ? JSON.stringify(x) : ''}`)),
  debug: () => {},
  child() {
    return logger;
  },
};

let failures = 0;
function assert(ok, label, detail) {
  if (ok) console.log(`  ${c.green('✓')} ${label}`);
  else {
    failures += 1;
    console.log(
      `  ${c.red('✗')} ${label}${detail ? c.dim(`\n      ${detail}`) : ''}`,
    );
  }
}

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Poll until at least `min` memories match `query`, or timeout. Extraction is
 * async (~15-20s per document via the Claude shim), so this is generous.
 */
async function waitForMemories(client, query, min, timeoutMs) {
  const until = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < until) {
    // eslint-disable-next-line no-await-in-loop
    last = await client.search(query, { limit: 25 }).catch(() => []);
    if (last.length >= min) return last;
    // eslint-disable-next-line no-await-in-loop
    await sleep(4000);
  }
  return last;
}

/** Every memory in the container, via a broad query. */
async function allMemories(client) {
  // A broad, common query surfaces the whole small set in these tests.
  const queries = [
    'user',
    'food',
    'name',
    'city',
    'preference',
    'pizza',
    'burger',
  ];
  const byId = new Map();
  for (const q of queries) {
    // eslint-disable-next-line no-await-in-loop
    const hits = await client.search(q, { limit: 50 }).catch(() => []);
    for (const h of hits) if (h.id) byId.set(h.id, h);
  }
  return [...byId.values()];
}

async function main() {
  console.log(c.bold('\n🧠 Memory engine check\n'));

  const shim = createLlmShim({ logger });
  await shim.start();
  console.log(`  shim: ${c.cyan(shim.baseUrl)}`);

  // Use an isolated data dir so the check is repeatable and never touches a
  // user's real memories.
  const dataDir = path.join(os.tmpdir(), 'supermemory-check-data');
  const supervisor = createSupervisor({
    logger,
    llmBaseUrl: shim.baseUrl,
    dataDir,
  });

  console.log('  starting server (first run downloads binary + model)…');
  await supervisor.start();
  if (!supervisor.ready) {
    console.log(c.red('\n  server never became healthy — cannot test.\n'));
    await shim.stop();
    await killAllTracked().catch(() => {});
    process.exit(1);
  }
  console.log(`  server: ${c.green(supervisor.url)} ${c.dim('(ready)')}\n`);

  const client = createSupermemoryClient({ baseUrl: supervisor.url, logger });

  /* ---- 1. create memories from a statement ---- */
  console.log(c.bold('1) Atomic memory creation'));
  await client.add(
    'I love pizza, especially pepperoni. My name is Kartik and I live in Bangalore.',
  );
  const created = await waitForMemories(client, 'pizza name city', 1, 120_000);
  assert(
    created.length >= 1,
    `extracted ${created.length} memories from one statement`,
  );
  for (const hit of created.slice(0, 6)) {
    console.log(`      ${c.dim('•')} ${hit.memory}`);
  }

  /* ---- 2. contradiction supersedes ---- */
  console.log(c.bold('\n2) Contradiction supersedes (pizza → burgers)'));
  await client.add(
    'Actually I changed my mind — I love burgers now, not pizza. Pizza is not my favorite anymore.',
  );
  // Wait for the burger memory to appear, then read the whole set.
  await waitForMemories(client, 'burger favorite food', 1, 120_000);
  await sleep(4000);
  const after = await allMemories(client);
  const mentionsBurger = after.some((h) => /burger/i.test(h.memory));
  const superseded = after.some((h) => (h.version ?? 1) > 1);
  // A stale memory would assert pizza is *still* the favorite. The superseding
  // memory ("favorite is now burgers, not pizza") mentions pizza but negates it,
  // so exclude any memory that also mentions burgers or "not pizza".
  const noStalePizzaLove = !after.some(
    (h) =>
      /love[s]? pizza|favorite.*is.*pizza|pizza.*is.*favorite/i.test(
        h.memory,
      ) && !/burger|not pizza|no longer|not.*favorite/i.test(h.memory),
  );
  for (const hit of after.slice(0, 12)) {
    console.log(
      `      ${c.dim('•')} ${hit.memory} ${hit.version ? c.dim(`(v${hit.version})`) : ''}`,
    );
  }
  assert(mentionsBurger, 'a memory now records the burger preference');
  assert(
    superseded,
    'a memory was superseded (version > 1), not just duplicated',
  );
  assert(noStalePizzaLove, 'no memory still claims pizza is the favorite');

  /* ---- done ---- */
  console.log('');
  await supervisor.stop();
  await shim.stop();
  await killAllTracked().catch(() => {});

  if (failures === 0)
    console.log(c.green(c.bold('All memory checks passed ✓\n')));
  else console.log(c.red(c.bold(`${failures} check(s) failed ✗\n`)));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(c.red(`\n${error?.stack ?? error}`));
  try {
    await killAllTracked();
  } catch {
    /* best effort */
  }
  process.exit(1);
});
