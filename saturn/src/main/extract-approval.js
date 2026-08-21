'use strict';

const { sanitizeForFilename } = require('./extract');

/**
 * Parse the header of an "ЛИСТ СОГЛАСОВАНИЯ" (approval sheet). The needed data
 * sits at the very top:
 *
 *   ООО «SEG TASCO»
 *   ЛИСТ СОГЛАСОВАНИЯ
 *   к Договору № 241/26-TASCO от 02.06.2026 года
 *   Контрагент: ООО «SEG MOTOL»
 *
 * Produces the target file name:
 *   Лист согласований к Договору № 241-26-TASCO от 02.06.2026 SEG MOTOL
 */

function normalize(text) {
  return String(text || '').replace(/[«»„“”"]/g, '"').replace(/[ \t]+/g, ' ');
}

// Contract token after "Договору №", up to " от ". Tolerant of OCR noise in the
// separators (/, <, >, |, spaces) which we later fold to dashes.
// Contract token between the "№" marker and " от <date>". Captured loosely
// (any non-newline chars) and cleaned afterwards, because OCR mangles the
// separators (/, <, >, =) and the date separators may be commas.
const DATE_SEP = '[.,\\-\\/]';
const CONTRACT_RE = new RegExp(
  'договор[а-яё]*\\s*[\\/|]?\\s*(?:№|N[eo°]?)\\s*(.+?)\\s+от\\s+\\d{2}\\s*' +
  DATE_SEP + '\\s*\\d{2}\\s*' + DATE_SEP + '\\s*\\d{4}', 'i');
const DATE_RE = new RegExp('от\\s+(\\d{2})\\s*' + DATE_SEP + '\\s*(\\d{2})\\s*' + DATE_SEP + '\\s*(\\d{4})', 'i');
// Counterparty after "Контрагент:", stripping the org-form prefix and quotes.
const PARTY_RE =
  /контрагент\s*[:：]?\s*(?:ООО|OOO|000|ЗАО|ПАО|ОАО|ПТК|ГУП|МЧЖ|MCHJ|АО|ИП)?\s*"?\s*([^"\n]+?)\s*(?:".*)?$/im;

function cleanContract(raw) {
  return String(raw || '')
    .replace(/\$/g, 'S')                   // "$" mis-read for "S"
    .replace(/^[A-Za-zА-Яа-я](?=\d)/, '')  // strip a stray leading letter (e.g. "Ne" -> "e241")
    .replace(/[\/<>=|·•–—]+/g, '-')         // OCR separators -> dash
    .replace(/\s+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .trim();
}

function cleanParty(raw) {
  return String(raw || '')
    .replace(/["«»`]+/g, '')                  // strip quotes, keep apostrophes (O'LMAS)
    .replace(/^[a-zа-я](?=[A-ZА-Я])/, '')      // drop a stray leading lower-case letter (cAVTO -> AVTO)
    .replace(/[^\wА-Яа-яЁё'’ .&/-]+/g, ' ')    // drop other OCR junk
    .replace(/\s+[A-Za-zА-Яа-я]$/, '')         // drop a single trailing stray letter
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} text OCR text of the sheet's top region
 * @returns {{contract:string,date:string,counterparty:string,filename:string,
 *            confidence:'high'|'medium'|'low',fields:object}}
 */
function parseApproval(text) {
  const t = normalize(text);

  const cm = t.match(CONTRACT_RE);
  const contract = cm ? cleanContract(cm[1]) : '';

  const dm = t.match(DATE_RE);
  const date = dm ? `${dm[1]}.${dm[2]}.${dm[3]}` : '';

  const pm = t.match(PARTY_RE);
  const counterparty = pm ? cleanParty(pm[1]) : '';

  const found = [contract, date, counterparty].filter(Boolean).length;
  const confidence = found === 3 ? 'high' : found >= 1 ? 'medium' : 'low';

  return {
    contract,
    date,
    counterparty,
    confidence,
    fields: { contract: !!contract, date: !!date, counterparty: !!counterparty },
    filename: makeApprovalFilename({ contract, date, counterparty }),
  };
}

/** Build "Лист согласований к Договору № {contract} от {date} {party}.pdf". */
function makeApprovalFilename({ contract, date, counterparty }) {
  const c = sanitizeForFilename(contract) || 'NA';
  const d = sanitizeForFilename(date) || 'NA';
  const p = sanitizeForFilename(counterparty) || 'NA';
  return `Лист согласований к Договору № ${c} от ${d} ${p}.pdf`;
}

module.exports = { parseApproval, makeApprovalFilename, cleanContract, cleanParty };
