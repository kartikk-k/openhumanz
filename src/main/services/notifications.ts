/**
 * OS notifications.
 *
 * Tells the user when a scheduled job (reminder) has run and produced an answer,
 * a run they kicked off has finished, or an action is waiting on their approval.
 *
 * DELIVERY: on macOS this posts via AppleScript `display notification`, which
 * needs no per-app notification permission and is not silently dropped by the
 * dev binary's ad-hoc signature the way Electron's `Notification` is (see
 * `showViaAppleScript`). Electron's cross-platform `Notification` is the
 * fallback for non-macOS and for any osascript failure.
 *
 * Notifications CANNOT be turned off. The `enabled` setting is intentionally
 * not consulted — a reminder the user never sees defeats the purpose. The
 * remaining per-class toggles only tune noisiness, not whether it works.
 */
import type { AppEvents, EventBus } from '../infra/events';
import type { Logger } from '../infra/logger';
import type { Run, RunEvent, RunEventsQuery } from '../../shared/runs';
import { runProcess } from '../infra/spawn';
import { appleScriptStringExpr } from '../modules/macos/escape';

/** `/usr/bin/osascript` on the signed system volume — never resolved via PATH. */
const OSASCRIPT_PATH = '/usr/bin/osascript';

/** What the service needs from the settings module, narrowed to one getter. */
export interface NotificationSettingsSource {
  get(): Promise<{
    notifications: {
      enabled: boolean;
      onApprovalRequired: boolean;
      onRunFinished: boolean;
    };
  }>;
}

/** What the service needs from the runs store. */
export interface NotificationRunSource {
  getRun(id: string): Run | undefined;
  readEvents(query: RunEventsQuery): Promise<{ events: RunEvent[] }>;
}

export interface NotificationServiceDeps {
  events: EventBus;
  settings: NotificationSettingsSource;
  runs: NotificationRunSource;
  logger: Logger;
}

interface ElectronNotification {
  show(): void;
  on(event: 'click', listener: () => void): void;
  on(event: 'show', listener: () => void): void;
  on(event: 'failed', listener: (event: unknown, error: string) => void): void;
}
interface ElectronNotificationApi {
  Notification: {
    new (options: {
      title: string;
      body: string;
      silent?: boolean;
    }): ElectronNotification;
    isSupported(): boolean;
  };
  BrowserWindow: {
    getAllWindows(): Array<{
      isDestroyed(): boolean;
      show(): void;
      focus(): void;
    }>;
  };
}

function loadElectron(): ElectronNotificationApi | null {
  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    const electron = require('electron') as Partial<ElectronNotificationApi>;
    if (!electron?.Notification || !electron?.BrowserWindow) return null;
    return electron as ElectronNotificationApi;
  } catch {
    return null;
  }
}

export interface NotificationService {
  /** Attach the bus listeners. Call once from bootstrap. */
  start(): void;
  /**
   * Post a notification directly with a title and body. Used by the scheduler
   * for `reminder` jobs, which must NOT spawn the engine — they just show the
   * user the pre-filled message. Zero tokens, no run.
   */
  notify(title: string, body: string): void;
}

export function createNotificationService(
  deps: NotificationServiceDeps,
): NotificationService {
  const { events, settings, runs, logger } = deps;

  /** Read the notification settings, defaulting to "on" if unavailable. */
  const readSettings = async (): Promise<{
    enabled: boolean;
    onApprovalRequired: boolean;
    onRunFinished: boolean;
  }> => {
    try {
      return (await settings.get()).notifications;
    } catch {
      return { enabled: true, onApprovalRequired: true, onRunFinished: false };
    }
  };

  /**
   * Show a notification via AppleScript `display notification`.
   *
   * WHY AppleScript instead of Electron's `Notification`: on macOS the Electron
   * path requires the app bundle to be registered *and* not suppressed by the
   * user's Focus/Do-Not-Disturb, and in dev the ad-hoc-signed binary is easily
   * dropped silently (delivered but `presented=0`). `display notification`, by
   * contrast, is posted by the system's AppleScript host — it needs no
   * per-app notification permission and reliably surfaces in dev. This is the
   * same osascript path the reminders/notes features already use, so if the app
   * can create a reminder it can post a notification.
   *
   * Only the darwin path uses AppleScript; other platforms (and any osascript
   * failure) fall back to Electron's cross-platform `Notification`.
   */
  const showViaAppleScript = async (
    title: string,
    body: string,
  ): Promise<boolean> => {
    if (process.platform !== 'darwin') return false;
    try {
      // Build the source with the project's audited string-literal escaper so a
      // title/body containing quotes, backslashes or emoji can never break out
      // of the AppleScript string context.
      const src =
        `display notification ${appleScriptStringExpr(body)} ` +
        `with title ${appleScriptStringExpr(title)}`;
      const result = await runProcess(OSASCRIPT_PATH, ['-e', src], {
        timeoutMs: 10_000,
        label: 'osascript-notify',
        collectStdout: true,
        // osascript is not node; strip the Electron-node env it would inherit.
        env: {
          ELECTRON_RUN_AS_NODE: undefined,
          ELECTRON_NO_ATTACH_CONSOLE: undefined,
          NODE_OPTIONS: undefined,
        },
      });
      if (result.timedOut || result.code !== 0) {
        logger.warn('applescript notification failed', {
          title,
          code: result.code,
          timedOut: result.timedOut,
          stderr: result.stderrTail,
        });
        return false;
      }
      logger.info('notification shown via applescript', { title });
      return true;
    } catch (error) {
      logger.warn('applescript notification errored', {
        title,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };

  /** Fallback path: Electron's cross-platform Notification (non-macOS, or if
   *  the AppleScript path is unavailable/failed). */
  const showViaElectron = (title: string, body: string): void => {
    const electron = loadElectron();
    if (!electron || !electron.Notification.isSupported()) {
      logger.warn(
        'notification not shown: unsupported or electron unavailable',
        {
          electron: Boolean(electron),
          supported: electron ? electron.Notification.isSupported() : false,
          title,
        },
      );
      return;
    }
    try {
      const notification = new electron.Notification({ title, body });
      notification.on('failed', (_event, error) => {
        logger.warn('electron notification delivery failed', { error, title });
      });
      notification.on('click', () => {
        // Bring the app forward when the user clicks the notification.
        for (const win of electron.BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.show();
            win.focus();
          }
        }
      });
      notification.show();
      logger.info('notification shown via electron', { title });
    } catch (error) {
      logger.warn('failed to show notification', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /** Show a notification, preferring the reliable AppleScript path on macOS. */
  const showNotification = (title: string, body: string): void => {
    void showViaAppleScript(title, body).then((ok) => {
      if (!ok) showViaElectron(title, body);
      return ok;
    });
  };

  /** The last assistant message in a run, for the notification body. */
  const lastAssistantText = async (
    runId: string,
  ): Promise<string | undefined> => {
    try {
      const { events: list } = await runs.readEvents({
        runId,
        sinceSeq: 0,
        limit: 500,
      });
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const event = list[i];
        if (
          event.type === 'message' &&
          event.role === 'assistant' &&
          event.text
        ) {
          return event.text;
        }
      }
    } catch {
      /* transcript unreadable — fall back to a generic body */
    }
    return undefined;
  };

  const onRunFinished = async ({
    runId,
    status,
  }: AppEvents['run:finished']): Promise<void> => {
    const run = runs.getRun(runId);
    if (!run) return;
    if (status === 'cancelled') return;

    const scheduled = run.trigger === 'schedule' || Boolean(run.scheduledJobId);
    const config = await readSettings();
    // Notifications are always on and cannot be disabled (product decision):
    // a reminder the user never sees is worse than useless. The `enabled`
    // setting is intentionally NOT consulted here. Scheduled reminders always
    // notify; ad-hoc runs still respect the per-run `onRunFinished` preference
    // (that toggle governs noisiness, not whether notifications work at all).
    if (!scheduled && !config.onRunFinished) return;

    const body =
      (await lastAssistantText(runId)) ??
      (status === 'succeeded' ? 'Finished.' : `Ended: ${status}.`);
    const title = scheduled
      ? run.title || 'Reminder'
      : run.title || 'Run finished';
    showNotification(title, truncate(body, 220));
  };

  const onApproval = async ({
    approval,
  }: AppEvents['approval:requested']): Promise<void> => {
    const config = await readSettings();
    // `enabled` is intentionally not consulted — notifications can't be turned
    // off. The `onApprovalRequired` toggle only controls this specific class.
    if (!config.onApprovalRequired) return;
    const toolName =
      (approval as { toolName?: string }).toolName ?? 'An action';
    showNotification(
      'Waiting on your approval',
      `${toolName} needs your approval.`,
    );
  };

  return {
    start() {
      events.on('run:finished', (payload) => {
        void onRunFinished(payload);
      });
      events.on('approval:requested', (payload) => {
        void onApproval(payload);
      });
    },
    notify(title: string, body: string) {
      showNotification(title, body);
    },
  };
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}
