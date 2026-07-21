'use strict';

const fs = require('fs/promises');
const path = require('path');
const { PDFDocument, degrees } = require('pdf-lib');

/**
 * PDF helpers:
 *   - renderPagesToImages: rasterize each page to a PNG buffer (for OCR / AI).
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

/**
 * Rasterize every page of a PDF to a PNG buffer.
 * @param {string} filePath
 * @param {number} scale  render scale (higher = better OCR, bigger buffers)
 * @returns {Promise<Buffer[]>}
 */
async function renderPagesToImages(filePath, scale = 3.2) {
  const mupdf = await getMupdf();
  const bytes = await fs.readFile(filePath);
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  const count = doc.countPages();
  const images = [];
  const matrix = mupdf.Matrix.scale(scale, scale);
  for (let i = 0; i < count; i++) {
    const page = doc.loadPage(i);
    const pix = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
    images.push(Buffer.from(pix.asPNG()));
    pix.destroy?.();
    page.destroy?.();
  }
  doc.destroy?.();
  return images;
}

/**
 * Rasterize a single page to a PNG buffer (used for the on-demand zoom view).
 * @param {string} filePath
 * @param {number} pageIndex  0-based
 * @param {number} scale
 * @returns {Promise<Buffer>}
 */
async function renderSinglePage(filePath, pageIndex, scale = 3.2) {
  const mupdf = await getMupdf();
  const bytes = await fs.readFile(filePath);
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  const page = doc.loadPage(pageIndex);
  const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
  const png = Buffer.from(pix.asPNG());
  pix.destroy?.();
  page.destroy?.();
  doc.destroy?.();
  return png;
}

/** Number of pages in a PDF. */
async function pageCount(filePath) {
  const bytes = await fs.readFile(filePath);
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  return doc.getPageCount();
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

async function embedImage(doc, imagePath) {
  const bytes = await fs.readFile(imagePath);
  const ext = path.extname(imagePath).toLowerCase();
  if (ext === '.png') return doc.embedPng(bytes);
  // .jpg/.jpeg (pdf-lib embeds baseline JPEG)
  return doc.embedJpg(bytes);
}

function addImagePage(doc, img) {
  const page = doc.addPage([img.width, img.height]);
  page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
}

/** Write one image as a single-page PDF. */
async function imageToPdf(imagePath, outPath) {
  const doc = await PDFDocument.create();
  addImagePage(doc, await embedImage(doc, imagePath));
  const bytes = await doc.save();
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, bytes);
  return outPath;
}

/** Combine several images into one multi-page PDF (one image per page). */
async function imagesToPdf(imagePaths, outPath) {
  const doc = await PDFDocument.create();
  for (const p of imagePaths) addImagePage(doc, await embedImage(doc, p));
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
  renderPagesToImages, renderSinglePage, pageCount, splitPage,
  imageToPdf, imagesToPdf, mergePages,
};
