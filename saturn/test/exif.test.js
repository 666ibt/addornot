'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { readJpegOrientation, orientationPlan } = require('../src/main/exif');

// Build a minimal JPEG (SOI + APP1/Exif with one Orientation entry + EOI),
// little-endian TIFF, so we can drive readJpegOrientation without real photos.
function jpegWithOrientation(o) {
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'ascii');       // little-endian
  tiff.writeUInt16LE(0x002A, 2);
  tiff.writeUInt32LE(8, 4);           // IFD0 at offset 8
  tiff.writeUInt16LE(1, 8);           // one entry
  tiff.writeUInt16LE(0x0112, 10);     // tag: Orientation
  tiff.writeUInt16LE(3, 12);          // type: SHORT
  tiff.writeUInt32LE(1, 14);          // count
  tiff.writeUInt16LE(o, 18);          // value
  tiff.writeUInt32LE(0, 22);          // no next IFD
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const app1len = exif.length + 2;
  const head = Buffer.from([0xFF, 0xD8, 0xFF, 0xE1, (app1len >> 8) & 0xFF, app1len & 0xFF]);
  return Buffer.concat([head, exif, Buffer.from([0xFF, 0xD9])]);
}

// --- readJpegOrientation ---------------------------------------------------
test('reads each orientation value 1..8', () => {
  for (let o = 1; o <= 8; o++) {
    assert.equal(readJpegOrientation(jpegWithOrientation(o)), o, `orientation ${o}`);
  }
});

test('big-endian (MM) TIFF is read too', () => {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'ascii');
  tiff.writeUInt16BE(0x002A, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(6, 18);
  tiff.writeUInt32BE(0, 22);
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const app1len = exif.length + 2;
  const head = Buffer.from([0xFF, 0xD8, 0xFF, 0xE1, (app1len >> 8) & 0xFF, app1len & 0xFF]);
  assert.equal(readJpegOrientation(Buffer.concat([head, exif, Buffer.from([0xFF, 0xD9])])), 6);
});

test('JPEG without EXIF → 1 (normal)', () => {
  assert.equal(readJpegOrientation(Buffer.from([0xFF, 0xD8, 0xFF, 0xD9])), 1);
});

test('non-JPEG buffer → 1', () => {
  assert.equal(readJpegOrientation(Buffer.from('not a jpeg at all')), 1);
});

test('empty / nullish → 1', () => {
  assert.equal(readJpegOrientation(Buffer.alloc(0)), 1);
  assert.equal(readJpegOrientation(null), 1);
});

// --- orientationPlan -------------------------------------------------------
test('normal orientation makes no change', () => {
  assert.deepEqual(orientationPlan(1), { rotate: 0, flipH: false, changed: false });
});

test('pure rotations do not flip pixels', () => {
  assert.deepEqual(orientationPlan(6), { rotate: 90, flipH: false, changed: true });
  assert.deepEqual(orientationPlan(3), { rotate: 180, flipH: false, changed: true });
  assert.deepEqual(orientationPlan(8), { rotate: 270, flipH: false, changed: true });
});

test('mirrored orientations flip horizontally', () => {
  assert.equal(orientationPlan(2).flipH, true);
  assert.equal(orientationPlan(4).flipH, true);
  assert.equal(orientationPlan(5).flipH, true);
  assert.equal(orientationPlan(7).flipH, true);
});
