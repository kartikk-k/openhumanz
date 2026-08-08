/**
 * New card.
 *
 * Deliberately short: a card is created with intent (title, objective, what
 * "done" means) and everything else — the plan, the criteria, the evidence — is
 * filled in on the card itself, where the work actually happens. A twelve-field
 * creation form would be filled in badly once and never revisited.
 */
import { useEffect, useState } from 'react';
import { IPC } from '../../../shared/ipc';
import {
  APPROVAL_MODES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type ApprovalMode,
  type BoardKind,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from '../../../shared/tasks';
import { cn } from '../../lib/utils';
import { useMutation } from '../../lib/ipc';
import { taskPriorityMeta, taskStatusMeta } from '../../lib/status';
import { Button, Dialog, Input, Select, Textarea } from '../../components/ui';
import { eyebrow, textMuted } from '../../components/ui/styles';

export interface TaskDialogProps {
  open: boolean;
  /** Where the card lands. */
  board: BoardKind;
  conversationId?: string;
  /** Column the card was created from. */
  status: TaskStatus;
  onClose: () => void;
  onCreated: (task: Task) => void;
}

interface Draft {
  title: string;
  objective: string;
  desiredOutcome: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedAgent: string;
  approvalMode: ApprovalMode;
}

function emptyDraft(status: TaskStatus): Draft {
  return {
    title: '',
    objective: '',
    desiredOutcome: '',
    description: '',
    status,
    priority: 'normal',
    assignedAgent: '',
    approvalMode: 'manual',
  };
}

export function TaskDialog({
  open,
  board,
  conversationId,
  status,
  onClose,
  onCreated,
}: TaskDialogProps) {
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(status));
  const [failure, setFailure] = useState<string | null>(null);
  const create = useMutation(IPC.tasks.create);

  useEffect(() => {
    if (!open) return;
    setDraft(emptyDraft(status));
    setFailure(null);
  }, [open, status]);

  const patch = (next: Partial<Draft>) =>
    setDraft((previous) => ({ ...previous, ...next }));

  const submit = async () => {
    const title = draft.title.trim();
    if (!title) return;
    setFailure(null);

    const created = await create.mutate({
      title,
      objective: draft.objective.trim(),
      desiredOutcome: draft.desiredOutcome.trim(),
      description: draft.description.trim(),
      status: draft.status,
      priority: draft.priority,
      approvalMode: draft.approvalMode,
      assignedAgent: draft.assignedAgent.trim() || undefined,
      board,
      conversationId: board === 'conversation' ? conversationId : undefined,
      source: 'user',
    });

    if (!created) {
      setFailure(
        create.error?.isUnavailable
          ? 'Not connected to the backend, so the card was not created. Nothing was lost — the form is still here.'
          : (create.error?.message ?? 'The card could not be created.'),
      );
      return;
    }
    onCreated(created);
  };

  return (
    <Dialog
      open={open}
      onClose={create.pending ? () => {} : onClose}
      size="lg"
      title="New card"
      description={
        board === 'conversation'
          ? `Lands on the conversation board ${conversationId ?? ''}.`
          : 'Lands on your personal board.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={create.pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={create.pending}
            disabled={!draft.title.trim()}
            onClick={() => {
              void submit();
            }}
          >
            Create card
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {failure ? (
          <p className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-[12.5px] text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-300">
            {failure}
          </p>
        ) : null}

        <Input
          label="Title"
          required
          value={draft.title}
          placeholder="Rewrite the onboarding copy"
          onChange={(event) => patch({ title: event.target.value })}
        />

        <div className="grid grid-cols-2 gap-3">
          <Textarea
            label="Objective"
            rows={2}
            value={draft.objective}
            placeholder="Why this exists — the point, not the steps."
            onChange={(event) => patch({ objective: event.target.value })}
          />
          <Textarea
            label="Desired outcome"
            rows={2}
            value={draft.desiredOutcome}
            placeholder="What the world looks like when it is finished."
            onChange={(event) => patch({ desiredOutcome: event.target.value })}
          />
        </div>

        <Textarea
          label="Description"
          rows={2}
          value={draft.description}
          placeholder="Optional context."
          onChange={(event) => patch({ description: event.target.value })}
        />

        <div className="border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <p className={cn('mb-2', eyebrow)}>How it is worked</p>
          <div className="grid grid-cols-4 gap-3">
            <Select
              size="sm"
              label="Status"
              value={draft.status}
              options={TASK_STATUSES.map((value) => ({
                value,
                label: taskStatusMeta(value).label,
              }))}
              onChange={(event) =>
                patch({ status: event.target.value as TaskStatus })
              }
            />
            <Select
              size="sm"
              label="Priority"
              value={draft.priority}
              options={TASK_PRIORITIES.map((value) => ({
                value,
                label: taskPriorityMeta(value).label,
              }))}
              onChange={(event) =>
                patch({ priority: event.target.value as TaskPriority })
              }
            />
            <Select
              size="sm"
              label="Approval mode"
              value={draft.approvalMode}
              options={APPROVAL_MODES.map((value) => ({ value, label: value }))}
              onChange={(event) =>
                patch({ approvalMode: event.target.value as ApprovalMode })
              }
            />
            <Input
              size="sm"
              label="Assign to"
              value={draft.assignedAgent}
              placeholder="claude, me…"
              onChange={(event) => patch({ assignedAgent: event.target.value })}
            />
          </div>
          <p className={cn('mt-2 text-[11.5px] leading-relaxed', textMuted)}>
            Approval mode is advisory — the gate is what enforces anything. It
            tells the gate, and you, what this card expects to be allowed to do.
          </p>
        </div>
      </div>
    </Dialog>
  );
}

export default TaskDialog;
