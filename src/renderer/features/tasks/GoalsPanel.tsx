/**
 * Long-term goals.
 *
 * Goals are not rows in a table — they live in `GOALS.md`, a file the user can
 * open and edit by hand, and the whole list is prepended to every turn the
 * agent takes. That per-turn cost is why there is a hard cap of eight items and
 * a ~500-token budget, and it is why this panel *shows* the cap instead of
 * silently refusing the ninth write: "the list is full, here is what is in it,
 * which one is finished?" is the conversation the cap exists to force.
 *
 * The backend enforces both limits and returns its own sentence when a write
 * would break one; that sentence is shown verbatim rather than replaced with a
 * generic error, because it names the goals that are already there.
 */
import { useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  FileText,
  Plus,
  Target,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { IPC, IPC_PUSH } from '../../../shared/ipc';
import {
  GOAL_HORIZONS,
  GOAL_STATUSES,
  type Goal,
  type GoalHorizon,
  type GoalStatus,
} from '../../../shared/tasks';
import { cn } from '../../lib/utils';
import { useMutation, useQuery } from '../../lib/ipc';
import { formatDate, pluralize } from '../../lib/format';
import { goalStatusMeta } from '../../lib/status';
import { TONE_TEXT } from '../../lib/tone';
import { toast } from '../../store/toastStore';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Input,
  Select,
  Spinner,
  StatusDot,
} from '../../components/ui';
import { eyebrow, textMuted } from '../../components/ui/styles';
import { BridgeNotice, InlineText } from './parts';

/**
 * The item cap, mirroring `MAX_GOALS` in `src/main/modules/goals/schema.ts`.
 *
 * Duplicated rather than imported: the renderer may not reach into `main/`, and
 * the constant is not in `src/shared/`. It is only used to *warn* — the backend
 * is what enforces it, and this screen believes the backend's answer over its
 * own arithmetic.
 */
const GOAL_CAP = 8;

/** Mirrors `MAX_GOAL_TOKENS`. Same caveat as {@link GOAL_CAP}. */
const TOKEN_BUDGET = 500;

/** Mirrors the backend's estimate: four characters per token. */
function estimateTokens(goals: readonly Goal[]): number {
  const text = goals
    .map((goal) => `${goal.title} ${goal.metric} ${goal.description}`)
    .join(' ');
  return Math.ceil(text.length / 4);
}

const HORIZON_OPTIONS = GOAL_HORIZONS.map((horizon) => ({
  value: horizon,
  label: horizon,
}));

const STATUS_OPTIONS = GOAL_STATUSES.map((status) => ({
  value: status,
  label: goalStatusMeta(status).label,
}));

export interface GoalsPanelProps {
  className?: string;
}

export function GoalsPanel({ className }: GoalsPanelProps) {
  const goals = useQuery(
    IPC.goals.list,
    {},
    { refetchOn: [IPC_PUSH.goalsChanged] },
  );
  const write = useMutation(IPC.goals.write);
  const remove = useMutation(IPC.goals.remove);

  const [title, setTitle] = useState('');
  const [horizon, setHorizon] = useState<GoalHorizon>('quarter');
  const [metric, setMetric] = useState('');
  const [pendingDelete, setPendingDelete] = useState<Goal | null>(null);
  const [rejection, setRejection] = useState<string | null>(null);

  const ordered = useMemo(
    () =>
      [...(goals.data ?? [])].sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        return a.createdAt < b.createdAt ? -1 : 1;
      }),
    [goals.data],
  );

  const live = ordered.filter(
    (goal) => goal.status === 'active' || goal.status === 'paused',
  );
  const atCap = ordered.length >= GOAL_CAP;
  const tokens = estimateTokens(ordered);
  const overBudget = tokens > TOKEN_BUDGET;

  const save = async (
    patch: Parameters<typeof write.mutate>[0],
    successMessage?: string,
  ) => {
    setRejection(null);
    const saved = await write.mutate(patch);
    if (!saved) {
      // The budget error carries the useful sentence — it names what is
      // already in the list. Show it as written.
      setRejection(
        write.error?.isUnavailable
          ? 'Not connected to the backend, so GOALS.md could not be written. Nothing was changed.'
          : (write.error?.message ?? 'The goal could not be saved.'),
      );
      return false;
    }
    if (successMessage) toast.success(successMessage);
    void goals.refetch();
    return true;
  };

  const add = async () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    const ok = await save(
      {
        title: trimmed,
        horizon,
        metric: metric.trim(),
        status: 'active',
        order: ordered.length,
      },
      `Added “${trimmed}”`,
    );
    if (ok) {
      setTitle('');
      setMetric('');
    }
  };

  /**
   * Reorder by renumbering. Only the goals whose position actually moved are
   * written, so a swap is two writes rather than eight.
   */
  const move = async (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= ordered.length) return;
    const next = [...ordered];
    [next[index], next[target]] = [next[target], next[index]];

    setRejection(null);
    const changed = next
      .map((goal, position) => ({ goal, position }))
      .filter(({ goal, position }) => goal.order !== position);

    for (const { goal, position } of changed) {
      // Sequential on purpose: every write is a read-modify-write against
      // GOALS.md, and firing them together would race for the same file.
      // eslint-disable-next-line no-await-in-loop
      const saved = await write.mutate({
        id: goal.id,
        title: goal.title,
        order: position,
      });
      if (!saved) {
        setRejection(
          write.error?.isUnavailable
            ? 'Not connected to the backend, so the order could not be saved.'
            : (write.error?.message ?? 'The order could not be saved.'),
        );
        break;
      }
    }
    void goals.refetch();
  };

  const confirmDelete = async () => {
    const goal = pendingDelete;
    if (!goal) return;
    const deleted = await remove.mutate({ id: goal.id });
    setPendingDelete(null);
    if (!deleted) {
      toast.error(`Could not remove “${goal.title}”`, {
        description: remove.error?.isUnavailable
          ? 'Not connected to the backend. GOALS.md is untouched.'
          : remove.error?.message,
      });
      return;
    }
    toast.success(`Removed “${goal.title}”`);
    void goals.refetch();
  };

  return (
    <div className={cn('mx-auto w-full max-w-3xl p-5', className)}>
      <header className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h2 className="text-[14px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            Long-term goals
          </h2>
          <p className={cn('mt-0.5 text-[12px] leading-relaxed', textMuted)}>
            The standing intent tasks are measured against. Stored as{' '}
            <span className="font-mono text-[11px]">GOALS.md</span> in the
            workspace, so you can edit it in any editor and the app will pick it
            up.
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p
            className={cn(
              'text-[13px] font-semibold tabular-nums',
              atCap ? TONE_TEXT.warning : 'text-zinc-700 dark:text-zinc-300',
            )}
          >
            {ordered.length} of {GOAL_CAP}
          </p>
          <p
            className={cn(
              'text-[11px] tabular-nums',
              overBudget ? TONE_TEXT.warning : textMuted,
            )}
            title="The list is prepended to every turn, so its size is paid per request."
          >
            ~{tokens} / {TOKEN_BUDGET} tokens
          </p>
        </div>
      </header>

      {goals.error ? (
        <BridgeNotice
          error={goals.error}
          subject="your goals"
          className="mb-3"
          actions={
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void goals.refetch();
              }}
            >
              Try again
            </Button>
          }
        />
      ) : null}

      {rejection ? (
        <div className="mb-3 flex gap-2.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 dark:border-amber-500/40 dark:bg-amber-500/10">
          <TriangleAlert
            size={15}
            aria-hidden="true"
            className={cn('mt-0.5 shrink-0', TONE_TEXT.warning)}
          />
          <p className="text-[12.5px] leading-relaxed text-amber-900 dark:text-amber-200">
            {rejection}
          </p>
        </div>
      ) : null}

      {goals.loading ? (
        <div className="flex items-center gap-2 py-10 text-[13px] text-zinc-500">
          <Spinner size="sm" label={null} />
          Loading goals…
        </div>
      ) : null}

      {!goals.loading && !goals.error && ordered.length === 0 ? (
        <EmptyState
          icon={Target}
          title="No long-term goals yet"
          description="Goals are the intent behind the board — up to eight of them, in your own words, with your own measure of progress. The assistant reads them every turn and can propose changes, but only you decide what is on the list."
        />
      ) : null}

      {ordered.length > 0 ? (
        <ol className="space-y-1.5">
          {ordered.map((goal, index) => (
            <GoalRow
              key={goal.id}
              goal={goal}
              index={index}
              total={ordered.length}
              onMove={(delta) => {
                void move(index, delta);
              }}
              onPatch={(patch) => {
                void save({ id: goal.id, title: goal.title, ...patch });
              }}
              onDelete={() => setPendingDelete(goal)}
            />
          ))}
        </ol>
      ) : null}

      {/* add ------------------------------------------------------- */}
      <div className="mt-4 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
        <p className={cn('mb-2', eyebrow)}>Add a goal</p>

        {atCap ? (
          <div className="flex gap-2.5">
            <TriangleAlert
              size={15}
              aria-hidden="true"
              className={cn('mt-0.5 shrink-0', TONE_TEXT.warning)}
            />
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">
                The list is full — {GOAL_CAP} of {GOAL_CAP}.
              </p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-zinc-700 dark:text-zinc-300">
                Every goal is injected into every turn, so the cap is a running
                cost, not a style rule. Mark one achieved, drop one, or shorten
                the list before adding another.{' '}
                {live.length > 0
                  ? `${pluralize(live.length, 'goal is', 'goals are')} still open.`
                  : ''}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-end gap-2">
            <Input
              size="sm"
              label="Goal"
              value={title}
              placeholder="Ship the assistant to my own machine and use it daily"
              containerClassName="flex-1"
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void add();
                }
              }}
            />
            <Select
              size="sm"
              label="Horizon"
              value={horizon}
              options={HORIZON_OPTIONS}
              containerClassName="w-28 shrink-0"
              onChange={(event) =>
                setHorizon(event.target.value as GoalHorizon)
              }
            />
            <Input
              size="sm"
              label="Measure"
              value={metric}
              placeholder="How you will know"
              containerClassName="w-48 shrink-0"
              onChange={(event) => setMetric(event.target.value)}
            />
            <Button
              size="sm"
              variant="primary"
              icon={Plus}
              loading={write.pending}
              disabled={!title.trim()}
              onClick={() => {
                void add();
              }}
            >
              Add
            </Button>
          </div>
        )}
      </div>

      <p
        className={cn('mt-2 flex items-center gap-1.5 text-[11px]', textMuted)}
      >
        <FileText size={11} aria-hidden="true" />
        Written straight to GOALS.md. A hand edit in your editor wins the next
        time the file is read.
      </p>

      <ConfirmDialog
        open={pendingDelete !== null}
        tone="danger"
        title={`Remove “${pendingDelete?.title ?? ''}”?`}
        description="The goal is deleted from GOALS.md. Tasks attached to it are left alone."
        confirmLabel="Remove goal"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => confirmDelete()}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One goal                                                            */
/* ------------------------------------------------------------------ */

interface GoalRowProps {
  goal: Goal;
  index: number;
  total: number;
  onMove: (delta: number) => void;
  onPatch: (patch: {
    title?: string;
    description?: string;
    metric?: string;
    horizon?: GoalHorizon;
    status?: GoalStatus;
  }) => void;
  onDelete: () => void;
}

function GoalRow({
  goal,
  index,
  total,
  onMove,
  onPatch,
  onDelete,
}: GoalRowProps) {
  const meta = goalStatusMeta(goal.status);
  const dimmed = goal.status === 'achieved' || goal.status === 'dropped';

  return (
    <li
      className={cn(
        'group rounded-lg border border-zinc-200 px-3 py-2.5 dark:border-zinc-800',
        dimmed && 'opacity-70',
      )}
    >
      <div className="flex items-start gap-2">
        <span className="flex shrink-0 flex-col pt-0.5">
          <Button
            size="icon-sm"
            variant="ghost"
            icon={ArrowUp}
            disabled={index === 0}
            aria-label={`Move “${goal.title}” up`}
            className="h-5 w-5"
            onClick={() => onMove(-1)}
          />
          <Button
            size="icon-sm"
            variant="ghost"
            icon={ArrowDown}
            disabled={index === total - 1}
            aria-label={`Move “${goal.title}” down`}
            className="h-5 w-5"
            onClick={() => onMove(1)}
          />
        </span>

        <span
          className={cn(
            'w-4 shrink-0 pt-1 text-right text-[11px] tabular-nums',
            textMuted,
          )}
        >
          {index + 1}
        </span>

        <div className="min-w-0 flex-1">
          <InlineText
            value={goal.title}
            aria-label={`Goal ${index + 1} title`}
            className={cn(
              'text-[13px] font-medium leading-snug text-zinc-900 dark:text-zinc-100',
              dimmed && 'line-through',
            )}
            onCommit={(title) =>
              title.trim() && onPatch({ title: title.trim() })
            }
          />
          <InlineText
            value={goal.metric}
            placeholder="+ measure"
            aria-label={`Goal ${index + 1} measure`}
            className={cn('mt-0.5 text-[11.5px] leading-snug', textMuted)}
            onCommit={(value) => onPatch({ metric: value })}
          />
          <InlineText
            value={goal.description}
            placeholder="+ detail"
            multiline
            aria-label={`Goal ${index + 1} description`}
            className="mt-0.5 text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-400"
            onCommit={(value) => onPatch({ description: value })}
          />
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {goal.targetDate ? (
            <span className={cn('text-[11px] tabular-nums', textMuted)}>
              {formatDate(goal.targetDate)}
            </span>
          ) : null}
          <Badge tone="neutral" variant="outline">
            {goal.horizon}
          </Badge>
          <StatusDot tone={meta.tone} label={meta.label} />
          <Select
            size="sm"
            value={goal.status}
            aria-label={`Status of ${goal.title}`}
            options={STATUS_OPTIONS}
            containerClassName="w-24"
            onChange={(event) =>
              onPatch({ status: event.target.value as GoalStatus })
            }
          />
          <Button
            size="icon-sm"
            variant="ghost"
            icon={Trash2}
            aria-label={`Remove ${goal.title}`}
            className="text-zinc-400 opacity-0 transition-opacity hover:text-rose-600 group-focus-within:opacity-100 group-hover:opacity-100 dark:hover:text-rose-400"
            onClick={onDelete}
          />
        </div>
      </div>
    </li>
  );
}

export default GoalsPanel;
