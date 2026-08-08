/**
 * The words on the approval card.
 *
 * Kept in one file because the three scopes are the only part of this product a
 * user has to understand *before* pressing the button, and a sentence that
 * drifts between the card, the confirm dialog and the grants table is a
 * sentence that stops being trusted.
 *
 * The button labels come from `APPROVAL_SCOPE_LABEL` in `lib/status.ts` — the
 * shared table, so the sidebar, the run timeline and this screen all say the
 * same words. What is added here is the *consequence*: one line that says how
 * far the press reaches, written in the second person and without hedging.
 *
 * `always` is the consequential one. It reads as consequential by being
 * explicit about reach and about being revocable — not by being red. Red is for
 * denial and destruction; a standing grant the user chose is neither.
 */
import { Check, RefreshCw, ShieldCheck, type LucideIcon } from 'lucide-react';
import type { ApprovalScope } from '../../../shared/approvals';
import { APPROVAL_SCOPE_LABEL } from '../../lib/status';
import type { Tone } from '../../lib/tone';

export interface ApproveScopeCopy {
  scope: ApprovalScope;
  /** Button label. From the shared table — do not re-word it here. */
  label: string;
  /**
   * Full sentence, shown in the tooltip and in the confirm dialog. It carries
   * no keyboard hint — {@link withShortcut} adds one where a hint belongs, and
   * a dialog reads better without a stray letter in brackets.
   */
  consequence: string;
  /** Compact form for the one-line legend under the buttons. */
  legend: string;
  /** Single key that triggers it from the queue. */
  shortcut: string;
  icon: LucideIcon;
  tone: Tone;
}

/** Narrow to wide, left to right. The order the buttons render in. */
export const APPROVE_SCOPES: readonly ApproveScopeCopy[] = [
  {
    scope: 'once',
    label: APPROVAL_SCOPE_LABEL.once,
    consequence: 'Runs this one call. The next call like it asks you again.',
    legend: 'this call only',
    shortcut: 'a',
    icon: Check,
    tone: 'accent',
  },
  {
    scope: 'run',
    label: APPROVAL_SCOPE_LABEL.run,
    consequence:
      'Runs this call, and matching calls stop asking until this run ends. ' +
      'The grant is dropped when the run finishes.',
    legend: 'matching calls until this run ends',
    shortcut: 'r',
    icon: RefreshCw,
    tone: 'info',
  },
  {
    scope: 'always',
    label: APPROVAL_SCOPE_LABEL.always,
    consequence:
      'Runs this call, and matching calls stop asking in every run from now ' +
      'on. It is listed under Grants and you can take it back at any time.',
    legend: 'matching calls in every run, revocable under Grants',
    shortcut: 'l',
    icon: ShieldCheck,
    tone: 'success',
  },
];

export const DENY_COPY = {
  label: 'Deny',
  consequence:
    'This call does not run. The assistant is told to stop rather than being ' +
    'asked again, and you can attach a note saying why.',
  shortcut: 'd',
};

/** `…take it back at any time. (L)` — the tooltip form of a consequence. */
export function withShortcut(consequence: string, shortcut: string): string {
  return `${consequence} (${shortcut.toUpperCase()})`;
}

export function approveScopeCopy(scope: ApprovalScope): ApproveScopeCopy {
  return (
    APPROVE_SCOPES.find((item) => item.scope === scope) ?? APPROVE_SCOPES[0]
  );
}

/**
 * What an `always` grant will actually cover, said plainly.
 *
 * Deliberately not "every call to this tool": the gate keys grants on a
 * capability — the tool, the action, and whatever arguments that tool declares
 * security-relevant — so "matching" is the honest word, and the tool name is
 * shown next to it so the user can see the ceiling.
 */
export function alwaysGrantCoverage(toolName: string): string {
  return `Future ${toolName} calls that match this request will run without asking.`;
}

/** The keyboard legend under the queue. One line, learnable in one read. */
export const QUEUE_SHORTCUTS =
  '↑↓ move · A just this once · R this run · L always · D deny · Enter raw arguments';
