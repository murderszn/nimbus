const { app, BrowserWindow, Menu, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const isMac = process.platform === 'darwin';
const isDev = process.argv.includes('--dev');

function appHtmlPath() {
  return path.join(app.getAppPath(), 'pomodoro-cloud-v2.html');
}

function iconPath() {
  const ext = process.platform === 'win32' ? 'ico' : 'png';
  const candidate = path.join(app.getAppPath(), 'assets', `icon.${ext}`);
  return fs.existsSync(candidate) ? candidate : undefined;
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

function isInternalWebUrl(url) {
  try {
    const parsed = new URL(url);
    return isNimbusAppUrl(url) || parsed.protocol === 'blob:' || parsed.protocol === 'about:';
  } catch {
    return false;
  }
}

function hardenWindow(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isNimbusAppUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 420,
          height: 620,
          minWidth: 320,
          minHeight: 420,
          title: 'Nimbus Timer',
          backgroundColor: '#102a4a',
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

  window.webContents.on('did-create-window', child => {
    hardenWindow(child);
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
    backgroundColor: '#102a4a',
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

app.whenReady().then(() => {
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
