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
  renderPagesToImages, renderSinglePage, pageCount, splitPage,
  imageToPdf, imagesToPdf, mergePages,
};
