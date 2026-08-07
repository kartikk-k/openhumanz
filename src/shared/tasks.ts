/**
 * Tasks and goals.
 *
 * Goals are the long-lived intent; tasks are the units of work. Both are
 * structured state (SQLite). Their prose lives in the memory vault.
 */
import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema, JsonObjectSchema } from './common';

export const TASK_STATUSES = [
  'inbox',
  'todo',
  'doing',
  'blocked',
  'done',
  'cancelled',
] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const TaskPrioritySchema = z.enum(TASK_PRIORITIES);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

export const TaskSchema = z.object({
  id: IdSchema,
  title: z.string().min(1),
  notes: z.string().default(''),
  status: TaskStatusSchema.default('inbox'),
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
});
export type TaskCreate = z.infer<typeof TaskCreateSchema>;
export type TaskCreateInput = z.input<typeof TaskCreateSchema>;

export const TaskUpdateSchema = TaskSchema.omit({
  createdAt: true,
  updatedAt: true,
})
  .partial()
  .extend({ id: IdSchema });
export type TaskUpdate = z.infer<typeof TaskUpdateSchema>;

export const TaskQuerySchema = z.object({
  status: z.array(TaskStatusSchema).optional(),
  priority: z.array(TaskPrioritySchema).optional(),
  goalId: IdSchema.optional(),
  parentId: IdSchema.optional(),
  tag: z.string().optional(),
  search: z.string().optional(),
  dueBefore: IsoDateTimeSchema.optional(),
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

export const GoalWriteSchema = GoalSchema.omit({
  createdAt: true,
  updatedAt: true,
})
  .partial()
  .extend({ title: z.string().min(1) });
export type GoalWrite = z.infer<typeof GoalWriteSchema>;

export const GoalQuerySchema = z.object({
  status: z.array(GoalStatusSchema).optional(),
  horizon: z.array(GoalHorizonSchema).optional(),
});
export type GoalQuery = z.infer<typeof GoalQuerySchema>;
export type GoalQueryInput = z.input<typeof GoalQuerySchema>;
