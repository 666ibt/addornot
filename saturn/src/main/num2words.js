'use strict';

/**
 * Russian number-to-words ("сумма прописью"), in Cyrillic, for currency
 * amounts. Used to fill the "(… сум)" spelled-out amounts in the contracts.
 *
 * Handles gender agreement (тысяча is feminine) and Russian plural forms
 * (один/два/пять → миллион/миллиона/миллионов).
 */

const ONES_M = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь',
  'восемь', 'девять', 'десять', 'одиннадцать', 'двенадцать', 'тринадцать',
  'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
const ONES_F = [...ONES_M];
ONES_F[1] = 'одна';
ONES_F[2] = 'две';
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят',
  'семьдесят', 'восемьдесят', 'девяносто'];
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот',
  'семьсот', 'восемьсот', 'девятьсот'];

// Scale group names: [one, few, many], and grammatical gender (feminine for тысяча).
const SCALES = [
  { forms: ['', '', ''], fem: false },                                  // units
  { forms: ['тысяча', 'тысячи', 'тысяч'], fem: true },
  { forms: ['миллион', 'миллиона', 'миллионов'], fem: false },
  { forms: ['миллиард', 'миллиарда', 'миллиардов'], fem: false },
  { forms: ['триллион', 'триллиона', 'триллионов'], fem: false },
];

/** Pick Russian plural form: [one, few, many] by count. */
function pluralForm(n, forms) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return forms[0];
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return forms[1];
  return forms[2];
}

/** Words for a 0..999 group. */
function tripletWords(n, fem) {
  const ones = fem ? ONES_F : ONES_M;
  const out = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h) out.push(HUNDREDS[h]);
  if (rest < 20) {
    if (rest) out.push(ones[rest]);
  } else {
    out.push(TENS[Math.floor(rest / 10)]);
    if (rest % 10) out.push(ones[rest % 10]);
  }
  return out;
}

/**
 * Spell out a non-negative integer in Russian words.
 * @param {number} value
 * @returns {string}
 */
function integerToWords(value) {
  let n = Math.floor(Math.abs(Number(value) || 0));
  if (n === 0) return 'ноль';

  // split into groups of 3 from the least significant
  const groups = [];
  while (n > 0) { groups.push(n % 1000); n = Math.floor(n / 1000); }

  const parts = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (g === 0) continue;
    const scale = SCALES[i] || SCALES[SCALES.length - 1];
    parts.push(...tripletWords(g, scale.fem));
    if (scale.forms[0]) parts.push(pluralForm(g, scale.forms));
  }
  return parts.join(' ');
}

/**
 * Spell out a currency amount as "<words> сум NN тийин".
 * @param {number} amount  сум (may have fractional тийин)
 * @param {object} [opts]  { capital:boolean }
 */
function amountToWords(amount, opts = {}) {
  const a = Number(amount) || 0;
  const sum = Math.floor(a);
  const tiyin = Math.round((a - sum) * 100);
  let words = `${integerToWords(sum)} сум ${String(tiyin).padStart(2, '0')} тийин`;
  if (opts.capital !== false) words = words.charAt(0).toUpperCase() + words.slice(1);
  return words;
}

module.exports = { integerToWords, amountToWords };
