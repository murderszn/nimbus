const { app, BrowserWindow, Menu, ipcMain, nativeImage, screen, shell } = require('electron');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const isMac = process.platform === 'darwin';
const isDev = process.argv.includes('--dev');
const windowBackground = '#061a3d';
const updateFeedUrl = 'https://github.com/murderszn/nimbus/releases/latest/download/';
const updateReleaseUrl = 'https://github.com/murderszn/nimbus/releases/latest';
let checkedUpdatesThisLaunch = false;
let pendingStartupUpdateCheck = null;
let installUpdateScheduled = false;
let mainWindow = null;
let autoUpdater = null;
let autoUpdaterConfigured = false;
let autoUpdaterLoadError = null;
const popoutWindowStates = new WeakMap();
let updaterPreferences = {
  autoRestartAfterUpdate: true
};
let updateStatus = {
  state: 'idle',
  message: 'Ready to check for updates.',
  version: null,
  percent: 0,
  canInstall: false,
  lastCheckedAt: null
};
let cachedUpdateSupport = null;

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

function macAppBundlePath() {
  if (!isMac) return null;

  const marker = `${path.sep}Contents${path.sep}MacOS${path.sep}`;
  const markerIndex = process.execPath.indexOf(marker);
  if (markerIndex === -1) return null;
  return process.execPath.slice(0, markerIndex);
}

function runCodesign(args) {
  const result = spawnSync('/usr/bin/codesign', args, { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    output: `${result.stdout || ''}${result.stderr || ''}`.trim()
  };
}

function macCodeSignatureStatus() {
  const appPath = macAppBundlePath();
  if (!appPath) {
    return {
      supported: false,
      reason: 'Nimbus could not locate the installed macOS app bundle for updater validation.',
      manualDownloadUrl: macManualDownloadUrl()
    };
  }

  const details = runCodesign(['-dv', '--verbose=4', appPath]);
  const verification = runCodesign(['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  const output = `${details.output || ''}\n${verification.output || ''}`;
  const signatureMatch = output.match(/Signature=(.+)/);
  const teamMatch = output.match(/TeamIdentifier=(.+)/);
  const signature = signatureMatch ? signatureMatch[1].trim() : null;
  const teamIdentifier = teamMatch ? teamMatch[1].trim() : null;
  const isAdHoc = signature === 'adhoc' || /flags=.*adhoc/.test(output);
  const hasStableIdentity = !!teamIdentifier && teamIdentifier !== 'not set' && !isAdHoc;

  if (!verification.ok) {
    return {
      supported: false,
      reason: 'This macOS build is not signed in a way that supports automatic updates.',
      detail: verification.output || details.output || null,
      manualDownloadUrl: macManualDownloadUrl()
    };
  }

  if (!hasStableIdentity) {
    return {
      supported: false,
      reason: 'Automatic macOS updates require a Developer ID signed Nimbus build.',
      detail: 'The installed app has no stable Apple Team Identifier.',
      manualDownloadUrl: macManualDownloadUrl()
    };
  }

  return {
    supported: true,
    reason: 'Automatic updates are available for this signed macOS build.',
    detail: null,
    manualDownloadUrl: null
  };
}

function updateSupport() {
  if (autoUpdaterLoadError) {
    return {
      supported: false,
      reason: `Update checks are unavailable because the updater failed to load: ${normalizeUpdateError(autoUpdaterLoadError)}`,
      manualDownloadUrl: isMac ? macManualDownloadUrl() : null
    };
  }

  if (isDev || !app.isPackaged) {
    return {
      supported: false,
      reason: 'Update checks are available in packaged builds installed from GitHub releases.',
      manualDownloadUrl: null
    };
  }

  if (isMac) {
    cachedUpdateSupport = cachedUpdateSupport || macCodeSignatureStatus();
    return cachedUpdateSupport;
  }

  return {
    supported: true,
    reason: 'Automatic updates are available for this packaged build.',
    manualDownloadUrl: null
  };
}

function macManualDownloadUrl() {
  return updateReleaseUrl;
}

function publicUpdateStatus() {
  const support = updateSupport();
  return {
    ...updateStatus,
    supported: support.supported,
    supportMessage: support.reason,
    manualDownloadUrl: support.manualDownloadUrl,
    isPackaged: app.isPackaged,
    currentVersion: app.getVersion(),
    feedUrl: updateFeedUrl,
    releaseUrl: updateReleaseUrl
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
  const message = error.message || String(error);
  if (isMac && /code signature|signature.*validation|code has no resources/i.test(message)) {
    return 'This macOS build is not signed for automatic updates. Download the latest Nimbus DMG from GitHub and install it manually.';
  }
  return message;
}

function loadAutoUpdater() {
  if (autoUpdater || autoUpdaterLoadError) return autoUpdater;

  try {
    ({ autoUpdater } = require('electron-updater'));
    return autoUpdater;
  } catch (error) {
    autoUpdaterLoadError = error;
    return null;
  }
}

function configureAutoUpdater() {
  if (autoUpdaterConfigured) return;

  const support = updateSupport();
  if (!support.supported) return;

  const updater = loadAutoUpdater();
  if (!updater) return;

  autoUpdaterConfigured = true;

  updater.setFeedURL({
    provider: 'generic',
    url: updateFeedUrl
  });
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.autoRunAppAfterInstall = true;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.fullChangelog = true;

  updater.on('checking-for-update', () => {
    sendUpdateStatus({
      state: 'checking',
      message: 'Checking GitHub releases for updates...',
      percent: 0,
      canInstall: false,
      lastCheckedAt: new Date().toISOString()
    });
  });

  updater.on('update-available', info => {
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

  updater.on('update-not-available', info => {
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

  updater.on('download-progress', progress => {
    sendUpdateStatus({
      state: 'downloading',
      message: `Downloading update... ${Math.round(progress.percent || 0)}%`,
      percent: Math.round(progress.percent || 0),
      canInstall: false
    });
  });

  updater.on('update-downloaded', info => {
    sendUpdateStatus({
      state: 'downloaded',
      message: updaterPreferences.autoRestartAfterUpdate
        ? `Version ${info.version} is ready. Restarting Nimbus to install it...`
        : `Version ${info.version} is ready. Restart Nimbus to install it.`,
      version: info.version,
      releaseDate: info.releaseDate || null,
      releaseNotes: info.releaseNotes || null,
      percent: 100,
      canInstall: true
    });

    if (updaterPreferences.autoRestartAfterUpdate) {
      scheduleUpdateInstall();
    }
  });

  updater.on('error', error => {
    installUpdateScheduled = false;
    sendUpdateStatus({
      state: 'error',
      message: normalizeUpdateError(error),
      percent: 0,
      canInstall: false
    });
  });
}

async function checkForUpdates({ userInitiated = false } = {}) {
  const support = updateSupport();
  if (!support.supported) {
    return sendUpdateStatus({
      state: 'unavailable',
      message: support.reason,
      percent: 0,
      canInstall: false,
      manualDownloadUrl: support.manualDownloadUrl
    });
  }

  checkedUpdatesThisLaunch = true;

  try {
    configureAutoUpdater();
    const updater = loadAutoUpdater();
    if (!updater) {
      throw autoUpdaterLoadError || new Error('Updater failed to load.');
    }
    await updater.checkForUpdates();
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

function scheduleUpdateInstall() {
  if (!updateStatus.canInstall || installUpdateScheduled) {
    return publicUpdateStatus();
  }

  const updater = loadAutoUpdater();
  if (!updater) {
    return sendUpdateStatus({
      state: 'error',
      message: normalizeUpdateError(autoUpdaterLoadError || new Error('Updater failed to load.')),
      percent: 0,
      canInstall: false
    });
  }

  installUpdateScheduled = true;
  sendUpdateStatus({
    state: 'installing',
    message: 'Installing update and restarting Nimbus...',
    percent: 100,
    canInstall: false
  });

  setTimeout(() => {
    try {
      if (isMac) {
        updater.quitAndInstall();
      } else {
        updater.quitAndInstall(true, true);
      }
    } catch (error) {
      installUpdateScheduled = false;
      sendUpdateStatus({
        state: 'error',
        message: normalizeUpdateError(error),
        percent: 0,
        canInstall: false
      });
    }
  }, 1000);

  return publicUpdateStatus();
}

function registerIpcHandlers() {
  ipcMain.handle('nimbus:get-app-info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    updateFeedUrl,
    updateReleaseUrl,
    updateStatus: publicUpdateStatus()
  }));

  ipcMain.handle('nimbus:get-update-status', () => publicUpdateStatus());

  ipcMain.handle('nimbus:set-preferences', (_event, preferences = {}) => {
    updaterPreferences = {
      ...updaterPreferences,
      autoRestartAfterUpdate: preferences.autoRestartAfterUpdate !== false
    };

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
    return scheduleUpdateInstall();
  });

  ipcMain.handle('nimbus:enter-popout-mode', event => (
    enterWindowPopoutMode(BrowserWindow.fromWebContents(event.sender))
  ));

  ipcMain.handle('nimbus:exit-popout-mode', event => (
    exitWindowPopoutMode(BrowserWindow.fromWebContents(event.sender))
  ));
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

function invokeWindowSetter(window, method, ...args) {
  if (typeof window?.[method] !== 'function') return;
  try {
    window[method](...args);
  } catch {}
}

function compactPopoutBounds(window) {
  const display = screen.getDisplayMatching(window.getBounds());
  const { workArea } = display;
  const width = Math.min(360, Math.max(280, workArea.width - 48));
  const height = Math.min(360, Math.max(280, workArea.height - 96));
  return {
    width,
    height,
    x: Math.round(workArea.x + workArea.width - width - 24),
    y: Math.round(workArea.y + 64)
  };
}

function configurePopoutOverlay(window) {
  window.setAlwaysOnTop(true, 'floating');
  invokeWindowSetter(window, 'setFullScreenable', false);
  invokeWindowSetter(window, 'setSkipTaskbar', true);

  if (isMac) {
    invokeWindowSetter(window, 'setVisibleOnAllWorkspaces', true, { visibleOnFullScreen: true });
  }
}

function enterWindowPopoutMode(window) {
  if (!window || window.isDestroyed()) return { active: false };
  const existingState = popoutWindowStates.get(window);
  if (existingState?.active) return { active: true };

  const state = {
    active: true,
    bounds: window.getBounds(),
    minimumSize: window.getMinimumSize(),
    resizable: window.isResizable(),
    maximizable: window.isMaximizable(),
    minimizable: window.isMinimizable(),
    fullScreen: window.isFullScreen(),
    maximized: window.isMaximized()
  };
  popoutWindowStates.set(window, state);

  if (state.fullScreen) window.setFullScreen(false);
  if (state.maximized) window.unmaximize();

  window.setMinimumSize(280, 280);
  window.setResizable(true);
  invokeWindowSetter(window, 'setMaximizable', false);
  invokeWindowSetter(window, 'setMinimizable', false);
  configurePopoutOverlay(window);
  window.setTitle('Nimbus Timer');
  window.setBounds(compactPopoutBounds(window), true);
  window.webContents.send('nimbus:popout-mode', { active: true });
  return { active: true };
}

function exitWindowPopoutMode(window) {
  if (!window || window.isDestroyed()) return { active: false };
  const state = popoutWindowStates.get(window);
  popoutWindowStates.delete(window);

  window.setAlwaysOnTop(false);
  invokeWindowSetter(window, 'setSkipTaskbar', false);
  invokeWindowSetter(window, 'setVisibleOnAllWorkspaces', false);
  invokeWindowSetter(window, 'setFullScreenable', true);
  window.setTitle('Nimbus');

  if (state) {
    window.setMinimumSize(...state.minimumSize);
    window.setResizable(state.resizable);
    invokeWindowSetter(window, 'setMaximizable', state.maximizable);
    invokeWindowSetter(window, 'setMinimizable', state.minimizable);
    window.setBounds(state.bounds, true);
    if (state.maximized) window.maximize();
    if (state.fullScreen) window.setFullScreen(true);
  } else {
    window.setMinimumSize(760, 560);
    window.setBounds({ width: 1120, height: 760 }, true);
  }

  window.webContents.send('nimbus:popout-mode', { active: false });
  return { active: false };
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
  const window = new BrowserWindow({
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

  mainWindow = window;

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  hardenWindow(window);

  window.once('ready-to-show', () => {
    window.show();
  });

  window.loadFile(appHtmlPath());

  if (isDev) {
    window.webContents.openDevTools({ mode: 'detach' });
  }

  return window;
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

registerIpcHandlers();

app.whenReady().then(() => {
  configureAutoUpdater();

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
