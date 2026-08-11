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
  pageImage: (filePath, pageIndex, rotation) =>
    ipcRenderer.invoke('page:image', { filePath, pageIndex, rotation }),

  // processing (PDF tools: ttn / split / approval)
  startProcessing: (filePaths, mode) => ipcRenderer.invoke('process:start', { filePaths, mode }),
  cancel: () => ipcRenderer.invoke('process:cancel'),
  pause: () => ipcRenderer.invoke('process:pause'),
  resume: () => ipcRenderer.invoke('process:resume'),
  release: (jobId) => ipcRenderer.invoke('process:release', jobId),
  save: (payload) => ipcRenderer.invoke('process:save', payload),
  saveOne: (payload) => ipcRenderer.invoke('process:saveOne', payload),

  // Image -> PDF tool
  pickImages: () => ipcRenderer.invoke('img:pick'),
  saveImages: (payload) => ipcRenderer.invoke('img:save', payload),

  mergePick: () => ipcRenderer.invoke('merge:pick'),
  mergePages: (filePaths) => ipcRenderer.invoke('merge:pages', filePaths),
  mergeSave: (payload) => ipcRenderer.invoke('merge:save', payload),

  // Сжатие PDF
  compressPick: () => ipcRenderer.invoke('compress:pick'),
  compressRun: (payload) => ipcRenderer.invoke('compress:run', payload),

  // Сортировка накладных
  sortPickSource: () => ipcRenderer.invoke('sort:pickSource'),
  sortPickDest: () => ipcRenderer.invoke('sort:pickDest'),
  sortPlan: (payload) => ipcRenderer.invoke('sort:plan', payload),
  sortApply: (payload) => ipcRenderer.invoke('sort:apply', payload),

  // events (main -> renderer)
  on: (channel, cb) => {
    const allowed = [
      'process:meta',
      'process:page',
      'process:complete',
      'process:error',
      'compress:progress',
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
