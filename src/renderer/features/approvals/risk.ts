/**
 * A reading hint, not a security control.
 *
 * The gate has already decided that everything on this screen needs a human —
 * that decision is made in main, from the tool's declared `sideEffecting` flag,
 * and it fails closed. This file only decides whether a card gets an extra word
 * of emphasis so that "delete every event in August" does not look exactly like
 * "read the calendar" in a queue of twelve.
 *
 * Two rules, because a heuristic in front of a security decision is dangerous
 * if it is allowed to work in the other direction:
 *
 *  1. It can only *add* emphasis. There is no "safe" badge, no auto-approve,
 *     nothing that shortens the path to a decision.
 *  2. A card with no signal is not a card that has been cleared. It is a card
 *     whose title did not match a word list, which is why the absence renders
 *     as nothing at all rather than as reassurance.
 */
import type { Tone } from '../../lib/tone';
import type { Approval } from '../../../shared/approvals';

export interface RiskSignal {
  label: string;
  tone: Tone;
}

/**
 * Ordered: the first match wins, so the most consequential families come first.
 * Matched against the tool name, the title and the summary together — the
 * backend's `summarize()` output is where the verb usually lives.
 */
const SIGNALS: ReadonlyArray<{ pattern: RegExp; signal: RiskSignal }> = [
  {
    pattern: /\b(delete|deletes|remove|removes|destroy|purge|drop|erase|wipe|trash|uninstall)\b|_delete|_remove/i,
    signal: { label: 'Deletes data', tone: 'danger' },
  },
  {
    pattern: /\b(pay|pays|payment|charge|charges|purchase|order|invoice|transfer|refund)\b/i,
    signal: { label: 'Spends money', tone: 'danger' },
  },
  {
    pattern: /\b(send|sends|email|emails|mail|reply|replies|post|publish|message|sms|notify)\b|_send|_email/i,
    signal: { label: 'Sends on your behalf', tone: 'warning' },
  },
  {
    pattern: /\b(overwrite|overwrites|replace|replaces|rename|move|moves|archive|revoke|cancel|reschedule)\b/i,
    signal: { label: 'Changes existing data', tone: 'warning' },
  },
];

/** The emphasis for one approval, or null when nothing matched. */
export function riskSignal(approval: Approval): RiskSignal | null {
  const haystack = `${approval.toolName} ${approval.title} ${approval.summary}`;
  const hit = SIGNALS.find((entry) => entry.pattern.test(haystack));
  return hit ? hit.signal : null;
}
