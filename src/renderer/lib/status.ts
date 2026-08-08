/**
 * Status -> label, tone, icon. One table so "failed" looks and reads the same
 * on the runs list, the schedule table and the status strip.
 *
 * If a screen needs a different word for a status, change it here.
 */
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleDashed,
  CircleDot,
  Clock,
  Hourglass,
  Inbox,
  Loader,
  MinusCircle,
  Pause,
  Play,
  Target,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type {
  RunStatus,
  RunStepStatus,
  ToolCallStatus,
} from '../../shared/runs';
import type { TaskPriority, TaskStatus, GoalStatus } from '../../shared/tasks';
import type { ApprovalStatus, ApprovalScope } from '../../shared/approvals';
import type { Tone } from './tone';

export interface StatusMeta {
  label: string;
  tone: Tone;
  icon: LucideIcon;
  /** True while the thing is actively moving — drives spinners and pulses. */
  active?: boolean;
}

const RUN_STATUS_META: Record<RunStatus, StatusMeta> = {
  queued: { label: 'Queued', tone: 'neutral', icon: CircleDashed },
  running: { label: 'Running', tone: 'info', icon: Loader, active: true },
  awaiting_approval: {
    label: 'Waiting on you',
    tone: 'warning',
    icon: Hourglass,
    active: true,
  },
  succeeded: { label: 'Succeeded', tone: 'success', icon: CheckCircle2 },
  failed: { label: 'Failed', tone: 'danger', icon: XCircle },
  cancelled: { label: 'Cancelled', tone: 'neutral', icon: Ban },
};

export function runStatusMeta(status: RunStatus): StatusMeta {
  return RUN_STATUS_META[status] ?? RUN_STATUS_META.queued;
}

const STEP_STATUS_META: Record<RunStepStatus, StatusMeta> = {
  pending: { label: 'Pending', tone: 'neutral', icon: CircleDashed },
  running: { label: 'Running', tone: 'info', icon: Loader, active: true },
  awaiting_approval: {
    label: 'Waiting on you',
    tone: 'warning',
    icon: Hourglass,
    active: true,
  },
  succeeded: { label: 'Succeeded', tone: 'success', icon: CheckCircle2 },
  failed: { label: 'Failed', tone: 'danger', icon: XCircle },
  skipped: { label: 'Skipped', tone: 'neutral', icon: MinusCircle },
  cancelled: { label: 'Cancelled', tone: 'neutral', icon: Ban },
};

export function stepStatusMeta(status: RunStepStatus): StatusMeta {
  return STEP_STATUS_META[status] ?? STEP_STATUS_META.pending;
}

const TOOL_CALL_STATUS_META: Record<ToolCallStatus, StatusMeta> = {
  pending: { label: 'Pending', tone: 'neutral', icon: CircleDashed },
  awaiting_approval: {
    label: 'Awaiting approval',
    tone: 'warning',
    icon: Hourglass,
    active: true,
  },
  denied: { label: 'Denied', tone: 'danger', icon: Ban },
  running: { label: 'Running', tone: 'info', icon: Loader, active: true },
  succeeded: { label: 'Done', tone: 'success', icon: CheckCircle2 },
  failed: { label: 'Failed', tone: 'danger', icon: XCircle },
};

export function toolCallStatusMeta(status: ToolCallStatus): StatusMeta {
  return TOOL_CALL_STATUS_META[status] ?? TOOL_CALL_STATUS_META.pending;
}

const TASK_STATUS_META: Record<TaskStatus, StatusMeta> = {
  todo: { label: 'To do', tone: 'neutral', icon: CircleDashed },
  in_progress: { label: 'In progress', tone: 'info', icon: Play, active: true },
  awaiting_approval: {
    label: 'Awaiting approval',
    tone: 'warning',
    icon: Inbox,
    active: true,
  },
  ready: { label: 'Ready', tone: 'success', icon: CircleDot },
  blocked: { label: 'Blocked', tone: 'warning', icon: AlertTriangle },
  done: { label: 'Done', tone: 'success', icon: CheckCircle2 },
  rejected: { label: 'Rejected', tone: 'neutral', icon: Ban },
};

export function taskStatusMeta(status: TaskStatus): StatusMeta {
  return TASK_STATUS_META[status] ?? TASK_STATUS_META.todo;
}

const TASK_PRIORITY_META: Record<TaskPriority, StatusMeta> = {
  low: { label: 'Low', tone: 'neutral', icon: CircleDot },
  normal: { label: 'Normal', tone: 'neutral', icon: CircleDot },
  high: { label: 'High', tone: 'warning', icon: CircleDot },
  urgent: { label: 'Urgent', tone: 'danger', icon: CircleDot },
};

export function taskPriorityMeta(priority: TaskPriority): StatusMeta {
  return TASK_PRIORITY_META[priority] ?? TASK_PRIORITY_META.normal;
}

const GOAL_STATUS_META: Record<GoalStatus, StatusMeta> = {
  active: { label: 'Active', tone: 'accent', icon: Target },
  paused: { label: 'Paused', tone: 'neutral', icon: Pause },
  achieved: { label: 'Achieved', tone: 'success', icon: CheckCircle2 },
  dropped: { label: 'Dropped', tone: 'neutral', icon: Ban },
};

export function goalStatusMeta(status: GoalStatus): StatusMeta {
  return GOAL_STATUS_META[status] ?? GOAL_STATUS_META.active;
}

const APPROVAL_STATUS_META: Record<ApprovalStatus, StatusMeta> = {
  pending: { label: 'Waiting', tone: 'warning', icon: Hourglass, active: true },
  approved: { label: 'Approved', tone: 'success', icon: CheckCircle2 },
  denied: { label: 'Denied', tone: 'danger', icon: XCircle },
  expired: { label: 'Expired', tone: 'neutral', icon: Clock },
  cancelled: { label: 'Cancelled', tone: 'neutral', icon: Ban },
};

export function approvalStatusMeta(status: ApprovalStatus): StatusMeta {
  return APPROVAL_STATUS_META[status] ?? APPROVAL_STATUS_META.pending;
}

/** Wording for the three grant scopes, as shown on the approval card. */
export const APPROVAL_SCOPE_LABEL: Record<ApprovalScope, string> = {
  once: 'Just this once',
  run: 'For the rest of this run',
  always: 'Always allow',
};
