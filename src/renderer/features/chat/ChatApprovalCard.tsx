/**
 * The approval card, inline in chat.
 *
 * When a chat tool needs approval the turn does not end — the tool call is held
 * open on the backend (see `mcp/server.ts`) and the user decides right here, in
 * the conversation, then the same turn continues. This is the one surface a
 * human meets the gate during a chat; the Approvals tab is the record and the
 * management view, not where you go to answer mid-conversation.
 *
 * It is a compact sibling of the full {@link ApprovalCard}: the same non-
 * negotiables (nothing hidden — the exact payload is one click away; the scopes
 * are visibly different; no reassurance), sized for a chat bubble. The four
 * choices map to the gate's decisions:
 *
 *   Allow once   -> approve, scope `once`   (this call only)
 *   For this chat-> approve, scope `run`    (a chat's run id is `chat:<session>`)
 *   Always allow -> approve, scope `always` (standing grant, revocable in the tab)
 *   Deny         -> deny                     (the turn continues; the tool is refused)
 *
 * "Always allow" takes a second, explicit beat before it lands, exactly as the
 * queue does — a gate you cannot escape is one people quit, but it must never be
 * the button a tired hand falls onto.
 */
import { useState } from 'react';
import {
  Ban,
  Check,
  FileTerminal,
  Hash,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import type { Approval, ApprovalScope } from '../../../shared/approvals';
import { cn } from '../../lib/utils';
import {
  Button,
  CodeBlock,
  CollapsibleSection,
  eyebrow,
  mono,
  textMuted,
} from '../../components/ui';
import { usePendingApprovalsForRun, useApprovalsStore } from '../../store';
import { argumentCount, usePrettyJson } from '../approvals/parts';

/** Chat's run id for a session — the key its approvals are filed under. */
export function chatRunId(sessionId: string | null): string | null {
  return sessionId ? `chat:${sessionId}` : null;
}

interface ChoiceProps {
  approval: Approval;
  busy: boolean;
  allowAlways: boolean;
  onApprove: (scope: ApprovalScope) => void;
  onDeny: () => void;
}

/** The four buttons, with the "always" confirmation beat. */
function Choices({
  approval,
  busy,
  allowAlways,
  onApprove,
  onDeny,
}: ChoiceProps) {
  const [confirmAlways, setConfirmAlways] = useState(false);

  if (confirmAlways) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-[12px] leading-relaxed text-zinc-700 dark:text-zinc-300">
          Always allow <span className={mono}>{approval.toolName}</span>? It
          will run without asking again — in any chat — until you revoke it in
          Approvals. Arguments can differ each time.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="primary"
            icon={ShieldCheck}
            disabled={busy}
            onClick={() => onApprove('always')}
          >
            Yes, always allow
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => setConfirmAlways(false)}
          >
            Back
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="primary"
        icon={Check}
        disabled={busy}
        onClick={() => onApprove('once')}
      >
        Allow once
      </Button>
      <Button
        size="sm"
        variant="secondary"
        icon={RefreshCw}
        disabled={busy}
        onClick={() => onApprove('run')}
      >
        For this chat
      </Button>
      {allowAlways ? (
        <Button
          size="sm"
          variant="outline"
          icon={ShieldCheck}
          disabled={busy}
          onClick={() => setConfirmAlways(true)}
        >
          Always allow
        </Button>
      ) : null}
      <span
        aria-hidden="true"
        className="mx-0.5 hidden h-6 w-px bg-zinc-200 sm:block dark:bg-zinc-800"
      />
      <Button
        size="sm"
        variant="outline"
        icon={Ban}
        disabled={busy}
        onClick={onDeny}
        className="text-rose-600 dark:text-rose-400"
      >
        Deny
      </Button>
    </div>
  );
}

function OneCard({ approval }: { approval: Approval }) {
  const resolve = useApprovalsStore((s) => s.resolve);
  const resolving = useApprovalsStore((s) => s.resolving);
  const busy = resolving.includes(approval.id);
  const [expanded, setExpanded] = useState(!approval.summary?.trim());
  const args = usePrettyJson(approval.toolArguments);
  const hasArgs = Object.keys(approval.toolArguments ?? {}).length > 0;

  const approve = (scope: ApprovalScope): void => {
    void resolve({ approvalId: approval.id, decision: 'approve', scope });
  };
  const deny = (): void => {
    void resolve({ approvalId: approval.id, decision: 'deny', scope: 'once' });
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-amber-300/70 bg-amber-50/60 dark:border-amber-500/30 dark:bg-amber-500/5">
      <div className="flex items-start gap-2 px-4 pb-2 pt-3">
        <ShieldCheck
          size={16}
          aria-hidden
          className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
        />
        <div className="min-w-0 flex-1">
          <p className={cn(eyebrow, 'mb-0.5')}>Approval needed</p>
          <h3 className="text-[13.5px] font-semibold leading-snug text-zinc-900 dark:text-zinc-100">
            {approval.title}
          </h3>
          {approval.summary?.trim() ? (
            <p className="mt-1 text-[13px] leading-relaxed text-zinc-700 dark:text-zinc-300">
              {approval.summary}
            </p>
          ) : (
            <p className={cn('mt-1 text-xs italic', textMuted)}>
              This tool did not describe itself. Read the arguments below before
              deciding.
            </p>
          )}
        </div>
      </div>

      <div className="px-4 pb-2">
        <CollapsibleSection
          density="compact"
          open={expanded}
          onOpenChange={setExpanded}
          icon={FileTerminal}
          title="Exactly what will run"
          meta={
            <span className={mono}>
              {argumentCount(approval.toolArguments)}
            </span>
          }
        >
          <div className="space-y-2">
            {approval.rawDetail ? (
              <CodeBlock
                code={approval.rawDetail}
                language="request"
                wrap
                maxHeight="12rem"
              />
            ) : null}
            {hasArgs ? (
              <CodeBlock code={args} language="json" maxHeight="14rem" />
            ) : (
              <p className={cn('text-xs', textMuted)}>
                No arguments — approving runs{' '}
                <span className={mono}>{approval.toolName}</span> exactly as
                named.
              </p>
            )}
            <p
              className={cn(
                'flex items-center gap-1.5 pt-0.5 text-[11px]',
                textMuted,
              )}
            >
              <Hash size={11} aria-hidden />
              <span className={eyebrow}>Tool</span>
              <span className={mono}>{approval.toolName}</span>
            </p>
          </div>
        </CollapsibleSection>
      </div>

      <div className="border-t border-amber-300/50 px-4 py-3 dark:border-amber-500/20">
        <Choices
          approval={approval}
          busy={busy}
          allowAlways
          onApprove={approve}
          onDeny={deny}
        />
      </div>
    </div>
  );
}

/**
 * All approvals waiting on the current chat session, rendered inline. Empty
 * (renders nothing) when nothing is pending — the common case.
 */
export function ChatApprovals({ sessionId }: { sessionId: string | null }) {
  const runId = chatRunId(sessionId);
  const pending = usePendingApprovalsForRun(runId);
  if (pending.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {pending.map((approval) => (
        <OneCard key={approval.id} approval={approval} />
      ))}
    </div>
  );
}

export default ChatApprovals;
