/**
 * The card, in full.
 *
 * A rail rather than a page: the board stays visible, so moving a card and
 * reading it are the same gesture. Everything here is edited in place — the
 * status row, the plan, the criteria — and each change is written straight
 * through `tasks:update` as a patch. There is no save button because a board
 * that needs one is a board that goes stale.
 *
 * `TaskUpdate` is a patch schema with the defaults stripped, so sending
 * `{ id, status }` changes the status and nothing else. That is what makes this
 * safe: an inline edit can never blank a field it did not touch.
 */
import { Trash2, X } from 'lucide-react';
import {
  APPROVAL_MODES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type ApprovalMode,
  type Task,
  type TaskPriority,
  type TaskUpdate,
} from '../../../shared/tasks';
import { cn } from '../../lib/utils';
import { formatDateTime, formatRelative } from '../../lib/format';
import { taskPriorityMeta, taskStatusMeta } from '../../lib/status';
import { TONE_SOFT, TONE_TEXT } from '../../lib/tone';
import { Badge, Button, Select, Spinner } from '../../components/ui';
import { focusRing, mono, textMuted } from '../../components/ui/styles';
import { ChecklistEditor, EvidenceEditor, InlineText, Section } from './parts';

const APPROVAL_MODE_HINT: Record<ApprovalMode, string> = {
  plan: 'Think and write the plan. No side effects at all.',
  manual: 'Every side-effecting call goes to the approval gate.',
  auto: 'The side effects this card implies are pre-approved.',
};

export type TaskPatch = Omit<TaskUpdate, 'id'>;

export interface TaskDetailProps {
  task: Task;
  /** True while a write for this card is in flight. */
  saving: boolean;
  onSave: (patch: TaskPatch) => void;
  onClose: () => void;
  onDelete: () => void;
  className?: string;
}

export function TaskDetail({
  task,
  saving,
  onSave,
  onClose,
  onDelete,
  className,
}: TaskDetailProps) {
  const statusMeta = taskStatusMeta(task.status);

  return (
    <aside
      className={cn(
        'flex min-h-0 flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950',
        className,
      )}
      aria-label={`Card: ${task.title}`}
    >
      {/* header ---------------------------------------------------- */}
      <div className="flex items-start gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="min-w-0 flex-1">
          <InlineText
            value={task.title}
            aria-label="Card title"
            className="text-[14px] font-semibold leading-snug text-zinc-900 dark:text-zinc-100"
            onCommit={(title) =>
              title.trim() && onSave({ title: title.trim() })
            }
          />
          <p className={cn('mt-0.5 px-1 text-[11px]', textMuted)}>
            {task.board === 'conversation'
              ? `Conversation board · ${task.conversationId ?? 'unassigned'}`
              : 'Personal board'}{' '}
            · from {task.source} · updated {formatRelative(task.updatedAt)}
          </p>
        </div>
        {saving ? <Spinner size="sm" label="Saving" className="mt-1" /> : null}
        <Button
          size="icon-sm"
          variant="ghost"
          icon={X}
          aria-label="Close card"
          onClick={onClose}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* status --------------------------------------------------- */}
        <Section
          title="Status"
          meta={
            <Badge tone={statusMeta.tone} icon={statusMeta.icon}>
              {statusMeta.label}
            </Badge>
          }
        >
          <div className="flex flex-wrap gap-1">
            {TASK_STATUSES.map((status) => {
              const meta = taskStatusMeta(status);
              const active = status === task.status;
              return (
                <button
                  key={status}
                  type="button"
                  aria-pressed={active}
                  onClick={() => !active && onSave({ status })}
                  className={cn(
                    'inline-flex items-center gap-1 rounded border px-1.5 py-1 text-[11.5px] font-medium transition-colors',
                    focusRing,
                    active
                      ? cn(TONE_SOFT[meta.tone], 'border-transparent')
                      : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900',
                  )}
                >
                  <meta.icon size={11} aria-hidden="true" />
                  {meta.label}
                </button>
              );
            })}
          </div>

          {task.status === 'blocked' ? (
            <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 dark:border-amber-500/40 dark:bg-amber-500/10">
              <p
                className={cn(
                  'text-[10.5px] font-semibold uppercase tracking-wider',
                  TONE_TEXT.warning,
                )}
              >
                Blocked by
              </p>
              <InlineText
                value={task.blockerReason ?? ''}
                placeholder="Say what is in the way — a card with no reason cannot be unblocked by anyone else."
                multiline
                aria-label="Blocker reason"
                className="mt-0.5 text-[12.5px] leading-snug text-amber-900 dark:text-amber-200"
                onCommit={(blockerReason) => onSave({ blockerReason })}
              />
            </div>
          ) : null}
        </Section>

        {/* attributes ----------------------------------------------- */}
        <Section
          title="Attributes"
          className="border-t border-zinc-100 dark:border-zinc-800/80"
        >
          <div className="grid grid-cols-2 gap-2.5">
            <Select
              size="sm"
              label="Priority"
              value={task.priority}
              options={TASK_PRIORITIES.map((priority) => ({
                value: priority,
                label: taskPriorityMeta(priority).label,
              }))}
              onChange={(event) =>
                onSave({ priority: event.target.value as TaskPriority })
              }
            />
            <Select
              size="sm"
              label="Approval mode"
              value={task.approvalMode}
              options={APPROVAL_MODES.map((mode) => ({
                value: mode,
                label: mode,
              }))}
              hint={APPROVAL_MODE_HINT[task.approvalMode]}
              onChange={(event) =>
                onSave({ approvalMode: event.target.value as ApprovalMode })
              }
            />
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2.5">
            <div>
              <p className={cn('mb-0.5 text-[11px] font-medium', textMuted)}>
                Assigned agent
              </p>
              <InlineText
                value={task.assignedAgent ?? ''}
                placeholder="Unassigned"
                aria-label="Assigned agent"
                className="text-[12.5px] text-zinc-700 dark:text-zinc-300"
                onCommit={(value) =>
                  onSave({ assignedAgent: value.trim() || undefined })
                }
              />
            </div>
            <div>
              <p className={cn('mb-0.5 text-[11px] font-medium', textMuted)}>
                Due
              </p>
              <p className="px-1 py-0.5 text-[12.5px] text-zinc-700 dark:text-zinc-300">
                {task.dueAt ? formatDateTime(task.dueAt) : '—'}
              </p>
            </div>
          </div>
        </Section>

        {/* intent ---------------------------------------------------- */}
        <Section
          title="Objective"
          className="border-t border-zinc-100 dark:border-zinc-800/80"
        >
          <InlineText
            value={task.objective}
            placeholder="Why this card exists — the point, not the steps."
            multiline
            aria-label="Objective"
            className="text-[12.5px] leading-relaxed text-zinc-700 dark:text-zinc-300"
            onCommit={(objective) => onSave({ objective })}
          />
        </Section>

        <Section
          title="Desired outcome"
          className="border-t border-zinc-100 dark:border-zinc-800/80"
        >
          <InlineText
            value={task.desiredOutcome}
            placeholder="What the world looks like when this is finished."
            multiline
            aria-label="Desired outcome"
            className="text-[12.5px] leading-relaxed text-zinc-700 dark:text-zinc-300"
            onCommit={(desiredOutcome) => onSave({ desiredOutcome })}
          />
        </Section>

        <Section
          title="Description"
          className="border-t border-zinc-100 dark:border-zinc-800/80"
        >
          <InlineText
            value={task.description}
            placeholder="What the card is, in prose."
            multiline
            aria-label="Description"
            className="text-[12.5px] leading-relaxed text-zinc-700 dark:text-zinc-300"
            onCommit={(description) => onSave({ description })}
          />
        </Section>

        {/* plan ------------------------------------------------------ */}
        <Section
          title="Execution plan"
          className="border-t border-zinc-100 dark:border-zinc-800/80"
          meta={
            task.plan.length > 0 ? (
              <span className={cn('text-[11px] tabular-nums', textMuted)}>
                {task.plan.filter((step) => step.done).length} of{' '}
                {task.plan.length} done
              </span>
            ) : null
          }
        >
          <ChecklistEditor
            ordered
            items={task.plan.map((step) => ({
              text: step.text,
              checked: step.done,
            }))}
            addLabel="Add a step"
            emptyHint="No steps yet. Order is the order they run in."
            onChange={(items) =>
              onSave({
                plan: items.map((item) => ({
                  text: item.text,
                  done: item.checked,
                })),
              })
            }
          />
        </Section>

        {/* acceptance ------------------------------------------------ */}
        <Section
          title="Acceptance criteria"
          className="border-t border-zinc-100 dark:border-zinc-800/80"
          meta={
            task.acceptanceCriteria.length > 0 ? (
              <span className={cn('text-[11px] tabular-nums', textMuted)}>
                {task.acceptanceCriteria.filter((item) => item.met).length} of{' '}
                {task.acceptanceCriteria.length} met
              </span>
            ) : null
          }
        >
          <ChecklistEditor
            items={task.acceptanceCriteria.map((item) => ({
              text: item.text,
              checked: item.met,
            }))}
            addLabel="Add a criterion"
            emptyHint="Nothing to check against yet. These are what “done” means for this card."
            onChange={(items) =>
              onSave({
                acceptanceCriteria: items.map((item) => ({
                  text: item.text,
                  met: item.checked,
                })),
              })
            }
          />
        </Section>

        {/* evidence -------------------------------------------------- */}
        <Section
          title="Evidence"
          className="border-t border-zinc-100 dark:border-zinc-800/80"
        >
          <EvidenceEditor
            items={task.evidence}
            onChange={(evidence) => onSave({ evidence })}
          />
        </Section>

        {/* notes ----------------------------------------------------- */}
        <Section
          title="Notes"
          className="border-t border-zinc-100 dark:border-zinc-800/80"
        >
          <InlineText
            value={task.notes}
            placeholder="Running commentary — what happened, what was tried."
            multiline
            aria-label="Notes"
            className="text-[12.5px] leading-relaxed text-zinc-700 dark:text-zinc-300"
            onCommit={(notes) => onSave({ notes })}
          />
        </Section>

        {/* footer ---------------------------------------------------- */}
        <div className="flex items-center gap-2 border-t border-zinc-100 px-4 py-3 dark:border-zinc-800/80">
          <span className={cn('text-[10.5px]', mono, textMuted)}>
            {task.id}
          </span>
          <span className={cn('text-[10.5px]', textMuted)}>
            created {formatDateTime(task.createdAt)}
          </span>
          <div className="flex-1" />
          <Button
            size="xs"
            variant="ghost"
            icon={Trash2}
            onClick={onDelete}
            className="text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10"
          >
            Delete
          </Button>
        </div>
      </div>
    </aside>
  );
}

export default TaskDetail;
