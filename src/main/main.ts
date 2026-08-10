/* eslint global-require: off, no-console: off, promise/always-return: off */

/**
 * This module executes inside of electron's main process. You can start
 * electron renderer process from here and communicate with the other processes
 * through IPC.
 */
import path from 'path';
import { app, BrowserWindow, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import { resolveHtmlPath } from './util';
import type { AppServices } from './bootstrap';
import { bootstrap } from './bootstrap';

/**
 * Handles application auto-updates
 */
class AppUpdater {
  constructor() {
    log.transports.file.level = 'info';
    autoUpdater.logger = log;
    autoUpdater.checkForUpdatesAndNotify();
  }
}

let mainWindow: BrowserWindow | null = null;
let services: AppServices | null = null;

const isDebug =
  process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true';

if (isDebug) {
  // electron-debug 4.x ships as an ES module, so its callable lives on
  // `.default` once webpack interops it. Calling the namespace object itself
  // throws "__webpack_require__(...) is not a function".
  //
  // `showDevTools: false` stops DevTools from auto-opening on every launch;
  // the F12 / Cmd+Opt+I shortcuts still work to open it on demand.
  const electronDebug = require('electron-debug');
  (electronDebug.default ?? electronDebug)({ showDevTools: false });
}

/**
 * Installs renderer devtools extensions in development
 */
const installExtensions = async () => {
  const installer = require('electron-devtools-installer');
  const forceDownload = !!process.env.UPGRADE_EXTENSIONS;
  const extensions = ['REACT_DEVELOPER_TOOLS'];

  return installer
    .default(
      extensions.map((name) => installer[name]),
      forceDownload,
    )
    .catch(console.log);
};

/**
 * Creates the main application window
 */
const createWindow = async () => {
  if (isDebug) {
    await installExtensions();
  }

  const RESOURCES_PATH = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, '../../assets');

  const getAssetPath = (...paths: string[]): string => {
    return path.join(RESOURCES_PATH, ...paths);
  };

  // In a packaged macOS build the dock icon comes from the bundled .icns, but
  // in development Electron shows its own default. Set it explicitly so the
  // dock matches the app icon while running `bun run start`.
  if (process.platform === 'darwin' && !app.isPackaged && app.dock) {
    app.dock.setIcon(getAssetPath('icon.png'));
  }

  const isMac = process.platform === 'darwin';

  mainWindow = new BrowserWindow({
    show: false,
    title: 'Assistant',
    width: 1024,
    height: 728,
    minWidth: 720,
    minHeight: 520,
    icon: getAssetPath('icon.png'),
    // Fully frameless on macOS: no system title bar AND no traffic lights.
    // `titleBarStyle: 'hidden'` drops the bar; the window buttons are then
    // hidden explicitly below with setWindowButtonVisibility(false). The
    // renderer owns a `.draggable-region` so the window can still be moved.
    titleBarStyle: isMac ? 'hidden' : 'default',
    // Let macOS vibrancy show through: the window is transparent and the OS
    // blurs whatever is behind it. `sidebar` is denser than `under-window`.
    // `visualEffectState: 'active'` keeps the blur lively even when the
    // window is not focused.
    ...(isMac
      ? {
          transparent: true,
          vibrancy: 'sidebar' as const,
          visualEffectState: 'active' as const,
          backgroundColor: '#00000000',
        }
      : { backgroundColor: '#0a0a0a' }),
    webPreferences: {
      preload: app.isPackaged
        ? path.join(__dirname, 'preload.js')
        : path.join(__dirname, '../../.erb/dll/preload.js'),
      devTools: isDebug,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // No traffic lights: hide the close/minimize/zoom buttons entirely. The
  // window is still closable via Cmd+Q / the app menu and movable via the
  // renderer's draggable region.
  if (isMac && typeof mainWindow.setWindowButtonVisibility === 'function') {
    mainWindow.setWindowButtonVisibility(false);
  }

  mainWindow.loadURL(resolveHtmlPath('index.html'));

  mainWindow.on('ready-to-show', () => {
    if (!mainWindow) {
      throw new Error('"mainWindow" is not defined');
    }
    if (process.env.START_MINIMIZED) {
      mainWindow.minimize();
    } else {
      mainWindow.show();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open URLs in the user's browser.
  //
  // The scheme whitelist is load-bearing, not defensive habit. The renderer
  // displays memory notes whose text may have arrived from an email, so an
  // unchecked `openExternal` would hand an attacker `file:`, `smb:` or a
  // registered custom-protocol handler. The renderer has its own link filter;
  // this is the one that cannot be bypassed by a careless anchor tag.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    let scheme: string;
    try {
      scheme = new URL(url).protocol;
    } catch {
      return { action: 'deny' };
    }
    if (scheme === 'http:' || scheme === 'https:' || scheme === 'mailto:') {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  // Same reasoning: refuse to navigate the app window itself anywhere but our
  // own renderer. A hijacked top-level navigation replaces the app UI.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) {
      event.preventDefault();
    }
  });

  // Remove this if your app does not use auto updates
  // eslint-disable-next-line
  new AppUpdater();

  return mainWindow;
};

/**
 * Application lifecycle event handlers
 */

let quitting = false;
app.on('before-quit', (event) => {
  if (quitting || !services) return;
  event.preventDefault();
  quitting = true;
  void services
    .shutdown()
    .catch((error) => console.error('shutdown failed:', error))
    .finally(() => app.exit(0));
});

app.on('window-all-closed', () => {
  // Respect the OSX convention of keeping the app in memory
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// A broken stdout/stderr pipe (the launching terminal closed, the dev parent
// went away) must never crash the app. Node turns a write to a severed pipe
// into an EPIPE error event on the stream; swallow it so it can't bubble up as
// an uncaught exception and pop a crash dialog.
const ignoreEpipe = (stream: NodeJS.WriteStream) => {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') return;
    // Anything else is a real problem — re-surface it.
    throw error;
  });
};
ignoreEpipe(process.stdout);
ignoreEpipe(process.stderr);

// Error handlers for uncaught exceptions
process.on('uncaughtException', (error: NodeJS.ErrnoException) => {
  // A stray EPIPE (e.g. a log write racing shutdown) is not worth a dialog.
  if (error?.code === 'EPIPE') return;
  try {
    console.error('UNCAUGHT EXCEPTION:', error);
    console.error('Stack trace:', error.stack);
  } catch {
    /* console itself may be on a broken pipe — nothing more we can do */
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION at:', promise, 'reason:', reason);
});

// Single instance lock - prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Focus window if user tries to run a second instance
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app
    .whenReady()
    .then(async () => {
      // Before the first window: the renderer must never race against
      // unregistered IPC handlers.
      try {
        services = await bootstrap();
      } catch (error) {
        console.error('BOOTSTRAP FAILED:', error);
      }
      await createWindow();
      app.on('activate', () => {
        // On macOS re-create window when dock icon is clicked
        if (mainWindow === null) createWindow();
      });
    })
    .catch(console.log);
}
