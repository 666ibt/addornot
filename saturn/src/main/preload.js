'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const { integerToWordsUz } = require('./num2words');

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
  release: (jobId) => ipcRenderer.invoke('process:release', jobId),
  save: (payload) => ipcRenderer.invoke('process:save', payload),
  saveOne: (payload) => ipcRenderer.invoke('process:saveOne', payload),

  // Image -> PDF tool
  pickImages: () => ipcRenderer.invoke('img:pick'),
  saveImages: (payload) => ipcRenderer.invoke('img:save', payload),

  mergePick: () => ipcRenderer.invoke('merge:pick'),
  mergePages: (filePaths) => ipcRenderer.invoke('merge:pages', filePaths),
  mergeSave: (payload) => ipcRenderer.invoke('merge:save', payload),

  // contract database
  db: {
    all: () => ipcRenderer.invoke('db:all'),
    contractors: (company) => ipcRenderer.invoke('db:contractors', company),
    saveContractor: (company, data) => ipcRenderer.invoke('db:saveContractor', { company, data }),
    deleteContractor: (company, id) => ipcRenderer.invoke('db:deleteContractor', { company, id }),
    products: () => ipcRenderer.invoke('db:products'),
    saveProduct: (data) => ipcRenderer.invoke('db:saveProduct', data),
    deleteProduct: (id) => ipcRenderer.invoke('db:deleteProduct', id),
    contractTypes: (company) => ipcRenderer.invoke('db:contractTypes', company),
    addContractType: (company, type) => ipcRenderer.invoke('db:addContractType', { company, type }),
    setContractTypes: (company, types) => ipcRenderer.invoke('db:setContractTypes', { company, types }),
  },

  // contract drafting
  generateContract: (data) => ipcRenderer.invoke('contract:generate', data),
  // сумма прописью (Uzbek Cyrillic) — pure function, no IPC round-trip
  amountUz: (n) => integerToWordsUz(n),

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
