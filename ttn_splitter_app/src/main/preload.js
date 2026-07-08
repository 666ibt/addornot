'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Safe, minimal bridge between the renderer (UI) and the main process.
 * No Node APIs are exposed directly to the page.
 */
try {
contextBridge.exposeInMainWorld('api', {
  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),

  // pickers
  pickFiles: () => ipcRenderer.invoke('files:pick'),
  pickOutputDir: () => ipcRenderer.invoke('output:pickDir'),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  pageImage: (filePath, pageIndex) => ipcRenderer.invoke('page:image', { filePath, pageIndex }),

  // processing
  startProcessing: (filePaths) => ipcRenderer.invoke('process:start', filePaths),
  save: (payload) => ipcRenderer.invoke('process:save', payload),

  // events (main -> renderer)
  on: (channel, cb) => {
    const allowed = [
      'process:meta',
      'process:page',
      'process:complete',
      'process:error',
    ];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
  console.log('[preload] api bridge exposed');
} catch (err) {
  console.error('[preload] failed to expose api bridge:', err);
}
