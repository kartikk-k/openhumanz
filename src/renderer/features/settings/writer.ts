/**
 * The one place settings are written from.
 *
 * Two guarantees the screen relies on:
 *
 *  1. **Nothing invalid is ever sent.** Every patch is run through
 *     `SettingsPatchSchema` before it leaves the renderer, so a bad value is
 *     refused here with a sentence the user can read, instead of travelling to
 *     main, failing there, and coming back as a generic write error — or worse,
 *     being persisted.
 *  2. **Failure is visible.** `settingsStore.update` returns `false` and stores
 *     the message; on its own that is silent. This raises a toast naming the
 *     setting that did not save, and distinguishes "the app is not wired up
 *     yet" from "the value was rejected".
 */
import { useCallback, useState } from 'react';
import {
  SettingsPatchSchema,
  type SettingsPatch,
} from '../../../shared/settings';
import { isBridgeAvailable } from '../../lib/ipc';
import { toast, useSettingsStore } from '../../store';

/**
 * The shape of a zod failure, structurally.
 *
 * Declared rather than imported so a screen-level validator (the time-zone
 * check, which `Intl` decides and no schema can) can produce one without
 * constructing a real `ZodError`. Every `z.ZodError` satisfies it.
 */
export interface SchemaIssue {
  path: readonly PropertyKey[];
  message: string;
}
export interface SchemaError {
  issues: readonly SchemaIssue[];
}

/** The most useful sentence out of a zod failure. */
export function firstIssueMessage(error: SchemaError): string {
  const issue = error.issues[0];
  if (!issue) return 'That value is not allowed.';
  const path = issue.path.join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

export interface SettingsWriter {
  /**
   * Validate, send, report. `label` names the setting in any error toast —
   * "Turn limit could not be saved" beats "Save failed".
   */
  write: (patch: SettingsPatch, label: string) => Promise<boolean>;
  saving: boolean;
  /** False when there is no main process to save to. */
  canWrite: boolean;
  /** Why writing is impossible, when it is. */
  blockedReason: string | null;
}

export function useSettingsWriter(): SettingsWriter {
  const update = useSettingsStore((state) => state.update);
  const status = useSettingsStore((state) => state.status);
  const unavailable = useSettingsStore((state) => state.unavailable);
  const [saving, setSaving] = useState(false);

  const bridge = isBridgeAvailable();
  const blocked = !bridge || (status === 'error' && unavailable);

  let blockedReason: string | null = null;
  if (!bridge) {
    blockedReason =
      'This window is not attached to the desktop app, so settings cannot be saved.';
  } else if (blocked) {
    blockedReason =
      'The settings service has not started yet, so changes cannot be saved. Nothing you type here is lost — it just is not persisted.';
  }

  const write = useCallback(
    async (patch: SettingsPatch, label: string): Promise<boolean> => {
      const parsed = SettingsPatchSchema.safeParse(patch);
      if (!parsed.success) {
        toast.error(`${label} was not saved`, {
          key: `settings-invalid-${label}`,
          description: firstIssueMessage(parsed.error),
        });
        return false;
      }

      setSaving(true);
      const ok = await update(parsed.data);
      setSaving(false);

      if (!ok) {
        const reason =
          useSettingsStore.getState().error ??
          'The app did not say why the write failed.';
        toast.error(`${label} was not saved`, {
          key: `settings-write-${label}`,
          description: reason,
        });
      }
      return ok;
    },
    [update],
  );

  return { write, saving, canWrite: !blocked, blockedReason };
}
