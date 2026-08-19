'use strict';

const path = require('path');
const fs = require('fs/promises');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');

const { renderSinglePage, pageCount, splitPage, imageToPdf, imagesToPdf, mergePages, compressPdf, clearDocCache } = require('./pdf');
const {
  ocrImage, ocrPlain, cropTop, rotateBuffer, jimpToPdfRotation, workerCount,
  terminate: terminateOcr,
} = require('./ocr');
const { extractWithClaude } = require('./ai');
const { extract, makeFilename, sanitizeForFilename } = require('./extract');
const { parseApproval } = require('./extract-approval');
const { buildSortPlan } = require('./sort');
const { matchWaybills } = require('./matchExistingFolders');
const { presetOpts, savingsPercent } = require('./compress');
const { readJpegOrientation, orientationPlan } = require('./exif');
const { getSettings, setSettings } = require('./settings');

let mainWindow = null;
// In-memory map of jobId -> parsed pages, so "Save" can act on reviewed data.
const jobs = new Map();
// Set when the user hits "Start over" mid-processing; the run loop checks it.
let cancelRequested = false;

// Pause support: while paused, the run loop stops dispatching NEW pages (pages
// already in flight finish). `resumeWaiters` are resolved when the user resumes.
let paused = false;
let resumeWaiters = [];
function waitWhilePaused() {
  if (!paused || cancelRequested) return Promise.resolve();
  return new Promise((resolve) => resumeWaiters.push(resolve));
}
function releasePause() {
  const waiters = resumeWaiters;
  resumeWaiters = [];
  waiters.forEach((r) => r());
}

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

/** Downscale a PNG so API payloads stay reasonable; best-effort. Smaller/lighter
 *  thumbnails mean less base64 over IPC and lighter DOM in the review list. */
async function thumbnail(pngBuffer, maxWidth = 440) {
  try {
    const Jimp = require('jimp');
    const img = await Jimp.read(pngBuffer);
    if (img.bitmap.width > maxWidth) img.resize(maxWidth, Jimp.AUTO);
    const jpg = await img.quality(66).getBufferAsync(Jimp.MIME_JPEG);
    return `data:image/jpeg;base64,${jpg.toString('base64')}`;
  } catch (_) {
    return `data:image/png;base64,${pngBuffer.toString('base64')}`;
  }
}

ipcMain.handle('process:cancel', () => {
  cancelRequested = true;
  paused = false;
  releasePause(); // wake any paused runners so they can see the cancel and exit
});
ipcMain.handle('process:pause', () => { paused = true; return { ok: true }; });
ipcMain.handle('process:resume', () => { paused = false; releasePause(); return { ok: true }; });

ipcMain.handle('process:start', async (_e, arg) => {
  // Back-compat: arg may be an array of paths (defaults to the TTN tool).
  const filePaths = Array.isArray(arg) ? arg : arg.filePaths;
  const mode = (Array.isArray(arg) ? 'ttn' : arg.mode) || 'ttn';
  const jobId = `job_${Date.now()}`;
  const settings = getSettings();
  // The UI works one job at a time; drop any previous job so memory (and the
  // jobs map) never accumulates across batches.
  jobs.clear();
  clearDocCache();
  const pages = [];
  jobs.set(jobId, pages);
  cancelRequested = false;
  paused = false;
  resumeWaiters = [];

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
    await waitWhilePaused(); // hold here while paused; pages in flight finish
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
async function fileExists(p) {
  try { await fs.access(p); return true; } catch (_) { return false; }
}

/**
 * Pick a filename in `dir` that collides neither with a name already taken in
 * this batch (`used`) NOR with a file already on disk, appending _2, _3, … as
 * needed. The on-disk check is what makes independent single-page saves
 * ("Сохранить этот") safe: two cards with the same name no longer overwrite —
 * the second becomes «name_2.pdf» — so nothing is silently lost.
 */
async function uniqueName(dir, name, used) {
  const ext = path.extname(name);
  const base = name.slice(0, -ext.length);
  let candidate = name;
  let n = 1;
  // eslint-disable-next-line no-await-in-loop
  while ((used && used.has(candidate)) || await fileExists(path.join(dir, candidate))) {
    n += 1;
    candidate = `${base}_${n}${ext}`;
  }
  if (used) used.add(candidate);
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
    const finalName = await uniqueName(outputDir, ensurePdfName(edit.name ?? page.name), used);
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
  clearDocCache(); // free the opened source PDFs from memory
  return { ok: true };
});

// Save a single reviewed page.
ipcMain.handle('process:saveOne', async (_e, { jobId, pageId, outputDir, name }) => {
  const pages = jobs.get(jobId);
  if (!pages) throw new Error('Задача не найдена (возможно, приложение перезапускалось).');
  if (!outputDir) throw new Error('Не выбрана папка для сохранения.');
  const page = pages.find((p) => p && p.pageId === pageId);
  if (!page) throw new Error('Страница не найдена.');

  const finalName = await uniqueName(outputDir, ensurePdfName(name ?? page.name), null);
  const outPath = path.join(outputDir, finalName);
  const pdfRotation = jimpToPdfRotation(page.rotation || 0);
  await splitPage(page.filePath, page.pageIndex, outPath, pdfRotation);
  setSettings({ lastOutputDir: outputDir });
  return { pageId, name: finalName, outPath, ok: true };
});

// ---------------------------------------------------------------------------
// IPC: Merge PDFs tool
// ---------------------------------------------------------------------------

// Pick PDF files to merge. Returns just the paths; pages are loaded separately.
ipcMain.handle('merge:pick', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Выберите PDF-файлы для объединения',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  return res.canceled ? [] : res.filePaths;
});

// Expand the given PDF paths into a flat, ordered list of pages, each with a
// small preview thumbnail so the user can arrange them.
ipcMain.handle('merge:pages', async (_e, filePaths) => {
  const Jimp = require('jimp');
  const pages = [];
  for (const filePath of filePaths || []) {
    let count;
    try {
      count = await pageCount(filePath);
    } catch (err) {
      send('process:error', { filePath, message: String(err.message || err) });
      continue;
    }
    for (let i = 0; i < count; i++) {
      let thumb = '';
      try {
        const img = await Jimp.read(await renderSinglePage(filePath, i, 1.0));
        if (img.bitmap.width > 300) img.resize(300, Jimp.AUTO);
        thumb = `data:image/jpeg;base64,${(await img.quality(70).getBufferAsync(Jimp.MIME_JPEG)).toString('base64')}`;
      } catch (_) { /* preview optional */ }
      pages.push({ filePath, fileName: path.basename(filePath), pageIndex: i, thumb });
    }
  }
  return pages;
});

// Merge the ordered pages into one PDF named `name` in `outputDir`.
ipcMain.handle('merge:save', async (_e, { pages, outputDir, name }) => {
  if (!outputDir) throw new Error('Не выбрана папка для сохранения.');
  if (!pages || !pages.length) throw new Error('Нет страниц для объединения.');
  const fileName = await uniqueName(outputDir, ensurePdfName(name || 'merged'), null);
  const outPath = path.join(outputDir, fileName);
  await mergePages(pages.map((p) => ({ filePath: p.filePath, pageIndex: p.pageIndex })), outPath);
  setSettings({ lastOutputDir: outputDir });
  return { outputDir, name: fileName, outPath };
});

// ---------------------------------------------------------------------------
// IPC: Image -> PDF tool
// ---------------------------------------------------------------------------

ipcMain.handle('img:pick', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Выберите изображения (JPG, PNG, TIFF)',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Изображения', extensions: ['jpg', 'jpeg', 'png', 'tif', 'tiff'] }],
  });
  if (res.canceled) return [];
  // Return a small preview + default name for each image.
  const out = [];
  for (const filePath of res.filePaths) {
    let thumb = '';
    let reoriented = false;
    try {
      const buf = await fs.readFile(filePath);
      if (/\.jpe?g$/i.test(filePath)) {
        reoriented = orientationPlan(readJpegOrientation(buf)).changed;
      }
      const Jimp = require('jimp');
      const img = await Jimp.read(buf);
      if (img.bitmap.width > 400) img.resize(400, Jimp.AUTO);
      thumb = `data:image/jpeg;base64,${(await img.quality(70).getBufferAsync(Jimp.MIME_JPEG)).toString('base64')}`;
    } catch (_) { /* ignore preview failure */ }
    out.push({ filePath, fileName: path.basename(filePath), thumb, reoriented });
  }
  return out;
});

ipcMain.handle('img:save', async (_e, { images, mode, outputDir, combinedName }) => {
  if (!outputDir) throw new Error('Не выбрана папка для сохранения.');
  if (!images || !images.length) throw new Error('Нет изображений.');
  const used = new Set();

  if (mode === 'one') {
    const name = await uniqueName(outputDir, ensurePdfName(combinedName || 'photos'), used);
    const outPath = path.join(outputDir, name);
    await imagesToPdf(images.map((i) => i.filePath), outPath);
    setSettings({ lastOutputDir: outputDir });
    return { outputDir, results: [{ name, outPath, ok: true }] };
  }

  // one PDF per image
  const results = [];
  for (const im of images) {
    const base = im.name || path.basename(im.filePath, path.extname(im.filePath));
    const name = await uniqueName(outputDir, ensurePdfName(base), used);
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
// IPC: Сжатие PDF
// ---------------------------------------------------------------------------

ipcMain.handle('compress:pick', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Выберите PDF-файлы для сжатия',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  return res.canceled ? [] : res.filePaths;
});

// Compress each chosen PDF into `outputDir`, keeping the original filename
// (deduped so nothing is overwritten). Progress is streamed per file.
ipcMain.handle('compress:run', async (_e, { filePaths, preset, outputDir }) => {
  if (!outputDir) throw new Error('Не выбрана папка для сохранения.');
  if (!filePaths || !filePaths.length) throw new Error('Нет файлов для сжатия.');
  const opts = presetOpts(preset);
  const used = new Set();
  const results = [];
  let done = 0;

  for (const filePath of filePaths) {
    const fileName = path.basename(filePath);
    send('compress:progress', { fileName, done, total: filePaths.length });
    // eslint-disable-next-line no-await-in-loop
    const name = await uniqueName(outputDir, fileName, used);
    const outPath = path.join(outputDir, name);
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await compressPdf(filePath, outPath, opts, (page, total) =>
        send('compress:progress', { fileName, done, total: filePaths.length, page, pageTotal: total }));
      results.push({
        fileName, name, ok: true,
        originalSize: r.originalSize, newSize: r.newSize,
        savings: savingsPercent(r.originalSize, r.newSize),
        kept: r.kept, pages: r.pages,
      });
    } catch (err) {
      results.push({ fileName, name, ok: false, error: String(err.message || err) });
    }
    done += 1;
    clearDocCache(); // free the source doc between files so memory stays flat
  }

  const okResults = results.filter((r) => r.ok);
  const originalTotal = okResults.reduce((n, r) => n + r.originalSize, 0);
  const newTotal = okResults.reduce((n, r) => n + r.newSize, 0);
  setSettings({ lastOutputDir: outputDir });
  return {
    outputDir, results,
    originalTotal, newTotal,
    savingsTotal: savingsPercent(originalTotal, newTotal),
  };
});

// ---------------------------------------------------------------------------
// IPC: Сортировка накладных (filename-based filing into contract folders)
// ---------------------------------------------------------------------------

const UNSORTED_DIR = 'неотсортированные'; // subfolder in the SOURCE for problems
const TTN_SUBDIR = 'ТТН';                  // subfolder inside each contract folder

/** Move a file, falling back to copy+unlink when src/dst are on different
 *  drives (fs.rename throws EXDEV across volumes — common on Windows). */
async function moveFile(src, dst) {
  try {
    await fs.rename(src, dst);
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      await fs.copyFile(src, dst);
      await fs.unlink(src);
    } else {
      throw err;
    }
  }
}

/** Keep folder names safe: never let a parsed contract escape into a path. */
function safeFolderName(name) {
  return String(name || '').replace(/[\\/:*?"<>|]/g, '-').replace(/\.+$/, '').trim() || 'NA';
}

/** Top-level *.pdf file names in a directory (subfolders are ignored, so an
 *  existing "неотсортированные" folder is never re-processed). */
async function listPdfNames(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isFile() && /\.pdf$/i.test(e.name)).map((e) => e.name);
}

/** First-level subdirectories of `dir`, as {name, path}. Scanned once per run —
 *  the destination may be a slow network share with hundreds of folders. */
async function listSubdirs(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => ({ name: e.name, path: path.join(dir, e.name) }));
}

/** Locate the «ТТН» subfolder inside a contract folder (case-insensitive,
 *  trimmed). Cached per folder path for the whole run so a folder with 1000+
 *  files on a network share is listed only once. Returns its path or null. */
async function findTtnSubdir(folderPath, cache) {
  if (cache.has(folderPath)) return cache.get(folderPath);
  let result = null;
  try {
    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    const hit = entries.find((e) => e.isDirectory() && e.name.trim().toLowerCase() === 'ттн');
    if (hit) result = path.join(folderPath, hit.name);
  } catch (_) { result = null; }
  cache.set(folderPath, result);
  return result;
}

/**
 * Resolve where each waybill goes when matching AGAINST existing contract
 * folders in `destDir` (the "искать, а не создавать" mode). Read-only: it scans
 * `destDir` once, matches by numeric core (see matchExistingFolders.js), and
 * finds each matched folder's «ТТН» subfolder (cached). Returns matched groups
 * plus an `unsorted` list that already folds in the NA/format problems, the
 * AMBIGUOUS / NOT FOUND / NO_TTN_FOLDER cases with human-readable reasons.
 */
async function resolveMatchPlan(destDir, plan) {
  const folders = await listSubdirs(destDir);
  const items = plan.groups.flatMap((g) => g.items).map((it) => ({ fileName: it.fileName, dogovor: it.dogovor }));
  const { matched, ambiguous, notFound } = matchWaybills(items, folders);

  const ttnCache = new Map();
  const groupsByPath = new Map();
  const unsorted = [...plan.unsorted]; // NA / wrong-format problems stay as-is

  for (const m of matched) {
    // eslint-disable-next-line no-await-in-loop
    const ttnDir = await findTtnSubdir(m.folder.path, ttnCache);
    if (!ttnDir) {
      unsorted.push({ fileName: m.fileName, reason: `в папке «${m.folder.name}» нет подпапки «ТТН»` });
      continue;
    }
    let g = groupsByPath.get(m.folder.path);
    if (!g) {
      g = { folderName: m.folder.name, ttnDir, targetRel: path.join(m.folder.name, path.basename(ttnDir)), items: [] };
      groupsByPath.set(m.folder.path, g);
    }
    g.items.push({ fileName: m.fileName, dogovor: m.dogovor });
  }

  for (const a of ambiguous) {
    unsorted.push({
      fileName: a.fileName,
      reason: `неоднозначно — несколько папок с кодом ${a.core}: ${a.candidates.map((c) => c.name).join('; ')}`,
    });
  }
  for (const nf of notFound) {
    const code = nf.core ? `код ${nf.core}` : 'нет числового кода';
    const hint = nf.similar.length ? ` (похожие: ${nf.similar.join('; ')})` : '';
    unsorted.push({ fileName: nf.fileName, reason: `папка договора не найдена — ${code}${hint}` });
  }

  return { groups: [...groupsByPath.values()], unsorted };
}

/**
 * Build the full sort plan for the UI: where each file would go, with on-disk
 * collision resolution (so the report shows the real target name, e.g. _2.pdf).
 * Read-only — safe to run as a dry run.
 */
async function buildSortReport(sourceDir, destDir, matchExisting) {
  const names = await listPdfNames(sourceDir);
  const plan = buildSortPlan(names);

  if (matchExisting) return buildMatchReport(sourceDir, destDir, plan);

  const groups = [];
  let conflicts = 0;
  for (const g of plan.groups) {
    const folder = safeFolderName(g.folder);
    const targetDir = path.join(destDir, folder, TTN_SUBDIR);
    const used = new Set();
    const files = [];
    for (const it of g.items) {
      // eslint-disable-next-line no-await-in-loop
      const finalName = await uniqueName(targetDir, it.fileName, used);
      const conflict = finalName !== it.fileName;
      if (conflict) conflicts += 1;
      files.push({
        fileName: it.fileName, nakladnaya: it.nakladnaya, dogovor: it.dogovor,
        finalName, conflict,
      });
    }
    groups.push({ folder, targetRel: path.join(folder, TTN_SUBDIR), files });
  }

  const toSort = groups.reduce((n, g) => n + g.files.length, 0);
  return {
    sourceDir, destDir,
    totalPdf: plan.totalPdf,
    toSort,
    problems: plan.unsorted.length,
    folderCount: groups.length,
    conflicts,
    groups,
    unsorted: plan.unsorted,
  };
}

/** Read-only report for the match-existing-folders mode (dry run). */
async function buildMatchReport(sourceDir, destDir, plan) {
  const rp = await resolveMatchPlan(destDir, plan);
  const groups = [];
  let conflicts = 0;
  for (const g of rp.groups) {
    const used = new Set();
    const files = [];
    for (const it of g.items) {
      // eslint-disable-next-line no-await-in-loop
      const finalName = await uniqueName(g.ttnDir, it.fileName, used);
      const conflict = finalName !== it.fileName;
      if (conflict) conflicts += 1;
      files.push({ fileName: it.fileName, nakladnaya: '', dogovor: it.dogovor, finalName, conflict });
    }
    groups.push({ folder: g.folderName, targetRel: g.targetRel, files });
  }
  const toSort = groups.reduce((n, g) => n + g.files.length, 0);
  return {
    matchExisting: true,
    sourceDir, destDir,
    totalPdf: plan.totalPdf,
    toSort,
    problems: rp.unsorted.length,
    folderCount: groups.length,
    conflicts,
    groups,
    unsorted: rp.unsorted,
  };
}

/** Actually move files into existing folders' «ТТН» subfolders (apply). */
async function applyMatch(sourceDir, destDir, plan) {
  const rp = await resolveMatchPlan(destDir, plan);
  const results = [];
  let moved = 0;
  let failed = 0;

  for (const g of rp.groups) {
    const used = new Set();
    for (const it of g.items) {
      // eslint-disable-next-line no-await-in-loop
      const finalName = await uniqueName(g.ttnDir, it.fileName, used);
      try {
        // eslint-disable-next-line no-await-in-loop
        await moveFile(path.join(sourceDir, it.fileName), path.join(g.ttnDir, finalName));
        moved += 1;
        results.push({ fileName: it.fileName, folder: g.folderName, finalName, ok: true });
      } catch (err) {
        failed += 1;
        results.push({ fileName: it.fileName, folder: g.folderName, ok: false, error: String(err.message || err) });
      }
    }
  }

  // Everything that didn't match → неотсортированные in the SOURCE folder.
  let unsortedMoved = 0;
  const unsortedDir = path.join(sourceDir, UNSORTED_DIR);
  if (rp.unsorted.length) {
    await fs.mkdir(unsortedDir, { recursive: true });
    const used = new Set();
    for (const u of rp.unsorted) {
      // eslint-disable-next-line no-await-in-loop
      const finalName = await uniqueName(unsortedDir, u.fileName, used);
      try {
        // eslint-disable-next-line no-await-in-loop
        await moveFile(path.join(sourceDir, u.fileName), path.join(unsortedDir, finalName));
        unsortedMoved += 1;
        results.push({ fileName: u.fileName, folder: UNSORTED_DIR, finalName, ok: true });
      } catch (err) {
        failed += 1;
        results.push({ fileName: u.fileName, folder: UNSORTED_DIR, ok: false, error: String(err.message || err) });
      }
    }
  }

  return { moved, failed, unsortedMoved, unsortedDir, results };
}

// Two folder pickers. Titles differ so the dialog is self-explanatory.
ipcMain.handle('sort:pickSource', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Папка с накладными (откуда сортировать)',
    properties: ['openDirectory'],
  });
  return res.canceled ? '' : res.filePaths[0];
});
ipcMain.handle('sort:pickDest', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Папка назначения (куда разложить)',
    properties: ['openDirectory', 'createDirectory'],
  });
  return res.canceled ? '' : res.filePaths[0];
});

// Dry run: compute the plan without touching disk.
ipcMain.handle('sort:plan', async (_e, { sourceDir, destDir, matchExisting }) => {
  if (!sourceDir) throw new Error('Не выбрана папка с накладными.');
  if (!destDir) throw new Error('Не выбрана папка назначения.');
  return buildSortReport(sourceDir, destDir, !!matchExisting);
});

// Apply: actually move the files. Re-plans against the current disk state so
// the run is correct even if files changed since the dry run.
ipcMain.handle('sort:apply', async (_e, { sourceDir, destDir, matchExisting }) => {
  if (!sourceDir) throw new Error('Не выбрана папка с накладными.');
  if (!destDir) throw new Error('Не выбрана папка назначения.');

  const names = await listPdfNames(sourceDir);
  const plan = buildSortPlan(names);
  if (matchExisting) return applyMatch(sourceDir, destDir, plan);

  const results = [];
  let moved = 0;
  let failed = 0;

  for (const g of plan.groups) {
    const folder = safeFolderName(g.folder);
    const targetDir = path.join(destDir, folder, TTN_SUBDIR);
    // eslint-disable-next-line no-await-in-loop
    await fs.mkdir(targetDir, { recursive: true });
    const used = new Set();
    for (const it of g.items) {
      // eslint-disable-next-line no-await-in-loop
      const finalName = await uniqueName(targetDir, it.fileName, used);
      const to = path.join(targetDir, finalName);
      try {
        // eslint-disable-next-line no-await-in-loop
        await moveFile(path.join(sourceDir, it.fileName), to);
        moved += 1;
        results.push({ fileName: it.fileName, folder, finalName, ok: true });
      } catch (err) {
        failed += 1;
        results.push({ fileName: it.fileName, folder, ok: false, error: String(err.message || err) });
      }
    }
  }

  // Problem files → неотсортированные inside the SOURCE folder.
  let unsortedMoved = 0;
  if (plan.unsorted.length) {
    const unsortedDir = path.join(sourceDir, UNSORTED_DIR);
    await fs.mkdir(unsortedDir, { recursive: true });
    const used = new Set();
    for (const u of plan.unsorted) {
      // eslint-disable-next-line no-await-in-loop
      const finalName = await uniqueName(unsortedDir, u.fileName, used);
      try {
        // eslint-disable-next-line no-await-in-loop
        await moveFile(path.join(sourceDir, u.fileName), path.join(unsortedDir, finalName));
        unsortedMoved += 1;
        results.push({ fileName: u.fileName, folder: UNSORTED_DIR, finalName, ok: true });
      } catch (err) {
        failed += 1;
        results.push({ fileName: u.fileName, folder: UNSORTED_DIR, ok: false, error: String(err.message || err) });
      }
    }
  }

  return { moved, failed, unsortedMoved, unsortedDir: path.join(sourceDir, UNSORTED_DIR), results };
});

// ---------------------------------------------------------------------------

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}
