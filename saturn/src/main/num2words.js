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

// ---------------------------------------------------------------------------
// Uzbek (Cyrillic) — used for the contract's spelled-out amount, e.g.
//   37 290 000  -> "ўттиз етти миллион икки юз тўқсон минг"
// Uzbek has no gender/plural agreement, so it's a simple concatenation; we use
// explicit multipliers ("бир юз", "икки юз", …), matching the contracts.
// ---------------------------------------------------------------------------

const UZ = ['нол', 'бир', 'икки', 'уч', 'тўрт', 'беш', 'олти', 'етти', 'саккиз',
  'тўққиз', 'ўн', 'ўн бир', 'ўн икки', 'ўн уч', 'ўн тўрт', 'ўн беш', 'ўн олти',
  'ўн етти', 'ўн саккиз', 'ўн тўққиз'];
const UZ_TENS = ['', '', 'йигирма', 'ўттиз', 'қирқ', 'эллик', 'олтмиш', 'етмиш',
  'саксон', 'тўқсон'];
const UZ_SCALES = ['', 'минг', 'миллион', 'миллиард', 'триллион'];

function uzTriplet(n) {
  const parts = [];
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h) parts.push(UZ[h], 'юз');
  if (r < 20) {
    if (r) parts.push(UZ[r]);
  } else {
    parts.push(UZ_TENS[Math.floor(r / 10)]);
    if (r % 10) parts.push(UZ[r % 10]);
  }
  return parts;
}

/** Spell out a non-negative integer in Uzbek (Cyrillic). */
function integerToWordsUz(value) {
  let n = Math.floor(Math.abs(Number(value) || 0));
  if (n === 0) return 'нол';
  const groups = [];
  while (n > 0) { groups.push(n % 1000); n = Math.floor(n / 1000); }
  const parts = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i] === 0) continue;
    parts.push(...uzTriplet(groups[i]));
    if (UZ_SCALES[i]) parts.push(UZ_SCALES[i]);
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Dates. The contracts write the month in Russian nominative ("«02» июнь 2026")
// even in the Uzbek договор; the лист/записка use DD.MM.YYYY.
// ---------------------------------------------------------------------------

const MONTHS_RU = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль',
  'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

/** Parse 'YYYY-MM-DD' (or a Date) into {d, m, y} with zero-padded day. */
function ymd(date) {
  const dt = date instanceof Date ? date : new Date(date);
  return { d: String(dt.getDate()).padStart(2, '0'), m: dt.getMonth(), y: dt.getFullYear() };
}
/** «06» июль 2026 — the договор date phrase (no trailing "й."). */
function dateContract(date) {
  const { d, m, y } = ymd(date);
  return `«${d}» ${MONTHS_RU[m]} ${y}`;
}
/** 06.07.2026 — лист/записка date. */
function dateDots(date) {
  const { d, m, y } = ymd(date);
  return `${d}.${String(m + 1).padStart(2, '0')}.${y}`;
}

module.exports = {
  integerToWords, amountToWords, integerToWordsUz,
  MONTHS_RU, dateContract, dateDots,
};
