'use strict';

/**
 * Pure helpers for the "Сжатие PDF" tool — compression presets and the tiny
 * size-decision math. No I/O, no native deps, so it is unit-testable on its own
 * (see test/compress.test.js). The heavy lifting (rendering pages, re-encoding
 * images, rebuilding the PDF) lives in pdf.js.
 *
 * Two families of presets:
 *   - lossless: only re-save the PDF (deflate streams, object streams, drop
 *     unused objects). Pixels and text are untouched → identical quality, but
 *     the win is modest, especially on already-optimized scans.
 *   - image:   re-encode the page images at a capped DPI + JPEG quality. This
 *     is where big savings come from on scanned documents. Visually near-
 *     lossless at the higher presets; the page's physical size is preserved.
 */

const PRESETS = {
  lossless: { mode: 'lossless', label: 'Без потерь' },
  high:     { mode: 'image', dpi: 200, quality: 85, maxEdge: 2600, label: 'Высокое качество' },
  medium:   { mode: 'image', dpi: 150, quality: 78, maxEdge: 2200, label: 'Среднее' },
  strong:   { mode: 'image', dpi: 120, quality: 70, maxEdge: 1800, label: 'Сильное' },
};

/** Options for a preset name, defaulting to the recommended "high" preset. */
function presetOpts(name) {
  return PRESETS[name] || PRESETS.high;
}

/**
 * Which file to keep so the output is never larger than the input.
 * @returns {'compressed'|'original'}
 */
function keepSmaller(origLen, newLen) {
  return newLen < origLen ? 'compressed' : 'original';
}

/** Percent saved (0..100), clamped at 0 so a no-gain file reads as 0%. */
function savingsPercent(origLen, newLen) {
  if (!origLen) return 0;
  return Math.max(0, Math.round((1 - newLen / origLen) * 100));
}

module.exports = { PRESETS, presetOpts, keepSmaller, savingsPercent };
