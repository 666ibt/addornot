'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const Jimp = require('jimp');
const { createWorker, createScheduler } = require('tesseract.js');
const { extract } = require('./extract');

/**
 * Thin wrapper around a single reusable Tesseract worker (rus + eng).
 *
 * The Russian + English language data is BUNDLED with the app (see the
 * `tessdata/` folder, shipped via electron-builder extraResources), so OCR
 * works fully offline and never contacts a CDN — important on networks with
 * SSL inspection / self-signed certificates.
 *
 * We serve the bundled data over a tiny loopback HTTP server and give
 * Tesseract that URL. Reason: inside a packaged Electron app tesseract.js
 * loads langPath via `fetch`, which rejects a Windows file path
 * ("Only absolute URLs are supported"). A `http://127.0.0.1:<port>` URL works
 * the same everywhere — no network, no SSL, no path/scheme quirks.
 */

let schedulerPromise = null;
let server = null;
let langBase = null;

/** Number of parallel OCR workers (one per core, capped, leaving one free). */
function workerCount() {
  const cores = (os.cpus() && os.cpus().length) || 2;
  return Math.max(1, Math.min(cores - 1, 4));
}

/** Locate the folder that holds rus/eng .traineddata.gz. */
function tessdataDir() {
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'tessdata'));
  candidates.push(path.join(__dirname, '..', '..', 'tessdata')); // dev
  candidates.push(path.join(process.cwd(), 'tessdata'));
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'rus.traineddata.gz'))) return dir;
    } catch (_) { /* ignore */ }
  }
  return null;
}

/** Start a loopback server that serves *.traineddata.gz from the bundle. */
async function ensureLangServer() {
  if (langBase) return langBase;
  const dir = tessdataDir();
  if (!dir) return null; // no bundled data; fall back to tesseract default (CDN)

  server = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url || '').split('?')[0].replace(/^\/+/, ''));
    if (!/^[a-z]+\.traineddata\.gz$/i.test(name)) {
      res.statusCode = 404;
      return res.end('not found');
    }
    fs.readFile(path.join(dir, name), (err, buf) => {
      if (err) {
        res.statusCode = 404;
        return res.end('not found');
      }
      // Serve raw gzip bytes; tesseract.js decompresses them itself (gzip:true).
      // Do NOT set Content-Encoding, or the HTTP layer would decompress first.
      res.setHeader('Content-Type', 'application/octet-stream');
      res.end(buf);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  langBase = `http://127.0.0.1:${port}`;
  return langBase;
}

// A pool of workers so pages (and the 4 orientation checks) run in parallel
// across CPU cores.
async function getScheduler() {
  if (!schedulerPromise) {
    schedulerPromise = (async () => {
      const langPath = await ensureLangServer();
      const opts = langPath ? { langPath, gzip: true, cacheMethod: 'none' } : {};
      const scheduler = createScheduler();
      const n = workerCount();
      const workers = await Promise.all(
        Array.from({ length: n }, () => createWorker('rus+eng', 1, opts)));
      workers.forEach((w) => scheduler.addWorker(w));
      return scheduler;
    })();
  }
  return schedulerPromise;
}

/** Rotate a PNG buffer counter-clockwise by `deg` (0/90/180/270). */
async function rotateBuffer(buffer, deg) {
  if (!deg) return buffer;
  const img = await Jimp.read(buffer);
  img.rotate(deg);
  return img.getBufferAsync(Jimp.MIME_PNG);
}

/** Pixel dimensions of a PNG buffer. */
async function imageSize(buffer) {
  const img = await Jimp.read(buffer);
  return { width: img.bitmap.width, height: img.bitmap.height };
}

async function recognizeScored(scheduler, buffer, deg) {
  const buf = await rotateBuffer(buffer, deg);
  const { data } = await scheduler.addJob('recognize', buf);
  const text = data.text || '';
  const r = extract(text);
  const fields = (r.nakladnaya ? 1 : 0) + (r.dogovor ? 1 : 0);
  const confidence = data.confidence || 0;
  return { text, rotation: deg, confidence, fields, score: fields * 1000 + confidence };
}

/**
 * Run OCR on a PNG image buffer, auto-correcting page orientation.
 *
 * Full-page OCR has a large fixed cost (~8-14s) that barely shrinks with image
 * size, so the win is in doing as FEW passes as possible — not in shrinking
 * them. Quality is never traded away: every page is still OCR'd at full scale
 * and the orientation is confirmed by how well it actually reads.
 *
 *   1. Try the LAST known-good orientation first. Scans arrive in batches that
 *      share one orientation, so once we've learned it, every following page
 *      reads in a single pass — this is what makes a batch of rotated scans
 *      fast instead of paying a sweep on every page. Starts at 0° (upright),
 *      which also serves the common upright case and both form shapes
 *      (landscape ТТН, portrait FNPZ "Накладная на отпуск материалов").
 *
 *   2. Accept that pass ONLY if it actually extracted a field (накладная or
 *      договор). Extraction is the ground truth that the page is the right way
 *      up — high OCR "confidence" is not: a sideways page can still read
 *      confidently, and trusting it would save garbage AND poison the memory
 *      for the rest of the batch. If nothing was extracted, sweep the other
 *      plausible orientations (limited by aspect ratio) and keep the best.
 *
 * The chosen rotation (a counter-clockwise jimp angle) is returned so the
 * caller can show and save the page upright.
 *
 * @param {Buffer} imageBuffer
 * @returns {Promise<{text: string, confidence: number, rotation: number}>}
 */
let lastGoodRotation = 0;

async function ocrImage(imageBuffer) {
  const scheduler = await getScheduler();

  // 1) Try the orientation that worked for the previous page(s).
  const first = await recognizeScored(scheduler, imageBuffer, lastGoodRotation);
  if (first.fields >= 1) {
    lastGoodRotation = first.rotation;
    return { text: first.text, confidence: first.confidence, rotation: first.rotation };
  }

  // 2) Nothing extracted → sweep the still-plausible orientations and pick the
  //    best-reading one (by fields, then confidence).
  const { width, height } = await imageSize(imageBuffer);
  const candidates = new Set(width >= height ? [0, 180] : [0, 90, 270]);
  candidates.delete(lastGoodRotation); // already tried in step 1
  const results = await Promise.all(
    [...candidates].map((deg) => recognizeScored(scheduler, imageBuffer, deg)));

  let best = first;
  for (const r of results) if (r.score > best.score) best = r;
  // Only remember an orientation that actually yielded a field, so a blank or
  // unreadable page can't set a bad hint for the next one.
  if (best.fields >= 1) lastGoodRotation = best.rotation;
  return { text: best.text, confidence: best.confidence, rotation: best.rotation };
}

/** Convert the chosen jimp (CCW) angle to a PDF /Rotate (CW) angle. */
function jimpToPdfRotation(jimpDeg) {
  return (360 - (jimpDeg || 0)) % 360;
}

/** Plain OCR of an image buffer (no orientation sweep). */
async function ocrPlain(imageBuffer) {
  const scheduler = await getScheduler();
  const { data } = await scheduler.addJob('recognize', imageBuffer);
  return { text: data.text || '', confidence: data.confidence || 0 };
}

/** Crop a PNG buffer to its top fraction (e.g. 0.4 = top 40%). */
async function cropTop(buffer, frac) {
  const img = await Jimp.read(buffer);
  const { width, height } = img.bitmap;
  img.crop(0, 0, width, Math.round(height * frac));
  return img.getBufferAsync(Jimp.MIME_PNG);
}

async function terminate() {
  if (schedulerPromise) {
    const scheduler = await schedulerPromise;
    await scheduler.terminate(); // terminates all workers in the pool
    schedulerPromise = null;
  }
  if (server) {
    server.close();
    server = null;
    langBase = null;
  }
}

module.exports = {
  ocrImage, ocrPlain, cropTop, rotateBuffer, jimpToPdfRotation, workerCount, terminate,
};
