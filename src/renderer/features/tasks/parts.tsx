/**
 * Pieces the task board and the goals panel share.
 *
 *  - {@link BridgeNotice}     what a dead IPC channel looks like
 *  - {@link Progress}         `3/5` with a hairline bar — plan and criteria
 *  - {@link ChecklistEditor}  the ordered-list editor behind both the execution
 *                             plan and the acceptance criteria
 *  - {@link EvidenceEditor}   label + ref rows
 *  - {@link InlineText}       a text field that saves when you leave it
 *  - board naming helpers
 *
 * `BridgeNotice` is deliberately a copy of the schedule screen's rather than a
 * shared component: `components/shared/` belongs to the app, not to a feature,
 * and two features may not import each other's internals. If a third screen
 * needs it, it should be promoted into the design system.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  Link2,
  Plus,
  PlugZap,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { Evidence, Task } from '../../../shared/tasks';
import { cn } from '../../lib/utils';
import { TONE_TEXT, type Tone } from '../../lib/tone';
import type { IpcError } from '../../lib/ipc';
import { Button, CodeBlock, Input } from '../../components/ui';
import {
  eyebrow,
  focusRing,
  mono,
  textMuted,
} from '../../components/ui/styles';

/* ------------------------------------------------------------------ */
/* Boards                                                              */
/* ------------------------------------------------------------------ */

/** A board the switcher can show: the standing one, or one conversation. */
export interface BoardRef {
  key: string;
  label: string;
  board: 'personal' | 'conversation';
  conversationId?: string;
  count: number;
  /** Most recent `updatedAt` on the board, for ordering the rail. */
  touchedAt: string;
}

export const PERSONAL_BOARD: BoardRef = {
  key: 'personal',
  label: 'Personal',
  board: 'personal',
  count: 0,
  touchedAt: '',
};

/**
 * The boards present in a set of cards.
 *
 * Conversation boards are discovered rather than declared — a run creates one
 * by writing a card with its own id on it, so the switcher has to be derived
 * from the data.
 */
export function boardsFrom(tasks: readonly Task[]): BoardRef[] {
  const personal = tasks.filter((task) => task.board !== 'conversation');
  const byConversation = new Map<string, Task[]>();
  for (const task of tasks) {
    if (task.board !== 'conversation') continue;
    const id = task.conversationId ?? 'unassigned';
    const bucket = byConversation.get(id);
    if (bucket) bucket.push(task);
    else byConversation.set(id, [task]);
  }

  const conversations: BoardRef[] = [...byConversation.entries()].map(
    ([conversationId, cards]) => ({
      key: `conversation:${conversationId}`,
      label: conversationLabel(conversationId, cards),
      board: 'conversation' as const,
      conversationId,
      count: cards.length,
      touchedAt: cards.reduce(
        (latest, card) => (card.updatedAt > latest ? card.updatedAt : latest),
        '',
      ),
    }),
  );
  conversations.sort((a, b) => (a.touchedAt < b.touchedAt ? 1 : -1));

  return [
    {
      ...PERSONAL_BOARD,
      count: personal.length,
      touchedAt: personal.reduce(
        (latest, card) => (card.updatedAt > latest ? card.updatedAt : latest),
        '',
      ),
    },
    ...conversations,
  ];
}

/** A conversation board's name: whatever the cards call it, else the id. */
function conversationLabel(
  conversationId: string,
  cards: readonly Task[],
): string {
  const named = cards.find(
    (card) => typeof card.metadata?.boardTitle === 'string',
  );
  if (named) return String(named.metadata.boardTitle);
  return conversationId;
}

/* ------------------------------------------------------------------ */
/* Progress                                                            */
/* ------------------------------------------------------------------ */

export interface ProgressProps {
  done: number;
  total: number;
  label: string;
  className?: string;
}

/** `Plan 3/5` with a hairline bar. Reads at a glance across twenty cards. */
export function Progress({ done, total, label, className }: ProgressProps) {
  if (total === 0) return null;
  const complete = done >= total;
  const percent = Math.round((done / total) * 100);
  return (
    <span
      className={cn('inline-flex items-center gap-1.5', className)}
      title={`${label}: ${done} of ${total}`}
    >
      <span className={cn('text-[10.5px] tabular-nums', textMuted)}>
        {label} {done}/{total}
      </span>
      <span className="h-1 w-8 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <span
          className={cn(
            'block h-full rounded-full',
            complete ? 'bg-emerald-500' : 'bg-indigo-500',
          )}
          style={{ width: `${percent}%` }}
        />
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Checklist editor                                                    */
/* ------------------------------------------------------------------ */

export interface ChecklistItem {
  text: string;
  checked: boolean;
}

export interface ChecklistEditorProps {
  items: readonly ChecklistItem[];
  /** `ordered` numbers the rows — the execution plan is a sequence. */
  ordered?: boolean;
  addLabel: string;
  emptyHint: string;
  disabled?: boolean;
  onChange: (items: ChecklistItem[]) => void;
}

/**
 * The editor behind both the execution plan and the acceptance criteria.
 *
 * Every mutation is a whole-array replacement handed straight back to the
 * caller, which writes it through `tasks:update`. Order is array order, so
 * moving a step is a swap, not an index rewrite.
 */
export function ChecklistEditor({
  items,
  ordered = false,
  addLabel,
  emptyHint,
  disabled = false,
  onChange,
}: ChecklistEditorProps) {
  const [draft, setDraft] = useState('');

  const replace = (index: number, next: Partial<ChecklistItem>) => {
    onChange(
      items.map((item, position) =>
        position === index ? { ...item, ...next } : item,
      ),
    );
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    onChange([...items, { text, checked: false }]);
    setDraft('');
  };

  return (
    <div className="space-y-1">
      {items.length === 0 ? (
        <p className={cn('py-1 text-[12px] leading-relaxed', textMuted)}>
          {emptyHint}
        </p>
      ) : null}

      <ol className="space-y-0.5">
        {items.map((item, index) => (
          <li
            // Position is the identity here: these rows have no ids and the
            // list is short, ordered and fully controlled.
            // eslint-disable-next-line react/no-array-index-key
            key={`${index}-${item.text}`}
            className="group flex items-start gap-1.5 rounded px-1 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-900/60"
          >
            <button
              type="button"
              role="checkbox"
              aria-checked={item.checked}
              disabled={disabled}
              onClick={() => replace(index, { checked: !item.checked })}
              className={cn(
                'mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border transition-colors',
                focusRing,
                item.checked
                  ? 'border-emerald-500 bg-emerald-500 text-white'
                  : 'border-zinc-300 hover:border-zinc-400 dark:border-zinc-600',
              )}
            >
              {item.checked ? (
                <Check size={10} strokeWidth={3} aria-hidden="true" />
              ) : null}
            </button>

            {ordered ? (
              <span
                className={cn(
                  'mt-[2px] w-4 shrink-0 text-right text-[11px] tabular-nums',
                  textMuted,
                )}
              >
                {index + 1}
              </span>
            ) : null}

            <InlineText
              value={item.text}
              disabled={disabled}
              onCommit={(text) =>
                text.trim()
                  ? replace(index, { text: text.trim() })
                  : onChange(items.filter((_, position) => position !== index))
              }
              className={cn(
                'min-w-0 flex-1 text-[12.5px] leading-snug',
                item.checked && 'text-zinc-400 line-through dark:text-zinc-600',
              )}
            />

            <span className="flex shrink-0 items-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
              <Button
                size="icon-sm"
                variant="ghost"
                icon={ArrowUp}
                disabled={disabled || index === 0}
                aria-label="Move up"
                onClick={() => move(index, -1)}
              />
              <Button
                size="icon-sm"
                variant="ghost"
                icon={ArrowDown}
                disabled={disabled || index === items.length - 1}
                aria-label="Move down"
                onClick={() => move(index, 1)}
              />
              <Button
                size="icon-sm"
                variant="ghost"
                icon={X}
                disabled={disabled}
                aria-label="Remove"
                onClick={() =>
                  onChange(items.filter((_, position) => position !== index))
                }
              />
            </span>
          </li>
        ))}
      </ol>

      <div className="flex items-center gap-1.5 pt-0.5">
        <Input
          size="sm"
          value={draft}
          disabled={disabled}
          placeholder={addLabel}
          aria-label={addLabel}
          containerClassName="flex-1"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
        />
        <Button
          size="sm"
          variant="outline"
          icon={Plus}
          disabled={disabled || !draft.trim()}
          onClick={add}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Evidence                                                            */
/* ------------------------------------------------------------------ */

export function EvidenceEditor({
  items,
  disabled = false,
  onChange,
}: {
  items: readonly Evidence[];
  disabled?: boolean;
  onChange: (items: Evidence[]) => void;
}) {
  const [label, setLabel] = useState('');
  const [ref, setRef] = useState('');

  const add = () => {
    if (!label.trim()) return;
    onChange([...items, { label: label.trim(), ref: ref.trim() }]);
    setLabel('');
    setRef('');
  };

  return (
    <div className="space-y-1">
      {items.length === 0 ? (
        <p className={cn('py-1 text-[12px] leading-relaxed', textMuted)}>
          Nothing attached yet. Evidence is what shows the work actually
          happened — a run id, a file path, a link.
        </p>
      ) : null}

      <ul className="space-y-0.5">
        {items.map((item, index) => (
          <li
            // eslint-disable-next-line react/no-array-index-key
            key={`${index}-${item.label}`}
            className="group flex items-center gap-2 rounded px-1 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-900/60"
          >
            <Link2
              size={12}
              aria-hidden="true"
              className="shrink-0 text-zinc-400 dark:text-zinc-500"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] text-zinc-700 dark:text-zinc-300">
                {item.label}
              </span>
              {item.ref ? (
                <span
                  className={cn('block truncate text-[11px]', mono, textMuted)}
                >
                  {item.ref}
                </span>
              ) : null}
            </span>
            <Button
              size="icon-sm"
              variant="ghost"
              icon={X}
              disabled={disabled}
              aria-label={`Remove ${item.label}`}
              className="shrink-0 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
              onClick={() =>
                onChange(items.filter((_, position) => position !== index))
              }
            />
          </li>
        ))}
      </ul>

      <div className="flex items-center gap-1.5 pt-0.5">
        <Input
          size="sm"
          value={label}
          disabled={disabled}
          placeholder="Label"
          aria-label="Evidence label"
          containerClassName="w-32 shrink-0"
          onChange={(event) => setLabel(event.target.value)}
        />
        <Input
          size="sm"
          value={ref}
          disabled={disabled}
          placeholder="run id, path or URL"
          aria-label="Evidence reference"
          containerClassName="flex-1"
          onChange={(event) => setRef(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
        />
        <Button
          size="sm"
          variant="outline"
          icon={Plus}
          disabled={disabled || !label.trim()}
          onClick={add}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Inline text                                                         */
/* ------------------------------------------------------------------ */

export interface InlineTextProps {
  value: string;
  onCommit: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  multiline?: boolean;
  className?: string;
  'aria-label'?: string;
}

/**
 * Click-to-edit text.
 *
 * Commits on blur and on Enter (Escape reverts), because a board where every
 * edit needs a save button is a board nobody keeps up to date. A `contentEditable`
 * would be fewer lines and worse: no undo stack, no IME support, no placeholder.
 */
export function InlineText({
  value,
  onCommit,
  disabled = false,
  placeholder = 'Empty',
  multiline = false,
  className,
  'aria-label': ariaLabel,
}: InlineTextProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (draft !== value) onCommit(draft);
  };

  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };

  if (!editing) {
    return (
      <button
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        onClick={() => setEditing(true)}
        className={cn(
          'w-full rounded px-1 py-0.5 text-left transition-colors',
          'hover:bg-zinc-100 dark:hover:bg-zinc-800/70',
          focusRing,
          !value && 'text-zinc-400 dark:text-zinc-600',
          multiline && 'whitespace-pre-wrap',
          className,
        )}
      >
        {value || placeholder}
      </button>
    );
  }

  const shared = {
    value: draft,
    'aria-label': ariaLabel,
    onBlur: commit,
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => setDraft(event.target.value),
    className: cn(
      'w-full rounded border border-indigo-500 bg-white px-1 py-0.5 outline-none ring-2 ring-indigo-500/40',
      'dark:bg-zinc-950',
      className,
    ),
  };

  if (multiline) {
    return (
      <textarea
        {...shared}
        ref={(node) => {
          ref.current = node;
        }}
        rows={3}
        onKeyDown={(event) => {
          if (event.key === 'Escape') cancel();
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            commit();
          }
        }}
      />
    );
  }

  return (
    <input
      {...shared}
      ref={(node) => {
        ref.current = node;
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') cancel();
        if (event.key === 'Enter') commit();
      }}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Section heading                                                     */
/* ------------------------------------------------------------------ */

export function Section({
  title,
  meta,
  children,
  className,
}: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('px-4 py-3', className)}>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <h3 className={eyebrow}>{title}</h3>
        {meta}
      </div>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Channel failures                                                    */
/* ------------------------------------------------------------------ */

export interface BridgeNoticeProps {
  error: IpcError;
  /** What the user was trying to see, e.g. `the task board`. */
  subject: string;
  actions?: ReactNode;
  className?: string;
}

export function BridgeNotice({
  error,
  subject,
  actions,
  className,
}: BridgeNoticeProps) {
  const unavailable = error.isUnavailable;
  const tone: Tone = unavailable ? 'warning' : 'danger';
  const Icon = unavailable ? PlugZap : TriangleAlert;

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border',
        unavailable
          ? 'border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-500/10'
          : 'border-rose-300 bg-rose-50 dark:border-rose-500/40 dark:bg-rose-500/10',
        className,
      )}
    >
      <div className="flex gap-3 px-4 py-3.5">
        <Icon
          size={17}
          aria-hidden="true"
          className={cn('mt-0.5 shrink-0', TONE_TEXT[tone])}
        />
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-semibold text-zinc-900 dark:text-zinc-100">
            {unavailable
              ? `Not connected to the backend, so ${subject} cannot be loaded.`
              : `Could not load ${subject}.`}
          </p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-zinc-700 dark:text-zinc-300">
            {unavailable
              ? 'The main process has not registered this channel yet. Nothing is lost — the screen fills in the moment it does.'
              : error.message}
          </p>
          <CodeBlock
            code={`${error.channel}\n${error.code}: ${error.message}`}
            language="ipc"
            wrap
            className="mt-2.5 bg-white/70 dark:bg-zinc-950/60"
          />
          {actions ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {actions}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
