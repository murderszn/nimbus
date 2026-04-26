const { app, BrowserWindow, Menu, ipcMain, nativeImage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { autoUpdater } = require('electron-updater');

const isMac = process.platform === 'darwin';
const isDev = process.argv.includes('--dev');
const windowBackground = '#061a3d';
const updateFeedUrl = 'https://github.com/murderszn/nimbus/releases/latest';
let checkedUpdatesThisLaunch = false;
let pendingStartupUpdateCheck = null;
let updateStatus = {
  state: 'idle',
  message: 'Ready to check for updates.',
  version: null,
  percent: 0,
  canInstall: false,
  lastCheckedAt: null
};

function appHtmlPath() {
  return path.join(app.getAppPath(), 'pomodoro-cloud-v2.html');
}

function iconPath() {
  const ext = process.platform === 'win32' ? 'ico' : 'png';
  const candidate = path.join(app.getAppPath(), 'assets', `icon.${ext}`);
  return fs.existsSync(candidate) ? candidate : undefined;
}

function appIcon() {
  const filePath = iconPath();
  if (!filePath) return undefined;

  const image = nativeImage.createFromPath(filePath);
  return image.isEmpty() ? undefined : image;
}

function publicUpdateStatus() {
  return {
    ...updateStatus,
    supported: app.isPackaged && !isDev,
    isPackaged: app.isPackaged,
    currentVersion: app.getVersion(),
    feedUrl: updateFeedUrl
  };
}

function sendUpdateStatus(nextStatus) {
  updateStatus = {
    ...updateStatus,
    ...nextStatus
  };

  const status = publicUpdateStatus();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('nimbus:update-status', status);
    }
  }
  return status;
}

function normalizeUpdateError(error) {
  if (!error) return 'Update check failed.';
  return error.message || String(error);
}

function configureAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.fullChangelog = true;

  autoUpdater.on('checking-for-update', () => {
    sendUpdateStatus({
      state: 'checking',
      message: 'Checking GitHub releases for updates...',
      percent: 0,
      canInstall: false,
      lastCheckedAt: new Date().toISOString()
    });
  });

  autoUpdater.on('update-available', info => {
    sendUpdateStatus({
      state: 'available',
      message: `Version ${info.version} is available. Downloading update...`,
      version: info.version,
      releaseDate: info.releaseDate || null,
      releaseNotes: info.releaseNotes || null,
      percent: 0,
      canInstall: false
    });
  });

  autoUpdater.on('update-not-available', info => {
    sendUpdateStatus({
      state: 'current',
      message: `Nimbus is up to date on version ${info.version || app.getVersion()}.`,
      version: info.version || app.getVersion(),
      releaseDate: info.releaseDate || null,
      releaseNotes: info.releaseNotes || null,
      percent: 0,
      canInstall: false
    });
  });

  autoUpdater.on('download-progress', progress => {
    sendUpdateStatus({
      state: 'downloading',
      message: `Downloading update... ${Math.round(progress.percent || 0)}%`,
      percent: Math.round(progress.percent || 0),
      canInstall: false
    });
  });

  autoUpdater.on('update-downloaded', info => {
    sendUpdateStatus({
      state: 'downloaded',
      message: `Version ${info.version} is ready. Restart Nimbus to install it.`,
      version: info.version,
      releaseDate: info.releaseDate || null,
      releaseNotes: info.releaseNotes || null,
      percent: 100,
      canInstall: true
    });
  });

  autoUpdater.on('error', error => {
    sendUpdateStatus({
      state: 'error',
      message: normalizeUpdateError(error),
      percent: 0,
      canInstall: false
    });
  });
}

async function checkForUpdates({ userInitiated = false } = {}) {
  if (isDev || !app.isPackaged) {
    return sendUpdateStatus({
      state: 'unavailable',
      message: 'Update checks are available in packaged builds installed from GitHub releases.',
      percent: 0,
      canInstall: false
    });
  }

  checkedUpdatesThisLaunch = true;

  try {
    await autoUpdater.checkForUpdates();
    return publicUpdateStatus();
  } catch (error) {
    return sendUpdateStatus({
      state: 'error',
      message: userInitiated
        ? normalizeUpdateError(error)
        : 'Automatic update check failed. You can try again from Settings.',
      percent: 0,
      canInstall: false
    });
  }
}

function registerIpcHandlers() {
  ipcMain.handle('nimbus:get-app-info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    updateFeedUrl,
    updateStatus: publicUpdateStatus()
  }));

  ipcMain.handle('nimbus:get-update-status', () => publicUpdateStatus());

  ipcMain.handle('nimbus:set-preferences', (_event, preferences = {}) => {
    if (pendingStartupUpdateCheck) {
      clearTimeout(pendingStartupUpdateCheck);
      pendingStartupUpdateCheck = null;
    }

    if (preferences.autoUpdateOnStart && !checkedUpdatesThisLaunch) {
      pendingStartupUpdateCheck = setTimeout(() => {
        pendingStartupUpdateCheck = null;
        checkForUpdates({ userInitiated: false });
      }, 1200);
    }

    return publicUpdateStatus();
  });

  ipcMain.handle('nimbus:check-for-updates', (_event, options = {}) => (
    checkForUpdates({ userInitiated: !!options.userInitiated })
  ));

  ipcMain.handle('nimbus:install-update', () => {
    if (!updateStatus.canInstall) {
      return publicUpdateStatus();
    }
    autoUpdater.quitAndInstall(false, true);
    return publicUpdateStatus();
  });
}

function windowChromeOptions({ compact = false } = {}) {
  if (isMac) {
    return {
      backgroundColor: windowBackground,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 18, y: compact ? 14 : 17 }
    };
  }

  return {
    backgroundColor: windowBackground,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: windowBackground,
      symbolColor: '#f6fbff',
      height: compact ? 44 : 48
    }
  };
}

function isNimbusAppUrl(url) {
  try {
    const parsed = new URL(url);
    const appUrl = new URL(pathToFileURL(appHtmlPath()).toString());
    return parsed.protocol === 'file:' && parsed.pathname === appUrl.pathname;
  } catch {
    return false;
  }
}

function isNimbusPopoutUrl(url) {
  if (!isNimbusAppUrl(url)) return false;

  try {
    return new URL(url).searchParams.get('popout') === '1';
  } catch {
    return false;
  }
}

function isInternalWebUrl(url) {
  try {
    const parsed = new URL(url);
    return isNimbusAppUrl(url) || parsed.protocol === 'blob:' || parsed.protocol === 'about:';
  } catch {
    return false;
  }
}

function popoutOverlayOptions() {
  return {
    alwaysOnTop: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    acceptFirstMouse: true
  };
}

function configurePopoutOverlay(window) {
  window.setAlwaysOnTop(true, 'floating');
  window.setFullScreenable(false);
  window.setSkipTaskbar(true);

  if (isMac) {
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
}

function hardenWindow(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isNimbusAppUrl(url)) {
      const isPopout = isNimbusPopoutUrl(url);
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 360,
          height: 360,
          minWidth: 280,
          minHeight: 280,
          title: 'Nimbus Timer',
          ...windowChromeOptions({ compact: true }),
          ...(isPopout ? popoutOverlayOptions() : {}),
          icon: iconPath(),
          webPreferences: webPreferences()
        }
      };
    }

    shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (isInternalWebUrl(url)) return;

    event.preventDefault();
    shell.openExternal(url);
  });

  window.webContents.on('did-create-window', (child, details) => {
    hardenWindow(child);
    if (isNimbusPopoutUrl(details.url)) {
      configurePopoutOverlay(child);
    }
  });

  if (!isDev) {
    window.webContents.on('before-input-event', (event, input) => {
      const key = input.key.toLowerCase();
      const opensDevtools = key === 'f12' || ((input.control || input.meta) && input.shift && key === 'i');

      if (opensDevtools) {
        event.preventDefault();
      }
    });
  }
}

function webPreferences() {
  return {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true
  };
}

function createMainWindow() {
  const mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 760,
    minHeight: 560,
    show: false,
    title: 'Nimbus',
    ...windowChromeOptions(),
    icon: iconPath(),
    webPreferences: webPreferences()
  });

  hardenWindow(mainWindow);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.loadFile(appHtmlPath());

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  return mainWindow;
}

function createMenu() {
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ]
      : []),
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        ...(isDev ? [{ role: 'toggleDevTools' }] : []),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [isMac ? { role: 'minimize' } : { role: 'close' }]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.setName('Nimbus');

if (process.platform === 'win32') {
  app.setAppUserModelId('com.murderszn.nimbus');
}

configureAutoUpdater();
registerIpcHandlers();

app.whenReady().then(() => {
  if (isMac) {
    const dockIcon = appIcon();
    if (dockIcon) app.dock.setIcon(dockIcon);
  }

  createMenu();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (!isMac) {
    app.quit();
  }
});
