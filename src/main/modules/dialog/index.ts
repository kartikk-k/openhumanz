/**
 * The `dialog` module.
 *
 * A single job: open the native OS "choose a folder" panel and return the
 * chosen path. The renderer cannot reach Electron's `dialog` API directly
 * (contextIsolation is on, and exposing it wholesale would hand a compromised
 * renderer arbitrary file access), so it goes through this one narrow channel.
 *
 * It owns no tables and no long-lived state. Electron is required lazily, the
 * same way the registry's IPC binder does it, so importing this module under
 * plain `bun` (tests) does not require an Electron runtime.
 */
import type { AppModule, IpcHandlerMap } from '../types';
import type {
  DirectoryPickRequest,
  DirectoryPickResult,
} from '../../../shared/ipc';

/** Minimal shape of the bits of Electron we touch, so tests can stub it. */
interface ElectronDialogApi {
  dialog: {
    showOpenDialog(
      window: unknown,
      options: {
        title?: string;
        defaultPath?: string;
        buttonLabel?: string;
        properties: string[];
      },
    ): Promise<{ canceled: boolean; filePaths: string[] }>;
  };
  BrowserWindow: {
    getFocusedWindow(): unknown;
  };
}

function loadElectron(): ElectronDialogApi | null {
  try {
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
    const electron = require('electron') as Partial<ElectronDialogApi>;
    if (!electron?.dialog || !electron?.BrowserWindow) return null;
    return electron as ElectronDialogApi;
  } catch {
    return null;
  }
}

async function pickDirectory(
  request: DirectoryPickRequest,
): Promise<DirectoryPickResult> {
  const electron = loadElectron();
  if (!electron) {
    // No Electron (tests / headless): there is no OS panel to show.
    return { path: null };
  }

  const parent = electron.BrowserWindow.getFocusedWindow();
  const result = await electron.dialog.showOpenDialog(parent, {
    title: request.title ?? 'Choose a folder',
    defaultPath: request.defaultPath,
    buttonLabel: request.buttonLabel ?? 'Choose',
    // `createDirectory` lets the user make a new folder from the panel;
    // `openDirectory` restricts the selection to folders.
    properties: ['openDirectory', 'createDirectory'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { path: null };
  }
  return { path: result.filePaths[0] };
}

export function createDialogModule(): AppModule {
  const ipc: IpcHandlerMap = {
    'dialog:pick-directory': async (request) => pickDirectory(request),
  };

  return {
    id: 'dialog',
    migrations: [],
    ipc,
  };
}

export default createDialogModule;
