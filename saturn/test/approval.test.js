'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseApproval } = require('../src/main/extract-approval');

const cases = [
  ['ООО «SEG TASCO»\nЛИСТ СОГЛАСОВАНИЯ\nк Договору Ne241/26-TASCO от 02.06.2026 года\nКонтрагент: ООО «SEG MOTOL»',
    { contract: '241-26-TASCO', date: '02.06.2026', counterparty: 'SEG MOTOL' }],
  ['ЛИСТ СОГЛАСОВАНИЯ\nк Договору № 243/26-TASCO от 05.06.2026 года\nКонтрагент: ООО «SANEG JETWHITES»',
    { contract: '243-26-TASCO', date: '05.06.2026', counterparty: 'SANEG JETWHITES' }],
  ['к Договору № ST-15/26-KS от 26.01.2026 года\nКонтрагент: ООО «O\'LMAS HO\'JA TOJI AZIZ»',
    { contract: 'ST-15-26-KS', date: '26.01.2026', counterparty: "O'LMAS HO'JA TOJI AZIZ" }],
  ['к Договору/№ 27/26-АЗС от 03.06.2026 года\n| Контрагент: ООО «DIL SUL» Ff',
    { contract: '27-26-АЗС', date: '03.06.2026', counterparty: 'DIL SUL' }],
];

for (const [i, [text, exp]] of cases.entries()) {
  test(`approval case ${i + 1}`, () => {
    const r = parseApproval(text);
    assert.equal(r.contract, exp.contract, 'contract');
    assert.equal(r.date, exp.date, 'date');
    assert.equal(r.counterparty, exp.counterparty, 'counterparty');
  });
}

test('approval builds the target filename', () => {
  const r = parseApproval(
    'ЛИСТ СОГЛАСОВАНИЯ\nк Договору Ne241/26-TASCO от 02.06.2026 года\nКонтрагент: ООО «SEG MOTOL»');
  assert.equal(r.filename, 'Лист согласований к Договору № 241-26-TASCO от 02.06.2026 SEG MOTOL.pdf');
});

test('strips a stray leading letter on the contract (e241 -> 241)', () => {
  // "№" mis-read leaving an "e" before the digits
  const { cleanContract } = require('../src/main/extract-approval');
  assert.equal(cleanContract('e241/26-TASCO'), '241-26-TASCO');
});

test('missing contract still yields a usable name (NA placeholder)', () => {
  const r = parseApproval('ЛИСТ СОГЛАСОВАНИЯ\nКонтрагент: ООО «SEG MOTOL»');
  assert.match(r.filename, /^Лист согласований к Договору № NA от NA SEG MOTOL\.pdf$/);
});
