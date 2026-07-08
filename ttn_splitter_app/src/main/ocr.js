'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const Jimp = require('jimp');
const { createWorker } = require('tesseract.js');
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

let workerPromise = null;
let server = null;
let langBase = null;

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

async function getWorker() {
  if (!workerPromise) {
    const langPath = await ensureLangServer();
    const opts = langPath ? { langPath, gzip: true, cacheMethod: 'none' } : {};
    workerPromise = createWorker('rus+eng', 1, opts);
  }
  return workerPromise;
}

/** Rotate a PNG buffer counter-clockwise by `deg` (0/90/180/270). */
async function rotateBuffer(buffer, deg) {
  if (!deg) return buffer;
  const img = await Jimp.read(buffer);
  img.rotate(deg);
  return img.getBufferAsync(Jimp.MIME_PNG);
}

async function recognizeScored(worker, buffer, deg) {
  const buf = await rotateBuffer(buffer, deg);
  const { data } = await worker.recognize(buf);
  const text = data.text || '';
  const r = extract(text);
  const fields = (r.nakladnaya ? 1 : 0) + (r.dogovor ? 1 : 0);
  const confidence = data.confidence || 0;
  return { text, rotation: deg, confidence, fields, score: fields * 1000 + confidence };
}

/**
 * Run OCR on a PNG image buffer, auto-correcting page orientation.
 *
 * Scanned waybills are sometimes rotated 90°/180°. We OCR the upright image
 * first; if it doesn't read well (few fields, low confidence) we try the other
 * three orientations and keep whichever recognizes best. The chosen rotation
 * (a counter-clockwise jimp angle) is returned so the caller can show and save
 * the page upright.
 *
 * @param {Buffer} imageBuffer
 * @returns {Promise<{text: string, confidence: number, rotation: number}>}
 */
async function ocrImage(imageBuffer) {
  const worker = await getWorker();

  const at0 = await recognizeScored(worker, imageBuffer, 0);
  if (at0.fields >= 2 || at0.confidence >= 68) {
    return { text: at0.text, confidence: at0.confidence, rotation: 0 };
  }

  let best = at0;
  for (const deg of [90, 180, 270]) {
    const r = await recognizeScored(worker, imageBuffer, deg);
    if (r.score > best.score) best = r;
  }
  return { text: best.text, confidence: best.confidence, rotation: best.rotation };
}

/** Convert the chosen jimp (CCW) angle to a PDF /Rotate (CW) angle. */
function jimpToPdfRotation(jimpDeg) {
  return (360 - (jimpDeg || 0)) % 360;
}

async function terminate() {
  if (workerPromise) {
    const worker = await workerPromise;
    await worker.terminate();
    workerPromise = null;
  }
  if (server) {
    server.close();
    server = null;
    langBase = null;
  }
}

module.exports = { ocrImage, rotateBuffer, jimpToPdfRotation, terminate };
