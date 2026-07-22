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

/**
 * How many OCR workers to run in parallel — chosen adaptively so the app is
 * fast on strong machines yet leaves the computer usable for other work.
 *
 * Each worker pins one CPU core at ~100% during a page and needs ~0.6 GB RAM
 * (rus+eng LSTM). We therefore bound the count by BOTH the CPU and the RAM, and
 * deliberately leave headroom instead of grabbing every core:
 *   • 1–2 cores  → 1 worker
 *   • 3–4 cores  → cores − 2  (a quad-core keeps 2 cores free)
 *   • 5+ cores   → ~60% of cores, and always keep ≥3 cores free
 * The result is capped at 8 (diminishing returns past that) and by available
 * RAM (~0.7 GB per worker, ~1 GB reserved for the OS and the app itself).
 *
 * Examples: 2c→1, 4c→2, 6c→3, 8c→4, 12c→7, 16c→8. On a 12-core machine that is
 * 7 workers busy and 5 cores free, so the user can keep working meanwhile.
 */
function workerCount() {
  const cores = (os.cpus() && os.cpus().length) || 2;

  let byCores;
  if (cores <= 2) byCores = 1;
  else if (cores <= 4) byCores = cores - 2;
  else byCores = Math.min(Math.floor(cores * 0.6), cores - 3);

  const gb = (os.totalmem() || 0) / 1e9;
  const byMem = Math.max(1, Math.floor((gb - 1) / 0.7));

  return Math.max(1, Math.min(byCores, byMem, 8));
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

// Width (px) of the small copy used only to GUESS orientation. The pages are
// OCR'd for real at full resolution afterwards, so this just has to be legible
// enough to tell which way up the text reads — small = fast (measured ~2-3x
// cheaper per pass than full scale).
const PROBE_WIDTH = 1200;

/** A down-scaled copy of a PNG buffer, capped at PROBE_WIDTH wide. */
async function downscaleForProbe(buffer) {
  const img = await Jimp.read(buffer);
  if (img.bitmap.width > PROBE_WIDTH) img.resize(PROBE_WIDTH, Jimp.AUTO);
  return img.getBufferAsync(Jimp.MIME_PNG);
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
 * The win is in doing as FEW full-resolution passes as possible. Quality is
 * never traded away: the text we return is always produced at full scale.
 *
 *   1. Try the LAST known-good orientation first, at full resolution. Scans
 *      arrive in batches that share one orientation, so once we've learned it,
 *      every following page reads in a single pass — this is what makes a batch
 *      of rotated scans fast. Starts at 0° (upright), which also serves the
 *      common upright case and both form shapes (landscape ТТН, portrait FNPZ
 *      "Накладная на отпуск материалов").
 *
 *   2. Accept that pass ONLY if it actually extracted a field (накладная or
 *      договор). Extraction is the ground truth that the page is the right way
 *      up — high OCR "confidence" is not: a sideways page can still read
 *      confidently, and trusting it would save garbage AND poison the memory
 *      for the rest of the batch.
 *
 *   3. Orientation unknown → don't brute-force full-resolution OCR at every
 *      angle. First PROBE the plausible angles on a small (down-scaled) copy —
 *      2-3x cheaper per pass — to guess the orientation, then do ONE full-res
 *      pass at the winning angle. If that reads a field we're done. Only if the
 *      probe's pick fails do we fall back to the exhaustive full-res sweep, so
 *      genuinely hard pages are never worse off than before.
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

  // Candidate angles still plausible for this page shape (minus the one tried).
  const { width, height } = await imageSize(imageBuffer);
  const candidates = [...new Set(width >= height ? [0, 180] : [0, 90, 270])]
    .filter((deg) => deg !== lastGoodRotation);

  // 2) Cheap low-res probe to rank the candidate orientations.
  const small = await downscaleForProbe(imageBuffer);
  const probes = await Promise.all(candidates.map((deg) => recognizeScored(scheduler, small, deg)));
  probes.sort((a, b) => b.score - a.score);

  // 3) Confirm the probe's best guess with a single full-resolution pass.
  const results = [first];
  if (probes.length) {
    const top = await recognizeScored(scheduler, imageBuffer, probes[0].rotation);
    results.push(top);
    if (top.fields >= 1) {
      lastGoodRotation = top.rotation;
      return { text: top.text, confidence: top.confidence, rotation: top.rotation };
    }
  }

  // 4) Probe's pick didn't read → fall back to the exhaustive full-res sweep of
  //    the remaining angles (unchanged robustness for hard/rotated pages).
  const remaining = probes.slice(1).map((p) => p.rotation);
  const swept = await Promise.all(remaining.map((deg) => recognizeScored(scheduler, imageBuffer, deg)));
  results.push(...swept);

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
