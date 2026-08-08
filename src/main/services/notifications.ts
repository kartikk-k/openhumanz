/**
 * OS notifications.
 *
 * The app has notification *settings* (enabled / on-approval / on-run-finished)
 * but until now nothing acted on them — a scheduled reminder fired into a run
 * transcript and the user never heard about it. This wires the settings to
 * Electron's `Notification` so the machine actually tells you when:
 *
 *   - a scheduled job (a reminder) has run and produced an answer,
 *   - a run you kicked off has finished,
 *   - an action is waiting on your approval.
 *
 * Electron is required lazily (like the rest of bootstrap) so the backend can
 * boot headlessly; outside Electron, or when notifications aren't supported,
 * every call is a no-op.
 */
import type { AppEvents, EventBus } from '../infra/events';
import type { Logger } from '../infra/logger';
import type { Run, RunEvent, RunEventsQuery } from '../../shared/runs';

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

  const showNotification = (title: string, body: string): void => {
    const electron = loadElectron();
    if (!electron || !electron.Notification.isSupported()) return;
    try {
      const notification = new electron.Notification({ title, body });
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
    } catch (error) {
      logger.warn('failed to show notification', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
    if (!config.enabled) return;
    // Scheduled reminders always notify (that is the whole point of a
    // reminder); other runs only when the user opted in.
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
    if (!config.enabled || !config.onApprovalRequired) return;
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
  };
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}
