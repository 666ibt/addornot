'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { fillDocx, documentText, readDocumentXml } = require('../src/main/docx');

const tpl = path.join(__dirname, '..', 'templates', 'segnum-dogovor.docx');
const buffer = fs.readFileSync(tpl);

function paraCount(xml) { return (xml.match(/<w:p[ >]/g) || []).length; }

test('fills values that Word split across many runs', () => {
  const out = fillDocx(buffer, [
    { from: 'SGN-225/26', to: 'SGN-999/26' },          // split as SGN-,2,2,5,/2,6
    { from: 'SANOAT ENERGETIKA GURUHI', to: 'TEST CO' },
    { from: '37 290 000,00', to: '1 234 567,00' },      // the total (appears 3×)
    { from: 'Смирнов Т.В.', to: 'Петров П.П.' },
  ]);
  const text = documentText(readDocumentXml(out));
  for (const s of ['SGN-999/26', 'TEST CO', '1 234 567,00', 'Петров П.П.']) {
    assert.ok(text.includes(s), `expected ${s}`);
  }
  assert.ok(!text.includes('SGN-225/26'), 'old number replaced');
  assert.ok(!text.includes('SANOAT ENERGETIKA GURUHI'), 'old name replaced');
});

test('toggles the акциз clause without touching other text', () => {
  const out = fillDocx(buffer, [
    { from: 'акциз солиғи билан кўрсатилган', to: 'акциз солиғисиз кўрсатилган' },
  ]);
  const text = documentText(readDocumentXml(out));
  assert.ok(text.includes('акциз солиғисиз кўрсатилган'));
  assert.ok(!text.includes('акциз солиғи билан кўрсатилган'));
});

test('preserves document structure (paragraph count) and is a valid docx', () => {
  const out = fillDocx(buffer, [{ from: 'Бензин АИ-100-К5', to: 'Дизель Л-0.2-62' }]);
  assert.equal(paraCount(readDocumentXml(out)), paraCount(readDocumentXml(buffer)));
  assert.ok(out.length > 1000, 'produced a non-trivial file');
});

test('strict mode throws when template text is missing (drift guard)', () => {
  assert.throws(() => fillDocx(buffer, [{ from: 'НЕТ ТАКОГО ТЕКСТА', to: 'x' }], { strict: true }));
});
