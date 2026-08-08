/**
 * The tasks slice of the MCP surface.
 *
 * Four tools: list, get, create, update. No delete and no bulk clear — an agent
 * that can silently empty the user's board is a bug waiting to happen, and the
 * destructive API in `store.ts` is reachable only from the app, behind an
 * explicit opt-in flag.
 *
 * Results are markdown, not JSON. The agent pays for every byte returned, and
 * the rendered board is both smaller and more readable than the object graph it
 * came from. Full card bodies are fetched one at a time by id.
 */
import { z } from 'zod';
import { defineTool } from '../types';
import type { AnyToolDefinition } from '../types';
import { renderBoard, renderCard } from './markdown';
import {
  AcceptanceCriterionSchema,
  ApprovalModeSchema,
  BoardKindSchema,
  CARD_STATUS_LABELS,
  CardStatusSchema,
  EvidenceSchema,
  PlanStepSchema,
  TaskCardQuerySchema,
  resolveBoard,
} from './schema';
import type { TaskStore } from './store';
import { TaskPrioritySchema } from '../../../shared/tasks';

/** How many cards a single list call will render before it starts truncating. */
const LIST_LIMIT = 50;

const boardFields = {
  board: BoardKindSchema.optional().describe(
    "Which board. Omit for the user's standing personal board.",
  ),
  conversationId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Scope to one conversation or run. Implies the conversation board.',
    ),
};

/* ------------------------------------------------------------------ */
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const ListInputSchema = z.object({
  ...boardFields,
  status: z
    .array(CardStatusSchema)
    .optional()
    .describe('Filter to these statuses. Omit for everything unfinished.'),
  assignedAgent: z.string().optional(),
  tag: z.string().optional(),
  search: z.string().optional().describe('Substring match on title and body.'),
  includeCompleted: z
    .boolean()
    .default(false)
    .describe('Include done and rejected cards.'),
  limit: z.number().int().positive().max(200).default(LIST_LIMIT),
});

const GetInputSchema = z.object({
  id: z.string().min(1).describe('Task id, as shown on the board.'),
});

const CardBodySchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  objective: z.string().optional().describe('Why this card exists.'),
  desiredOutcome: z
    .string()
    .optional()
    .describe('What is true when it is finished.'),
  plan: z
    .array(PlanStepSchema)
    .optional()
    .describe('Ordered execution steps. Array order is step order.'),
  acceptanceCriteria: z
    .array(AcceptanceCriterionSchema)
    .optional()
    .describe('Checklist that decides whether the card is done.'),
  status: CardStatusSchema.optional(),
  priority: TaskPrioritySchema.optional(),
  assignedAgent: z.string().optional(),
  approvalMode: ApprovalModeSchema.optional(),
  notes: z.string().optional(),
  blockerReason: z
    .string()
    .optional()
    .describe('Why it is stuck. Set this whenever status is blocked.'),
  evidence: z
    .array(EvidenceSchema)
    .optional()
    .describe('Links or paths showing the work was done.'),
  tags: z.array(z.string()).optional(),
  dueAt: z.string().optional().describe('ISO-8601 timestamp.'),
  goalId: z.string().optional().describe('Long-term goal this serves.'),
  parentId: z.string().optional(),
});

const CreateInputSchema = CardBodySchema.extend(boardFields);

const UpdateInputSchema = CardBodySchema.partial()
  .extend(boardFields)
  .extend({ id: z.string().min(1) });

type ListInput = z.infer<typeof ListInputSchema>;
type GetInput = z.infer<typeof GetInputSchema>;
type CreateInput = z.infer<typeof CreateInputSchema>;
type UpdateInput = z.infer<typeof UpdateInputSchema>;

/* ------------------------------------------------------------------ */
/* Plain-language summaries                                            */
/* ------------------------------------------------------------------ */

function boardPhrase(input: {
  board?: string;
  conversationId?: string;
}): string {
  return input.conversationId
    ? `the board for conversation ${input.conversationId}`
    : 'the personal task board';
}

function quote(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return `“${flat.length > 70 ? `${flat.slice(0, 69)}…` : flat}”`;
}

/** `1 step` / `3 steps`. An approval card that says "1 step(s)" reads as a bug. */
function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * What the user reads on the approval card. Plain sentences, no JSON: the point
 * of the card is that someone can decide in two seconds without expanding it.
 */
export function summarizeCreate(input: CreateInput): string {
  const parts = [`Add a task to ${boardPhrase(input)}: ${quote(input.title)}`];
  const extras: string[] = [];
  if (input.assignedAgent) extras.push(`assigned to ${input.assignedAgent}`);
  if (input.status && input.status !== 'todo') {
    extras.push(`status ${CARD_STATUS_LABELS[input.status].toLowerCase()}`);
  }
  if (input.priority && input.priority !== 'normal') {
    extras.push(`${input.priority} priority`);
  }
  if (input.plan?.length) extras.push(`${input.plan.length}-step plan`);
  if (input.acceptanceCriteria?.length) {
    extras.push(
      count(
        input.acceptanceCriteria.length,
        'acceptance criterion',
        'acceptance criteria',
      ),
    );
  }
  if (extras.length > 0) parts.push(` (${extras.join(', ')})`);
  return `${parts.join('')}.`;
}

export function summarizeUpdate(input: UpdateInput): string {
  const changes: string[] = [];
  if (input.status) {
    changes.push(`move it to ${CARD_STATUS_LABELS[input.status]}`);
  }
  if (input.title) changes.push(`rename it to ${quote(input.title)}`);
  if (input.assignedAgent) changes.push(`assign it to ${input.assignedAgent}`);
  if (input.priority) changes.push(`set priority to ${input.priority}`);
  if (input.blockerReason) {
    changes.push(`record a blocker: ${quote(input.blockerReason)}`);
  }
  if (input.plan) {
    changes.push(`replace the plan with ${count(input.plan.length, 'step')}`);
  }
  if (input.acceptanceCriteria) {
    changes.push(
      `replace the acceptance criteria with ${count(
        input.acceptanceCriteria.length,
        'item',
      )}`,
    );
  }
  if (input.evidence) {
    changes.push(`attach ${count(input.evidence.length, 'piece')} of evidence`);
  }
  if (input.objective) changes.push('rewrite the objective');
  if (input.desiredOutcome) changes.push('rewrite the desired outcome');
  if (input.description) changes.push('rewrite the description');
  if (input.notes) changes.push('update the notes');
  if (input.tags)
    changes.push(`set tags to ${input.tags.join(', ') || 'none'}`);
  if (input.dueAt)
    changes.push(`set the due date to ${input.dueAt.slice(0, 10)}`);
  if (input.approvalMode) {
    changes.push(`set approval mode to ${input.approvalMode}`);
  }
  if (input.goalId) changes.push(`link it to goal ${input.goalId}`);
  if (input.board || input.conversationId) {
    changes.push(`move it to ${boardPhrase(input)}`);
  }

  if (changes.length === 0) return `Update task ${input.id} (no changes).`;
  return `Update task ${input.id}: ${changes.join(', ')}.`;
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

export interface TaskToolDeps {
  store: TaskStore;
  /** Called after any mutation, with the ids that changed. */
  onChanged(ids: string[]): void;
}

export function createTaskTools(deps: TaskToolDeps): AnyToolDefinition[] {
  const { store, onChanged } = deps;

  const list = defineTool<ListInput>({
    name: 'tasks_list',
    description:
      'Read a task board as markdown. Defaults to the personal board and hides finished cards. Returns one line per task; use tasks_get for the full card.',
    inputSchema: ListInputSchema,
    sideEffecting: false,
    annotations: { title: 'List tasks', readOnlyHint: true },
    handler(input) {
      const board = resolveBoard(input);
      const query = TaskCardQuerySchema.parse({
        board: board.board,
        conversationId: board.conversationId,
        status: input.status,
        assignedAgent: input.assignedAgent,
        tag: input.tag,
        search: input.search,
        includeCompleted: input.includeCompleted,
        limit: input.limit,
      });
      const page = store.list(query);
      return {
        markdown: renderBoard(page.items, {
          board: board.board,
          conversationId: board.conversationId,
          total: page.total,
        }),
        shown: page.items.length,
        total: page.total,
      };
    },
  });

  const get = defineTool<GetInput>({
    name: 'tasks_get',
    description:
      'The full task card as markdown: objective, desired outcome, execution plan, acceptance criteria, blocker and evidence.',
    inputSchema: GetInputSchema,
    sideEffecting: false,
    annotations: { title: 'Get a task', readOnlyHint: true },
    handler(input) {
      const card = store.get(input.id);
      if (!card) return { found: false, id: input.id };
      return { found: true, id: card.id, markdown: renderCard(card) };
    },
  });

  const create = defineTool<CreateInput>({
    name: 'tasks_create',
    description:
      "Add a task card to a board. Use the conversation board for work you are doing now, and the personal board for the user's standing commitments.",
    inputSchema: CreateInputSchema,
    sideEffecting: true,
    summarize: summarizeCreate,
    annotations: { title: 'Create a task', destructiveHint: false },
    handler(input) {
      const card = store.create({ ...input, source: 'agent' });
      onChanged([card.id]);
      return {
        id: card.id,
        status: card.status,
        board: card.board,
        summary: `Created ${quote(card.title)} on the ${card.board} board.`,
      };
    },
  });

  const update = defineTool<UpdateInput>({
    name: 'tasks_update',
    description:
      'Change a task card. Only the fields you pass are touched; passing plan or acceptanceCriteria replaces that list entirely. Set blockerReason whenever you set status to blocked.',
    inputSchema: UpdateInputSchema,
    sideEffecting: true,
    summarize: summarizeUpdate,
    annotations: { title: 'Update a task', idempotentHint: true },
    handler(input) {
      const card = store.update(input);
      onChanged([card.id]);
      return {
        id: card.id,
        status: card.status,
        summary: `${quote(card.title)} is now ${CARD_STATUS_LABELS[
          card.status
        ].toLowerCase()}.`,
      };
    },
  });

  return [list, get, create, update];
}
