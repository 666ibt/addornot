'use strict';

/**
 * Minimal EXIF orientation reader for JPEG buffers, plus the mapping from an
 * EXIF Orientation value (1–8) to the transform that makes the image upright.
 *
 * Why this exists: phone cameras store the photo in the sensor's native
 * orientation and record how it should be displayed in the EXIF "Orientation"
 * tag (0x0112). pdf-lib embeds JPEG pixels as-is and PDF has no orientation
 * concept, so without this a sideways-shot photo lands sideways in the PDF.
 *
 * No dependencies, no I/O — unit-testable on its own (see test/exif.test.js).
 */

/**
 * Read the EXIF Orientation tag from a JPEG buffer.
 * @param {Buffer} buf
 * @returns {number} 1–8, or 1 (normal) when absent/unreadable.
 */
function readJpegOrientation(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return 1; // not a JPEG

  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xFF) { off += 1; continue; } // resync to next marker
    const marker = buf[off + 1];
    if (marker === 0xD9 || marker === 0xDA) break;  // EOI or start of scan — no more headers
    const size = buf.readUInt16BE(off + 2);
    if (size < 2) break;
    if (marker === 0xE1) { // APP1 — may hold the "Exif\0\0" TIFF block
      const start = off + 4;
      if (start + 6 <= buf.length && buf.toString('ascii', start, start + 4) === 'Exif') {
        return parseExifOrientation(buf, start + 6); // skip "Exif\0\0"
      }
    }
    off += 2 + size;
  }
  return 1;
}

/** Parse the Orientation tag out of a TIFF block starting at `tiffStart`. */
function parseExifOrientation(buf, tiffStart) {
  if (tiffStart + 8 > buf.length) return 1;
  const bo = buf.toString('ascii', tiffStart, tiffStart + 2);
  const le = bo === 'II';
  if (!le && bo !== 'MM') return 1;
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));

  if (u16(tiffStart + 2) !== 0x002A) return 1;
  const ifd0 = tiffStart + u32(tiffStart + 4);
  if (ifd0 + 2 > buf.length) return 1;

  const count = u16(ifd0);
  for (let i = 0; i < count; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > buf.length) break;
    if (u16(entry) === 0x0112) { // Orientation
      const val = u16(entry + 8); // SHORT value sits in the first 2 bytes of the value field
      return val >= 1 && val <= 8 ? val : 1;
    }
  }
  return 1;
}

/**
 * Decompose an EXIF orientation into a horizontal mirror plus a clockwise
 * rotation: orientation = rotateCW( flipH? pixels ). The four "mirror"
 * orientations (2,4,5,7) need a real pixel flip; the rest are pure rotations we
 * can apply as a PDF page rotation with no re-encode.
 *
 * @param {number} o  EXIF orientation 1–8
 * @returns {{rotate:number, flipH:boolean, changed:boolean}}
 */
function orientationPlan(o) {
  const rotate = { 1: 0, 2: 0, 3: 180, 4: 180, 5: 90, 6: 90, 7: 270, 8: 270 }[o] || 0;
  const flipH = o === 2 || o === 4 || o === 5 || o === 7;
  return { rotate, flipH, changed: rotate !== 0 || flipH };
}

module.exports = { readJpegOrientation, orientationPlan };
