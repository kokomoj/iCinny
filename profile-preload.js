// Tiny, privilege-free bridge for the profile editor window.
// Exposes ONLY: receive the initial data, save, cancel. No node, no fs.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('profileEditor', {
  onInit(cb) {
    ipcRenderer.on('editor:init', (_e, data) => cb(data));
  },
  save(data) {
    return ipcRenderer.invoke('profile:save', data);
  },
  cancel() {
    ipcRenderer.send('profile:close');
  },
});
