'use strict';

const path = require('path');
const fs = require('fs/promises');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');

const { renderSinglePage, pageCount, splitPage, imageToPdf, imagesToPdf } = require('./pdf');
const {
  ocrImage, ocrPlain, cropTop, rotateBuffer, jimpToPdfRotation, workerCount,
  terminate: terminateOcr,
} = require('./ocr');
const { extractWithClaude } = require('./ai');
const { extract, makeFilename, sanitizeForFilename } = require('./extract');
const { parseApproval } = require('./extract-approval');
const { getSettings, setSettings } = require('./settings');
const db = require('./db');
const { generate: generateContract } = require('./contract');

const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates');

let mainWindow = null;
// In-memory map of jobId -> parsed pages, so "Save" can act on reviewed data.
const jobs = new Map();
// Set when the user hits "Start over" mid-processing; the run loop checks it.
let cancelRequested = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Saturn',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    backgroundColor: '#0f1216',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Run the preload with full Node so the contextBridge reliably exposes
      // `window.api` in packaged builds.
      sandbox: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);

  attachDiagnostics(mainWindow);

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
    .catch((err) => reportStartupError('loadFile failed', err));

  // Diagnostic build: always open DevTools so any error is visible.
  if (DEBUG_BUILD || process.env.TTN_DEBUG) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

// --- diagnostics -----------------------------------------------------------
// Off for release: normal use is clean. Error dialogs and ttn-debug.log still
// fire on any real failure; set TTN_DEBUG=1 to force DevTools open.
const DEBUG_BUILD = false;

function logLine(msg) {
  try {
    const p = path.join(app.getPath('userData'), 'ttn-debug.log');
    require('fs').appendFileSync(p, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) { /* ignore */ }
}

function reportStartupError(where, err) {
  const message = `${where}: ${err && (err.stack || err.message || err)}`;
  logLine(message);
  try { dialog.showErrorBox('TTN Splitter — ошибка запуска', message); } catch (_) {}
}

function attachDiagnostics(win) {
  const wc = win.webContents;
  wc.on('preload-error', (_e, preloadPath, error) =>
    reportStartupError(`preload-error (${preloadPath})`, error));
  wc.on('did-fail-load', (_e, code, desc, url) =>
    reportStartupError('did-fail-load', new Error(`${code} ${desc} @ ${url}`)));
  wc.on('render-process-gone', (_e, details) =>
    reportStartupError('render-process-gone', new Error(JSON.stringify(details))));
  let shownRendererError = false;
  wc.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) { // 2 = warning, 3 = error
      logLine(`renderer console[${level}] ${message} (${sourceId}:${line})`);
    }
    if (level >= 3 && !shownRendererError) {
      shownRendererError = true;
      try {
        dialog.showErrorBox('TTN Splitter — ошибка интерфейса',
          `${message}\n\n(${sourceId}:${line})`);
      } catch (_) {}
    }
  });
}

process.on('uncaughtException', (err) => reportStartupError('uncaughtException (main)', err));

app.whenReady()
  .then(createWindow)
  .catch((err) => reportStartupError('app.whenReady', err));

app.on('window-all-closed', async () => {
  await terminateOcr().catch(() => {});
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ---------------------------------------------------------------------------
// IPC: settings
// ---------------------------------------------------------------------------

ipcMain.handle('settings:get', () => getSettings());
ipcMain.handle('settings:set', (_e, partial) => setSettings(partial));

// ---------------------------------------------------------------------------
// IPC: contract database (контрагенты / продукты / виды договора)
// ---------------------------------------------------------------------------

ipcMain.handle('db:all', () => db.getAll());
ipcMain.handle('db:contractors', (_e, c) => db.getContractors(c));
ipcMain.handle('db:saveContractor', (_e, { company, data }) => db.saveContractor(company, data));
ipcMain.handle('db:deleteContractor', (_e, { company, id }) => db.deleteContractor(company, id));
ipcMain.handle('db:products', () => db.getProducts());
ipcMain.handle('db:saveProduct', (_e, data) => db.saveProduct(data));
ipcMain.handle('db:deleteProduct', (_e, id) => db.deleteProduct(id));
ipcMain.handle('db:contractTypes', (_e, c) => db.getContractTypes(c));
ipcMain.handle('db:addContractType', (_e, { company, type }) => db.addContractType(company, type));
ipcMain.handle('db:setContractTypes', (_e, { company, types }) => db.setContractTypes(company, types));

// ---------------------------------------------------------------------------
// IPC: contract drafting (Оформление договора)
// ---------------------------------------------------------------------------

ipcMain.handle('contract:generate', async (_e, data) => {
  if (!data.outputDir) throw new Error('Не выбрана папка для сохранения.');
  // Auto-save manually-entered contractor / product / contract type to the DB.
  if (data.counterparty && data.counterparty.name) {
    data.counterparty = db.saveContractor(data.company, data.counterparty);
  }
  if (data.product) db.saveProduct({ name: data.product, pricePerTon: data.pricePerTon });
  if (data.contractType) db.addContractType(data.company, data.contractType);

  const { folder, files } = generateContract(data, TEMPLATES_DIR);
  const destFolder = path.join(data.outputDir, folder);
  await fs.mkdir(destFolder, { recursive: true });
  for (const f of files) await fs.writeFile(path.join(destFolder, f.name), f.buffer);
  setSettings({ lastOutputDir: data.outputDir });
  return { folder: destFolder, files: files.map((f) => f.name) };
});

// ---------------------------------------------------------------------------
// IPC: file & folder pickers
// ---------------------------------------------------------------------------

ipcMain.handle('files:pick', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Выберите PDF-файлы накладных',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle('output:pickDir', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Папка для сохранения результатов',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled) return '';
  setSettings({ lastOutputDir: res.filePaths[0] });
  return res.filePaths[0];
});

ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));

// High-resolution image of a single page, rendered on demand for the zoom view.
ipcMain.handle('page:image', async (_e, { filePath, pageIndex, rotation }) => {
  let png = await renderSinglePage(filePath, pageIndex);
  if (rotation) png = await rotateBuffer(png, rotation);
  return `data:image/png;base64,${png.toString('base64')}`;
});

// ---------------------------------------------------------------------------
// IPC: processing
// ---------------------------------------------------------------------------

function shouldUseAi(settings, confidence) {
  if (!settings.useAiFallback || !settings.apiKey) return false;
  if (settings.aiOnConfidence === 'never') return false;
  if (settings.aiOnConfidence === 'medium') return confidence !== 'high';
  return confidence === 'low'; // default
}

/** Downscale a PNG so API payloads stay reasonable; best-effort. */
async function thumbnail(pngBuffer, maxWidth = 520) {
  try {
    const Jimp = require('jimp');
    const img = await Jimp.read(pngBuffer);
    if (img.bitmap.width > maxWidth) img.resize(maxWidth, Jimp.AUTO);
    const jpg = await img.quality(72).getBufferAsync(Jimp.MIME_JPEG);
    return `data:image/jpeg;base64,${jpg.toString('base64')}`;
  } catch (_) {
    return `data:image/png;base64,${pngBuffer.toString('base64')}`;
  }
}

ipcMain.handle('process:cancel', () => { cancelRequested = true; });

ipcMain.handle('process:start', async (_e, arg) => {
  // Back-compat: arg may be an array of paths (defaults to the TTN tool).
  const filePaths = Array.isArray(arg) ? arg : arg.filePaths;
  const mode = (Array.isArray(arg) ? 'ttn' : arg.mode) || 'ttn';
  const jobId = `job_${Date.now()}`;
  const settings = getSettings();
  // The UI works one job at a time; drop any previous job so memory (and the
  // jobs map) never accumulates across batches.
  jobs.clear();
  const pages = [];
  jobs.set(jobId, pages);
  cancelRequested = false;

  // Render scale by tool: TTN needs high res; the approval header is larger so
  // a lower scale is enough and much faster; the splitter only needs a preview.
  const renderScale = mode === 'ttn' ? 3.2 : mode === 'approval' ? 2.6 : 1.6;

  // Build the page task list from page COUNTS only — we do NOT pre-render every
  // page up front (that held the whole batch of PNGs in memory at once and made
  // large batches hang). Each page is rendered lazily inside processTask, so at
  // most `workerCount()` page images live at any moment, regardless of batch size.
  const tasks = [];
  for (const filePath of filePaths) {
    if (cancelRequested) return { jobId, cancelled: true };
    try {
      const count = await pageCount(filePath);
      for (let i = 0; i < count; i++) {
        tasks.push({ filePath, pageIndex: i, index: tasks.length });
      }
    } catch (err) {
      send('process:error', { filePath, message: String(err.message || err) });
    }
  }
  send('process:meta', { jobId, totalPages: tasks.length });
  pages.length = tasks.length; // pre-size so results keep page order

  let done = 0;
  const processTask = async (task) => {
    if (cancelRequested) return;
    let fields = {};
    let rotation = 0;
    let png = null;         // rendered lazily below; freed when the task ends
    let displayPng = null;
    let ocrText = '';
    try {
      png = await renderSinglePage(task.filePath, task.pageIndex, renderScale);
      displayPng = png;
      if (mode === 'split') {
        // No OCR — just split and name by page.
        const base = path.basename(task.filePath, path.extname(task.filePath));
        fields = { name: `${base}_splitted_${task.pageIndex + 1}.pdf`, confidence: 'high', source: 'split' };
      } else if (mode === 'approval') {
        const top = await cropTop(png, 0.45);
        const ocr = await ocrPlain(top);
        ocrText = ocr.text;
        const p = parseApproval(ocrText);
        fields = {
          name: p.filename, contract: p.contract, date: p.date,
          counterparty: p.counterparty, confidence: p.confidence, source: 'ocr',
        };
      } else {
        // TTN: full-page OCR with orientation + extraction (+ optional AI).
        const ocr = await ocrImage(png);
        ocrText = ocr.text;
        rotation = ocr.rotation || 0;
        displayPng = rotation ? await rotateBuffer(png, rotation) : png;
        let result = extract(ocrText);
        if (shouldUseAi(settings, result.confidence)) {
          try {
            const ai = await extractWithClaude(displayPng, { apiKey: settings.apiKey, model: settings.model });
            const merged = {
              nakladnaya: ai.nakladnaya || result.nakladnaya,
              dogovor: ai.dogovor || result.dogovor,
            };
            result = {
              ...result, ...merged, source: 'ai',
              confidence: merged.nakladnaya && merged.dogovor ? 'high' : result.confidence,
              filename: makeFilename(merged),
            };
          } catch (aiErr) {
            result.aiError = String(aiErr.message || aiErr);
          }
        }
        fields = {
          nakladnaya: result.nakladnaya, dogovor: result.dogovor,
          confidence: result.confidence, source: result.source,
          name: result.filename, aiError: result.aiError,
        };
      }
    } catch (err) {
      fields = { confidence: 'low', source: 'error', name: '', error: String(err.message || err) };
    }

    const record = {
      pageId: `${jobId}:${task.index}`,
      filePath: task.filePath,
      fileName: path.basename(task.filePath),
      pageIndex: task.pageIndex,
      rotation,
      mode,
      ...fields,
      ocrText,
    };
    pages[task.index] = record;

    const thumb = displayPng ? await thumbnail(displayPng) : null;
    // Drop the page bitmaps so they can be reclaimed before the next task.
    png = null;
    displayPng = null;
    if (cancelRequested) return;
    done += 1;
    send('process:page', { jobId, done, ...record, thumb });
  };

  // Run several pages at once so the OCR worker pool stays busy.
  await runPool(tasks, workerCount(), processTask);

  if (cancelRequested) return { jobId, cancelled: true };
  send('process:complete', { jobId, count: pages.length });
  return { jobId, count: pages.length };
});

/** Run async `fn` over `items` with a bounded number in flight. */
async function runPool(items, concurrency, fn) {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(runners);
}

// ---------------------------------------------------------------------------
// IPC: saving
// ---------------------------------------------------------------------------

/** Ensure no two outputs collide by suffixing _2, _3, ... */
function dedupe(name, used) {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const ext = path.extname(name);
  const base = name.slice(0, -ext.length);
  let n = 2;
  let candidate = `${base}_${n}${ext}`;
  while (used.has(candidate)) {
    n += 1;
    candidate = `${base}_${n}${ext}`;
  }
  used.add(candidate);
  return candidate;
}

/** Sanitize a user-supplied filename and ensure a .pdf extension. */
function ensurePdfName(name) {
  let n = sanitizeForFilename(name || '') || 'NA';
  if (!/\.pdf$/i.test(n)) n += '.pdf';
  return n;
}

ipcMain.handle('process:save', async (_e, { jobId, outputDir, edits }) => {
  const pages = jobs.get(jobId);
  if (!pages) throw new Error('Задача не найдена (возможно, приложение перезапускалось).');
  if (!outputDir) throw new Error('Не выбрана папка для сохранения.');

  // `edits` is the authoritative list of pages to save — it comes from the
  // cards still on screen, so pages the user deleted are simply absent and are
  // NOT saved. (Previously we looped over every page in the job, which saved
  // deleted cards anyway.)
  const pageById = new Map(pages.filter(Boolean).map((p) => [p.pageId, p]));
  const used = new Set();
  const results = [];

  for (const edit of edits || []) {
    const page = pageById.get(edit.pageId);
    if (!page) continue;
    const finalName = dedupe(ensurePdfName(edit.name ?? page.name), used);
    const outPath = path.join(outputDir, finalName);
    try {
      const pdfRotation = jimpToPdfRotation(page.rotation || 0);
      await splitPage(page.filePath, page.pageIndex, outPath, pdfRotation);
      results.push({ pageId: page.pageId, outPath, name: finalName, ok: true });
    } catch (err) {
      results.push({ pageId: page.pageId, name: finalName, ok: false, error: String(err.message || err) });
    }
  }

  setSettings({ lastOutputDir: outputDir });
  return { outputDir, results };
});

// Release a finished job's data (called on "Начать заново") so memory doesn't
// accumulate across batches.
ipcMain.handle('process:release', (_e, jobId) => {
  if (jobId) jobs.delete(jobId); else jobs.clear();
  return { ok: true };
});

// Save a single reviewed page.
ipcMain.handle('process:saveOne', async (_e, { jobId, pageId, outputDir, name }) => {
  const pages = jobs.get(jobId);
  if (!pages) throw new Error('Задача не найдена (возможно, приложение перезапускалось).');
  if (!outputDir) throw new Error('Не выбрана папка для сохранения.');
  const page = pages.find((p) => p && p.pageId === pageId);
  if (!page) throw new Error('Страница не найдена.');

  const finalName = ensurePdfName(name ?? page.name);
  const outPath = path.join(outputDir, finalName);
  const pdfRotation = jimpToPdfRotation(page.rotation || 0);
  await splitPage(page.filePath, page.pageIndex, outPath, pdfRotation);
  setSettings({ lastOutputDir: outputDir });
  return { pageId, name: finalName, outPath, ok: true };
});

// ---------------------------------------------------------------------------
// IPC: Image -> PDF tool
// ---------------------------------------------------------------------------

ipcMain.handle('img:pick', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Выберите изображения (JPG, PNG)',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Изображения', extensions: ['jpg', 'jpeg', 'png'] }],
  });
  if (res.canceled) return [];
  // Return a small preview + default name for each image.
  const out = [];
  for (const filePath of res.filePaths) {
    let thumb = '';
    try {
      const Jimp = require('jimp');
      const img = await Jimp.read(filePath);
      if (img.bitmap.width > 400) img.resize(400, Jimp.AUTO);
      thumb = `data:image/jpeg;base64,${(await img.quality(70).getBufferAsync(Jimp.MIME_JPEG)).toString('base64')}`;
    } catch (_) { /* ignore preview failure */ }
    out.push({ filePath, fileName: path.basename(filePath), thumb });
  }
  return out;
});

ipcMain.handle('img:save', async (_e, { images, mode, outputDir, combinedName }) => {
  if (!outputDir) throw new Error('Не выбрана папка для сохранения.');
  if (!images || !images.length) throw new Error('Нет изображений.');
  const used = new Set();

  if (mode === 'one') {
    const name = dedupe(ensurePdfName(combinedName || 'photos'), used);
    const outPath = path.join(outputDir, name);
    await imagesToPdf(images.map((i) => i.filePath), outPath);
    setSettings({ lastOutputDir: outputDir });
    return { outputDir, results: [{ name, outPath, ok: true }] };
  }

  // one PDF per image
  const results = [];
  for (const im of images) {
    const base = im.name || path.basename(im.filePath, path.extname(im.filePath));
    const name = dedupe(ensurePdfName(base), used);
    const outPath = path.join(outputDir, name);
    try {
      await imageToPdf(im.filePath, outPath);
      results.push({ filePath: im.filePath, name, outPath, ok: true });
    } catch (err) {
      results.push({ filePath: im.filePath, name, ok: false, error: String(err.message || err) });
    }
  }
  setSettings({ lastOutputDir: outputDir });
  return { outputDir, results };
});

// ---------------------------------------------------------------------------

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}
