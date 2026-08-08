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
 * Sources of steps, in precedence order:
 *  - `request.plan` — an explicit decomposition, with an optional title;
 *  - `request.steps` — the same thing without the title;
 *  - `metadata.plan` — where the decomposition used to travel, before
 *    `RunStartRequest` had a field for it. Still read so a caller written
 *    against the old shape keeps working;
 *  - otherwise, one step containing the whole prompt.
 *
 * One step is the honest default. Guessing at a decomposition without a model
 * to do it produces steps whose boundaries mean nothing, and a meaningless step
 * boundary is worse than none — it splits the budget without splitting the
 * blast radius.
 */
import { RunPlanInputSchema } from '../../../shared/runs';
import type { PlanContext, PlannedStep, Planner, RunPlan } from './types';

/**
 * An explicit decomposition supplied by the caller.
 *
 * This shape lives in `shared/runs.ts` now — it is what `RunStartRequest.plan`
 * carries — and is re-exported here under its original name for callers that
 * already import it from the planner.
 */
export { RunPlanInputSchema as PlanInputSchema } from '../../../shared/runs';
export type { RunPlanInput as PlanInput } from '../../../shared/runs';

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
      // Real fields first; `metadata.plan` is the legacy channel and is only
      // consulted when neither is present.
      const source =
        request.plan ??
        (request.steps ? { steps: request.steps } : undefined) ??
        request.metadata?.plan;
      const explicit = RunPlanInputSchema.safeParse(source);
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
