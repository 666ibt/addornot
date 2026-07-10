'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { integerToWords, amountToWords, integerToWordsUz } = require('../src/main/num2words');

// Uzbek (Cyrillic) — exact strings taken from the user's real contracts.
const uzCases = [
  [37290000, 'ўттиз етти миллион икки юз тўқсон минг'],
  [2415000000, 'икки миллиард тўрт юз ўн беш миллион'],
  [11345000000, 'ўн бир миллиард уч юз қирқ беш миллион'],
  [3900000000, 'уч миллиард тўққиз юз миллион'],
  [11200000000, 'ўн бир миллиард икки юз миллион'],
  [385000000, 'уч юз саксон беш миллион'],
];
for (const [n, exp] of uzCases) {
  test(`integerToWordsUz(${n})`, () => assert.equal(integerToWordsUz(n), exp));
}

const cases = [
  [0, 'ноль'],
  [1, 'один'],
  [21, 'двадцать один'],
  [100, 'сто'],
  [111, 'сто одиннадцать'],
  [1000, 'одна тысяча'],
  [2000, 'две тысячи'],
  [5000, 'пять тысяч'],
  [1002003, 'один миллион две тысячи три'],
  [18645000, 'восемнадцать миллионов шестьсот сорок пять тысяч'],
  [21000000, 'двадцать один миллион'],
];

for (const [n, exp] of cases) {
  test(`integerToWords(${n})`, () => assert.equal(integerToWords(n), exp));
}

test('amountToWords adds сум/тийин and capitalizes', () => {
  assert.equal(amountToWords(18645000),
    'Восемнадцать миллионов шестьсот сорок пять тысяч сум 00 тийин');
});

test('amountToWords keeps тийин', () => {
  assert.equal(amountToWords(1000.5), 'Одна тысяча сум 50 тийин');
});
