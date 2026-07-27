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

test('SGN mangled to Cyrillic (5С№-211/26-Р -> SGN-211/26-P)', () => {
  assert.equal(extractDogovor('Основание 5С№-211/26-Р от 25.06.2026').value, 'SGN-211/26-P');
});

test('SGN Cyrillic suffix normalized to Latin', () => {
  assert.equal(extractDogovor('SGN-59/26-Р').value, 'SGN-59/26-P');
});

test('SGN with mangled slash yields empty, not a wrong split', () => {
  // "/" OCR'd as "7" ("SGN-211726-P"): better no result than a wrong 21/72.
  assert.equal(extractDogovor('SGN-211726-P').matched, false);
});

// --- TASCO / АЗС-С contracts (ТТН «Контракт» line) -------------------------
test('TASCO contract from Контракт line', () => {
  assert.equal(
    extractDogovor('Контракт Договор №73/26-TASCO от 11.03.2026').value, '73/26-TASCO');
  const r = extractDogovor('Договор №116/26-TASCO от 06.04.2026');
  assert.equal(r.value, '116/26-TASCO');
  assert.equal(r.kind, 'tasco');
  // OCR often mangles "TASCO" into Cyrillic look-alikes ("ТАЗСО")
  assert.equal(extractDogovor('Договор №56/26-ТАЗСО от 03.03.2026').value, '56/26-TASCO');
});

test('АЗС-С contract from Контракт line (с доставкой)', () => {
  const r = extractDogovor('Договор №15/26-АЗС-С от 03.04.2026 С Доставкой');
  assert.equal(r.value, '15/26-АЗС-С');
  assert.equal(r.kind, 'azs');
});

test('АЗС contract without «-С» suffix (самовывоз)', () => {
  const r = extractDogovor('Контракт Договор №8/26-АЗС от 28.01.2026');
  assert.equal(r.value, '8/26-АЗС');
  assert.equal(r.kind, 'azs');
  // and OCR "Ne" for №
  assert.equal(extractDogovor('Договор Ne8/26-A3C от 28.01.2026').value, '8/26-АЗС');
});

test('AZT contract (prefix-first) from Контракт line', () => {
  const r = extractDogovor('Контракт № AZT-2/26 от 03.03.2026');
  assert.equal(r.value, 'AZT-2/26');
  assert.equal(r.kind, 'azt');
  // Cyrillic-mangled letters
  assert.equal(extractDogovor('№ АЗT-14/26 от 01.01.2026').value, 'AZT-14/26');
  // must not swallow the "AZT FOODS" shipper name (no -number after)
  assert.equal(extractDogovor('Грузоотправитель ООО "AZT FOODS"').matched, false);
});

test('does not grab the Основание «№…-ПР» framework contract', () => {
  const text = 'Контракт: Договор №73/26-TASCO от 11.03.2026\n'
    + 'Основание: Согласно договору №109-ПР от 10.03.2022 года (собственный)';
  assert.equal(extractDogovor(text).value, '73/26-TASCO');
});

test('TASCO / АЗС-С -> filename form', () => {
  assert.equal(makeFilename({ nakladnaya: '661', dogovor: '73/26-TASCO' }),
    '661_73-26-TASCO.pdf');
  assert.equal(makeFilename({ nakladnaya: '657', dogovor: '15/26-АЗС-С' }),
    '657_15-26-АЗС-С.pdf');
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

test('накладная when № is OCR-read as "Ne"', () => {
  assert.equal(
    extractNakladnaya('ТОВАРНО-ТРАНСПОРТНАЯ НАКЛАДНАЯ Ne 1140 Типовая форма').value, '1140');
});

// --- letter suffix on the invoice number ("№ 1125 тч", "№ 1431 ч") ----------
test('накладная keeps "тч" suffix', () => {
  assert.equal(
    extractNakladnaya('ТОВАРНО-ТРАНСПОРТНАЯ НАКЛАДНАЯ № 1125 тч').value, '1125тч');
});

test('накладная keeps "ч" suffix', () => {
  assert.equal(extractNakladnaya('НАКЛАДНАЯ № 1431 ч').value, '1431ч');
});

test('накладная "ч" suffix OCR-read as Latin "y"', () => {
  // real scan: the lone «ч» came out of Tesseract as "y"
  assert.equal(extractNakladnaya('ТОВАРНО-ТРАНСПОРТНАЯ НАКЛАДНАЯ № 1431 y |').value, '1431ч');
});

test('накладная without suffix stays a plain number', () => {
  assert.equal(extractNakladnaya('НАКЛАДНАЯ № 657').value, '657');
});

test('two-letter border noise ("№ 656 ЧЩ") is not taken as a suffix', () => {
  assert.equal(extractNakladnaya('ТОВАРНО-ТРАНСПОРТНАЯ НАКЛАДНАЯ № 656 ЧЩ').value, '656');
});

test('OCR-split invoice number ("№ 31 68") is rejoined to 3168', () => {
  // real scan (31_NA / merged3mixedrotation стр.140): «НАКЛАДНАЯ № 3168»
  // came out of Tesseract as "№ 31 68"; the two groups belong to one number.
  assert.equal(
    extractNakladnaya('ТОВАРНО-ТРАНСПОРТНАЯ НАКЛАДНАЯ № 31 68').value, '3168');
});

test('OCR-split invoice number keeps a following "ч" suffix', () => {
  assert.equal(extractNakladnaya('НАКЛАДНАЯ № 31 68 ч').value, '3168ч');
});

test('a date after the invoice number is NOT merged into it', () => {
  // «№ 3168 08.09.2025» — the date must not become part of the number.
  assert.equal(
    extractNakladnaya('ТОВАРНО-ТРАНСПОРТНАЯ НАКЛАДНАЯ № 3168 08.09.2025').value, '3168');
});

test('slash sub-index "779/2" → dash with the index decremented (779-1)', () => {
  assert.equal(extractNakladnaya('ТОВАРНО-ТРАНСПОРТНАЯ НАКЛАДНАЯ № 779/2').value, '779-1');
  assert.equal(extractNakladnaya('НАКЛАДНАЯ № 779/3').value, '779-2');
  assert.equal(extractNakladnaya('НАКЛАДНАЯ № 779 / 2').value, '779-1'); // OCR spaces
});

test('slash sub-index "/1" becomes -0', () => {
  assert.equal(extractNakladnaya('НАКЛАДНАЯ № 779/1').value, '779-0');
});

test('plain invoice number (no slash) is unaffected', () => {
  assert.equal(extractNakladnaya('НАКЛАДНАЯ № 779').value, '779');
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

test('ST contract when № is OCR-glued as "NeST"', () => {
  // real scan: «Договор №ST-539/25-K» came out as "NeST-539/25-K"
  assert.equal(extractDogovor('Контракт Договор NeST-539/25-K от 26.09.2025').value,
    'ST-539/25-K');
});

test('ST contract when "ST" prefix is OCR-read as digits "57"', () => {
  // real scan (1999_NA): «Договор №ST-306/25-К» came out as "№57-306/25-К"
  assert.equal(extractDogovor('Коетрант Договор №57-306/25-К от 26.05.2025').value,
    'ST-306/25-K');
});

test('ST contract when "ST" prefix is OCR-read as digits "51"', () => {
  // real scan (2782_NA): «Договор №ST-437/25-К» came out as "№51-437/25-К"
  assert.equal(extractDogovor('Контракт - Договор №51-437/25-К-от 31:07.2025').value,
    'ST-437/25-K');
});

test('ST Cyrillic «К» suffix is Latinized to K', () => {
  assert.equal(extractDogovor('Договор NeST-163/25-К').value, 'ST-163/25-K');
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
