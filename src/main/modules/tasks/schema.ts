/**
 * The task-card schema.
 *
 * `src/shared/tasks.ts` owns the wire contract: {@link Task} is what crosses IPC
 * and what the renderer is typed against. This file *extends* it rather than
 * replacing it, because the board needs a richer card than the shared type
 * carries — objective, desired outcome, an ordered execution plan, an
 * acceptance-criteria checklist, the assigned agent, an approval mode, a blocker
 * reason and evidence links.
 *
 * Two deliberate compromises, both because shared/ is not ours to edit:
 *
 *  1. **Status.** The board's lifecycle is
 *     `todo → in_progress → awaiting_approval → ready → done`, with `blocked`
 *     and `rejected` as exits. The shared enum is
 *     `inbox|todo|doing|blocked|done|cancelled`. So {@link TaskCard.cardStatus}
 *     is canonical and stored, and {@link Task.status} is derived from it on
 *     every read via {@link toSharedStatus}. Writes accept either spelling.
 *  2. **Boards.** `board` / `conversationId` have no home in the shared type, so
 *     they are extra fields on the card. A `TaskCard` is still structurally a
 *     `Task`, which is what keeps the IPC contract honest.
 *
 * Both are listed in the module's report as shared-type gaps.
 */
import { z } from 'zod';
import {
  TASK_STATUSES,
  TaskPrioritySchema,
  TaskSchema,
  TaskStatusSchema,
} from '../../../shared/tasks';
import type { Task, TaskStatus } from '../../../shared/tasks';
import { IdSchema, IsoDateTimeSchema } from '../../../shared/common';

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

/** The board's own lifecycle. Canonical; this is what is stored. */
export const CARD_STATUSES = [
  'todo',
  'in_progress',
  'awaiting_approval',
  'ready',
  'blocked',
  'done',
  'rejected',
] as const;
export const CardStatusSchema = z.enum(CARD_STATUSES);
export type CardStatus = z.infer<typeof CardStatusSchema>;

/** Statuses that mean "this card is finished, one way or the other". */
export const TERMINAL_CARD_STATUSES: readonly CardStatus[] = [
  'done',
  'rejected',
];

/** Column order for the board, and the order sections render in. */
export const CARD_STATUS_ORDER: readonly CardStatus[] = [
  'in_progress',
  'awaiting_approval',
  'ready',
  'blocked',
  'todo',
  'done',
  'rejected',
];

export const CARD_STATUS_LABELS: Record<CardStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  awaiting_approval: 'Awaiting approval',
  ready: 'Ready',
  blocked: 'Blocked',
  done: 'Done',
  rejected: 'Rejected',
};

/** Card status -> the shared enum the IPC contract is typed against. */
const CARD_TO_SHARED: Record<CardStatus, TaskStatus> = {
  todo: 'todo',
  in_progress: 'doing',
  awaiting_approval: 'doing',
  ready: 'doing',
  blocked: 'blocked',
  done: 'done',
  rejected: 'cancelled',
};

/** Shared enum -> card status, for callers that speak the shared vocabulary. */
const SHARED_TO_CARD: Record<TaskStatus, CardStatus> = {
  inbox: 'todo',
  todo: 'todo',
  doing: 'in_progress',
  blocked: 'blocked',
  done: 'done',
  cancelled: 'rejected',
};

export function toSharedStatus(status: CardStatus): TaskStatus {
  return CARD_TO_SHARED[status];
}

/**
 * Normalise any status spelling to a card status. Unknown values fall back to
 * `todo` rather than throwing: a status read back from a database written by an
 * older build must not make the board unopenable.
 */
export function toCardStatus(value: string | null | undefined): CardStatus {
  if (!value) return 'todo';
  if ((CARD_STATUSES as readonly string[]).includes(value)) {
    return value as CardStatus;
  }
  if ((TASK_STATUSES as readonly string[]).includes(value)) {
    return SHARED_TO_CARD[value as TaskStatus];
  }
  return 'todo';
}

/**
 * What a writer may send as a status: either vocabulary. Kept as a plain enum
 * (rather than a union with a transform) so the JSON Schema published over MCP
 * stays a flat `enum`.
 */
export const STATUS_INPUTS = [
  ...CARD_STATUSES,
  'inbox',
  'doing',
  'cancelled',
] as const;
export const StatusInputSchema = z.enum(STATUS_INPUTS);
export type StatusInput = z.infer<typeof StatusInputSchema>;

/* ------------------------------------------------------------------ */
/* Boards                                                              */
/* ------------------------------------------------------------------ */

/**
 * `personal` is the standing board and outlives every conversation.
 * `conversation` boards are scoped to one conversation or run and are what an
 * agent should use for the plan it is executing right now.
 */
export const BOARD_KINDS = ['personal', 'conversation'] as const;
export const BoardKindSchema = z.enum(BOARD_KINDS);
export type BoardKind = z.infer<typeof BoardKindSchema>;

export interface BoardRef {
  board: BoardKind;
  /** Present exactly when `board === 'conversation'`. */
  conversationId?: string;
}

export const BoardInputSchema = z.object({
  board: BoardKindSchema.optional(),
  /** A conversation id or a run id. Implies `board: 'conversation'`. */
  conversationId: z.string().min(1).optional(),
});
export type BoardInput = z.infer<typeof BoardInputSchema>;

/**
 * Work out which board a call is talking about.
 *
 * A `conversationId` on its own is enough — asking the agent to also pass
 * `board: 'conversation'` is a redundancy it will get wrong. Asking for a
 * conversation board without an id is an error, because silently writing to the
 * personal board is exactly the kind of surprise a user cannot undo.
 */
export function resolveBoard(input: BoardInput | undefined): BoardRef {
  const kind = input?.board;
  const conversationId = input?.conversationId?.trim() || undefined;
  if (conversationId) return { board: 'conversation', conversationId };
  if (kind === 'conversation') {
    throw new Error(
      'A conversation board needs a conversationId. Pass the conversation or run id, or use the personal board.',
    );
  }
  return { board: 'personal' };
}

/* ------------------------------------------------------------------ */
/* Card sub-structures                                                 */
/* ------------------------------------------------------------------ */

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
 * Advisory metadata on the card. The gate in `services/` is what actually
 * enforces anything; this tells it (and the user) what the card expects.
 */
export const APPROVAL_MODES = ['plan', 'manual', 'auto'] as const;
export const ApprovalModeSchema = z.enum(APPROVAL_MODES);
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

/* ------------------------------------------------------------------ */
/* The card                                                            */
/* ------------------------------------------------------------------ */

export const TaskCardSchema = TaskSchema.extend({
  board: BoardKindSchema.default('personal'),
  conversationId: z.string().optional(),
  /** The canonical status. `status` is derived from this. */
  cardStatus: CardStatusSchema.default('todo'),
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
  /** Required in spirit whenever `cardStatus === 'blocked'`. */
  blockerReason: z.string().optional(),
  evidence: z.array(EvidenceSchema).default([]),
});

/**
 * A board card. Structurally a {@link Task}, so it satisfies the IPC contract
 * as-is, plus the fields the shared type has no room for.
 */
export type TaskCard = z.infer<typeof TaskCardSchema>;

/** Compile-time proof that a card is still a valid `Task` over the wire. */
export type CardIsTask = TaskCard extends Task ? true : never;

/**
 * A card as returned from `tasks:get` — carries its own pre-rendered markdown so
 * the UI and an agent transcript show the same thing.
 */
export interface TaskCardView extends TaskCard {
  markdown: string;
}

/* ------------------------------------------------------------------ */
/* Create / update / query                                             */
/* ------------------------------------------------------------------ */

const cardWritableFields = {
  title: z.string().min(1),
  description: z.string(),
  notes: z.string(),
  status: StatusInputSchema,
  priority: TaskPrioritySchema,
  objective: z.string(),
  desiredOutcome: z.string(),
  plan: z.array(PlanStepSchema),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema),
  assignedAgent: z.string(),
  approvalMode: ApprovalModeSchema,
  blockerReason: z.string(),
  evidence: z.array(EvidenceSchema),
  goalId: IdSchema,
  parentId: IdSchema,
  dueAt: IsoDateTimeSchema,
  scheduledFor: IsoDateTimeSchema,
  tags: z.array(z.string()),
  source: z.string(),
  externalId: z.string(),
  order: z.number().int(),
  metadata: z.record(z.string(), z.unknown()),
};

export const TaskCardCreateSchema = z
  .object({
    ...cardWritableFields,
    board: BoardKindSchema.optional(),
    conversationId: z.string().min(1).optional(),
  })
  .partial()
  .extend({ title: z.string().min(1) });
export type TaskCardCreate = z.infer<typeof TaskCardCreateSchema>;

export const TaskCardUpdateSchema = z
  .object(cardWritableFields)
  .partial()
  .extend({
    id: IdSchema,
    /** Moving a card between boards. Omit to leave it where it is. */
    board: BoardKindSchema.optional(),
    conversationId: z.string().min(1).optional(),
  });
export type TaskCardUpdate = z.infer<typeof TaskCardUpdateSchema>;

/**
 * List query. A superset of the shared `TaskQuery` — same field names and
 * defaults, plus board scoping — so a renderer typed against the shared type
 * keeps working and a board-aware caller gets what it needs.
 */
export const TaskCardQuerySchema = z.object({
  board: BoardKindSchema.optional(),
  conversationId: z.string().min(1).optional(),
  /** Card statuses, shared statuses, or a mix. */
  status: z.array(StatusInputSchema).optional(),
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
export type TaskCardQuery = z.infer<typeof TaskCardQuerySchema>;
export type TaskCardQueryInput = z.input<typeof TaskCardQuerySchema>;

/* ------------------------------------------------------------------ */
/* Destructive bulk operations                                         */
/* ------------------------------------------------------------------ */

/**
 * The opt-in every bulk destructive call needs.
 *
 * Deliberately not a boolean named `force`: the caller has to type the field
 * name, and the field name says what happens. Defaulting it to `false` (rather
 * than making it required) means an agent that forgets it gets a refusal
 * explaining the flag, not a schema error it will retry blindly.
 */
export const DestructiveOptionsSchema = z.object({
  confirmDestructive: z.boolean().default(false),
  /** Optional guard: refuse if the board does not hold exactly this many. */
  expectedCount: z.number().int().nonnegative().optional(),
});
export type DestructiveOptions = z.infer<typeof DestructiveOptionsSchema>;

/** Thrown when a bulk destructive call arrives without its opt-in flag. */
export class DestructiveOperationBlockedError extends Error {
  readonly code = 'DESTRUCTIVE_BLOCKED';

  readonly operation: string;

  readonly affected: number;

  constructor(operation: string, affected: number, detail?: string) {
    super(
      `Refused to ${operation}: it would remove ${affected} task${
        affected === 1 ? '' : 's'
      }. ${detail ?? 'Pass confirmDestructive: true to allow it.'}`,
    );
    this.name = 'DestructiveOperationBlockedError';
    this.operation = operation;
    this.affected = affected;
  }
}
