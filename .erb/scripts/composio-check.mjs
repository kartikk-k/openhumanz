/* eslint-disable no-console */
/**
 * Composio connectivity check — proves the connector pipe end to end without
 * launching the app.
 *
 * Run:  COMPOSIO_API_KEY=ak_xxx bun run composio:check
 *   (optionally)  COMPOSIO_TOOLKIT=gmail
 *
 * With a key it: verifies the key, lists active connections, and — if the
 * toolkit is connected — prints its available tools. If the toolkit is NOT
 * connected, it starts the OAuth flow, prints the consent URL for you to open,
 * and polls until you finish, then lists the tools.
 *
 * Without a key it still confirms the SDK loads and the client builds, so the
 * wiring is verified even before you have credentials.
 */
import path from 'node:path';
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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  createComposioClient,
} = require('./src/main/modules/composio/client.ts');

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

async function main() {
  const apiKey = process.env.COMPOSIO_API_KEY?.trim();
  const toolkit = (process.env.COMPOSIO_TOOLKIT ?? 'gmail').trim();

  console.log(c.bold('\n🔗 Composio check\n'));

  if (!apiKey) {
    console.log('No COMPOSIO_API_KEY set — verifying the SDK wiring only.');
    const client = await createComposioClient('dummy_key_for_wiring_check');
    console.log(
      `  client built: ${client && typeof client.connect === 'function' ? c.green('yes ✓') : c.red('no ✗')}`,
    );
    console.log(
      c.dim(
        '\n  To run the full flow:\n    COMPOSIO_API_KEY=ak_xxx bun run composio:check\n',
      ),
    );
    return;
  }

  const client = await createComposioClient(apiKey);

  process.stdout.write('  verifying key… ');
  const verify = await client.verify();
  if (!verify.ok) {
    console.log(c.red(`✗\n  ${verify.error}`));
    process.exit(1);
  }
  console.log(c.green('connected ✓'));

  const connections = await client.listConnections();
  console.log(`  active connections: ${c.cyan(String(connections.length))}`);
  for (const conn of connections) {
    console.log(`    • ${conn.toolkitSlug} ${c.dim(`(${conn.status})`)}`);
  }

  const isConnected = connections.some((x) => x.toolkitSlug === toolkit);
  if (!isConnected) {
    console.log(`\n  ${toolkit} is not connected — starting OAuth…`);
    const request = await client.connect(toolkit);
    console.log(c.bold(`\n  Open this URL to connect ${toolkit}:`));
    console.log(`  ${c.cyan(request.redirectUrl ?? '(no url)')}\n`);
    console.log('  waiting for you to finish (up to 3 min)…');
    try {
      await request.waitForConnection(180_000);
      console.log(c.green('  connected ✓'));
    } catch (error) {
      console.log(
        c.red(
          `  did not connect: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      process.exit(1);
    }
  }

  console.log(c.bold(`\n  Tools available for ${toolkit}:`));
  const tools = await client.toolsForToolkit(toolkit);
  if (tools.length === 0) {
    console.log(
      c.red('  none returned — check the toolkit slug / connection.'),
    );
  } else {
    for (const tool of tools.slice(0, 25)) {
      console.log(`    • ${c.cyan(tool.slug)} ${c.dim(`— ${tool.name}`)}`);
    }
    console.log(`\n  ${c.green(`${tools.length} tools ✓`)}`);
  }

  // Read vs write: reads must never prompt, writes must. Composio tags each tool
  // (`readOnlyHint` vs create/update/destructive); we surface that as
  // `sideEffecting` so the approval gate only stops on writes.
  const readOnly = await client.readOnlySlugs();
  console.log(
    c.bold(`\n  Read/write classification (approval only on writes):`),
  );
  console.log(`  read-only tools detected: ${c.cyan(String(readOnly.size))}`);
  const expectRead = ['GMAIL_FETCH_EMAILS', 'GMAIL_LIST_MESSAGES'];
  const expectWrite = ['GMAIL_SEND_EMAIL', 'GMAIL_DELETE_MESSAGE'];
  if (toolkit === 'gmail') {
    const readsOk = expectRead.every((s) => readOnly.has(s));
    const writesOk = expectWrite.every((s) => !readOnly.has(s));
    console.log(
      `  gmail reads are un-gated: ${readsOk ? c.green('yes ✓') : c.red('no ✗')}`,
    );
    console.log(
      `  gmail writes still gated: ${writesOk ? c.green('yes ✓') : c.red('no ✗')}`,
    );
    if (!readsOk || !writesOk) process.exit(1);
  }

  // Prove `execute` actually runs — this is the path that failed with
  // "Toolkit version not specified" before we passed dangerouslySkipVersionCheck.
  // Set COMPOSIO_EXECUTE to a slug (default GMAIL_FETCH_EMAILS for gmail) to run
  // a real, read-only call and confirm no version error comes back.
  const execSlug =
    process.env.COMPOSIO_EXECUTE?.trim() ||
    (toolkit === 'gmail' ? 'GMAIL_FETCH_EMAILS' : '');
  if (execSlug && isConnected) {
    console.log(c.bold(`\n  Executing ${execSlug} (read-only smoke test)…`));
    try {
      const result = await client.execute(execSlug, { max_results: 1 });
      const err =
        result && typeof result === 'object' ? result.error : undefined;
      if (err) {
        console.log(
          c.red(`  ✗ execute returned an error: ${JSON.stringify(err)}`),
        );
        process.exit(1);
      }
      const successful =
        result && typeof result === 'object' && 'successful' in result
          ? result.successful
          : true;
      console.log(
        successful === false
          ? c.red('  ✗ execute reported successful=false')
          : c.green(
              '  ✓ execute succeeded — no "Toolkit version not specified"',
            ),
      );
      if (successful === false) process.exit(1);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(c.red(`  ✗ execute threw: ${message}`));
      process.exit(1);
    }
  }
  console.log('');
}

main().catch((error) => {
  console.error(c.red(`\n${error?.stack ?? error}`));
  process.exit(1);
});
