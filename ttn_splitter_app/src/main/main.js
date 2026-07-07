'use strict';

const path = require('path');
const fs = require('fs/promises');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');

const { renderPagesToImages, splitPage } = require('./pdf');
const { ocrImage, terminate: terminateOcr } = require('./ocr');
const { extractWithClaude } = require('./ai');
const { extract, makeFilename } = require('./extract');
const { getSettings, setSettings } = require('./settings');

let mainWindow = null;
// In-memory map of jobId -> parsed pages, so "Save" can act on reviewed data.
const jobs = new Map();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'TTN Waybill Splitter',
    backgroundColor: '#0f1216',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);

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

ipcMain.handle('process:start', async (_e, filePaths) => {
  const jobId = `job_${Date.now()}`;
  const settings = getSettings();
  const pages = [];
  jobs.set(jobId, pages);

  // Count total pages up front for progress.
  let totalPages = 0;
  const perFileImages = [];
  for (const filePath of filePaths) {
    try {
      const images = await renderPagesToImages(filePath);
      perFileImages.push({ filePath, images });
      totalPages += images.length;
    } catch (err) {
      send('process:error', { filePath, message: String(err.message || err) });
    }
  }
  send('process:meta', { jobId, totalPages });

  let done = 0;
  for (const { filePath, images } of perFileImages) {
    for (let i = 0; i < images.length; i++) {
      const png = images[i];
      const pageId = `${jobId}:${pages.length}`;
      let result;
      let ocrText = '';
      try {
        const ocr = await ocrImage(png);
        ocrText = ocr.text;
        result = extract(ocrText);

        if (shouldUseAi(settings, result.confidence)) {
          try {
            const ai = await extractWithClaude(png, {
              apiKey: settings.apiKey,
              model: settings.model,
            });
            // Merge: prefer AI values when present.
            const merged = {
              nakladnaya: ai.nakladnaya || result.nakladnaya,
              dogovor: ai.dogovor || result.dogovor,
            };
            result = {
              ...result,
              ...merged,
              source: 'ai',
              confidence:
                merged.nakladnaya && merged.dogovor ? 'high' : result.confidence,
              filename: makeFilename(merged),
            };
          } catch (aiErr) {
            result.aiError = String(aiErr.message || aiErr);
          }
        }
      } catch (err) {
        result = {
          nakladnaya: '',
          dogovor: '',
          confidence: 'low',
          source: 'error',
          filename: makeFilename({}),
          error: String(err.message || err),
        };
      }

      const record = {
        pageId,
        filePath,
        fileName: path.basename(filePath),
        pageIndex: i,
        ...result,
        ocrText,
      };
      pages.push(record);

      const thumb = await thumbnail(png);
      done += 1;
      send('process:page', { jobId, done, ...record, thumb });
    }
  }

  send('process:complete', { jobId, count: pages.length });
  return { jobId, count: pages.length };
});

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

ipcMain.handle('process:save', async (_e, { jobId, outputDir, edits }) => {
  const pages = jobs.get(jobId);
  if (!pages) throw new Error('Задача не найдена (возможно, приложение перезапускалось).');
  if (!outputDir) throw new Error('Не выбрана папка для сохранения.');

  const editMap = new Map((edits || []).map((x) => [x.pageId, x]));
  const used = new Set();
  const results = [];

  for (const page of pages) {
    const edit = editMap.get(page.pageId) || {};
    const nakladnaya = (edit.nakladnaya ?? page.nakladnaya) || '';
    const dogovor = (edit.dogovor ?? page.dogovor) || '';
    const desired = makeFilename({ nakladnaya, dogovor });
    const finalName = dedupe(desired, used);
    const outPath = path.join(outputDir, finalName);
    try {
      await splitPage(page.filePath, page.pageIndex, outPath);
      results.push({ pageId: page.pageId, outPath, name: finalName, ok: true });
    } catch (err) {
      results.push({
        pageId: page.pageId,
        name: finalName,
        ok: false,
        error: String(err.message || err),
      });
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
