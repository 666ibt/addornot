'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { generate } = require('../src/main/contract');
const { documentText, readDocumentXml } = require('../src/main/docx');

const TPL = path.join(__dirname, '..', 'templates');
const text = (buf) => documentText(readDocumentXml(buf));

const segnum = {
  company: 'SEGNUM', number: 'SGN-231/26', date: '2026-07-15',
  counterparty: {
    name: 'E-OIL', form: 'МЧЖ', director: 'Иванов И.И.', directorTitle: 'директор',
    directorBasis: 'ustav', address: 'г. Ташкент', bank: 'АКБ ТестБанк',
    account: '1111 2222', mfo: '01234', inn: '305000111', oked: '', vat: '326999', phone: '(90) 111',
  },
  product: 'Дизель Л-0.2-62', qty: 50, pricePerTon: 12000000, akciz: false,
};

const tasco = {
  company: 'SEG TASCO', number: 'ST-260/26-KS', date: '2026-08-03',
  counterparty: {
    name: 'FARGONA GAZ', form: 'МЧЖ', director: 'Каримов К.К.', directorTitle: 'бош директор',
    directorBasis: 'dover', address: 'Фергана', bank: 'Ипотека Банк', account: '9999',
    mfo: '00777', inn: '301222333', oked: '46710', vat: '326111', phone: '(73) 244',
  },
  product: 'Битум БНД 60/90', qty: 100, pricePerTon: 8500000, akciz: true,
};

test('SEGNUM: договор only, no акциз, Uzbek amount, folder layout', () => {
  const r = generate(segnum, TPL);
  assert.equal(r.files.length, 1, 'SEGNUM has no лист согласования');
  assert.equal(r.folder, path.join('SEGNUM', '231. Договор № SGN-231-26 от 15.07.2026 E-OIL'));
  assert.equal(r.files[0].name, 'Договор № SGN-231-26 от 15.07.2026 E-OIL.docx');
  const t = text(r.files[0].buffer);
  for (const s of ['SGN-231/26', '«15» июль 2026', 'E-OIL', 'Иванов И.И.', 'Дизель Л-0.2-62',
    '12 000 000,00', '600 000 000,00', 'олти юз миллион', 'акциз солиғисиз кўрсатилган',
    '305000111', '326999', '(90) 111']) {
    assert.ok(t.includes(s), `expected «${s}»`);
  }
  assert.ok(!t.includes('SANOAT'), 'baseline counterparty replaced');
  assert.ok(!t.includes('37 290 000,00'), 'baseline sum replaced');
});

test('SEG TASCO: договор + лист, акциз on, доверенность intro', () => {
  const r = generate(tasco, TPL);
  assert.equal(r.files.length, 2, 'SEG TASCO adds a лист согласования');
  const d = text(r.files[0].buffer);
  for (const s of ['ST-260/26-KS', '«03» август 2026', 'FARGONA GAZ', 'Каримов К.К.',
    'ишончнома асосида', 'Битум БНД 60/90', '8 500 000,00', '850 000 000,00',
    'саккиз юз эллик миллион', 'ва акциз солиғи билан кўрсатилган', '301222333', '46710']) {
    assert.ok(d.includes(s), `договор expected «${s}»`);
  }
  assert.ok(!d.includes('SEG MOTOL'), 'baseline counterparty replaced');
  const l = text(r.files[1].buffer);
  assert.match(r.files[1].name, /^Лист согласований к Договору № ST-260-26-KS от 03\.08\.2026 FARGONA GAZ\.docx$/);
  for (const s of ['ST-260/26-KS', '03.08.2026', 'FARGONA GAZ']) {
    assert.ok(l.includes(s), `лист expected «${s}»`);
  }
});

test('counterparty requisites do not clobber the supplier block', () => {
  const r = generate(segnum, TPL);
  const t = text(r.files[0].buffer);
  // supplier (SEGNUM) МФО 01081 must survive; only the counterparty line changed
  assert.ok(t.includes('01081'), 'supplier МФО intact');
  assert.ok(t.includes('305000111'), 'counterparty ИНН set');
});
