/**
 * Telling "you are out of quota" apart from "it broke".
 *
 * A well-behaved adapter sets {@link EngineFailureKind} itself. Not every CLI
 * build is well-behaved: plenty of them exit non-zero with nothing but
 * "Claude AI usage limit reached" on stderr. Since quota exhaustion is the
 * failure a real user hits first, and the one where the UI must say something
 * specific and true, the text is sniffed as a backstop.
 *
 * Ordering matters. `credit balance` and `usage limit` mean the account is out
 * and retrying now is pointless (`quota`); `429` and `overloaded` mean try
 * again shortly (`rate_limit`). Conflating them produces the wrong advice.
 */
import type { EngineFailureKind } from './types';

const PATTERNS: { kind: EngineFailureKind; test: RegExp }[] = [
  {
    kind: 'quota',
    test: /\b(usage limit|quota (?:exceeded|exhausted|reached)|out of credits?|credit balance|insufficient (?:credit|quota|balance)|monthly limit|weekly limit|plan limit)\b/i,
  },
  {
    kind: 'rate_limit',
    test: /\b(rate[ _-]?limit(?:ed|ing)?|too many requests|429|overloaded|slow down|retry[- ]after)\b/i,
  },
  {
    kind: 'auth',
    test: /\b(unauthori[sz]ed|authentication|not logged in|invalid api key|401|403|forbidden|please run .*login)\b/i,
  },
  { kind: 'timeout', test: /\b(timed? ?out|etimedout|deadline exceeded)\b/i },
  {
    kind: 'budget_exceeded',
    test: /\b(budget (?:exceeded|limit)|max[- ]budget|cost limit)\b/i,
  },
  { kind: 'max_turns', test: /\b(max[- ]turns|turn limit|too many turns)\b/i },
  {
    kind: 'spawn_failed',
    test: /\b(enoent|command not found|is not recognized|permission denied|eacces)\b/i,
  },
];

/**
 * Best guess at why something failed, from whatever text we have.
 * Returns `engine_error` when nothing matches — never `undefined`, because a
 * caller that has to null-check gets it wrong under pressure.
 */
export function classifyFailure(
  ...candidates: (string | undefined | null)[]
): EngineFailureKind {
  const haystack = candidates.filter(Boolean).join('\n');
  if (!haystack) return 'engine_error';
  for (const { kind, test } of PATTERNS) {
    if (test.test(haystack)) return kind;
  }
  return 'engine_error';
}

/** True when the account is out of capacity, not when the code is broken. */
export function isQuotaKind(kind: EngineFailureKind | undefined): boolean {
  return kind === 'quota' || kind === 'rate_limit';
}

/**
 * One sentence for the timeline. Quota gets its own copy because "Step failed:
 * Error" is exactly the message that makes a user think the app is broken when
 * in fact their plan renewed on Tuesday.
 */
export function describeFailure(
  kind: EngineFailureKind,
  detail?: string,
): string {
  const suffix = detail ? ` ${detail.trim()}` : '';
  switch (kind) {
    case 'quota':
      return `The engine is out of quota, so this step could not run. Nothing was left half-done; re-run it once your plan resets.${suffix}`;
    case 'rate_limit':
      return `The engine is rate limited right now. This is temporary — re-run the step in a few minutes.${suffix}`;
    case 'auth':
      return `The engine rejected our credentials. Sign in to the CLI and try again.${suffix}`;
    case 'timeout':
      return `The step took too long and was stopped.${suffix}`;
    case 'budget_exceeded':
      return `The step hit its cost ceiling and was stopped before spending more.${suffix}`;
    case 'max_turns':
      return `The step hit its turn limit and was stopped.${suffix}`;
    case 'spawn_failed':
      return `The engine could not be started.${suffix}`;
    case 'cancelled':
      return `Cancelled.${suffix}`;
    default:
      return `The step failed.${suffix}`;
  }
}
