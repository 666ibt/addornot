'use strict';

const path = require('path');
const fs = require('fs');
const { createWorker } = require('tesseract.js');

/**
 * Thin wrapper around a single reusable Tesseract worker (rus + eng).
 *
 * By default tesseract.js fetches language data from a CDN on first use. For a
 * fully offline install, drop `rus.traineddata.gz` and `eng.traineddata.gz`
 * into a `tessdata/` folder next to the app and it will be used automatically.
 */

let workerPromise = null;

function localLangPath() {
  const candidate = path.join(process.cwd(), 'tessdata');
  return fs.existsSync(candidate) ? candidate : undefined;
}

async function getWorker() {
  if (!workerPromise) {
    const langPath = localLangPath();
    workerPromise = createWorker('rus+eng', 1, langPath ? { langPath, gzip: true } : {});
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
