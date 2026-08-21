'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PRESETS, presetOpts, keepSmaller, savingsPercent } = require('../src/main/compress');

test('presetOpts returns the named preset', () => {
  assert.equal(presetOpts('strong').quality, 70);
  assert.equal(presetOpts('lossless').mode, 'lossless');
});

test('presetOpts falls back to high for unknown names', () => {
  assert.deepEqual(presetOpts('nope'), PRESETS.high);
});

test('image presets carry dpi + quality; lossless does not re-encode', () => {
  assert.equal(PRESETS.high.mode, 'image');
  assert.equal(PRESETS.medium.mode, 'image');
  assert.equal(PRESETS.lossless.mode, 'lossless');
  assert.equal(PRESETS.lossless.dpi, undefined);
});

test('keepSmaller never grows a file', () => {
  assert.equal(keepSmaller(1000, 400), 'compressed');
  assert.equal(keepSmaller(1000, 1000), 'original'); // equal → keep original
  assert.equal(keepSmaller(1000, 1200), 'original');
});

test('savingsPercent', () => {
  assert.equal(savingsPercent(1000, 250), 75);
  assert.equal(savingsPercent(1000, 1000), 0);
  assert.equal(savingsPercent(1000, 1500), 0); // clamped, never negative
  assert.equal(savingsPercent(0, 0), 0);       // no divide-by-zero
});
