/**
 * Why a run or a step ended badly, in words a person can act on.
 *
 * Quota exhaustion is the failure a real user hits first, and the only one
 * where the honest copy is "your plan is out of capacity" rather than
 * "something went wrong". So it is a separate branch here and a separate
 * *tone* on screen — warning, not danger — because it is not a bug and there is
 * nothing to debug.
 *
 * ## Reading the kind
 *
 * The main process classifies the failure and stores it in a `failure_kind`
 * column. `Run`/`RunStep` now carry it as a real field, but older rows still
 * only have `metadata.failureKind`. {@link readFailureKind} reads both, so this
 * screen is correct against either shape and never has to know which it got.
 */
import {
  Ban,
  Bug,
  CircleDollarSign,
  Clock,
  KeyRound,
  PlugZap,
  Repeat,
  Timer,
  Unplug,
  XCircle,
  Gauge,
  type LucideIcon,
} from 'lucide-react';
import { FAILURE_KINDS, type FailureKind } from '../../../shared/runs';
import type { Tone } from '../../lib/tone';

export { FAILURE_KINDS, isQuotaFailure } from '../../../shared/runs';
export type { FailureKind } from '../../../shared/runs';

const KIND_SET = new Set<string>(FAILURE_KINDS);

function asKind(value: unknown): FailureKind | undefined {
  return typeof value === 'string' && KIND_SET.has(value)
    ? (value as FailureKind)
    : undefined;
}

/**
 * `x.failureKind ?? x.metadata.failureKind`, defensively.
 *
 * Works for a `Run`, a `RunStep`, or anything else carrying either shape, and
 * never throws on a malformed payload — this renders data the agent wrote.
 */
export function readFailureKind(source: unknown): FailureKind | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const record = source as {
    failureKind?: unknown;
    metadata?: unknown;
  };
  const direct = asKind(record.failureKind);
  if (direct) return direct;
  const metadata = record.metadata;
  if (metadata && typeof metadata === 'object') {
    return asKind((metadata as { failureKind?: unknown }).failureKind);
  }
  return undefined;
}

export interface FailureExplanation {
  kind: FailureKind | 'unknown';
  /** Headline. A statement of fact, never "Error".  */
  title: string;
  /** What happened, in one or two sentences. */
  body: string;
  /** What to do about it. Omitted when there is nothing useful to say. */
  advice?: string;
  /**
   * `warning` for "your plan is out" / "you hit a limit you set" — those are
   * capacity, not breakage. `danger` for anything that is actually wrong.
   */
  tone: Tone;
  icon: LucideIcon;
  /** Small-caps label above the panel. Names the *class* of failure. */
  eyebrow: string;
  /** Retrying right now is pointless — drives the re-run button's copy. */
  retryPointless?: boolean;
}

const EXPLANATIONS: Record<FailureKind, Omit<FailureExplanation, 'kind'>> = {
  quota: {
    title: 'Your plan is out of capacity',
    body: 'The engine reported that the account has no capacity left, so the run stopped. This is not a bug in the app and nothing was left half-done.',
    advice:
      'Re-running now will fail exactly the same way. Try again once your plan resets.',
    tone: 'warning',
    icon: Gauge,
    eyebrow: 'Plan capacity',
    retryPointless: true,
  },
  rate_limit: {
    title: 'Rate limited by the engine',
    body: 'The engine asked us to slow down. This is temporary and says nothing about the work itself.',
    advice: 'Wait a few minutes, then re-run.',
    tone: 'warning',
    icon: Timer,
    eyebrow: 'Plan capacity',
  },
  auth: {
    title: 'The engine rejected our credentials',
    body: 'The agent CLI is not signed in, or the credentials it has are no longer valid.',
    advice:
      'Sign in to the CLI, then re-run. Settings shows what was detected.',
    tone: 'danger',
    icon: KeyRound,
    eyebrow: 'Authentication',
  },
  timeout: {
    title: 'The step took too long and was stopped',
    body: 'A step ran past its wall-clock ceiling and was killed so it could not sit there forever.',
    advice:
      'Raise the step timeout in Settings, or give the run a smaller piece of work.',
    tone: 'warning',
    icon: Clock,
    eyebrow: 'Limit reached',
  },
  budget_exceeded: {
    title: 'It hit the cost ceiling you set',
    body: 'The run reached the per-run spend limit and was stopped before it could spend more.',
    advice: 'Raise the per-run cost limit in Settings if that was too tight.',
    tone: 'warning',
    icon: CircleDollarSign,
    eyebrow: 'Limit reached',
  },
  max_turns: {
    title: 'It hit the turn limit',
    body: 'The step used every turn it was allowed. That usually means it was looping rather than converging.',
    advice: 'Split the work into smaller steps, or raise the turn limit.',
    tone: 'warning',
    icon: Repeat,
    eyebrow: 'Limit reached',
  },
  engine_error: {
    title: 'The engine failed',
    body: 'The agent CLI exited badly and did not tell us why in a form we could classify.',
    advice: 'The raw error is below. Re-running is usually worth one attempt.',
    tone: 'danger',
    icon: XCircle,
    eyebrow: 'Engine error',
  },
  spawn_failed: {
    title: 'The engine could not be started',
    body: 'We could not launch the agent CLI at all — it was missing, or not executable.',
    advice: 'Check the engine binary path in Settings.',
    tone: 'danger',
    icon: PlugZap,
    eyebrow: 'Engine error',
  },
  cancelled: {
    title: 'Cancelled',
    body: 'This run was stopped from the app. Work already finished is kept; nothing further was started.',
    tone: 'neutral',
    icon: Ban,
    eyebrow: 'Stopped',
  },
  interrupted: {
    title: 'The run was interrupted',
    body: 'The run stopped before it finished — the app quit or the machine went away mid-run.',
    advice: 'Re-run it; the transcript up to the interruption is kept.',
    tone: 'warning',
    icon: Unplug,
    eyebrow: 'Stopped',
  },
  internal: {
    title: 'Something inside the app went wrong',
    body: 'The failure happened on our side of the seam, not in the engine.',
    advice: 'The raw error is below, and the full transcript is on disk.',
    tone: 'danger',
    icon: Bug,
    eyebrow: 'App error',
  },
};

const UNKNOWN: Omit<FailureExplanation, 'kind'> = {
  title: 'The run failed',
  body: 'The engine stopped without reporting a reason we recognise.',
  advice: 'The raw error is below.',
  tone: 'danger',
  icon: XCircle,
  eyebrow: 'Failure',
};

/** The plain-language rendering of a failure kind. Never returns undefined. */
export function explainFailure(
  kind: FailureKind | undefined,
): FailureExplanation {
  if (!kind) return { kind: 'unknown', ...UNKNOWN };
  return { kind, ...EXPLANATIONS[kind] };
}

/** Short label for a chip next to a status badge. */
export function failureKindLabel(kind: FailureKind): string {
  switch (kind) {
    case 'quota':
      return 'Out of quota';
    case 'rate_limit':
      return 'Rate limited';
    case 'auth':
      return 'Auth';
    case 'timeout':
      return 'Timed out';
    case 'budget_exceeded':
      return 'Cost limit';
    case 'max_turns':
      return 'Turn limit';
    case 'engine_error':
      return 'Engine error';
    case 'spawn_failed':
      return 'Spawn failed';
    case 'cancelled':
      return 'Cancelled';
    case 'interrupted':
      return 'Interrupted';
    default:
      return 'Internal';
  }
}
