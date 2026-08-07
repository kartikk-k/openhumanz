/**
 * The goals slice of the MCP surface.
 *
 * Two tools. Reading is cheap and unconditional; writing is one gated tool that
 * covers adding, rewriting and dropping, because "propose an edit" is the only
 * verb the agent should have here — the goals are the user's, and the agent's
 * job is to suggest, not to curate.
 *
 * The read result is the compact one-line-per-goal rendering rather than the
 * file. The whole point of the cap is that this can be injected every turn, and
 * returning the full markdown would spend the budget it exists to protect.
 *
 * The edit tool takes a flat object with an `action` discriminator rather than a
 * union, because `z.toJSONSchema` turns a union into a top-level `anyOf`, which
 * MCP cannot publish as a tool input without being wrapped.
 */
import { z } from 'zod';
import { GoalHorizonSchema, GoalStatusSchema } from '../../../shared/tasks';
import { defineTool } from '../types';
import type { AnyToolDefinition } from '../types';
import { renderGoalsCompact } from './markdown';
import { MAX_GOALS } from './schema';
import type { GoalStore } from './store';

const ReadInputSchema = z.object({
  includeInactive: z
    .boolean()
    .default(false)
    .describe('Include paused, achieved and dropped goals.'),
});
type ReadInput = z.infer<typeof ReadInputSchema>;

const EditInputSchema = z.object({
  action: z
    .enum(['set', 'remove'])
    .default('set')
    .describe('`set` adds or rewrites a goal; `remove` drops one.'),
  id: z
    .string()
    .optional()
    .describe('Goal id (g1, g2, …). Omit on `set` to add a new goal.'),
  title: z.string().optional().describe('One line. Required for `set`.'),
  description: z
    .string()
    .optional()
    .describe('Optional context. Keep it short — this is read every turn.'),
  horizon: GoalHorizonSchema.optional(),
  status: GoalStatusSchema.optional(),
  metric: z
    .string()
    .optional()
    .describe("How progress is judged, in the user's own words."),
  targetDate: z.string().optional().describe('ISO-8601 date or timestamp.'),
});
type EditInput = z.infer<typeof EditInputSchema>;

function quote(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return `“${flat.length > 80 ? `${flat.slice(0, 79)}…` : flat}”`;
}

/** Plain language for the approval card. No JSON, no field names. */
export function summarizeEdit(input: EditInput): string {
  if (input.action === 'remove') {
    return `Remove long-term goal ${input.id ?? '(no id given)'} from GOALS.md.`;
  }

  const details: string[] = [];
  if (input.horizon) details.push(`horizon ${input.horizon}`);
  if (input.status) details.push(`status ${input.status}`);
  if (input.metric) details.push(`measured by ${quote(input.metric)}`);
  if (input.targetDate) {
    details.push(`target ${input.targetDate.slice(0, 10)}`);
  }
  const tail = details.length > 0 ? ` (${details.join(', ')})` : '';
  const title = input.title ? quote(input.title) : '(no title given)';

  return input.id
    ? `Rewrite long-term goal ${input.id} as ${title}${tail}.`
    : `Add a long-term goal: ${title}${tail}.`;
}

export interface GoalToolDeps {
  store: GoalStore;
  onChanged(ids: string[]): void;
}

export function createGoalTools(deps: GoalToolDeps): AnyToolDefinition[] {
  const { store, onChanged } = deps;

  const read = defineTool<ReadInput>({
    name: 'goals_read',
    description:
      "The user's long-term goals, one line each. Capped and cheap; read it before planning anything that spans more than a day.",
    inputSchema: ReadInputSchema,
    sideEffecting: false,
    annotations: { title: 'Read goals', readOnlyHint: true },
    async handler(input) {
      const goals = await store.list(
        input.includeInactive ? undefined : { status: ['active'] },
      );
      const budget = await store.budget();
      const shown = goals.slice(0, MAX_GOALS);
      return {
        markdown: renderGoalsCompact(shown),
        count: shown.length,
        truncated: Math.max(0, goals.length - shown.length),
        ...(budget.overBudget
          ? {
              note: `GOALS.md is over budget (${budget.count}/${budget.maxCount} goals, ~${budget.tokens}/${budget.maxTokens} tokens). Suggest trimming it.`,
            }
          : {}),
      };
    },
  });

  const propose = defineTool<EditInput>({
    name: 'goals_propose_edit',
    description:
      "Propose a change to the user's long-term goals: add one, rewrite one, or remove one. Capped at 8 goals — if the list is full, say which one should go rather than forcing another in.",
    inputSchema: EditInputSchema,
    sideEffecting: true,
    summarize: summarizeEdit,
    annotations: { title: 'Propose a goal edit', idempotentHint: true },
    async handler(input) {
      if (input.action === 'remove') {
        if (!input.id) throw new Error('Removing a goal needs its id.');
        const removed = await store.remove(input.id);
        if (removed) onChanged([input.id]);
        return { id: input.id, removed };
      }

      if (!input.title) {
        throw new Error('Setting a goal needs a title.');
      }
      const goal = await store.write({
        id: input.id,
        title: input.title,
        description: input.description,
        horizon: input.horizon,
        status: input.status,
        metric: input.metric,
        targetDate: input.targetDate,
      });
      onChanged([goal.id]);
      const budget = await store.budget();
      return {
        id: goal.id,
        summary: `${goal.id}: ${goal.title}`,
        goals: `${budget.count}/${budget.maxCount}`,
      };
    },
  });

  return [read, propose];
}
