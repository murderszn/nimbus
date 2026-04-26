const { contextBridge, ipcRenderer } = require('electron');

function listen(channel, callback) {
  if (typeof callback !== 'function') return () => {};

  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('nimbusDesktop', {
  isDesktop: true,
  platform: process.platform,
  getAppInfo: () => ipcRenderer.invoke('nimbus:get-app-info'),
  getUpdateStatus: () => ipcRenderer.invoke('nimbus:get-update-status'),
  setPreferences: preferences => ipcRenderer.invoke('nimbus:set-preferences', preferences),
  checkForUpdates: options => ipcRenderer.invoke('nimbus:check-for-updates', options),
  installUpdate: () => ipcRenderer.invoke('nimbus:install-update'),
  onUpdateStatus: callback => listen('nimbus:update-status', callback)
});
