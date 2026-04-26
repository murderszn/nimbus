const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('nimbusDesktop', {
  isDesktop: true,
  platform: process.platform
});
