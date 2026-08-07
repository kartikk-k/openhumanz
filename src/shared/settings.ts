/**
 * Settings and onboarding state.
 *
 * Every field has a default, so `SettingsSchema.parse({})` yields a complete,
 * valid Settings object. Persisted as JSON at `<workspace>/settings.json`;
 * a partial patch is merged then re-parsed, which means an old settings file
 * missing new keys upgrades itself.
 */
import { z } from 'zod';
import { IsoDateTimeSchema, LogLevelSchema } from './common';
import { ApprovalScopeSchema } from './approvals';

export const EngineSettingsSchema = z.object({
  /** Engine adapter id to use when a run does not name one. */
  preferred: z.string().default('claude-code'),
  /** Explicit binary path. Empty means "find it on PATH". */
  binaryPath: z.string().default(''),
  /** Turn limit applied to every step. Cheaper than loop detection. */
  maxTurnsPerStep: z.number().int().positive().default(20),
  /** Hard cost ceiling per run, USD. 0 disables the check. */
  maxCostUsdPerRun: z.number().nonnegative().default(2),
  /** Wall-clock ceiling for a single step. */
  stepTimeoutMs: z.number().int().positive().default(10 * 60 * 1000),
  /** Working directory for engine invocations. Empty means the workspace root. */
  defaultCwd: z.string().default(''),
});
export type EngineSettings = z.infer<typeof EngineSettingsSchema>;

export const ApprovalSettingsSchema = z.object({
  /** Master switch. Turning this off is a deliberate, loud choice. */
  requireForSideEffecting: z.boolean().default(true),
  /** Whether the `always` button is offered on the approval card. */
  allowAlwaysScope: z.boolean().default(true),
  /** Which scope the card pre-selects. */
  defaultScope: ApprovalScopeSchema.default('once'),
  /** Pending approvals older than this are auto-expired. 0 disables. */
  pendingTtlMs: z.number().int().nonnegative().default(30 * 60 * 1000),
});
export type ApprovalSettings = z.infer<typeof ApprovalSettingsSchema>;

export const MemorySettingsSchema = z.object({
  indexOnStart: z.boolean().default(true),
  /** Watch the vault with chokidar and re-index changed files. */
  watch: z.boolean().default(true),
  /** Vault directory relative to the workspace root. */
  directory: z.string().default('memory'),
});
export type MemorySettings = z.infer<typeof MemorySettingsSchema>;

export const ScheduleSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  /** IANA timezone used when a job does not carry its own. */
  timezone: z.string().default('UTC'),
  /** How often the scheduler wakes to evaluate due jobs. */
  tickMs: z.number().int().positive().default(30_000),
});
export type ScheduleSettings = z.infer<typeof ScheduleSettingsSchema>;

export const UiSettingsSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  density: z.enum(['comfortable', 'compact']).default('comfortable'),
  /** Show cost and token counts inline in the run timeline. */
  showCosts: z.boolean().default(true),
});
export type UiSettings = z.infer<typeof UiSettingsSchema>;

export const SettingsSchema = z.object({
  /** Absolute path. Empty means the default `~/.assistant`. */
  workspaceRoot: z.string().default(''),
  engine: EngineSettingsSchema.default({}),
  approvals: ApprovalSettingsSchema.default({}),
  memory: MemorySettingsSchema.default({}),
  schedule: ScheduleSettingsSchema.default({}),
  ui: UiSettingsSchema.default({}),
  notifications: z
    .object({
      enabled: z.boolean().default(true),
      onApprovalRequired: z.boolean().default(true),
      onRunFinished: z.boolean().default(false),
    })
    .default({}),
  logging: z
    .object({
      level: LogLevelSchema.default('info'),
      /** Rotate the log file once it exceeds this size. */
      maxFileBytes: z.number().int().positive().default(5 * 1024 * 1024),
      maxFiles: z.number().int().positive().default(5),
    })
    .default({}),
});
export type Settings = z.infer<typeof SettingsSchema>;
/** The shape you may hand to `SettingsSchema.parse` — everything optional. */
export type SettingsInput = z.input<typeof SettingsSchema>;

/** A fully populated Settings object built from schema defaults. */
export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

/**
 * Deep-partial patch accepted by `settings:set`. Re-parsed after merging, so
 * an invalid patch is rejected as a whole rather than half-applied.
 */
export const SettingsPatchSchema = z.object({
  workspaceRoot: z.string().optional(),
  engine: EngineSettingsSchema.partial().optional(),
  approvals: ApprovalSettingsSchema.partial().optional(),
  memory: MemorySettingsSchema.partial().optional(),
  schedule: ScheduleSettingsSchema.partial().optional(),
  ui: UiSettingsSchema.partial().optional(),
  notifications: z
    .object({
      enabled: z.boolean(),
      onApprovalRequired: z.boolean(),
      onRunFinished: z.boolean(),
    })
    .partial()
    .optional(),
  logging: z
    .object({
      level: LogLevelSchema,
      maxFileBytes: z.number().int().positive(),
      maxFiles: z.number().int().positive(),
    })
    .partial()
    .optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/* ------------------------------------------------------------------ */
/* Onboarding                                                          */
/* ------------------------------------------------------------------ */

export const ONBOARDING_STEPS = [
  'welcome',
  'engine',
  'workspace',
  'permissions',
  'done',
] as const;
export const OnboardingStepSchema = z.enum(ONBOARDING_STEPS);
export type OnboardingStep = z.infer<typeof OnboardingStepSchema>;

export const OnboardingStateSchema = z.object({
  completed: z.boolean().default(false),
  step: OnboardingStepSchema.default('welcome'),
  engineDetected: z.boolean().default(false),
  workspaceReady: z.boolean().default(false),
  /** User has seen and dismissed the stray-ANTHROPIC_API_KEY warning. */
  acknowledgedApiKeyWarning: z.boolean().default(false),
  completedAt: IsoDateTimeSchema.optional(),
});
export type OnboardingState = z.infer<typeof OnboardingStateSchema>;
export type OnboardingStateInput = z.input<typeof OnboardingStateSchema>;

export const DEFAULT_ONBOARDING_STATE: OnboardingState =
  OnboardingStateSchema.parse({});
