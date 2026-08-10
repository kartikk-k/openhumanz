/**
 * The `system` module.
 *
 * OS-level odds and ends the renderer can't reach directly under
 * contextIsolation. Today: microphone permission — report the current status
 * and open the OS privacy pane so the user can grant access without hunting
 * through System Settings themselves.
 *
 * Owns no tables and no long-lived state. Electron is required lazily so the
 * module imports fine under plain `bun` (tests / headless).
 */
import type { AppModule, IpcHandlerMap } from '../types';
import type { MicPermissionResult } from '../../../shared/ipc';

type MediaKind = 'microphone' | 'camera' | 'screen';

interface ElectronSystemApi {
  systemPreferences?: {
    getMediaAccessStatus?(kind: MediaKind): MicPermissionResult['status'];
    askForMediaAccess?(kind: 'microphone' | 'camera'): Promise<boolean>;
  };
  shell?: {
    openExternal(url: string): Promise<void>;
  };
}

function loadElectron(): ElectronSystemApi | null {
  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    return require('electron') as ElectronSystemApi;
  } catch {
    return null;
  }
}

function micStatus(): MicPermissionResult {
  const electron = loadElectron();
  const get = electron?.systemPreferences?.getMediaAccessStatus;
  if (!get) return { status: 'unknown' };
  try {
    return { status: get('microphone') };
  } catch {
    return { status: 'unknown' };
  }
}

/**
 * Ensure OS microphone access. On macOS, if the status is not-determined this
 * calls askForMediaAccess — which shows the native prompt AND registers the app
 * in System Settings › Privacy › Microphone (without this, the app never
 * appears in that list). Returns the resulting status.
 */
async function requestMic(): Promise<MicPermissionResult> {
  const electron = loadElectron();
  const sp = electron?.systemPreferences;
  if (!sp?.getMediaAccessStatus) return { status: 'unknown' };

  if (process.platform === 'darwin') {
    let status = sp.getMediaAccessStatus('microphone');
    if (status === 'not-determined' && sp.askForMediaAccess) {
      try {
        await sp.askForMediaAccess('microphone');
      } catch {
        /* ignore — fall through to re-read status */
      }
      status = sp.getMediaAccessStatus('microphone');
    }
    return { status };
  }

  return { status: sp.getMediaAccessStatus('microphone') };
}

/**
 * Open the OS microphone privacy settings.
 *
 * If access is still "not-determined" we first trigger the native prompt
 * (askForMediaAccess) — that's the least disruptive path. Otherwise we deep-link
 * straight to the Microphone pane in System Settings. Windows/Linux fall back to
 * their own privacy URIs where available.
 */
async function openMicSettings(): Promise<{ ok: true }> {
  const electron = loadElectron();
  if (!electron) return { ok: true };

  const { systemPreferences, shell } = electron;

  if (process.platform === 'darwin') {
    const status = systemPreferences?.getMediaAccessStatus?.('microphone');
    if (status === 'not-determined' && systemPreferences?.askForMediaAccess) {
      // Let the OS show its native permission prompt first.
      await systemPreferences.askForMediaAccess('microphone').catch(() => {});
      return { ok: true };
    }
    // Deep-link into System Settings › Privacy & Security › Microphone.
    await shell
      ?.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
      )
      .catch(() => {});
    return { ok: true };
  }

  if (process.platform === 'win32') {
    await shell?.openExternal('ms-settings:privacy-microphone').catch(() => {});
    return { ok: true };
  }

  return { ok: true };
}

export function createSystemModule(): AppModule {
  const ipc: IpcHandlerMap = {
    'system:mic-status': async () => micStatus(),
    'system:request-mic': async () => requestMic(),
    'system:open-mic-settings': async () => openMicSettings(),
  };

  return {
    id: 'system',
    migrations: [],
    ipc,
  };
}

export default createSystemModule;
