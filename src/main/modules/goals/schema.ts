/**
 * Goal constants and module-local schemas.
 *
 * The wire type is `Goal` from `src/shared/tasks.ts` and is not restated here.
 * What this file adds is the two things that make goals cheap enough to inject
 * into every turn — a hard item cap and a token budget — and the id scheme that
 * survives a human editing the file underneath us.
 */
import { GoalWriteSchema } from '../../../shared/tasks';

/** The file, relative to the workspace root. Deliberately shouty and findable. */
export const GOALS_FILENAME = 'GOALS.md';

/**
 * Hard cap on goals.
 *
 * Not a style preference: the goal list is prepended to every turn, so its cost
 * is paid per-request forever. Eight is roughly the number a person can actually
 * hold, and it forces the useful conversation ("which one drops?") instead of
 * letting the list rot into a backlog.
 */
export const MAX_GOALS = 8;

/**
 * Token budget for the rendered goal list. Also per-turn forever. Both limits
 * apply on write only — a file a human over-filled by hand still parses whole.
 */
export const MAX_GOAL_TOKENS = 500;

/** Ids are `g1`, `g2`, … — short enough for an agent to say out loud. */
export const GOAL_ID_PATTERN = /^g\d+$/;

/**
 * Rough token count. Four characters per token is the usual English estimate and
 * is close enough for a budget whose job is to stop a list from doubling.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Thrown when a write would push the list past its item or token budget. */
export class GoalBudgetError extends Error {
  readonly code = 'GOAL_BUDGET_EXCEEDED';

  constructor(message: string) {
    super(message);
    this.name = 'GoalBudgetError';
  }
}

/** What a caller may write. The shared `GoalWrite`, re-exported by name. */
export const GoalWriteInputSchema = GoalWriteSchema;
