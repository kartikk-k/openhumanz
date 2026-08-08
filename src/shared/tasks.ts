/**
 * Tasks and goals.
 *
 * Goals are the long-lived intent; tasks are the units of work. Both are
 * structured state (SQLite). Their prose lives in the memory vault.
 */
import { z } from 'zod';
import {
  IdSchema,
  IsoDateTimeSchema,
  JsonObjectSchema,
  patchSchema,
} from './common';

/**
 * The task lifecycle: `todo → in_progress → awaiting_approval → ready → done`,
 * with `blocked` and `rejected` as exits.
 *
 * This is the board's real vocabulary. An earlier, coarser enum
 * (`inbox|todo|doing|blocked|done|cancelled`) could not distinguish "the agent
 * is working" from "the agent is waiting on you" from "it is done and awaiting
 * your review" — all three collapsed to `doing`, which is precisely the
 * distinction the board exists to show. {@link LEGACY_TASK_STATUS_ALIASES}
 * maps the old spellings for rows already on disk.
 */
export const TASK_STATUSES = [
  'todo',
  'in_progress',
  'awaiting_approval',
  'ready',
  'blocked',
  'done',
  'rejected',
] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** Statuses meaning "this card is finished, one way or the other". */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  'done',
  'rejected',
];

/**
 * The superseded vocabulary, mapped onto the current one.
 *
 * `doing → in_progress` is the lossy direction: the old enum could not say
 * which kind of in-flight a card was, so everything lands on the plainest
 * reading. Kept because dev workspaces hold rows written with these spellings,
 * and because callers may still send them.
 */
export const LEGACY_TASK_STATUS_ALIASES: Readonly<Record<string, TaskStatus>> =
  {
    inbox: 'todo',
    doing: 'in_progress',
    cancelled: 'rejected',
  };

/**
 * Normalise any status spelling — current or legacy — to a {@link TaskStatus}.
 *
 * Unknown values fall back to `todo` rather than throwing: a status read back
 * from a database written by an older build must not make the board
 * unopenable.
 */
export function toTaskStatus(value: string | null | undefined): TaskStatus {
  if (!value) return 'todo';
  if ((TASK_STATUSES as readonly string[]).includes(value)) {
    return value as TaskStatus;
  }
  return LEGACY_TASK_STATUS_ALIASES[value] ?? 'todo';
}

/**
 * Every status spelling a *writer* may send: the current vocabulary plus the
 * legacy aliases. A flat enum rather than a union with a transform, so the
 * JSON Schema published over MCP stays a plain `enum`.
 */
export const TASK_STATUS_INPUTS = [
  ...TASK_STATUSES,
  ...(Object.keys(LEGACY_TASK_STATUS_ALIASES) as [string, ...string[]]),
] as const;
export const TaskStatusInputSchema = z.enum(
  TASK_STATUS_INPUTS as unknown as [string, ...string[]],
);
export type TaskStatusInput = z.infer<typeof TaskStatusInputSchema>;

export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const TaskPrioritySchema = z.enum(TASK_PRIORITIES);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

/* ------------------------------------------------------------------ */
/* Card sub-structures                                                 */
/* ------------------------------------------------------------------ */

/**
 * `personal` is the standing board and outlives every conversation.
 * `conversation` boards are scoped to one conversation or run and are what an
 * agent should use for the plan it is executing right now.
 */
export const BOARD_KINDS = ['personal', 'conversation'] as const;
export const BoardKindSchema = z.enum(BOARD_KINDS);
export type BoardKind = z.infer<typeof BoardKindSchema>;

/** One ordered step of the execution plan. */
export const PlanStepSchema = z.object({
  text: z.string().min(1),
  done: z.boolean().default(false),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

/** One acceptance criterion. `met` is the checkbox. */
export const AcceptanceCriterionSchema = z.object({
  text: z.string().min(1),
  met: z.boolean().default(false),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

/** A link or artefact that shows the work was actually done. */
export const EvidenceSchema = z.object({
  label: z.string().min(1),
  /** URL, file path, run id — whatever points at the artefact. */
  ref: z.string().default(''),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/**
 * How much rope the agent has while working this card.
 *
 * `plan` — think and write the plan, take no side effects at all.
 * `manual` — every side-effecting tool call goes to the approval gate.
 * `auto` — the user has pre-approved the side effects this card implies.
 *
 * Advisory metadata on the card. The approval gate is what actually enforces
 * anything; this tells it (and the user) what the card expects.
 */
export const APPROVAL_MODES = ['plan', 'manual', 'auto'] as const;
export const ApprovalModeSchema = z.enum(APPROVAL_MODES);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

export const TaskSchema = z.object({
  id: IdSchema,
  title: z.string().min(1),
  notes: z.string().default(''),
  status: TaskStatusSchema.default('todo'),
  priority: TaskPrioritySchema.default('normal'),
  goalId: IdSchema.optional(),
  parentId: IdSchema.optional(),
  dueAt: IsoDateTimeSchema.optional(),
  scheduledFor: IsoDateTimeSchema.optional(),
  tags: z.array(z.string()).default([]),
  /** Where this came from: `user`, `agent`, `schedule:<jobId>`, `mail`, ... */
  source: z.string().default('user'),
  /** Id in an external system (Reminders, Things, ...) if mirrored. */
  externalId: z.string().optional(),
  order: z.number().int().default(0),

  /* --- the card ---------------------------------------------------- */
  /* These were module-side extensions, invisible to anything typed only
     against `Task`. They are the card the board actually renders. */

  /** Which board this lives on. */
  board: BoardKindSchema.default('personal'),
  /** A conversation id or a run id. Set exactly when `board` is `conversation`. */
  conversationId: z.string().optional(),
  /** What the card is, in prose. `notes` stays the running commentary. */
  description: z.string().default(''),
  /** Why this card exists — the point, not the steps. */
  objective: z.string().default(''),
  /** What the world looks like when this is finished. */
  desiredOutcome: z.string().default(''),
  /** Ordered steps. Order is array order. */
  plan: z.array(PlanStepSchema).default([]),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).default([]),
  /** Free-form agent name, e.g. `claude`, or a person. */
  assignedAgent: z.string().optional(),
  approvalMode: ApprovalModeSchema.default('manual'),
  /** Required in spirit whenever `status === 'blocked'`. */
  blockerReason: z.string().optional(),
  evidence: z.array(EvidenceSchema).default([]),

  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema.optional(),
  metadata: JsonObjectSchema.default({}),
});
export type Task = z.infer<typeof TaskSchema>;

export const TaskCreateSchema = TaskSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  completedAt: true,
}).partial({
  notes: true,
  status: true,
  priority: true,
  tags: true,
  source: true,
  order: true,
  metadata: true,
  board: true,
  description: true,
  objective: true,
  desiredOutcome: true,
  plan: true,
  acceptanceCriteria: true,
  approvalMode: true,
  evidence: true,
});
export type TaskCreate = z.infer<typeof TaskCreateSchema>;
export type TaskCreateInput = z.input<typeof TaskCreateSchema>;

/**
 * A patch. Built with {@link patchSchema}, not `.partial()`: `.partial()` keeps
 * the field defaults, so `parse({ id })` would come back carrying
 * `notes: ''`, `status: 'todo'`, `order: 0` and blank the stored card.
 * Unmentioned fields stay absent here.
 */
export const TaskUpdateSchema = patchSchema(
  TaskSchema.omit({ createdAt: true, updatedAt: true }),
).extend({ id: IdSchema });
export type TaskUpdate = z.infer<typeof TaskUpdateSchema>;

export const TaskQuerySchema = z.object({
  /** Scope to one board. Omit to search every board. */
  board: BoardKindSchema.optional(),
  conversationId: z.string().min(1).optional(),
  /** Current or legacy status spellings, or a mix. */
  status: z.array(TaskStatusInputSchema).optional(),
  priority: z.array(TaskPrioritySchema).optional(),
  goalId: IdSchema.optional(),
  parentId: IdSchema.optional(),
  tag: z.string().optional(),
  /** Substring match over title, description, objective and notes. */
  search: z.string().optional(),
  dueBefore: IsoDateTimeSchema.optional(),
  assignedAgent: z.string().optional(),
  /** `done` and `rejected` are hidden unless asked for. */
  includeCompleted: z.boolean().default(false),
  limit: z.number().int().positive().max(500).default(100),
  offset: z.number().int().nonnegative().default(0),
});
export type TaskQuery = z.infer<typeof TaskQuerySchema>;
export type TaskQueryInput = z.input<typeof TaskQuerySchema>;

/* ------------------------------------------------------------------ */
/* Goals                                                               */
/* ------------------------------------------------------------------ */

export const GOAL_HORIZONS = [
  'week',
  'month',
  'quarter',
  'year',
  'life',
] as const;
export const GoalHorizonSchema = z.enum(GOAL_HORIZONS);
export type GoalHorizon = z.infer<typeof GoalHorizonSchema>;

export const GOAL_STATUSES = [
  'active',
  'paused',
  'achieved',
  'dropped',
] as const;
export const GoalStatusSchema = z.enum(GOAL_STATUSES);
export type GoalStatus = z.infer<typeof GoalStatusSchema>;

export const GoalSchema = z.object({
  id: IdSchema,
  title: z.string().min(1),
  description: z.string().default(''),
  horizon: GoalHorizonSchema.default('quarter'),
  status: GoalStatusSchema.default('active'),
  /** How progress is judged, in the user's own words. */
  metric: z.string().default(''),
  targetDate: IsoDateTimeSchema.optional(),
  order: z.number().int().default(0),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  metadata: JsonObjectSchema.default({}),
});
export type Goal = z.infer<typeof GoalSchema>;

/**
 * Create-or-update by title. Same hazard as {@link TaskUpdateSchema} — with
 * `.partial()`, `parse({ title: 'x' })` returned `description: ''`,
 * `status: 'active'`, `order: 0`, so editing a goal's title silently erased its
 * description and moved it to the top of the list. Built with
 * {@link patchSchema} so only what the caller sent is present.
 */
export const GoalWriteSchema = patchSchema(
  GoalSchema.omit({ createdAt: true, updatedAt: true }),
).extend({ title: z.string().min(1) });
export type GoalWrite = z.infer<typeof GoalWriteSchema>;

export const GoalQuerySchema = z.object({
  status: z.array(GoalStatusSchema).optional(),
  horizon: z.array(GoalHorizonSchema).optional(),
});
export type GoalQuery = z.infer<typeof GoalQuerySchema>;
export type GoalQueryInput = z.input<typeof GoalQuerySchema>;
