'use strict';

const path = require('path');
const fs = require('fs');
const { createWorker } = require('tesseract.js');

/**
 * Thin wrapper around a single reusable Tesseract worker (rus + eng).
 *
 * The Russian + English language data is BUNDLED with the app (see the
 * `tessdata/` folder, shipped via electron-builder extraResources). We point
 * Tesseract at that local folder so OCR works fully offline and never contacts
 * a CDN — important on networks with SSL inspection / self-signed certificates.
 */

let workerPromise = null;

/** Locate the folder that holds rus/eng .traineddata.gz. */
function tessdataDir() {
  const candidates = [];
  // Packaged app: extraResources copies tessdata next to the app resources.
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'tessdata'));
  // Dev run (npm start): project-root tessdata (src/main -> ../../tessdata).
  candidates.push(path.join(__dirname, '..', '..', 'tessdata'));
  candidates.push(path.join(process.cwd(), 'tessdata'));
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'rus.traineddata.gz'))) return dir;
    } catch (_) { /* ignore */ }
  }
  return null;
}

async function getWorker() {
  if (!workerPromise) {
    const langPath = tessdataDir();
    // With a local langPath + gzip, Tesseract reads the data from disk and
    // makes no network request. cacheMethod:'none' avoids writing a cache
    // (the bundled folder may be read-only). If the data is somehow missing,
    // fall back to the default (CDN) behaviour rather than crashing.
    const opts = langPath ? { langPath, gzip: true, cacheMethod: 'none' } : {};
    workerPromise = createWorker('rus+eng', 1, opts);
  }
  return workerPromise;
}

/**
 * Run OCR on a PNG/JPEG image buffer.
 * @param {Buffer} imageBuffer
 * @returns {Promise<{text: string, confidence: number}>}
 */
async function ocrImage(imageBuffer) {
  const worker = await getWorker();
  const { data } = await worker.recognize(imageBuffer);
  return { text: data.text || '', confidence: data.confidence || 0 };
}

async function terminate() {
  if (workerPromise) {
    const worker = await workerPromise;
    await worker.terminate();
    workerPromise = null;
  }
}

module.exports = { ocrImage, terminate };
