/**
 * The task-card schema.
 *
 * `src/shared/tasks.ts` owns the wire contract, and it now carries the whole
 * card: the richer status lifecycle, the board, and the prose fields
 * (objective, desired outcome, plan, acceptance criteria, assigned agent,
 * approval mode, blocker reason, evidence). What is left here is the module's
 * own write/query surface and the board helpers.
 *
 * Two compromises are gone:
 *
 *  1. **Status.** There is no separate card vocabulary any more. `cardStatus`
 *     used to be canonical with `Task.status` derived from it on every read;
 *     shared adopted the richer enum, so that mapping is the identity and the
 *     second field is gone. {@link toTaskStatus} still normalises the legacy
 *     spellings for rows already on disk.
 *  2. **Boards.** `board` / `conversationId` are real fields on `Task`.
 */
import { z } from 'zod';
import {
  AcceptanceCriterionSchema,
  ApprovalModeSchema,
  BoardKindSchema,
  EvidenceSchema,
  PlanStepSchema,
  TaskPrioritySchema,
  TASK_STATUSES,
  TaskQuerySchema,
  TaskSchema,
  TaskStatusInputSchema,
  TERMINAL_TASK_STATUSES,
  toTaskStatus,
} from '../../../shared/tasks';
import type { BoardKind, Task, TaskStatus } from '../../../shared/tasks';
import { IdSchema, patchSchema } from '../../../shared/common';

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

/**
 * The board's lifecycle — the shared vocabulary, unchanged. These aliases
 * exist so the module's own files (store, tools, markdown) keep one import
 * site; `CardStatus` and `TaskStatus` are the same type.
 */
export const CARD_STATUSES = TASK_STATUSES;
export const CardStatusSchema = z.enum(CARD_STATUSES);
export type CardStatus = TaskStatus;

export const TERMINAL_CARD_STATUSES = TERMINAL_TASK_STATUSES;

/** Normalise any status spelling, current or legacy, to a {@link CardStatus}. */
export const toCardStatus = toTaskStatus;

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

/** What a writer may send as a status: the current enum plus legacy aliases. */
export const StatusInputSchema = TaskStatusInputSchema;
export type StatusInput = z.infer<typeof StatusInputSchema>;

/* ------------------------------------------------------------------ */
/* Boards                                                              */
/* ------------------------------------------------------------------ */

/** Board kinds live in shared/ now; re-exported so this stays one import site. */
export { BOARD_KINDS, BoardKindSchema } from '../../../shared/tasks';
export type { BoardKind } from '../../../shared/tasks';

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

/**
 * All of these are shared contract now — a renderer typed against `Task` can
 * see them. Re-exported so the module's files keep one import site.
 */
export {
  PlanStepSchema,
  AcceptanceCriterionSchema,
  EvidenceSchema,
  APPROVAL_MODES,
  ApprovalModeSchema,
} from '../../../shared/tasks';
export type {
  PlanStep,
  AcceptanceCriterion,
  Evidence,
  ApprovalMode,
} from '../../../shared/tasks';

/* ------------------------------------------------------------------ */
/* The card                                                            */
/* ------------------------------------------------------------------ */

/**
 * A board card is just a {@link Task} now — every field it needs is in the
 * shared contract. The alias is kept so the module's files (and its tests)
 * keep reading in terms of cards.
 */
export const TaskCardSchema = TaskSchema;

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

/**
 * The writable half of a card, as a patch: every field optional and every
 * default stripped, so "not mentioned" stays distinguishable from "set to the
 * default".
 *
 * Derived from `TaskSchema` with {@link patchSchema} rather than hand-listed.
 * It used to be a hand-maintained copy, because the shared patch schemas were
 * built with `.partial()` and zod v4 applies field defaults through it — a
 * title-only update came back carrying `notes: ''` and `order: 0` and blanked
 * the card. Shared strips the defaults now, so the copy is gone and a new
 * field on `Task` is writable here automatically.
 *
 * `board` / `conversationId` are excluded and re-added per schema below: they
 * are resolved together by {@link resolveBoard}, not written field by field.
 */
const cardPatchFields = patchSchema(
  TaskSchema.omit({
    id: true,
    createdAt: true,
    updatedAt: true,
    completedAt: true,
    board: true,
    conversationId: true,
  }),
).extend({
  /** Writers may use a legacy spelling; normalised on the way in. */
  status: StatusInputSchema.optional(),
});

export const TaskCardCreateSchema = cardPatchFields.extend({
  title: z.string().min(1),
  board: BoardKindSchema.optional(),
  conversationId: z.string().min(1).optional(),
});
export type TaskCardCreate = z.infer<typeof TaskCardCreateSchema>;

export const TaskCardUpdateSchema = cardPatchFields.extend({
  id: IdSchema,
  /** Moving a card between boards. Omit to leave it where it is. */
  board: BoardKindSchema.optional(),
  conversationId: z.string().min(1).optional(),
});
export type TaskCardUpdate = z.infer<typeof TaskCardUpdateSchema>;

/**
 * List query. The shared `TaskQuery` carries board scoping and
 * `assignedAgent` now, so there is nothing left to add — this is an alias.
 */
export const TaskCardQuerySchema = TaskQuerySchema;
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
