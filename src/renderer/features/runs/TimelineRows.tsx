/**
 * One React component per flattened timeline row.
 *
 * Every row here is a *leaf* as far as the virtualizer is concerned: a step
 * header is one row, and the entries inside it are siblings, not children. That
 * is what lets the timeline virtualize and stay collapsible at the same time —
 * nothing measures a nested variable-height container.
 *
 * Two consequences shape the API:
 *
 *  - **Expansion state is owned upstream.** A row scrolled out of view is
 *    unmounted, so if a `CollapsibleSection` kept its own `open` flag the tool
 *    call you expanded would silently re-collapse when you scrolled back. Every
 *    disclosure here is controlled, keyed by entry id, and the set lives in the
 *    timeline.
 *  - **Nothing is truncated destructively.** Arguments and results collapse to
 *    a one-line précis and expand to the full payload in a `CodeBlock`. The
 *    summary is a view, never a replacement.
 */
import { useMemo, type ReactNode } from 'react';
import {
  Bot,
  Braces,
  CircleAlert,
  CornerDownRight,
  Info,
  ScrollText,
  ShieldCheck,
  Terminal,
  Timer,
  User,
  Wrench,
} from 'lucide-react';
import type { LogLevel } from '../../../shared/common';
import type { ToolCall } from '../../../shared/runs';
import { cn } from '../../lib/utils';
import { TONE_DOT, TONE_TEXT, type Tone } from '../../lib/tone';
import {
  approvalStatusMeta,
  stepStatusMeta,
  toolCallStatusMeta,
} from '../../lib/status';
import {
  formatCost,
  formatCount,
  formatDuration,
  formatJson,
  formatTime,
  truncate,
} from '../../lib/format';
import {
  Badge,
  Button,
  CodeBlock,
  CollapsibleSection,
  eyebrow,
  focusRingInset,
  mono,
  textMuted,
} from '../../components/ui';
import { FailureNotice } from './FailureNotice';
import {
  RUN_LEVEL_KEY,
  elapsedMs,
  summariseArguments,
  type TimelineEntry,
  type TimelineRow,
  type TimelineStep,
} from './timeline';

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

/** Left rail + indent. Everything inside a step hangs off this line. */
function EntryShell({
  last,
  children,
}: {
  last: boolean;
  children: ReactNode;
}) {
  return (
    <div className="pl-[15px]">
      <div
        className={cn(
          'border-l border-zinc-200 pl-3 dark:border-zinc-800',
          last ? 'pb-2' : '',
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** `09:31:04` in the gutter. Seconds matter in a timeline. */
function Stamp({ at }: { at: string }) {
  return (
    <span
      className={cn(
        'shrink-0 select-none pt-[1px] font-mono text-[10.5px] tabular-nums text-zinc-400 dark:text-zinc-600',
      )}
    >
      {formatTime(at)}
    </span>
  );
}

/** A tiny metadata chip: `12 tools`, `1m 04s`, `$0.031`. */
function Meta({
  icon: Icon,
  children,
  tone,
  title,
}: {
  icon?: typeof Timer;
  children: ReactNode;
  tone?: Tone;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap tabular-nums',
        tone ? TONE_TEXT[tone] : 'text-zinc-500 dark:text-zinc-400',
      )}
    >
      {Icon ? <Icon size={11} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

/**
 * Pretty-print a payload the agent wrote.
 *
 * Tool results arrive as a string that is usually — but not always — JSON.
 * Parsing is best-effort and never throws; a plain-text result stays plain
 * text rather than being mangled into quotes.
 */
function prettyPayload(text: string): { code: string; language: string } {
  const trimmed = text.trim();
  const looksJson =
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'));
  if (looksJson) {
    try {
      return { code: formatJson(JSON.parse(trimmed)), language: 'json' };
    } catch {
      // Not JSON after all. Fall through to plain text.
    }
  }
  return { code: text, language: 'text' };
}

/* ------------------------------------------------------------------ */
/* Step header                                                         */
/* ------------------------------------------------------------------ */

export interface StepHeaderRowProps {
  step: TimelineStep;
  open: boolean;
  onToggle: (key: string) => void;
  /** Ticking wall clock, for a step that is still running. */
  now: number;
  showCosts: boolean;
}

/**
 * The header of one step, and — when open — the step's own metadata and
 * failure explanation. The step's *entries* are separate rows that follow.
 *
 * Deliberately not a `CollapsibleSection`: this control's body is the next N
 * virtual rows rather than its own children, so it borrows that component's
 * interaction language (chevron, `aria-expanded`, inset focus ring) instead of
 * nesting a second scroll-measured container inside the virtualizer.
 */
export function StepHeaderRow({
  step,
  open,
  onToggle,
  now,
  showCosts,
}: StepHeaderRowProps) {
  const meta = stepStatusMeta(step.status);
  const Icon = meta.icon;
  const runLevel = step.key === RUN_LEVEL_KEY;
  const duration =
    step.durationMs ?? elapsedMs(step.startedAt, step.finishedAt, now);
  const cost = step.usage?.totalCostUsd;

  return (
    <div
      className={cn(
        'border-y border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60',
        '-mt-px',
      )}
    >
      <button
        type="button"
        onClick={() => onToggle(step.key)}
        aria-expanded={open}
        className={cn(
          'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors',
          'hover:bg-zinc-100 dark:hover:bg-zinc-800/60',
          focusRingInset,
        )}
      >
        <svg
          viewBox="0 0 24 24"
          width={14}
          height={14}
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className={cn(
            'shrink-0 text-zinc-400 transition-transform duration-150 dark:text-zinc-500',
            open && 'rotate-90',
          )}
        >
          <path d="m9 18 6-6-6-6" />
        </svg>

        <Icon
          size={14}
          aria-hidden="true"
          className={cn(
            'shrink-0',
            TONE_TEXT[meta.tone],
            meta.active && 'animate-spin [animation-duration:2.4s]',
          )}
        />

        {runLevel ? (
          <span className={cn('shrink-0', eyebrow)}>Run level</span>
        ) : (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-zinc-400 dark:text-zinc-600">
            {String(step.index + 1).padStart(2, '0')}
          </span>
        )}

        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-800 dark:text-zinc-200">
          {step.name}
          {step.summary ? (
            <span className="ml-2 font-normal text-zinc-500 dark:text-zinc-400">
              {truncate(step.summary, 90)}
            </span>
          ) : null}
        </span>

        <span className="flex shrink-0 items-center gap-2.5 text-[11px]">
          {step.errorCount > 0 ? (
            <Meta icon={CircleAlert} tone="danger">
              {step.errorCount}
            </Meta>
          ) : null}
          {step.toolCount > 0 ? (
            <Meta icon={Wrench} title={`${step.toolCount} tool calls`}>
              {step.toolCount}
            </Meta>
          ) : null}
          {step.usage?.turns !== undefined ? (
            <Meta title={`${step.usage.turns} turns`}>
              {formatCount(step.usage.turns)}t
            </Meta>
          ) : null}
          {duration !== undefined ? (
            <Meta icon={Timer} tone={meta.active ? 'info' : undefined}>
              {formatDuration(duration)}
            </Meta>
          ) : null}
          {showCosts && cost !== undefined ? (
            <Meta title="Step cost">{formatCost(cost)}</Meta>
          ) : null}
          {!runLevel ? (
            <Badge tone={meta.tone} variant="soft">
              {meta.label}
            </Badge>
          ) : null}
        </span>
      </button>

      {open && (step.error || step.failureKind || step.prompt || step.cwd) ? (
        <div className="space-y-2 border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
          {step.status === 'failed' || step.failureKind ? (
            <FailureNotice
              kind={step.failureKind}
              detail={step.error}
              size="compact"
            />
          ) : null}

          {step.prompt ? (
            <p className="text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-400">
              <span className={cn('mr-1.5', eyebrow)}>Prompt</span>
              {truncate(step.prompt, 260)}
            </p>
          ) : null}

          <div
            className={cn(
              'flex flex-wrap gap-x-4 gap-y-1 text-[11px]',
              textMuted,
            )}
          >
            {step.usage?.model ? (
              <span className={mono}>{step.usage.model}</span>
            ) : null}
            {step.maxTurns !== undefined ? (
              <span>max {step.maxTurns} turns</span>
            ) : null}
            {step.maxCostUsd !== undefined ? (
              <span>max {formatCost(step.maxCostUsd)}</span>
            ) : null}
            {step.cwd ? <span className={mono}>{step.cwd}</span> : null}
            {step.allowedTools.length > 0 ? (
              <span title={step.allowedTools.join(', ')}>
                {step.allowedTools.length} tools allowed
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Entries                                                             */
/* ------------------------------------------------------------------ */

const ROLE_META: Record<
  'assistant' | 'user' | 'system',
  { icon: typeof Bot; label: string; tone: Tone }
> = {
  assistant: { icon: Bot, label: 'Assistant', tone: 'accent' },
  user: { icon: User, label: 'You', tone: 'neutral' },
  system: { icon: Terminal, label: 'System', tone: 'neutral' },
};

const LOG_TONE: Record<LogLevel, Tone> = {
  debug: 'neutral',
  info: 'neutral',
  warn: 'warning',
  error: 'danger',
};

/** Longer than this and prose gets a "show all" toggle instead of a wall. */
const PROSE_CLAMP = 900;

function MessageEntry({
  entry,
  expanded,
  onToggle,
}: {
  entry: Extract<TimelineEntry, { kind: 'message' }>;
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const role = ROLE_META[entry.role];
  const RoleIcon = role.icon;
  const long = entry.text.length > PROSE_CLAMP;
  const shown =
    long && !expanded ? entry.text.slice(0, PROSE_CLAMP) : entry.text;

  return (
    <div className="flex gap-2 py-1.5">
      <Stamp at={entry.at} />
      <RoleIcon
        size={13}
        aria-hidden="true"
        className={cn('mt-[2px] shrink-0', TONE_TEXT[role.tone])}
      />
      <div className="min-w-0 flex-1">
        <p className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-zinc-700 dark:text-zinc-300">
          {shown}
          {long && !expanded ? (
            <span className="text-zinc-400 dark:text-zinc-600">…</span>
          ) : null}
        </p>
        {long ? (
          <Button
            variant="link"
            size="xs"
            className="mt-0.5 h-auto"
            onClick={() => onToggle(entry.id)}
          >
            {expanded
              ? 'Show less'
              : `Show all ${formatCount(entry.text.length)} characters`}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ToolEntry({
  entry,
  expanded,
  onToggle,
  now,
}: {
  entry: Extract<TimelineEntry, { kind: 'tool' }>;
  expanded: boolean;
  onToggle: (id: string) => void;
  now: number;
}) {
  const { call } = entry;
  const meta = toolCallStatusMeta(call.status);
  const duration =
    call.durationMs ?? elapsedMs(call.startedAt, call.finishedAt, now);
  const argCount = Object.keys(call.arguments ?? {}).length;

  const result = useMemo(
    () => (call.resultSummary ? prettyPayload(call.resultSummary) : null),
    [call.resultSummary],
  );

  return (
    <div className="py-0.5">
      <CollapsibleSection
        bare
        density="compact"
        open={expanded}
        onOpenChange={() => onToggle(entry.id)}
        icon={Wrench}
        className="rounded-md border border-transparent hover:border-zinc-200 dark:hover:border-zinc-800"
        contentClassName="border-zinc-200 dark:border-zinc-800"
        title={<span className="font-mono text-[12px]">{call.name}</span>}
        subtitle={
          <span className="font-mono text-[11.5px]">
            {summariseArguments(call.arguments)}
          </span>
        }
        meta={
          <>
            {call.sideEffecting ? (
              <Badge tone="warning" variant="outline" title="Side-effecting">
                writes
              </Badge>
            ) : null}
            {duration !== undefined ? (
              <Meta icon={Timer} tone={meta.active ? 'info' : undefined}>
                {formatDuration(duration)}
              </Meta>
            ) : null}
            <Badge tone={meta.tone} variant="soft" icon={meta.icon}>
              {meta.label}
            </Badge>
          </>
        }
      >
        <div className="space-y-2">
          <div>
            <p className={cn('mb-1 flex items-center gap-1', eyebrow)}>
              <Braces size={11} aria-hidden="true" />
              Arguments
              <span className="font-normal normal-case tracking-normal text-zinc-400">
                {argCount === 0 ? '(none)' : `(${argCount})`}
              </span>
            </p>
            <CodeBlock
              code={formatJson(call.arguments ?? {})}
              language="json"
              wrap
              maxHeight="18rem"
            />
          </div>

          {result ? (
            <div>
              <p className={cn('mb-1 flex items-center gap-1', eyebrow)}>
                <CornerDownRight size={11} aria-hidden="true" />
                Result
              </p>
              <CodeBlock
                code={result.code}
                language={result.language}
                wrap
                maxHeight="22rem"
              />
            </div>
          ) : null}

          {call.error ? (
            <div>
              <p
                className={cn(
                  'mb-1 flex items-center gap-1',
                  eyebrow,
                  TONE_TEXT.danger,
                )}
              >
                <CircleAlert size={11} aria-hidden="true" />
                Error
              </p>
              <CodeBlock
                code={call.error}
                language="error"
                wrap
                maxHeight="12rem"
              />
            </div>
          ) : null}

          <ToolFooter call={call} />
        </div>
      </CollapsibleSection>
    </div>
  );
}

function ToolFooter({ call }: { call: ToolCall }) {
  return (
    <p
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]',
        textMuted,
      )}
    >
      <span>started {formatTime(call.startedAt)}</span>
      {call.finishedAt ? (
        <span>finished {formatTime(call.finishedAt)}</span>
      ) : null}
      {call.approvalId ? (
        <span className={mono} title={call.approvalId}>
          approval {truncate(call.approvalId, 12)}
        </span>
      ) : null}
      <span className={mono} title={call.id}>
        {truncate(call.id, 14)}
      </span>
    </p>
  );
}

function ApprovalEntry({
  entry,
  expanded,
  onToggle,
}: {
  entry: Extract<TimelineEntry, { kind: 'approval' }>;
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const { approval } = entry;
  const decided = entry.decision;
  let status = approval.status;
  if (decided === 'approve') status = 'approved';
  if (decided === 'deny') status = 'denied';
  const meta = approvalStatusMeta(status);

  return (
    <div className="py-1">
      <div
        className={cn(
          'rounded-md border px-2.5 py-2',
          decided === undefined && approval.status === 'pending'
            ? 'border-amber-300 bg-amber-50/60 dark:border-amber-500/40 dark:bg-amber-500/10'
            : 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900',
        )}
      >
        <div className="flex items-start gap-2">
          <ShieldCheck
            size={13}
            aria-hidden="true"
            className={cn('mt-[2px] shrink-0', TONE_TEXT[meta.tone])}
          />
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] font-medium text-zinc-800 dark:text-zinc-200">
              {approval.title}
            </p>
            {approval.summary ? (
              <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-400">
                {approval.summary}
              </p>
            ) : null}
            <p
              className={cn(
                'mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px]',
                textMuted,
              )}
            >
              <span className={mono}>{approval.toolName}</span>
              <span>{formatTime(approval.requestedAt)}</span>
              {entry.scope ? <span>scope: {entry.scope}</span> : null}
            </p>
          </div>
          <Badge tone={meta.tone} variant="soft" icon={meta.icon}>
            {meta.label}
          </Badge>
        </div>

        <div className="mt-1.5 pl-[21px]">
          <Button
            variant="link"
            size="xs"
            className="h-auto"
            onClick={() => onToggle(entry.id)}
          >
            {expanded ? 'Hide request' : 'Show request'}
          </Button>
          {expanded ? (
            <div className="mt-1.5 space-y-2">
              <CodeBlock
                code={formatJson(approval.toolArguments ?? {})}
                language="json"
                wrap
                maxHeight="16rem"
              />
              {approval.rawDetail ? (
                <CodeBlock
                  code={approval.rawDetail}
                  language="raw"
                  wrap
                  maxHeight="12rem"
                />
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function LogEntry({
  entry,
}: {
  entry: Extract<TimelineEntry, { kind: 'log' }>;
}) {
  const tone = LOG_TONE[entry.level];
  const Icon =
    entry.level === 'error' || entry.level === 'warn' ? CircleAlert : Info;

  return (
    <div className="flex items-start gap-2 py-1">
      <Stamp at={entry.at} />
      <Icon
        size={12}
        aria-hidden="true"
        className={cn('mt-[2px] shrink-0', TONE_TEXT[tone])}
      />
      <span
        className={cn(
          'min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed',
          entry.level === 'error' || entry.level === 'warn'
            ? TONE_TEXT[tone]
            : 'text-zinc-500 dark:text-zinc-500',
        )}
      >
        {entry.message}
      </span>
    </div>
  );
}

export interface EntryRowProps {
  entry: TimelineEntry;
  last: boolean;
  expanded: boolean;
  onToggle: (id: string) => void;
  now: number;
}

/** Dispatch one timeline entry to its renderer, inside the step's rail. */
export function EntryRow({
  entry,
  last,
  expanded,
  onToggle,
  now,
}: EntryRowProps) {
  return (
    <EntryShell last={last}>
      {entry.kind === 'message' ? (
        <MessageEntry entry={entry} expanded={expanded} onToggle={onToggle} />
      ) : null}
      {entry.kind === 'tool' ? (
        <ToolEntry
          entry={entry}
          expanded={expanded}
          onToggle={onToggle}
          now={now}
        />
      ) : null}
      {entry.kind === 'approval' ? (
        <ApprovalEntry entry={entry} expanded={expanded} onToggle={onToggle} />
      ) : null}
      {entry.kind === 'log' ? <LogEntry entry={entry} /> : null}
    </EntryShell>
  );
}

/** "N quiet log lines hidden" — the receipt for the chatter filter. */
export function QuietRow({
  hidden,
  onShow,
}: {
  hidden: number;
  onShow: () => void;
}) {
  return (
    <EntryShell last>
      <div className="flex items-center gap-2 py-1.5">
        <ScrollText size={12} aria-hidden="true" className="text-zinc-400" />
        <span className={cn('text-[11.5px]', textMuted)}>
          {hidden} quiet log line{hidden === 1 ? '' : 's'} hidden
        </span>
        <Button variant="link" size="xs" className="h-auto" onClick={onShow}>
          Show them
        </Button>
      </div>
    </EntryShell>
  );
}

/** A step that started and produced nothing. Said out loud, not left blank. */
export function EmptyStepRow({ step }: { step: TimelineStep }) {
  return (
    <EntryShell last>
      <p className={cn('py-1.5 text-[11.5px] italic', textMuted)}>
        {step.status === 'pending'
          ? 'Not started yet.'
          : 'No events recorded for this step.'}
      </p>
    </EntryShell>
  );
}

/* ------------------------------------------------------------------ */
/* Sizing                                                              */
/* ------------------------------------------------------------------ */

/**
 * First-paint height guess per row type. The virtualizer measures for real
 * once a row mounts; this only has to be close enough that the scrollbar does
 * not lurch on the way down.
 */
export function estimateRowSize(row: TimelineRow): number {
  switch (row.type) {
    case 'step':
      return row.open ? 78 : 37;
    case 'entry':
      switch (row.entry.kind) {
        case 'message':
          return Math.min(260, 48 + Math.ceil(row.entry.text.length / 90) * 19);
        case 'tool':
          return 32;
        case 'approval':
          return 92;
        default:
          return 26;
      }
    default:
      return 32;
  }
}

/** Stable per-row dot colour for the density strip in the timeline header. */
export const ENTRY_TONE: Record<TimelineEntry['kind'], string> = {
  message: TONE_DOT.accent,
  tool: TONE_DOT.info,
  approval: TONE_DOT.warning,
  log: TONE_DOT.neutral,
};
