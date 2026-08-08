/**
 * The board: one column per status, cards inside them.
 *
 * The status enum is the board's real vocabulary, and the columns are why it
 * exists — `in_progress`, `awaiting_approval` and `ready` are three different
 * situations ("the agent is working", "it is waiting on you", "it is done and
 * wants your review") that an older, coarser enum collapsed into one. So each
 * gets a column of its own rather than a filter chip.
 *
 * Columns scroll independently; the board scrolls horizontally as a whole.
 */
import { Plus } from 'lucide-react';
import type { Task, TaskStatus } from '../../../shared/tasks';
import { cn } from '../../lib/utils';
import { formatRelative } from '../../lib/format';
import { taskPriorityMeta, taskStatusMeta } from '../../lib/status';
import { TONE_DOT, TONE_TEXT } from '../../lib/tone';
import { Badge, Button, Select } from '../../components/ui';
import { focusRing, textMuted } from '../../components/ui/styles';
import { Progress } from './parts';

export interface BoardProps {
  tasks: readonly Task[];
  statuses: readonly TaskStatus[];
  selectedId: string | null;
  onSelect: (task: Task) => void;
  onStatusChange: (task: Task, status: TaskStatus) => void;
  onCreate: (status: TaskStatus) => void;
  className?: string;
}

export function Board({
  tasks,
  statuses,
  selectedId,
  onSelect,
  onStatusChange,
  onCreate,
  className,
}: BoardProps) {
  return (
    <div className={cn('flex min-h-0 gap-3 overflow-x-auto p-4', className)}>
      {statuses.map((status) => {
        const meta = taskStatusMeta(status);
        const column = tasks.filter((task) => task.status === status);
        return (
          <section
            key={status}
            className="flex w-[17.5rem] shrink-0 flex-col rounded-lg bg-zinc-50 dark:bg-zinc-900/50"
            aria-label={`${meta.label}, ${column.length} cards`}
          >
            <header className="flex items-center gap-1.5 px-2.5 py-2">
              <span
                aria-hidden="true"
                className={cn('h-1.5 w-1.5 rounded-full', TONE_DOT[meta.tone])}
              />
              <h2 className="text-[12px] font-semibold text-zinc-700 dark:text-zinc-300">
                {meta.label}
              </h2>
              <span className={cn('text-[11px] tabular-nums', textMuted)}>
                {column.length}
              </span>
              <div className="flex-1" />
              <Button
                size="icon-sm"
                variant="ghost"
                icon={Plus}
                aria-label={`New card in ${meta.label}`}
                onClick={() => onCreate(status)}
              />
            </header>

            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 pb-2">
              {column.length === 0 ? (
                <p
                  className={cn(
                    'rounded-md border border-dashed border-zinc-200 px-2 py-4 text-center text-[11.5px] dark:border-zinc-800',
                    textMuted,
                  )}
                >
                  Nothing here
                </p>
              ) : (
                column.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    selected={task.id === selectedId}
                    statuses={statuses}
                    onSelect={() => onSelect(task)}
                    onStatusChange={(next) => onStatusChange(task, next)}
                  />
                ))
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One card                                                            */
/* ------------------------------------------------------------------ */

interface TaskCardProps {
  task: Task;
  selected: boolean;
  statuses: readonly TaskStatus[];
  onSelect: () => void;
  onStatusChange: (status: TaskStatus) => void;
}

function TaskCard({
  task,
  selected,
  statuses,
  onSelect,
  onStatusChange,
}: TaskCardProps) {
  const priority = taskPriorityMeta(task.priority);
  const planDone = task.plan.filter((step) => step.done).length;
  const criteriaMet = task.acceptanceCriteria.filter((item) => item.met).length;
  const showPriority = task.priority !== 'normal' && task.priority !== 'low';

  // Every status is offered, including ones hidden from the board, so a card
  // can always be finished or rejected from where it is.
  const options = statuses.includes('done')
    ? statuses
    : [...statuses, 'done' as TaskStatus, 'rejected' as TaskStatus];

  return (
    <article
      className={cn(
        'rounded-md border bg-white transition-colors dark:bg-zinc-950',
        selected
          ? 'border-indigo-400 ring-1 ring-indigo-400/40 dark:border-indigo-500'
          : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          'block w-full rounded-t-md px-2.5 pb-1.5 pt-2 text-left',
          focusRing,
        )}
      >
        <span className="flex items-start gap-1.5">
          {showPriority ? (
            <span
              aria-label={`${priority.label} priority`}
              title={`${priority.label} priority`}
              className={cn(
                'mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full',
                TONE_DOT[priority.tone],
              )}
            />
          ) : null}
          <span className="min-w-0 flex-1 text-[12.5px] font-medium leading-snug text-zinc-900 dark:text-zinc-100">
            {task.title}
          </span>
        </span>

        {task.objective || task.description ? (
          <span
            className={cn(
              'mt-1 line-clamp-2 block text-[11.5px] leading-snug',
              textMuted,
            )}
          >
            {task.objective || task.description}
          </span>
        ) : null}

        {task.status === 'blocked' && task.blockerReason ? (
          <span className="mt-1.5 block rounded border border-amber-300 bg-amber-50 px-1.5 py-1 text-[11px] leading-snug text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
            {task.blockerReason}
          </span>
        ) : null}

        <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <Progress label="Plan" done={planDone} total={task.plan.length} />
          <Progress
            label="Criteria"
            done={criteriaMet}
            total={task.acceptanceCriteria.length}
          />
          {task.assignedAgent ? (
            <Badge tone="neutral" variant="outline">
              {task.assignedAgent}
            </Badge>
          ) : null}
          {task.approvalMode !== 'manual' ? (
            <Badge
              tone={task.approvalMode === 'auto' ? 'warning' : 'neutral'}
              variant="outline"
              title={
                task.approvalMode === 'auto'
                  ? 'Side effects this card implies are pre-approved.'
                  : 'Plan only — no side effects at all.'
              }
            >
              {task.approvalMode}
            </Badge>
          ) : null}
          {task.dueAt ? (
            <span className={cn('text-[10.5px]', TONE_TEXT.warning)}>
              due {formatRelative(task.dueAt)}
            </span>
          ) : null}
        </span>
      </button>

      <div className="flex items-center gap-1.5 border-t border-zinc-100 px-1.5 py-1 dark:border-zinc-800/80">
        <Select
          size="sm"
          value={task.status}
          aria-label={`Status of ${task.title}`}
          containerClassName="flex-1"
          selectClassName="h-6 border-transparent bg-transparent text-[11px] dark:bg-transparent"
          options={options.map((status) => ({
            value: status,
            label: taskStatusMeta(status).label,
          }))}
          onChange={(event) => onStatusChange(event.target.value as TaskStatus)}
        />
        <span className={cn('shrink-0 pr-1 text-[10.5px]', textMuted)}>
          {formatRelative(task.updatedAt)}
        </span>
      </div>
    </article>
  );
}

export default Board;
