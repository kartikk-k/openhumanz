/**
 * Settings and onboarding state.
 *
 * Every field has a default, so `SettingsSchema.parse({})` yields a complete,
 * valid Settings object. Persisted as JSON at `<workspace>/settings.json`;
 * a partial patch is merged then re-parsed, which means an old settings file
 * missing new keys upgrades itself.
 */
import { z } from 'zod';
import { IsoDateTimeSchema, LogLevelSchema, patchSchema } from './common';
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
  stepTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(10 * 60 * 1000),
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
  pendingTtlMs: z
    .number()
    .int()
    .nonnegative()
    .default(30 * 60 * 1000),
});
export type ApprovalSettings = z.infer<typeof ApprovalSettingsSchema>;

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

export const NotificationSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  onApprovalRequired: z.boolean().default(true),
  onRunFinished: z.boolean().default(false),
});
export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>;

export const LoggingSettingsSchema = z.object({
  level: LogLevelSchema.default('info'),
  /** Rotate the log file once it exceeds this size. */
  maxFileBytes: z
    .number()
    .int()
    .positive()
    .default(5 * 1024 * 1024),
  maxFiles: z.number().int().positive().default(5),
});
export type LoggingSettings = z.infer<typeof LoggingSettingsSchema>;

/**
 * Composio — the "bring your own account" connector. The API key is the user's
 * own Composio org credential; their connected apps live in their account. It
 * is stored here in plain settings.json, consistent with the app's local-files
 * model (nothing is uploaded anywhere but Composio, and only when the user acts).
 */
export const ComposioSettingsSchema = z.object({
  /** The user's Composio API key. Empty means "not connected". */
  apiKey: z.string().default(''),
});
export type ComposioSettings = z.infer<typeof ComposioSettingsSchema>;

/**
 * The memory engine (supermemory). Memories, embeddings and the vector store all
 * live on-device; fact extraction runs through the user's own Claude via a local
 * shim, so nothing needs an external key. These control the local server.
 */
export const SupermemorySettingsSchema = z.object({
  /** Run the local supermemory server. When false, memory tools are inert. */
  enabled: z.boolean().default(true),
  /** Extract memories from chat automatically, not just on explicit request. */
  autoCapture: z.boolean().default(true),
  /** Port the local server listens on. */
  port: z.number().int().positive().default(8787),
});
export type SupermemorySettings = z.infer<typeof SupermemorySettingsSchema>;

/**
 * Voice — speech-to-text for the hold-to-talk interaction. We send recorded
 * audio to OpenAI's transcription API and feed the transcript into chat. The
 * key is the user's own OpenAI key, stored here in plain settings.json (which
 * lives OUTSIDE the repo, like the Composio key) and editable from Settings.
 */
export const VoiceSettingsSchema = z.object({
  /** The user's OpenAI API key. Empty means voice is not configured. */
  openaiApiKey: z.string().default(''),
  /** Transcription model. gpt-4o-transcribe is newer/better than whisper-1. */
  transcribeModel: z.string().default('gpt-4o-transcribe'),
  /** BCP-47 transcription language. Empty means auto-detect. */
  language: z.string().default(''),
  /** Optional vocabulary/context hint to bias transcription. */
  prompt: z.string().default(''),
});
export type VoiceSettings = z.infer<typeof VoiceSettingsSchema>;

/**
 * Note on `.prefault({})` rather than `.default({})`:
 * in zod v4 `.default()` takes the schema's *output* type, so a nested object
 * whose every leaf has a default still cannot be defaulted from `{}` — the
 * output type has all keys required. `.prefault()` takes the *input* type,
 * which for these schemas is fully optional, and then runs the value through
 * parsing so the leaf defaults fill in. That is exactly the behaviour we want.
 */
export const SettingsSchema = z.object({
  /** Absolute path. Empty means the default `~/.assistant`. */
  workspaceRoot: z.string().default(''),
  engine: EngineSettingsSchema.prefault({}),
  approvals: ApprovalSettingsSchema.prefault({}),
  schedule: ScheduleSettingsSchema.prefault({}),
  ui: UiSettingsSchema.prefault({}),
  notifications: NotificationSettingsSchema.prefault({}),
  logging: LoggingSettingsSchema.prefault({}),
  composio: ComposioSettingsSchema.prefault({}),
  supermemory: SupermemorySettingsSchema.prefault({}),
  voice: VoiceSettingsSchema.prefault({}),
});
export type Settings = z.infer<typeof SettingsSchema>;
/** The shape you may hand to `SettingsSchema.parse` — everything optional. */
export type SettingsInput = z.input<typeof SettingsSchema>;

/** A fully populated Settings object built from schema defaults. */
export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

/**
 * Deep-partial patch accepted by `settings:set`. Re-parsed after merging, so
 * an invalid patch is rejected as a whole rather than half-applied.
 *
 * Each section uses {@link patchSchema}, not `.partial()`. Every leaf here
 * carries a default, and `.partial()` still applies them — so `{ui:{theme:
 * 'dark'}}` would parse to a full `ui` section and the merge would reset
 * `density` and `showCosts` to factory values. Stripping the defaults keeps a
 * patch a patch.
 */
export const SettingsPatchSchema = z.object({
  workspaceRoot: z.string().optional(),
  engine: patchSchema(EngineSettingsSchema).optional(),
  approvals: patchSchema(ApprovalSettingsSchema).optional(),
  schedule: patchSchema(ScheduleSettingsSchema).optional(),
  ui: patchSchema(UiSettingsSchema).optional(),
  notifications: patchSchema(NotificationSettingsSchema).optional(),
  logging: patchSchema(LoggingSettingsSchema).optional(),
  composio: patchSchema(ComposioSettingsSchema).optional(),
  supermemory: patchSchema(SupermemorySettingsSchema).optional(),
  voice: patchSchema(VoiceSettingsSchema).optional(),
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

/**
 * Patch accepted by `onboarding:set`. Same reasoning as
 * {@link SettingsPatchSchema}: with `.partial()` a `{step:'engine'}` patch
 * would carry `completed:false` and reset a finished onboarding.
 */
export const OnboardingStatePatchSchema = patchSchema(OnboardingStateSchema);
export type OnboardingStatePatch = z.infer<typeof OnboardingStatePatchSchema>;
