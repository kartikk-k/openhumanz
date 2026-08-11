/**
 * HomeApprovalCard — the approval gate, styled for the home / voice experience.
 *
 * Same behaviour and store wiring as the chat tab's ChatApprovalCard (a held
 * tool call the user must Allow/Deny mid-turn), but dressed in the home page's
 * ambient glass system — translucent panels, white text, soft borders — so it
 * blends with the orb experience instead of the boxy chat chrome.
 *
 * Deliberately a SEPARATE component from the chat card: the chat surface keeps
 * its own styling (needed later), and this one owns the home look.
 *
 * Decisions map to the gate exactly as chat does:
 *   Allow once    -> approve, scope `once`
 *   For this chat -> approve, scope `run`   (run id is `chat:<session>`)
 *   Always allow  -> approve, scope `always` (standing grant; confirm beat)
 *   Deny          -> deny
 */
import { useState } from 'react';
import type { Approval, ApprovalScope } from '../../../../shared/approvals';
import { usePendingApprovalsForRun, useApprovalsStore } from '../../../store';
import { usePrettyJson, argumentCount } from '../../approvals/parts';
import { chatRunId } from '../../chat/ChatApprovalCard';

/** A single pill button in the home aesthetic. */
function PillButton({
  children,
  onClick,
  disabled,
  tone = 'default',
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'primary' | 'default' | 'danger';
}) {
  const toneClasses: Record<'primary' | 'default' | 'danger', string> = {
    primary: 'bg-white/90 text-black hover:bg-white',
    danger: 'border border-white/15 text-rose-300/90 hover:text-rose-200',
    default:
      'border border-white/15 bg-white/10 text-white/80 hover:text-white',
  };
  const toneClass = toneClasses[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-full px-4 py-1.5 text-xs font-medium backdrop-blur transition disabled:opacity-50 ${toneClass}`}
    >
      {children}
    </button>
  );
}

function HomeCard({ approval }: { approval: Approval }) {
  const resolve = useApprovalsStore((s) => s.resolve);
  const resolving = useApprovalsStore((s) => s.resolving);
  const busy = resolving.includes(approval.id);
  const [expanded, setExpanded] = useState(false);
  const [confirmAlways, setConfirmAlways] = useState(false);
  const args = usePrettyJson(approval.toolArguments);
  const hasArgs = Object.keys(approval.toolArguments ?? {}).length > 0;

  const approve = (scope: ApprovalScope): void => {
    void resolve({ approvalId: approval.id, decision: 'approve', scope });
  };
  const deny = (): void => {
    void resolve({ approvalId: approval.id, decision: 'deny', scope: 'once' });
  };

  return (
    <div className="pointer-events-auto overflow-hidden rounded-3xl border border-white/10 bg-white/[0.06] p-5 backdrop-blur-xl">
      <p className="text-[11px] uppercase tracking-wider text-amber-300/70">
        Approval needed
      </p>
      <h3 className="mt-1 text-sm font-semibold leading-snug text-white/90">
        {approval.title}
      </h3>
      {approval.summary?.trim() ? (
        <p className="mt-1.5 text-[13px] leading-relaxed text-white/60">
          {approval.summary}
        </p>
      ) : (
        <p className="mt-1.5 text-xs italic text-white/40">
          This tool did not describe itself. Read the arguments before deciding.
        </p>
      )}

      {/* Details — collapsed by default; the exact payload is one click away. */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="mt-3 flex w-full items-center justify-between rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-left text-xs text-white/60 transition hover:text-white/80"
      >
        <span>Exactly what will run</span>
        <span className="text-white/40">
          {argumentCount(approval.toolArguments)}
        </span>
      </button>
      {expanded && (
        <div className="mt-2 space-y-2">
          {approval.rawDetail ? (
            <pre className="max-h-48 overflow-auto rounded-2xl border border-white/10 bg-black/30 p-3 text-[11px] leading-relaxed text-white/70">
              {approval.rawDetail}
            </pre>
          ) : null}
          {hasArgs ? (
            <pre className="max-h-56 overflow-auto rounded-2xl border border-white/10 bg-black/30 p-3 text-[11px] leading-relaxed text-white/70">
              {args}
            </pre>
          ) : (
            <p className="text-xs text-white/40">
              No arguments — approving runs {approval.toolName} exactly as
              named.
            </p>
          )}
        </div>
      )}

      {/* Choices */}
      <div className="mt-4">
        {confirmAlways ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs leading-relaxed text-white/60">
              Always allow {approval.toolName}? It will run without asking again
              — in any chat — until you revoke it in Approvals.
            </p>
            <div className="flex flex-wrap gap-2">
              <PillButton
                tone="primary"
                disabled={busy}
                onClick={() => approve('always')}
              >
                Yes, always allow
              </PillButton>
              <PillButton
                disabled={busy}
                onClick={() => setConfirmAlways(false)}
              >
                Back
              </PillButton>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <PillButton
              tone="primary"
              disabled={busy}
              onClick={() => approve('once')}
            >
              Allow once
            </PillButton>
            <PillButton disabled={busy} onClick={() => approve('run')}>
              For this chat
            </PillButton>
            <PillButton disabled={busy} onClick={() => setConfirmAlways(true)}>
              Always allow
            </PillButton>
            <PillButton tone="danger" disabled={busy} onClick={deny}>
              Deny
            </PillButton>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * All approvals waiting on the current home chat session, in the home style.
 * Renders nothing when none are pending (the common case).
 */
export function HomeApprovals({ sessionId }: { sessionId: string | null }) {
  const runId = chatRunId(sessionId);
  const pending = usePendingApprovalsForRun(runId);
  if (pending.length === 0) return null;
  return (
    <div className="flex w-full flex-col gap-3">
      {pending.map((approval) => (
        <HomeCard key={approval.id} approval={approval} />
      ))}
    </div>
  );
}

export default HomeApprovals;
