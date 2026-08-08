/**
 * Loading, composing and materialising the `.applescript` assets.
 *
 * Three problems this file exists to solve.
 *
 * **1. Script bodies are files, not strings in TypeScript.** A heredoc in a `.ts`
 * file is not lintable, diffs badly, cannot be opened in Script Editor, and
 * invites interpolation at every call site. Keeping them as files confines
 * substitution to {@link renderScript} and makes "is every script present and
 * parseable" a test that runs anywhere, including on Linux.
 *
 * **2. AppleScript has no include.** The shared JSON and argv handlers live in
 * `_prelude.applescript` and are concatenated in front of each body here. So the
 * text that reaches `osascript` is prelude + body, and a handler bug is fixed
 * once.
 *
 * **3. `osascript` cannot read out of `app.asar`.** Packaged, the scripts sit
 * inside the archive: Node reads them transparently, `osascript` — a separate
 * process with no idea what an asar is — cannot. So the composed text is written
 * to a private directory under the workspace at startup and `osascript` is
 * pointed at that. The directory is recreated on every `start()`, is mode 0700
 * with 0600 files, and lives beside the MCP socket and token, which is the same
 * trust boundary. Writing to the system temp directory instead would be a real
 * vulnerability: anything on the machine could replace a script between write
 * and exec and inherit our automation grants.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { APPLE_APPS, type AppleAppId } from './apps';
import {
  renderScript,
  type PlaceholderKinds,
} from './escape';

/** Override the directory holding the `.applescript` files. Tests, packaging. */
export const SCRIPTS_DIR_ENV_VAR = 'ASSISTANT_MACOS_SCRIPTS_DIR';

/** Basename of the directory written next to the webpack bundle. */
export const BUNDLED_SCRIPTS_DIRNAME = 'macos-scripts';

export const SCRIPT_EXTENSION = '.applescript';

/** Concatenated in front of every body. Never run on its own. */
export const PRELUDE_NAME = '_prelude';

/* ------------------------------------------------------------------ */
/* The catalogue                                                       */
/* ------------------------------------------------------------------ */

export interface ScriptSpec {
  /** File basename without the extension. */
  name: string;
  /** Placeholder kinds, checked by `renderScript`. Empty for argv-only scripts. */
  placeholders: PlaceholderKinds;
  /**
   * True when the composed text differs per target app, so one file has to be
   * materialised per app rather than once.
   */
  perApp?: boolean;
}

/**
 * Every script this module ships.
 *
 * Note how few placeholders there are. That is the design: `{{APP_NAME}}` is
 * interpolated because `tell application` needs a literal for permission
 * attribution, and it is drawn from a fixed allowlist. Everything else — search
 * queries, message ids, mail bodies, dates — travels through argv and is never
 * compiled.
 */
export const SCRIPT_SPECS: readonly ScriptSpec[] = [
  { name: 'probe-app', placeholders: { APP_NAME: 'app-name' }, perApp: true },
  { name: 'mail-mailboxes', placeholders: {} },
  { name: 'mail-search', placeholders: {} },
  { name: 'mail-message', placeholders: {} },
  { name: 'mail-unread-count', placeholders: {} },
  { name: 'mail-create-draft', placeholders: {} },
  { name: 'calendar-calendars', placeholders: {} },
  { name: 'calendar-events', placeholders: {} },
  { name: 'calendar-event', placeholders: {} },
  { name: 'calendar-create-event', placeholders: {} },
  { name: 'contacts-search', placeholders: {} },
  { name: 'contacts-person', placeholders: {} },
  { name: 'notes-search', placeholders: {} },
  { name: 'notes-note', placeholders: {} },
  { name: 'notes-create', placeholders: {} },
  { name: 'reminders-list', placeholders: {} },
  { name: 'reminders-reminder', placeholders: {} },
  { name: 'reminders-create', placeholders: {} },
  { name: 'finder-selection', placeholders: {} },
];

export type ScriptName = (typeof SCRIPT_SPECS)[number]['name'];

const SPEC_BY_NAME = new Map(SCRIPT_SPECS.map((spec) => [spec.name, spec]));

export function scriptSpec(name: string): ScriptSpec {
  const spec = SPEC_BY_NAME.get(name);
  if (!spec) throw new Error(`Unknown AppleScript "${name}".`);
  return spec;
}

/* ------------------------------------------------------------------ */
/* Locating the source files                                           */
/* ------------------------------------------------------------------ */

function hereDir(): string {
  return typeof __dirname === 'string' ? __dirname : process.cwd();
}

/**
 * Directories that might hold the `.applescript` files, in priority order.
 *
 * `<bundle>/macos-scripts` is where the webpack copy-files plugin puts them, so
 * it hits in dev (`.erb/dll/`) and packaged (`dist/main/`, read through the
 * asar). `<here>/scripts` is the source tree, which is what a plain `bun`
 * script or a jest run sees.
 */
export function scriptDirCandidates(extraDirs: readonly string[] = []): string[] {
  const candidates: string[] = [];
  const fromEnv = process.env[SCRIPTS_DIR_ENV_VAR];
  if (fromEnv) candidates.push(fromEnv);
  candidates.push(...extraDirs);

  const here = hereDir();
  candidates.push(path.join(here, BUNDLED_SCRIPTS_DIRNAME));
  candidates.push(path.join(here, '..', BUNDLED_SCRIPTS_DIRNAME));
  candidates.push(path.join(here, 'scripts'));
  candidates.push(
    path.join(here, 'src', 'main', 'modules', 'macos', 'scripts'),
  );
  candidates.push(
    path.join(process.cwd(), 'src', 'main', 'modules', 'macos', 'scripts'),
  );

  return [...new Set(candidates)];
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * First directory containing the prelude. Throws with the full candidate list,
 * because "script not found" with no path is unanswerable in a bug report.
 */
export function resolveScriptDir(extraDirs: readonly string[] = []): string {
  const candidates = scriptDirCandidates(extraDirs);
  for (const dir of candidates) {
    if (isFile(path.join(dir, `${PRELUDE_NAME}${SCRIPT_EXTENSION}`))) return dir;
  }
  throw new Error(
    `Could not locate the macOS AppleScript assets. Set ${SCRIPTS_DIR_ENV_VAR}, ` +
      `or make sure ${BUNDLED_SCRIPTS_DIRNAME}/ is copied next to the main bundle. ` +
      `Tried:\n  ${candidates.join('\n  ')}`,
  );
}

/* ------------------------------------------------------------------ */
/* Composition                                                         */
/* ------------------------------------------------------------------ */

/**
 * Prelude + body, with placeholders substituted.
 *
 * Exported separately from the file IO so the composition is unit-testable
 * without a filesystem and, more to the point, so the *output* can be asserted
 * ASCII-only and placeholder-free.
 */
export function composeScript(
  prelude: string,
  body: string,
  spec: ScriptSpec,
  values: Record<string, string> = {},
): string {
  const rendered = renderScript(body, spec.placeholders, values);
  return `${rendered.trimEnd()}\n\n${prelude.trimEnd()}\n`;
}

/** Values for a script's placeholders, given a target app. */
export function placeholderValues(
  spec: ScriptSpec,
  appId?: AppleAppId,
): Record<string, string> {
  if (!('APP_NAME' in spec.placeholders)) return {};
  if (!appId) {
    throw new Error(`Script "${spec.name}" needs a target app.`);
  }
  return { APP_NAME: APPLE_APPS[appId].appleScriptName };
}

/** Filename a composed script is written under. */
export function materializedFileName(
  spec: ScriptSpec,
  appId?: AppleAppId,
): string {
  return spec.perApp && appId
    ? `${spec.name}.${appId}${SCRIPT_EXTENSION}`
    : `${spec.name}${SCRIPT_EXTENSION}`;
}

/* ------------------------------------------------------------------ */
/* The store                                                           */
/* ------------------------------------------------------------------ */

export interface ScriptStoreOptions {
  /** Where composed scripts are written. Normally `<workspace>/macos-scripts`. */
  targetDir: string;
  /** Extra source directories tried before the built-in candidates. */
  sourceDirs?: readonly string[];
  /** Apps to materialise per-app scripts for. Defaults to all of them. */
  appIds?: readonly AppleAppId[];
}

export interface MaterializedScript {
  key: string;
  name: string;
  appId?: AppleAppId;
  /** Absolute path handed to `osascript`. */
  filePath: string;
  sha256: string;
  bytes: number;
}

/**
 * Composed scripts on disk, ready for `osascript`.
 *
 * `prepare()` is idempotent and cheap to re-run: a file whose content hash
 * already matches is left alone, so a second call after a hot reload does not
 * churn the directory.
 */
export class ScriptStore {
  private readonly targetDir: string;

  private readonly sourceDirs: readonly string[];

  private readonly appIds: readonly AppleAppId[];

  private entries = new Map<string, MaterializedScript>();

  private ready = false;

  constructor(options: ScriptStoreOptions) {
    this.targetDir = options.targetDir;
    this.sourceDirs = options.sourceDirs ?? [];
    this.appIds =
      options.appIds ?? (Object.keys(APPLE_APPS) as AppleAppId[]);
  }

  get prepared(): boolean {
    return this.ready;
  }

  get directory(): string {
    return this.targetDir;
  }

  /** Read, compose and write every script. Safe to call repeatedly. */
  async prepare(): Promise<MaterializedScript[]> {
    const sourceDir = resolveScriptDir(this.sourceDirs);
    const prelude = await fsp.readFile(
      path.join(sourceDir, `${PRELUDE_NAME}${SCRIPT_EXTENSION}`),
      'utf8',
    );

    await fsp.mkdir(this.targetDir, { recursive: true, mode: 0o700 });
    // mkdir's mode is masked by umask, so set it explicitly afterwards.
    await fsp.chmod(this.targetDir, 0o700).catch(() => undefined);

    const written: MaterializedScript[] = [];
    const next = new Map<string, MaterializedScript>();

    for (const spec of SCRIPT_SPECS) {
      const body = await fsp.readFile(
        path.join(sourceDir, `${spec.name}${SCRIPT_EXTENSION}`),
        'utf8',
      );
      const targets: (AppleAppId | undefined)[] = spec.perApp
        ? [...this.appIds]
        : [undefined];

      for (const appId of targets) {
        const text = composeScript(
          prelude,
          body,
          spec,
          placeholderValues(spec, appId),
        );
        const filePath = path.join(
          this.targetDir,
          materializedFileName(spec, appId),
        );
        const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');

        let needsWrite = true;
        try {
          const existing = await fsp.readFile(filePath, 'utf8');
          needsWrite = existing !== text;
        } catch {
          needsWrite = true;
        }
        if (needsWrite) {
          await fsp.writeFile(filePath, text, { encoding: 'utf8', mode: 0o600 });
          await fsp.chmod(filePath, 0o600).catch(() => undefined);
        }

        const entry: MaterializedScript = {
          key: scriptKey(spec.name, appId),
          name: spec.name,
          appId,
          filePath,
          sha256,
          bytes: Buffer.byteLength(text, 'utf8'),
        };
        next.set(entry.key, entry);
        written.push(entry);
      }
    }

    this.entries = next;
    this.ready = true;
    return written;
  }

  /** Absolute path for a script, or a clear error if `prepare()` has not run. */
  pathFor(name: string, appId?: AppleAppId): string {
    const spec = scriptSpec(name);
    const entry = this.entries.get(scriptKey(name, spec.perApp ? appId : undefined));
    if (!entry) {
      throw new Error(
        this.ready
          ? `No materialised script for "${name}"${appId ? ` (${appId})` : ''}.`
          : 'The macOS scripts have not been prepared yet; the module is not started.',
      );
    }
    return entry.filePath;
  }

  list(): MaterializedScript[] {
    return [...this.entries.values()];
  }

  /** Remove the materialised directory. Called from `stop()`. */
  async cleanup(): Promise<void> {
    this.entries = new Map();
    this.ready = false;
    await fsp.rm(this.targetDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

export function scriptKey(name: string, appId?: AppleAppId): string {
  return appId ? `${name}@${appId}` : name;
}
