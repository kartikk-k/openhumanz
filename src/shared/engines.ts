/**
 * Engine (agent CLI) detection and platform-capability availability.
 *
 * Two separate concerns share this file because they answer the same UI
 * question — "what can this machine actually do right now?".
 *
 * `available: false` is a normal, expected state. macOS-only capabilities on
 * Linux report `available: false` with a `reason`; they never throw.
 */
import { z } from 'zod';
import { IsoDateTimeSchema } from './common';

export const KNOWN_ENGINE_IDS = ['claude-code'] as const;
/** Not a closed enum — adapters may be added without touching shared/. */
export const EngineIdSchema = z.string().min(1);
export type EngineId = z.infer<typeof EngineIdSchema>;

export const EngineInfoSchema = z.object({
  id: EngineIdSchema,
  /** Display name, e.g. "Claude Code". */
  name: z.string().min(1),
  available: z.boolean(),
  /** Resolved absolute path to the binary, when found. */
  binaryPath: z.string().optional(),
  version: z.string().optional(),
  /** Why it is unavailable. Shown verbatim in onboarding. */
  reason: z.string().optional(),
  supportsResume: z.boolean().default(false),
  supportsStreamingJson: z.boolean().default(false),
  detectedAt: IsoDateTimeSchema,
});
export type EngineInfo = z.infer<typeof EngineInfoSchema>;

/**
 * A capability backed by the host OS or an installed app.
 * `platforms` lists the `process.platform` values it can ever work on.
 */
export const PROVIDER_KINDS = [
  'mail',
  'calendar',
  'reminders',
  'notes',
  'contacts',
  'messages',
  'notifications',
  'shortcuts',
  'filesystem',
] as const;
/** Open string, like EngineId — the const list is a convenience, not a gate. */
export const ProviderIdSchema = z.string().min(1);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ProviderAvailabilitySchema = z.object({
  id: ProviderIdSchema,
  name: z.string().min(1),
  available: z.boolean(),
  /** `process.platform` values this provider can work on. */
  platforms: z.array(z.string()).default([]),
  /** Populated whenever `available` is false. Never empty in that case. */
  reason: z.string().optional(),
  /** True when the OS gates this behind a user permission prompt. */
  requiresPermission: z.boolean().default(false),
  permissionGranted: z.boolean().optional(),
  checkedAt: IsoDateTimeSchema,
});
export type ProviderAvailability = z.infer<typeof ProviderAvailabilitySchema>;

/** Everything the onboarding and settings screens need in one call. */
export const EnvironmentStatusSchema = z.object({
  platform: z.string(),
  engines: z.array(EngineInfoSchema),
  providers: z.array(ProviderAvailabilitySchema),
  /**
   * True when `ANTHROPIC_API_KEY` is set in the environment we would spawn
   * with. Bare/API-key mode inverts the subscription premise and silently
   * burns credit, so we surface it loudly instead of hiding it.
   */
  apiKeyEnvDetected: z.boolean().default(false),
  warnings: z.array(z.string()).default([]),
  checkedAt: IsoDateTimeSchema,
});
export type EnvironmentStatus = z.infer<typeof EnvironmentStatusSchema>;

export const EngineDetectRequestSchema = z.object({
  /** Ignore any cached detection result and probe again. */
  force: z.boolean().default(false),
});
export type EngineDetectRequest = z.infer<typeof EngineDetectRequestSchema>;
export type EngineDetectRequestInput = z.input<
  typeof EngineDetectRequestSchema
>;
