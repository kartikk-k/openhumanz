/**
 * The approval card.
 *
 * ARCHITECTURE.md calls the gate the most important mechanism in the product;
 * this is the only place a human meets it. Three properties are non-negotiable,
 * and every layout decision below serves one of them:
 *
 *  1. **Nothing is hidden.** The plain sentence is the headline, and the exact
 *     payload the tool will receive is one click away on the same card — never
 *     on another screen, never behind a hover. When the backend gives us no
 *     sentence, the raw arguments open by default rather than letting a user
 *     approve a title alone.
 *  2. **The three scopes are visibly different.** Each button carries a caption
 *     saying how far the press reaches. `always` is the consequential one and
 *     takes a second, explicit beat before it lands — see ApprovalQueue, which
 *     owns that dialog.
 *  3. **The card never reassures.** Emphasis is added for a destructive-looking
 *     call (see `risk.ts`); its absence renders as nothing at all.
 *
 * The card is presentational on purpose: it raises intent (`onApprove`,
 * `onDeny`) and the queue decides what a press means. That is what lets the
 * keyboard path and the mouse path go through exactly the same code, including
 * the same confirmation.
 */
import { useCallback, type ReactNode } from 'react';
import { Ban, FileTerminal, Hash } from 'lucide-react';
import type { Approval, ApprovalScope } from '../../../shared/approvals';
import { cn } from '../../lib/utils';
import { formatDateTime, formatRelative } from '../../lib/format';
import { approvalStatusMeta } from '../../lib/status';
import { TONE_DOT, TONE_TEXT } from '../../lib/tone';
import {
  Badge,
  Button,
  Card,
  CodeBlock,
  CollapsibleSection,
  Tooltip,
  eyebrow,
  focusRing,
  mono,
  textMuted,
} from '../../components/ui';
import { APPROVE_SCOPES, DENY_COPY, withShortcut } from './copy';
import { riskSignal } from './risk';
import {
  MetaDivider,
  MetaItem,
  argumentCount,
  usePrettyJson,
  waitedFor,
} from './parts';

/** Opaque ids are long and nobody reads past the prefix. Full value in `title`. */
function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 12)}…` : id;
}

/**
 * Visual weight for the three approve buttons.
 *
 * The scope the user configured as their default is the filled one — it is the
 * press they meant to make. `always` is deliberately the lightest of the three:
 * it must be obvious and one click away, because a gate you cannot escape is a
 * gate people quit, but it should never be the button a tired hand falls onto.
 * Its weight comes from the caption underneath and the confirmation behind it,
 * not from colour.
 */
function scopeVariant(
  scope: ApprovalScope,
  preferred: ApprovalScope,
): 'primary' | 'secondary' | 'outline' {
  if (scope === preferred) return 'primary';
  return scope === 'always' ? 'outline' : 'secondary';
}

/**
 * Whether a card starts with its arguments open.
 *
 * True when the backend gave us no sentence: in that case the payload *is* the
 * description, and a collapsed card would be an invitation to approve a title.
 */
export function defaultExpanded(approval: Approval): boolean {
  return !approval.summary?.trim();
}

export interface ApprovalCardProps {
  approval: Approval;
  /** Ticking clock from the queue, so every card agrees on "waiting 4m". */
  now: number;
  /** Keyboard selection. Drives the ring and `aria-selected`. */
  selected?: boolean;
  /** A resolve for this card is in flight; every control is inert. */
  busy?: boolean;
  /** Controlled disclosure so the queue's Enter key can toggle it. */
  expanded: boolean;
  onExpandedChange: (open: boolean) => void;
  onSelect?: () => void;
  onApprove: (approval: Approval, scope: ApprovalScope) => void;
  onDeny: (approval: Approval) => void;
  /** `settings.approvals.allowAlwaysScope`. */
  allowAlways?: boolean;
  /** `settings.approvals.defaultScope` — decides which button reads as primary. */
  defaultScope?: ApprovalScope;
  /** Jump to the run that asked. Omitted when there is nowhere to go. */
  onOpenRun?: (runId: string) => void;
  className?: string;
}

export function ApprovalCard({
  approval,
  now,
  selected = false,
  busy = false,
  expanded,
  onExpandedChange,
  onSelect,
  onApprove,
  onDeny,
  allowAlways = true,
  defaultScope = 'once',
  onOpenRun,
  className,
}: ApprovalCardProps) {
  const risk = riskSignal(approval);
  const status = approvalStatusMeta(approval.status);
  const waited = waitedFor(approval.requestedAt, now);
  const args = usePrettyJson(approval.toolArguments);
  const hasArgs = Object.keys(approval.toolArguments ?? {}).length > 0;

  // No human sentence means the arguments *are* the description. Opening them
  // by default is the difference between an informed press and a blind one.
  const hasSentence = Boolean(approval.summary?.trim());

  const scopes = APPROVE_SCOPES.filter(
    (item) => item.scope !== 'always' || allowAlways,
  );

  const handleSelect = useCallback(() => onSelect?.(), [onSelect]);

  return (
    <Card
      role="group"
      aria-label={approval.title}
      aria-busy={busy || undefined}
      data-approval-id={approval.id}
      data-selected={selected || undefined}
      // Selection follows focus: tabbing to any control inside the card makes
      // it the keyboard target, so the shortcuts always act on what you see.
      onFocusCapture={handleSelect}
      className={cn(
        'relative overflow-hidden transition-shadow',
        selected &&
          'border-indigo-300 ring-2 ring-indigo-500/30 dark:border-indigo-500/50',
        busy && 'opacity-60',
        className,
      )}
    >
      {risk ? (
        <span
          aria-hidden="true"
          className={cn(
            'absolute inset-y-0 left-0 w-[3px]',
            TONE_DOT[risk.tone],
          )}
        />
      ) : null}

      <div className={cn('px-4 pb-3 pt-3', risk && 'pl-5')}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
              <Badge tone={status.tone} icon={status.icon}>
                {waited ? `Waiting ${waited}` : status.label}
              </Badge>
              {risk ? (
                <Badge tone={risk.tone} variant="soft">
                  {risk.label}
                </Badge>
              ) : null}
              {approval.expiresAt ? (
                <Badge tone="neutral" variant="outline">
                  {`Expires ${formatRelative(approval.expiresAt, now)}`}
                </Badge>
              ) : null}
            </div>

            <h3 className="text-sm font-semibold leading-snug tracking-tight text-zinc-900 dark:text-zinc-100">
              {approval.title}
            </h3>

            {hasSentence ? (
              <p className="mt-1 text-[13px] leading-relaxed text-zinc-700 dark:text-zinc-300">
                {approval.summary}
              </p>
            ) : (
              <p className={cn('mt-1 text-xs italic', textMuted)}>
                This tool did not describe itself in words. Read the arguments
                below before deciding.
              </p>
            )}
          </div>
        </div>

        <div className="mt-2.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <MetaItem label="Tool" code>
            {approval.toolName}
          </MetaItem>
          <MetaDivider />
          <MetaItem label="Run">
            {onOpenRun ? (
              <button
                type="button"
                onClick={() => onOpenRun(approval.runId)}
                title={approval.runId}
                className={cn(
                  'rounded underline-offset-2 hover:underline',
                  mono,
                  focusRing,
                  TONE_TEXT.accent,
                )}
              >
                {shortId(approval.runId)}
              </button>
            ) : (
              <span className={mono} title={approval.runId}>
                {shortId(approval.runId)}
              </span>
            )}
          </MetaItem>
          {approval.stepId ? (
            <>
              <MetaDivider />
              <MetaItem label="Step" code>
                <span title={approval.stepId}>{shortId(approval.stepId)}</span>
              </MetaItem>
            </>
          ) : null}
          <MetaDivider />
          <MetaItem label="Asked">
            <span title={formatDateTime(approval.requestedAt)}>
              {formatRelative(approval.requestedAt, now)}
            </span>
          </MetaItem>
        </div>
      </div>

      <div className={cn('px-4 pb-3', risk && 'pl-5')}>
        <CollapsibleSection
          density="compact"
          open={expanded}
          onOpenChange={onExpandedChange}
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
                maxHeight="14rem"
              />
            ) : null}
            {hasArgs ? (
              <CodeBlock code={args} language="json" maxHeight="18rem" />
            ) : (
              <p className={cn('text-xs', textMuted)}>
                The call carries no arguments. Approving it runs{' '}
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
              <Hash size={11} aria-hidden="true" />
              <span className={eyebrow}>Match key</span>
              <span
                className={cn(mono, 'truncate')}
                title={approval.fingerprint}
              >
                {approval.fingerprint}
              </span>
            </p>
          </div>
        </CollapsibleSection>
      </div>

      <div
        className={cn(
          'flex flex-wrap items-start gap-x-2 gap-y-3 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800',
          risk && 'pl-5',
        )}
      >
        {scopes.map((item) => (
          <ActionColumn
            key={item.scope}
            caption={item.legend}
            className="min-w-[8.5rem] flex-1"
          >
            <Tooltip
              content={withShortcut(item.consequence, item.shortcut)}
              className="w-full"
            >
              <Button
                fullWidth
                size="sm"
                icon={item.icon}
                variant={scopeVariant(item.scope, defaultScope)}
                disabled={busy}
                onClick={() => onApprove(approval, item.scope)}
              >
                {item.label}
              </Button>
            </Tooltip>
          </ActionColumn>
        ))}

        <span
          aria-hidden="true"
          className="mx-1 hidden h-7 w-px shrink-0 bg-zinc-200 sm:block dark:bg-zinc-800"
        />

        <ActionColumn caption="nothing runs" className="min-w-[6rem]">
          <Tooltip
            content={withShortcut(DENY_COPY.consequence, DENY_COPY.shortcut)}
            className="w-full"
          >
            <Button
              fullWidth
              size="sm"
              icon={Ban}
              variant="outline"
              disabled={busy}
              onClick={() => onDeny(approval)}
              className={TONE_TEXT.danger}
            >
              {DENY_COPY.label}
            </Button>
          </Tooltip>
        </ActionColumn>
      </div>

      {!allowAlways ? (
        <p
          className={cn(
            'border-t border-zinc-200 px-4 py-2 text-[11px] dark:border-zinc-800',
            textMuted,
            risk && 'pl-5',
          )}
        >
          “Always allow” is switched off in Settings → Approvals, so standing
          grants cannot be created from this card.
        </p>
      ) : null}
    </Card>
  );
}

function ActionColumn({
  caption,
  className,
  children,
}: {
  caption: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {children}
      <span className="px-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-500">
        {caption}
      </span>
    </div>
  );
}

export default ApprovalCard;
