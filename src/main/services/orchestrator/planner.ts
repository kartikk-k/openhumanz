/**
 * Turning a request into steps.
 *
 * Decomposition is a policy decision, so it is a swappable interface rather
 * than a hard-coded loop — an LLM planner can replace this without touching the
 * executor. What is *not* negotiable is the invariant the default planner
 * enforces on whatever a planner returns: **every step gets an explicit tool
 * scope and an explicit budget.** A step with no ceiling is a step that can
 * spend a weekly quota on a loop, so there is no code path that produces one.
 *
 * Two sources of steps today:
 *  - an explicit plan handed in through `metadata.plan` (the scheduler and the
 *    UI both want this), validated with zod like anything else crossing a
 *    boundary;
 *  - otherwise, one step containing the whole prompt.
 *
 * One step is the honest default. Guessing at a decomposition without a model
 * to do it produces steps whose boundaries mean nothing, and a meaningless step
 * boundary is worse than none — it splits the budget without splitting the
 * blast radius.
 */
import { z } from 'zod';
import type { PlanContext, PlannedStep, Planner, RunPlan } from './types';

/** `metadata.plan` — an explicit decomposition supplied by the caller. */
export const PlanInputSchema = z.object({
  title: z.string().min(1).optional(),
  steps: z
    .array(
      z.object({
        name: z.string().min(1),
        prompt: z.string().min(1),
        allowedTools: z.array(z.string()).optional(),
        maxTurns: z.number().int().positive().optional(),
        maxCostUsd: z.number().positive().optional(),
        cwd: z.string().optional(),
        continueSession: z.boolean().optional(),
        model: z.string().optional(),
      }),
    )
    .min(1),
});
export type PlanInput = z.infer<typeof PlanInputSchema>;

/** Ceilings applied when neither the request nor the plan names one. */
export const DEFAULT_MAX_TURNS = 20;
export const DEFAULT_MAX_COST_USD = 2;

/**
 * Fill in every ceiling and clamp it to the run-level one. A step may ask for
 * less than the run allows; it may never ask for more.
 */
export function normalizeStep(
  step: Omit<PlannedStep, 'allowedTools'> & { allowedTools?: string[] },
  ctx: PlanContext,
): PlannedStep {
  const maxTurns = Math.max(
    1,
    Math.min(step.maxTurns ?? ctx.defaults.maxTurns, ctx.defaults.maxTurns),
  );
  const maxCostUsd = Math.min(
    step.maxCostUsd ?? ctx.defaults.maxCostUsd,
    ctx.defaults.maxCostUsd,
  );
  return {
    ...step,
    allowedTools: [
      ...new Set(
        step.allowedTools && step.allowedTools.length > 0
          ? step.allowedTools
          : ctx.defaults.allowedTools,
      ),
    ],
    maxTurns,
    maxCostUsd: maxCostUsd > 0 ? maxCostUsd : ctx.defaults.maxCostUsd,
    cwd: step.cwd ?? ctx.cwd,
  };
}

export function createDefaultPlanner(): Planner {
  return {
    plan(request, ctx): RunPlan {
      const explicit = PlanInputSchema.safeParse(request.metadata?.plan);
      if (explicit.success) {
        return {
          title: explicit.data.title ?? request.title,
          steps: explicit.data.steps.map((step) => normalizeStep(step, ctx)),
        };
      }

      return {
        title: request.title,
        steps: [
          normalizeStep(
            {
              name: 'Run',
              prompt: request.prompt,
              allowedTools: request.allowedTools ?? ctx.defaults.allowedTools,
              maxTurns: request.maxTurns,
              maxCostUsd: request.maxCostUsd,
            },
            ctx,
          ),
        ],
      };
    },
  };
}

/** A readable run title from a prompt, for the runs list. */
export function titleFromPrompt(prompt: string, maxLength = 72): string {
  const firstLine = prompt.trim().split('\n')[0]?.trim() ?? '';
  const cleaned = firstLine.replace(/\s+/g, ' ');
  if (!cleaned) return 'Untitled run';
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1).trimEnd()}…`;
}
