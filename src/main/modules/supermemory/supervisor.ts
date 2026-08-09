/**
 * Keeps the local supermemory server alive.
 *
 * supermemory ships a self-contained native `supermemory-server` binary (no Node
 * needed to run it) plus a tiny `supermemory` npm launcher that installs it. The
 * supervisor:
 *   - resolves the installed binary (or installs it once, via the launcher);
 *   - spawns it with local embeddings + our Claude-Code LLM shim as the model
 *     provider, so it runs fully on-device with no external key;
 *   - health-checks every 30s and restarts it if it dies.
 *
 * Everything is spawned through the app's tracked-spawn infra, so the server and
 * its children are killed on quit.
 *
 * The server version is pinned: the stable v0.0.6 has a broken ingest pipeline
 * (its bundled RivetKit workflow engine fails to load its WASM binding, so
 * documents queue forever). v0.0.7-rc.2 fixes it — verified end to end.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { spawnProcess, runProcess, whichSync } from '../../infra/spawn';
import type { SpawnHandle } from '../../infra/spawn';
import { childEnvOverrides } from './env';
import type { Logger } from '../../infra/logger';

/** The server version we install and run. See the file header for why it's pinned. */
export const PINNED_SERVER_VERSION = '0.0.7-rc.2';
/** The npm launcher that installs/manages the native server. */
const LAUNCHER_SPEC = 'supermemory@4.25.4';
/** Default port for the local server. */
export const DEFAULT_SERVER_PORT = 8787;
/** How often to check the server is still answering. */
const HEALTH_INTERVAL_MS = 30_000;
/** How long to wait for a freshly-spawned server to answer before giving up. */
const BOOT_TIMEOUT_MS = 120_000;

export interface SupervisorOptions {
  logger: Logger;
  /** The LLM shim's base URL, e.g. `http://127.0.0.1:PORT/v1`. */
  llmBaseUrl: string;
  /** Port for the server. Default {@link DEFAULT_SERVER_PORT}. */
  port?: number;
  /** Install root. Default `~/.supermemory`. */
  installDir?: string;
  /** Where the server keeps its (encrypted) data. Default `<installDir>/data`. */
  dataDir?: string;
}

export interface SupermemorySupervisor {
  /** Install (if needed), start the server, and begin health-checking. */
  start(): Promise<void>;
  /** Stop health-checking and the server. */
  stop(): Promise<void>;
  /** True once the server has answered a health check. */
  readonly ready: boolean;
  /** The base URL of the running server. */
  readonly url: string;
  /** Whether the native binary is installed (no network needed to check). */
  isInstalled(): boolean;
  /** Install the pinned server version. Safe to call when already installed. */
  install(): Promise<void>;
}

export function createSupervisor(
  options: SupervisorOptions,
): SupermemorySupervisor {
  const { logger, llmBaseUrl } = options;
  const port = options.port ?? DEFAULT_SERVER_PORT;
  const installDir =
    options.installDir ?? path.join(os.homedir(), '.supermemory');
  const dataDir = options.dataDir ?? path.join(installDir, 'data');
  const binPath = path.join(installDir, 'bin', 'supermemory-server');
  const versionFile = `${binPath}.version`;
  const envFile = path.join(installDir, 'env');
  const url = `http://127.0.0.1:${port}`;

  let serverHandle: SpawnHandle | null = null;
  let healthTimer: NodeJS.Timeout | null = null;
  let ready = false;
  let stopping = false;
  let restarting = false;

  const isInstalled = (): boolean => {
    try {
      fs.accessSync(binPath, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  const installedVersion = (): string | null => {
    try {
      return fs.readFileSync(versionFile, 'utf8').trim() || null;
    } catch {
      return null;
    }
  };

  /** Write the server's env file: local embeddings + our shim as the LLM. */
  const writeEnvFile = async (): Promise<void> => {
    const lines = [
      `PORT=${port}`,
      `SUPERMEMORY_DATA_DIR=${dataDir}`,
      // Local, on-device embeddings — no API key, nothing sent off-box.
      'SUPERMEMORY_EMBEDDING_PROVIDER=local',
      'SUPERMEMORY_EMBEDDING_MODEL=Xenova/bge-base-en-v1.5',
      'SUPERMEMORY_EMBEDDING_DIMENSIONS=768',
      // The fact-extraction LLM: our local Claude-Code shim, dressed as OpenAI.
      // The key is unused by the shim but the SDK requires one to be present.
      'OPENAI_API_KEY=sk-local-claude-shim',
      `OPENAI_BASE_URL=${llmBaseUrl}`,
      'OPENAI_MODEL=gpt-4o-mini',
      // Don't nag about newer versions; we pin deliberately.
      'SUPERMEMORY_DISABLE_TELEMETRY=1',
    ];
    await fsp.mkdir(installDir, { recursive: true });
    await fsp.writeFile(envFile, `${lines.join('\n')}\n`, { mode: 0o600 });
  };

  const install = async (): Promise<void> => {
    if (isInstalled() && installedVersion() === PINNED_SERVER_VERSION) {
      logger.info('supermemory server already installed', {
        version: PINNED_SERVER_VERSION,
      });
      return;
    }
    // The launcher needs Node; run it through Electron's own node so end users
    // without a system node still work. `npx` is not available under
    // ELECTRON_RUN_AS_NODE, so resolve a real node/npx if present, else fall
    // back to the system launcher path.
    logger.info('installing supermemory server', {
      version: PINNED_SERVER_VERSION,
    });
    const npx = whichSync('npx');
    if (!npx) {
      throw new Error(
        'npx is required to install the supermemory server for now. ' +
          'Install Node, or install the server manually with ' +
          `"npx ${LAUNCHER_SPEC} local install --version ${PINNED_SERVER_VERSION}".`,
      );
    }
    const result = await runProcess(
      npx,
      [
        '-y',
        LAUNCHER_SPEC,
        'local',
        'install',
        '--version',
        PINNED_SERVER_VERSION,
      ],
      {
        env: {
          ...childEnvOverrides({ allowApiKeyEnv: false }),
          SUPERMEMORY_NO_PROMPT: '1',
          SUPERMEMORY_INSTALL_DIR: installDir,
        },
        timeoutMs: 5 * 60_000,
        label: 'supermemory-install',
        onStderrLine: (line) =>
          logger.debug('supermemory install', { line: line.slice(0, 200) }),
      },
    );
    if (result.code !== 0 || !isInstalled()) {
      throw new Error(
        `supermemory install failed (code ${result.code}): ${result.stderrTail.slice(
          -300,
        )}`,
      );
    }
    logger.info('supermemory server installed', {
      version: installedVersion(),
    });
  };

  const isHealthy = async (): Promise<boolean> => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      return res.ok || res.status < 500;
    } catch {
      return false;
    }
  };

  const spawnServer = (): void => {
    if (serverHandle) return;
    logger.info('starting supermemory server', { port, dataDir });
    serverHandle = spawnProcess(binPath, [], {
      env: {
        ...childEnvOverrides({ allowApiKeyEnv: false }),
        PORT: String(port),
        SUPERMEMORY_DATA_DIR: dataDir,
        SUPERMEMORY_EMBEDDING_PROVIDER: 'local',
        SUPERMEMORY_EMBEDDING_MODEL: 'Xenova/bge-base-en-v1.5',
        SUPERMEMORY_EMBEDDING_DIMENSIONS: '768',
        OPENAI_API_KEY: 'sk-local-claude-shim',
        OPENAI_BASE_URL: llmBaseUrl,
        OPENAI_MODEL: 'gpt-4o-mini',
        SUPERMEMORY_DISABLE_TELEMETRY: '1',
      },
      collectStdout: false,
      label: 'supermemory-server',
      onStdoutLine: (line) => {
        if (/error|fatal|failed/i.test(line)) {
          logger.warn('supermemory server', { line: line.slice(0, 200) });
        }
      },
    });
    // If the process exits on its own, the health loop will respawn it.
    void serverHandle.result.then((result) => {
      serverHandle = null;
      ready = false;
      if (!stopping) {
        logger.warn('supermemory server exited', {
          code: result.code,
          signal: result.signal,
        });
      }
      return undefined;
    });
  };

  const waitUntilHealthy = async (deadlineMs: number): Promise<boolean> => {
    const until = Date.now() + deadlineMs;
    while (Date.now() < until && !stopping) {
      // eslint-disable-next-line no-await-in-loop
      if (await isHealthy()) return true;
      // eslint-disable-next-line no-await-in-loop
      await delay(2000);
    }
    return false;
  };

  const ensureRunning = async (): Promise<void> => {
    if (stopping || restarting) return;
    if (await isHealthy()) {
      if (!ready) logger.info('supermemory server healthy', { url });
      ready = true;
      return;
    }
    restarting = true;
    try {
      ready = false;
      // Kill a hung process before respawning.
      if (serverHandle) {
        await serverHandle.kill('SIGTERM').catch(() => {});
        serverHandle = null;
      }
      spawnServer();
      const ok = await waitUntilHealthy(BOOT_TIMEOUT_MS);
      ready = ok;
      if (ok) logger.info('supermemory server ready', { url });
      else logger.warn('supermemory server did not become healthy in time');
    } finally {
      restarting = false;
    }
  };

  return {
    get ready() {
      return ready;
    },
    get url() {
      return url;
    },
    isInstalled,
    install,

    async start() {
      stopping = false;
      if (!isInstalled()) {
        // Install is a one-time, possibly-slow (model + binary) step. Do it here
        // for now; onboarding will drive it explicitly later.
        await install().catch((error) => {
          logger.error('supermemory install failed; memory engine offline', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      if (!isInstalled()) return; // install failed; stay offline, no crash.
      await writeEnvFile();
      await ensureRunning();
      healthTimer = setInterval(() => {
        void ensureRunning();
      }, HEALTH_INTERVAL_MS);
      healthTimer.unref?.();
    },

    async stop() {
      stopping = true;
      if (healthTimer) {
        clearInterval(healthTimer);
        healthTimer = null;
      }
      if (serverHandle) {
        await serverHandle.kill('SIGTERM').catch(() => {});
        serverHandle = null;
      }
      ready = false;
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
