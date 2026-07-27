'use strict';

const fs = require('fs/promises');
const path = require('path');
const { PDFDocument, degrees } = require('pdf-lib');

/**
 * PDF helpers:
 *   - renderSinglePage: rasterize one page to a PNG buffer (for OCR / AI / zoom).
 *     Uses mupdf (WebAssembly) so there are NO native/system dependencies —
 *     the app installs and runs the same on Windows, macOS and Linux.
 *   - splitPage: copy a single page from the source PDF into a new one-page PDF
 *     (keeps the original quality/vectors — we do NOT save the rasterized image).
 */

let mupdfPromise = null;
function getMupdf() {
  // mupdf is ESM-only with top-level await; import dynamically from CommonJS.
  if (!mupdfPromise) mupdfPromise = import('mupdf');
  return mupdfPromise;
}

// Opened-document cache. Rendering used to read AND re-parse the whole PDF for
// every single page — catastrophic for large multi-page files (a 100-page,
// 80 MB scan meant ~8 GB of repeated reads/parses, which lagged the UI and
// starved the OCR workers of memory until one crashed). We now read+parse each
// file ONCE and reuse the open document. Bounded LRU keeps memory in check; the
// max is kept above the number of pages rendered concurrently (workerCount ≤ 5)
// so a document still in use is never evicted mid-render.
const DOC_CACHE_MAX = 6;
const docCache = new Map(); // filePath -> Promise<mupdf document>

function openDoc(filePath) {
  const existing = docCache.get(filePath);
  if (existing) { // LRU touch
    docCache.delete(filePath);
    docCache.set(filePath, existing);
    return existing;
  }
  const p = (async () => {
    const mupdf = await getMupdf();
    const bytes = await fs.readFile(filePath);
    return mupdf.Document.openDocument(bytes, 'application/pdf');
  })();
  docCache.set(filePath, p);
  while (docCache.size > DOC_CACHE_MAX) {
    const oldest = docCache.keys().next().value; // least-recently used
    const oldP = docCache.get(oldest);
    docCache.delete(oldest);
    Promise.resolve(oldP).then((d) => { try { d.destroy?.(); } catch (_) { /* ignore */ } });
  }
  return p;
}

/** Drop and free every cached document (called when a job ends). */
function clearDocCache() {
  for (const p of docCache.values()) {
    Promise.resolve(p).then((d) => { try { d.destroy?.(); } catch (_) { /* ignore */ } });
  }
  docCache.clear();
}

/**
 * Rasterize a single page to a PNG buffer, reusing the file's cached document.
 * The render block itself is synchronous (no await between loadPage and asPNG),
 * so concurrent calls sharing one document can't interleave and corrupt it.
 * @param {string} filePath
 * @param {number} pageIndex  0-based
 * @param {number} scale
 * @returns {Promise<Buffer>}
 */
async function renderSinglePage(filePath, pageIndex, scale = 3.2) {
  const mupdf = await getMupdf();
  const doc = await openDoc(filePath);
  const page = doc.loadPage(pageIndex);
  const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
  const png = Buffer.from(pix.asPNG());
  pix.destroy?.();
  page.destroy?.();
  return png; // NB: the document is cached/reused — do NOT destroy it here
}

/** Number of pages in a PDF (via the cached mupdf document). */
async function pageCount(filePath) {
  const doc = await openDoc(filePath);
  return doc.countPages();
}

/**
 * Write a single page of `filePath` to `outPath` as a standalone PDF.
 * @param {string} filePath   source PDF
 * @param {number} pageIndex  0-based page index
 * @param {string} outPath    destination file path
 */
async function splitPage(filePath, pageIndex, outPath, rotation = 0) {
  const bytes = await fs.readFile(filePath);
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const [copied] = await out.copyPages(src, [pageIndex]);
  if (rotation) {
    // Add the correction on top of any existing page rotation, so the saved
    // file opens upright.
    const current = copied.getRotation().angle || 0;
    copied.setRotation(degrees((current + rotation) % 360));
  }
  out.addPage(copied);
  const outBytes = await out.save();
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, outBytes);
  return outPath;
}

// ---------------------------------------------------------------------------
// Image -> PDF
// ---------------------------------------------------------------------------

/**
 * Decode an image file into raw PNG buffers that pdf-lib can embed.
 * PNG and (baseline) JPEG are returned untouched — pdf-lib embeds them
 * directly, preserving quality. TIFF is not embeddable by pdf-lib, so it is
 * decoded to PNG. A TIFF may hold several pages (typical for scanned
 * documents), so EVERY page is returned, in order.
 *
 * @returns {Promise<{fmt: 'png'|'jpg', bytes: Buffer}[]>} one entry per page
 */
async function imageToPngBuffers(imagePath) {
  const bytes = await fs.readFile(imagePath);
  const ext = path.extname(imagePath).toLowerCase();

  if (ext === '.png') return [{ fmt: 'png', bytes }];
  if (ext === '.jpg' || ext === '.jpeg') return [{ fmt: 'jpg', bytes }];

  if (ext === '.tif' || ext === '.tiff') {
    const UTIF = require('utif2');
    const Jimp = require('jimp');
    const ifds = UTIF.decode(bytes);       // one IFD per page
    if (!ifds.length) throw new Error('TIFF не содержит страниц.');
    const pages = [];
    for (const ifd of ifds) {
      UTIF.decodeImage(bytes, ifd);        // fills ifd with pixel data
      const rgba = UTIF.toRGBA8(ifd);      // Uint8Array, width*height*4
      const img = await new Promise((resolve, reject) =>
        new Jimp(ifd.width, ifd.height, (err, image) => (err ? reject(err) : resolve(image))));
      img.bitmap.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
      pages.push({ fmt: 'png', bytes: await img.getBufferAsync(Jimp.MIME_PNG) });
    }
    return pages;
  }

  // Unknown extension: let Jimp try (bmp/gif…), fall back to PNG.
  const Jimp = require('jimp');
  const img = await Jimp.read(bytes);
  return [{ fmt: 'png', bytes: await img.getBufferAsync(Jimp.MIME_PNG) }];
}

/** Embed one image file's page(s) into `doc`, one PDF page per image page. */
async function addImageFilePages(doc, imagePath) {
  const pages = await imageToPngBuffers(imagePath);
  for (const { fmt, bytes } of pages) {
    const img = fmt === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    const page = doc.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }
}

/** Write one image as a PDF (a multi-page TIFF yields a multi-page PDF). */
async function imageToPdf(imagePath, outPath) {
  const doc = await PDFDocument.create();
  await addImageFilePages(doc, imagePath);
  const bytes = await doc.save();
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, bytes);
  return outPath;
}

/** Combine several images into one PDF (one page per image, TIFF pages kept). */
async function imagesToPdf(imagePaths, outPath) {
  const doc = await PDFDocument.create();
  for (const p of imagePaths) await addImageFilePages(doc, p);
  const bytes = await doc.save();
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, bytes);
  return outPath;
}

/**
 * Merge an ordered list of pages (each from any source PDF) into one file.
 * @param {{filePath: string, pageIndex: number}[]} pages  in output order
 * @param {string} outPath
 */
async function mergePages(pages, outPath) {
  const out = await PDFDocument.create();
  const cache = new Map(); // filePath -> loaded PDFDocument (each source read once)
  for (const { filePath, pageIndex } of pages) {
    let src = cache.get(filePath);
    if (!src) {
      const bytes = await fs.readFile(filePath);
      src = await PDFDocument.load(bytes, { ignoreEncryption: true });
      cache.set(filePath, src);
    }
    const [copied] = await out.copyPages(src, [pageIndex]);
    out.addPage(copied);
  }
  const outBytes = await out.save();
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, outBytes);
  return outPath;
}

module.exports = {
  renderSinglePage, pageCount, splitPage,
  imageToPdf, imagesToPdf, mergePages, clearDocCache,
};
