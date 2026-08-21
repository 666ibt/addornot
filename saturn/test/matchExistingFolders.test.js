'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeOmoglyphs, isAzs, numericCore, matchWaybills,
} = require('../src/main/matchExistingFolders');

// Helper: folders as {name, path} (path is irrelevant to the pure logic).
const F = (name) => ({ name, path: `/dest/${name}` });

// --- numericCore -----------------------------------------------------------
test('numericCore takes the first \\d+-\\d+ pair, ignoring letters', () => {
  assert.equal(numericCore('ST-425-25-K'), '425-25');
  assert.equal(numericCore('290-25-TASCO'), '290-25');
  assert.equal(numericCore('532-21'), '532-21');
  assert.equal(numericCore('09-22'), '09-22');
  assert.equal(numericCore('34-24-АЗС'), '34-24');
});

test('numericCore pulls the code out of a full hand-typed folder name', () => {
  assert.equal(numericCore('425. Договор № ST-425-25-K от 25.07.2025 E-OIL'), '425-25');
  assert.equal(numericCore('09. Договор № — ST-09-22-K от 08.06.2022 KOMP BREND OIL'), '09-22');
  assert.equal(numericCore('34. Договор № 34-24-АЗС от 23.02.2024 ENERGY OIL GROUP'), '34-24');
  assert.equal(numericCore('532. Договор № 532-21 от ...'), '532-21');
});

test('numericCore keeps leading zeros (09-22 ≠ 9-22)', () => {
  assert.equal(numericCore('09-22'), '09-22');
  assert.notEqual(numericCore('09-22'), numericCore('9-22'));
});

test('numericCore is null when there is no numeric pair', () => {
  assert.equal(numericCore('Перемещение'), null);
});

// --- omoglyphs / АЗС -------------------------------------------------------
test('omoglyph normalization folds Cyrillic look-alikes', () => {
  assert.equal(normalizeOmoglyphs('СТ-425-25-K'), 'CT-425-25-K'); // С,Т → C,T
});

test('Cyrillic "СТ" contract equals Latin "ST" after normalization (same core)', () => {
  assert.equal(numericCore('СТ-425-25-K'), numericCore('ST-425-25-K'));
});

test('isAzs detects the АЗС category', () => {
  assert.equal(isAzs('34-24-АЗС'), true);
  assert.equal(isAzs('ST-425-25-K'), false);
  assert.equal(isAzs('290-25-TASCO'), false);
});

// --- matchWaybills ---------------------------------------------------------
test('exact numeric core: "09-22" matches "09…" not "109…"/"209…"', () => {
  const folders = [
    F('09. Договор № — ST-09-22-K от 08.06.2022 KOMP BREND OIL'),
    F('109. Договор № — ST-109-22-K от 03.08.2022 EMPIRE OIL'),
    F('209. Договор № — ST-209-22-K от 28.09.2022 ENERGY OIL GROUP'),
  ];
  const { matched, notFound } = matchWaybills([{ fileName: '1004_09-22.pdf', dogovor: '09-22' }], folders);
  assert.equal(notFound.length, 0);
  assert.equal(matched.length, 1);
  assert.match(matched[0].folder.name, /^09\./);
});

test('АЗС waybill matches the АЗС folder by core "34-24"', () => {
  const folders = [F('34. Договор № 34-24-АЗС от 23.02.2024 ENERGY OIL GROUP')];
  const { matched } = matchWaybills([{ fileName: '5855-1_34-24-АЗС.pdf', dogovor: '34-24-АЗС' }], folders);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].core, '34-24');
});

test('АЗС waybill does NOT fall into an ordinary same-core folder', () => {
  const folders = [F('8. Договор № ST-8-24-K от ... OIL')];
  const { matched, notFound } = matchWaybills([{ fileName: 'x_8-24-АЗС.pdf', dogovor: '8-24-АЗС' }], folders);
  assert.equal(matched.length, 0);
  assert.equal(notFound.length, 1);
  // …but the ordinary folder is surfaced as a "similar" hint (wrong category)
  assert.deepEqual(notFound[0].similar, ['8. Договор № ST-8-24-K от ... OIL']);
});

test('ordinary waybill does NOT fall into an АЗС folder of the same core', () => {
  const folders = [F('8. Договор № 8-24-АЗС от ...')];
  const { matched, notFound } = matchWaybills([{ fileName: 'y_ST-8-24-K.pdf', dogovor: 'ST-8-24-K' }], folders);
  assert.equal(matched.length, 0);
  assert.equal(notFound.length, 1);
});

test('full ST format on both sides → OK', () => {
  const folders = [F('425. Договор № ST-425-25-K от 25.07.2025 E-OIL')];
  const { matched } = matchWaybills([{ fileName: '80112285_ST-425-25-K.pdf', dogovor: 'ST-425-25-K' }], folders);
  assert.equal(matched.length, 1);
});

test('bare numeric contract "532-21" matches bare folder', () => {
  const folders = [F('532. Договор № 532-21 от ...')];
  const { matched } = matchWaybills([{ fileName: '10_532-21.pdf', dogovor: '532-21' }], folders);
  assert.equal(matched.length, 1);
});

test('Cyrillic-typed contract matches the Latin-named folder', () => {
  const folders = [F('425. Договор № ST-425-25-K от 25.07.2025 E-OIL')];
  const { matched } = matchWaybills([{ fileName: 'z_СТ-425-25-K.pdf', dogovor: 'СТ-425-25-K' }], folders);
  assert.equal(matched.length, 1);
});

test('two folders with the same core in the same category → AMBIGUOUS', () => {
  const folders = [
    F('425. Договор № ST-425-25-K от 25.07.2025 E-OIL'),
    F('425b. Договор № ST-425-25-K (дубль) OIL2'),
  ];
  const { matched, ambiguous } = matchWaybills([{ fileName: 'a_ST-425-25-K.pdf', dogovor: 'ST-425-25-K' }], folders);
  assert.equal(matched.length, 0);
  assert.equal(ambiguous.length, 1);
  assert.equal(ambiguous[0].candidates.length, 2);
});

test('no folder with the core → NOT FOUND, similar empty', () => {
  const folders = [F('999. Договор № ST-999-25-K ...')];
  const { notFound } = matchWaybills([{ fileName: 'b_ST-425-25-K.pdf', dogovor: 'ST-425-25-K' }], folders);
  assert.equal(notFound.length, 1);
  assert.deepEqual(notFound[0].similar, []);
});
