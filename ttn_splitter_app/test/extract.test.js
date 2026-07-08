'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  extract,
  extractDogovor,
  extractNakladnaya,
  detectFormat,
  makeFilename,
  contractToFilename,
} = require('../src/main/extract');

// --- договор (contract) ----------------------------------------------------
test('SGN contract with slash', () => {
  assert.equal(extractDogovor('Договор SGN-158/25 от 01.01.2025').value, 'SGN-158/25');
});

test('SGN contract with suffix letter', () => {
  assert.equal(extractDogovor('по договору SGN-59/26-P').value, 'SGN-59/26-P');
});

test('SGN contract with dash separator normalizes to slash', () => {
  assert.equal(extractDogovor('SGN-2-25').value, 'SGN-2/25');
});

test('internal transfer -> Перемещение', () => {
  assert.equal(extractDogovor('Внутреннее перемещение между складами').value, 'Перемещение');
  assert.equal(extractDogovor('перемещение').kind, 'transfer');
});

test('no contract found', () => {
  assert.equal(extractDogovor('никаких номеров тут нет').matched, false);
});

test('OCR-noisy SGN (5GN / letter О)', () => {
  // loose matcher tolerates a mis-read leading char
  assert.equal(extractDogovor('5GN-2/25').value, 'SGN-2/25');
});

// --- накладная (invoice number) -------------------------------------------
test('накладная number after №', () => {
  assert.equal(extractNakladnaya('Товарно-транспортная накладная № 37').value, '37');
});

test('FNPZ: накладная на отпуск материалов', () => {
  assert.equal(extractNakladnaya('Накладная на отпуск материалов № 1024').value, '1024');
});

test('накладная with N instead of №', () => {
  assert.equal(extractNakladnaya('Накладная N 5').value, '5');
});

test('strips leading zeros', () => {
  assert.equal(extractNakladnaya('Накладная № 007').value, '7');
});

// --- FNPZ format: 8-digit накладная + ST contract --------------------------
test('FNPZ: full 8-digit накладная (not truncated to 6)', () => {
  assert.equal(
    extractNakladnaya('Накладная 80130800 на отпуск материалов на сторону').value,
    '80130800');
});

test('FNPZ: another 8-digit накладная', () => {
  assert.equal(
    extractNakladnaya('Feat Накладная 80130790 на отпуск материалов Ha сторону').value,
    '80130790');
});

test('FNPZ: ST contract with -KS suffix', () => {
  assert.equal(extractDogovor('Кому: "Mig impeks" MCHJ\nST-248/26-KS от 29.06.2026').value,
    'ST-248/26-KS');
});

test('FNPZ: ST contract does not grab Доверенность/FNPZ/Segnum', () => {
  const text = 'Основание: "Segnum" MCHJ № Доверенности: SN/25-353\n'
    + 'Склад: Цех № 4 FNPZ-2025-0210\nST-252/26-KS от 02.07.2026';
  assert.equal(extractDogovor(text).value, 'ST-252/26-KS');
});

test('FNPZ: ST contract -> filename form', () => {
  assert.equal(makeFilename({ nakladnaya: '80130800', dogovor: 'ST-248/26-KS' }),
    '80130800_ST-248-26-KS.pdf');
});

// --- format detection ------------------------------------------------------
test('detects TTN form', () => {
  assert.equal(detectFormat('Товарно-транспортная накладная (форма 1-т)'), 'TTN');
});

test('detects FNPZ form', () => {
  assert.equal(detectFormat('Накладная на отпуск материалов, Ферганский НПЗ'), 'FNPZ');
});

// --- filename --------------------------------------------------------------
test('makeFilename builds {накладная}_{договор}.pdf', () => {
  assert.equal(makeFilename({ nakladnaya: '37', dogovor: 'SGN-2/25' }), '37_SGN-2-25.pdf');
});

test('contractToFilename replaces slash', () => {
  assert.equal(contractToFilename('SGN-158/25'), 'SGN-158-25');
});

test('missing fields fall back to NA', () => {
  assert.equal(makeFilename({}), 'NA_NA.pdf');
  assert.equal(makeFilename({ nakladnaya: '9' }), '9_NA.pdf');
});

// --- end-to-end on a realistic OCR blob -----------------------------------
test('full extract: TTN page', () => {
  const text = [
    'Товарно-транспортная накладная № 37',
    'Типовая форма № 1-т',
    'Грузоотправитель: ...',
    'Основание: договор SGN-2/25',
  ].join('\n');
  const r = extract(text);
  assert.equal(r.nakladnaya, '37');
  assert.equal(r.dogovor, 'SGN-2/25');
  assert.equal(r.confidence, 'high');
  assert.equal(r.filename, '37_SGN-2-25.pdf');
});

test('full extract: low confidence when nothing found', () => {
  const r = extract('какой-то нераспознанный текст');
  assert.equal(r.confidence, 'low');
  assert.equal(r.filename, 'NA_NA.pdf');
});
