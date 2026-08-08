/**
 * Decision history.
 *
 * The durable log already exists in main: `approvals_audit` stores every
 * decision with the full arguments it was made about, and `ApprovalService`
 * exposes `queryAudit(filter)` over it. What does not exist is a way to ask for
 * it from the renderer — `src/shared/ipc.ts` declares four approvals channels
 * (`list-pending`, `resolve`, `list-grants`, `revoke-grant`) and the approvals
 * module registers exactly those four. Inventing a fifth name here would
 * compile and then fail forever, so this panel shows what it can legitimately
 * observe — the decisions this window made, with their arguments — and states
 * the gap in the UI rather than papering over it.
 *
 * The stand-in is labelled as one on screen. A history surface that quietly
 * omits decisions made yesterday, or made by a standing grant, would be worse
 * than no history surface at all: it would look complete.
 */
import { useCallback, useState } from 'react';
import { History, Info, Trash2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { formatDateTime, formatRelative } from '../../lib/format';
import { APPROVAL_SCOPE_LABEL, approvalStatusMeta } from '../../lib/status';
import {
  Badge,
  Button,
  CodeBlock,
  CollapsibleSection,
  EmptyState,
  eyebrow,
  mono,
  textMuted,
} from '../../components/ui';
import { NoticePanel, usePrettyJson } from './parts';
import { useDecisionLog, type DecisionRecord } from './decisionLog';

/** The channel that would make this panel real. Named once, here. */
const MISSING_CHANNEL = 'approvals:list-audit';

export interface HistoryPanelProps {
  now: number;
  className?: string;
}

export function HistoryPanel({ now, className }: HistoryPanelProps) {
  const entries = useDecisionLog((state) => state.entries);
  const clear = useDecisionLog((state) => state.clear);

  return (
    <div className={cn('space-y-3', className)}>
      <NoticePanel
        tone="info"
        icon={Info}
        eyebrow="Partial view"
        title="This is every decision made in this window, not the full log"
        detail={`missing channel · ${MISSING_CHANNEL}`}
      >
        Main keeps the real thing —{' '}
        <span className={mono}>approvals_audit</span> holds every decision with
        the arguments it was made about, including the ones a standing grant
        made for you. There is no IPC channel that reads it, so this list starts
        empty every time the app restarts. Adding{' '}
        <span className={mono}>{MISSING_CHANNEL}</span> to{' '}
        <span className={mono}>src/shared/ipc.ts</span> over the existing{' '}
        <span className={mono}>queryAudit()</span> is the whole fix.
      </NoticePanel>

      {entries.length === 0 ? (
        <EmptyState
          icon={History}
          size="sm"
          title="No decisions yet in this session"
          description="Answer something in the queue and it is recorded here, with the exact arguments it was answered about."
        />
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <p className={eyebrow}>
              {entries.length === 1
                ? '1 decision this session'
                : `${entries.length} decisions this session`}
            </p>
            <Button size="xs" variant="ghost" icon={Trash2} onClick={clear}>
              Clear
            </Button>
          </div>

          <div className="space-y-1.5">
            {entries.map((entry) => (
              <DecisionRow key={entry.id} entry={entry} now={now} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function DecisionRow({ entry, now }: { entry: DecisionRecord; now: number }) {
  const [open, setOpen] = useState(false);
  const args = usePrettyJson(entry.toolArguments);
  const meta = approvalStatusMeta(
    entry.decision === 'approve' ? 'approved' : 'denied',
  );
  const onOpenChange = useCallback((next: boolean) => setOpen(next), []);

  return (
    <CollapsibleSection
      density="compact"
      open={open}
      onOpenChange={onOpenChange}
      title={entry.title}
      subtitle={<span className={mono}>{entry.toolName}</span>}
      meta={
        <>
          <Badge tone={meta.tone} icon={meta.icon}>
            {meta.label}
          </Badge>
          {entry.decision === 'approve' ? (
            <span className={textMuted}>
              {APPROVAL_SCOPE_LABEL[entry.scope]}
            </span>
          ) : null}
          <span title={formatDateTime(entry.at)}>
            {formatRelative(entry.at, now)}
          </span>
        </>
      }
    >
      <div className="space-y-2">
        {entry.summary ? (
          <p className="text-[13px] leading-relaxed text-zinc-700 dark:text-zinc-300">
            {entry.summary}
          </p>
        ) : null}
        {entry.reason ? (
          <p className={cn('text-xs italic', textMuted)}>
            Reason given: “{entry.reason}”
          </p>
        ) : null}
        <CodeBlock code={args} language="json" maxHeight="16rem" />
        <p
          className={cn(
            'flex flex-wrap gap-x-3 gap-y-1 text-[11px]',
            textMuted,
          )}
        >
          <span>
            <span className={eyebrow}>Decided by</span>{' '}
            <span className={mono}>{entry.decidedBy}</span>
          </span>
          <span>
            <span className={eyebrow}>Run</span>{' '}
            <span className={mono} title={entry.runId}>
              {entry.runId.slice(0, 12)}
            </span>
          </span>
          <span>
            <span className={eyebrow}>At</span> {formatDateTime(entry.at)}
          </span>
        </p>
      </div>
    </CollapsibleSection>
  );
}

export default HistoryPanel;
