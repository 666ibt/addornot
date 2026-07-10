'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { integerToWords, amountToWords } = require('../src/main/num2words');

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
