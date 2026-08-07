/**
 * The module's view of `settings.approvals`.
 *
 * Modules must not import each other, so this does not go and ask a settings
 * module: it reads `<workspace>/settings.json` directly (the same file the
 * settings owner writes) and then keeps itself current from the
 * `settings:changed` event on the bus. Missing or malformed file means schema
 * defaults, never a failure to start.
 */
import fs from 'node:fs';
import {
  ApprovalSettingsSchema,
  DEFAULT_SETTINGS,
  SettingsSchema,
} from '../../../shared/settings';
import type { ApprovalSettings, Settings } from '../../../shared/settings';

export function defaultApprovalSettings(): ApprovalSettings {
  return ApprovalSettingsSchema.parse({});
}

/** Read `settings.approvals` off disk. Never throws. */
export function readApprovalSettings(settingsFile: string): ApprovalSettings {
  try {
    const raw = fs.readFileSync(settingsFile, 'utf8');
    const parsed = SettingsSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) return DEFAULT_SETTINGS.approvals;
    return parsed.data.approvals;
  } catch {
    return DEFAULT_SETTINGS.approvals;
  }
}

export function approvalSettingsFrom(settings: Settings): ApprovalSettings {
  return settings.approvals ?? DEFAULT_SETTINGS.approvals;
}
