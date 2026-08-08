/**
 * macOS version detection, and what each capability believes it can do there.
 *
 * Apple's application scripting support is not a stable API. Mail's dictionary
 * in particular has lost or broken behaviour across several recent releases:
 * properties that return `missing value` where they used to return text, `whose`
 * clauses that hang instead of filtering, elements that stopped being
 * addressable. None of it is announced and none of it is versioned.
 *
 * The response is not to hope. Each capability declares, per operation, the
 * range of macOS releases it is prepared to run on and whether it considers
 * itself degraded there. Resolution consults that declaration *before* spawning
 * anything, so an unsupported operation falls through to another provider, or
 * reports itself unavailable with a reason — rather than running, mis-parsing a
 * changed shape and returning a confidently wrong answer.
 *
 * The table below is what we believe today. It is data, not logic, precisely so
 * that a new release contradicting it is a one-line edit backed by evidence
 * rather than a debugging session.
 */
import os from 'node:os';
import { runProcess } from '../../infra/spawn';

export interface MacosVersion {
  major: number;
  minor: number;
  patch: number;
  /** As reported, e.g. "15.3.1". */
  raw: string;
  /** How the version was established. */
  source: 'sw_vers' | 'darwin' | 'assumed';
}

/** `/usr/bin/sw_vers`, absolute for the same reason `osascript` is. */
export const SW_VERS_PATH = '/usr/bin/sw_vers';

export function parseProductVersion(
  raw: string,
  source: MacosVersion['source'] = 'sw_vers',
): MacosVersion | null {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(raw.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    raw: raw.trim(),
    source,
  };
}

/**
 * Darwin kernel version to macOS version.
 *
 * The mapping is a table rather than arithmetic because Apple skipped from
 * macOS 15 to macOS 26 while Darwin kept counting: `darwinMajor - 9` is right
 * for Big Sur through Sequoia and wrong from Tahoe onwards. An unknown newer
 * kernel extrapolates from the last known pair, which will be approximately
 * right and is labelled `darwin` so a caller can tell it is inferred.
 */
const DARWIN_TO_MACOS: Record<number, number> = {
  19: 10,
  20: 11,
  21: 12,
  22: 13,
  23: 14,
  24: 15,
  25: 26,
};

const NEWEST_KNOWN_DARWIN = 25;

export function macosVersionFromDarwin(release: string): MacosVersion | null {
  const match = /^(\d+)\.(\d+)/.exec(release.trim());
  if (!match) return null;
  const darwinMajor = Number(match[1]);
  const known = DARWIN_TO_MACOS[darwinMajor];
  const major =
    known ??
    (darwinMajor > NEWEST_KNOWN_DARWIN
      ? DARWIN_TO_MACOS[NEWEST_KNOWN_DARWIN] +
        (darwinMajor - NEWEST_KNOWN_DARWIN)
      : 0);
  if (!major) return null;
  return {
    major,
    minor: 0,
    patch: 0,
    raw: `${major} (from Darwin ${release.trim()})`,
    source: 'darwin',
  };
}

export function compareVersion(a: MacosVersion, b: MacosVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Read the OS version.
 *
 * `sw_vers` first because it is authoritative; `os.release()` when the spawn
 * fails, which it does inside some sandboxes. Returns null off macOS — this
 * never throws, because a version probe failing is not a reason to fail to
 * start.
 */
export async function detectMacosVersion(options?: {
  platform?: NodeJS.Platform;
  run?: typeof runProcess;
  release?: () => string;
}): Promise<MacosVersion | null> {
  const platform = options?.platform ?? process.platform;
  if (platform !== 'darwin') return null;

  const run = options?.run ?? runProcess;
  try {
    const result = await run(SW_VERS_PATH, ['-productVersion'], {
      timeoutMs: 5000,
      label: 'sw_vers',
    });
    if (result.code === 0) {
      const parsed = parseProductVersion(result.stdout);
      if (parsed) return parsed;
    }
  } catch {
    /* fall through to the kernel version */
  }

  const release = (options?.release ?? os.release)();
  return macosVersionFromDarwin(release);
}

/* ------------------------------------------------------------------ */
/* Support matrix                                                      */
/* ------------------------------------------------------------------ */

/**
 * Operations a capability can be asked for. Kept as strings rather than a union
 * per capability so the matrix stays one flat, greppable table.
 */
export const CAPABILITY_OPS = [
  'mail.mailboxes',
  'mail.search',
  'mail.message',
  'mail.unread-count',
  'mail.create-draft',
  'calendar.calendars',
  'calendar.events',
  'calendar.event',
  'calendar.create-event',
  'contacts.search',
  'contacts.person',
  'notes.search',
  'notes.note',
  'notes.create',
  'reminders.list',
  'reminders.reminder',
  'reminders.create',
  'files.finder-selection',
] as const;

export type CapabilityOp = (typeof CAPABILITY_OPS)[number];

export interface OpSupport {
  /** Lowest macOS major this is known to work on. */
  minMajor?: number;
  /**
   * Highest macOS major this is known to work on. A newer release does not make
   * the operation unavailable — it makes it `degraded`, because refusing to run
   * on every future OS would be worse than running and validating the output.
   */
  lastVerifiedMajor?: number;
  /** Set when the operation works but with a caveat worth reporting. */
  caveat?: string;
  /**
   * Set when the operation is known to be broken and must not run. This is the
   * only value that makes a provider decline an operation outright.
   */
  brokenFrom?: number;
  brokenReason?: string;
}

/**
 * What we believe about each operation.
 *
 * `lastVerifiedMajor` deliberately trails: it records the newest release someone
 * actually confirmed, not the newest release that exists. On anything newer the
 * operation still runs and its output is still validated by zod — a changed
 * shape becomes a `bad-output` error naming the field, which is a bug report,
 * rather than a wrong answer.
 */
export const SUPPORT_MATRIX: Record<CapabilityOp, OpSupport> = {
  'mail.mailboxes': { minMajor: 11, lastVerifiedMajor: 15 },
  'mail.search': {
    minMajor: 11,
    lastVerifiedMajor: 15,
    caveat:
      'Searches the most recent messages in a mailbox rather than the whole mailbox, and matches subject and sender only.',
  },
  'mail.message': { minMajor: 11, lastVerifiedMajor: 15 },
  'mail.unread-count': { minMajor: 11, lastVerifiedMajor: 15 },
  'mail.create-draft': { minMajor: 11, lastVerifiedMajor: 15 },
  'calendar.calendars': { minMajor: 11, lastVerifiedMajor: 15 },
  'calendar.events': {
    minMajor: 11,
    lastVerifiedMajor: 15,
    caveat:
      'Recurring events are reported once, by their first occurrence; Calendar does not expand a recurrence over a date range.',
  },
  'calendar.event': { minMajor: 11, lastVerifiedMajor: 15 },
  'calendar.create-event': { minMajor: 11, lastVerifiedMajor: 15 },
  'contacts.search': { minMajor: 11, lastVerifiedMajor: 15 },
  'contacts.person': { minMajor: 11, lastVerifiedMajor: 15 },
  'notes.search': {
    minMajor: 11,
    lastVerifiedMajor: 15,
    caveat:
      'Matches note titles by default; searching bodies costs one request per note and must be asked for.',
  },
  'notes.note': { minMajor: 11, lastVerifiedMajor: 15 },
  'notes.create': { minMajor: 11, lastVerifiedMajor: 15 },
  'reminders.list': { minMajor: 11, lastVerifiedMajor: 15 },
  'reminders.reminder': { minMajor: 11, lastVerifiedMajor: 15 },
  'reminders.create': { minMajor: 11, lastVerifiedMajor: 15 },
  'files.finder-selection': { minMajor: 11, lastVerifiedMajor: 15 },
};

export interface OpVerdict {
  supported: boolean;
  /** True when it will run but something about the result is compromised. */
  degraded: boolean;
  /** Populated whenever `supported` is false, or `degraded` is true. */
  reason?: string;
}

/**
 * Whether an operation may run on this OS.
 *
 * An unknown version (probe failed) is treated as supported-but-degraded rather
 * than unsupported: refusing to work because we could not read a version number
 * is a worse failure than running and validating what comes back.
 */
export function checkOpSupport(
  op: CapabilityOp,
  version: MacosVersion | null,
): OpVerdict {
  const support = SUPPORT_MATRIX[op];
  if (!support) {
    return {
      supported: false,
      degraded: false,
      reason: `Unknown operation "${op}".`,
    };
  }
  if (!version) {
    return {
      supported: true,
      degraded: true,
      reason:
        'The macOS version could not be determined, so support is unverified.',
    };
  }
  if (support.minMajor !== undefined && version.major < support.minMajor) {
    return {
      supported: false,
      degraded: false,
      reason: `Requires macOS ${support.minMajor} or later; this is macOS ${version.major}.`,
    };
  }
  if (support.brokenFrom !== undefined && version.major >= support.brokenFrom) {
    return {
      supported: false,
      degraded: false,
      reason:
        support.brokenReason ??
        `Known not to work on macOS ${support.brokenFrom} or later.`,
    };
  }
  const notes: string[] = [];
  if (support.caveat) notes.push(support.caveat);
  if (
    support.lastVerifiedMajor !== undefined &&
    version.major > support.lastVerifiedMajor
  ) {
    notes.push(
      `Last verified on macOS ${support.lastVerifiedMajor}; this is macOS ${version.major}, so results are checked but unproven.`,
    );
  }
  return {
    supported: true,
    degraded: notes.length > 0,
    reason: notes.length > 0 ? notes.join(' ') : undefined,
  };
}
