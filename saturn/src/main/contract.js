'use strict';

const fs = require('fs');
const path = require('path');
const { fillDocx } = require('./docx');
const { integerToWordsUz, dateContract, dateDots } = require('./num2words');

/**
 * Contract generation. Fills the user's real .docx templates with the drafting
 * form's values via span-aware text replacement (see docx.js), reproducing the
 * archive's folder/file layout.
 *
 *   <SEGNUM|SEG TASCO>/<seq>. Договор № <номер> от <дата> <Контрагент>/
 *       Договор № … .docx
 *       Лист согласований к Договору № … .docx      (SEG TASCO only)
 *       СЛУЖЕБНАЯ ЗАПИСКА к Договору № … .docx        (added separately)
 *
 * Each template carries a fixed set of baseline (sample) values; we replace
 * those exact strings with the new ones. Counterparty requisites are byte-
 * identical to the supplier's in places, but the «Харидор» block is always
 * later in the document, so those lines are replaced at their *last* occurrence.
 */

// --- formatting -------------------------------------------------------------
const group = (n) => String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const money = (n) => `${group(n)},00`;
const numDash = (s) => String(s || '').replace(/[\\/]+/g, '-').trim();
const seqOf = (s) => { const m = String(s || '').match(/\d+/); return m ? m[0] : ''; };
const cleanName = (s) => String(s || '').replace(/[«»"]/g, '').trim();
const fileSafe = (s) => cleanName(s).replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();

function basisUz(basis) {
  return basis === 'dover'
    ? 'ишончнома асосида ҳаракат қилувчи'
    : 'ўз Устави асосида ҳаракат қилувчи';
}

// --- per-company договор templates ------------------------------------------
// Baseline strings taken verbatim from the user's real contracts.
const DOGOVOR = {
  SEGNUM: {
    file: 'segnum-dogovor.docx',
    number: 'SGN-225/26',
    date: '«06» июль 2026',
    introName: '«SANOAT ENERGETIKA GURUHI» ҚК МЧЖ',
    introMid: 'ўз Устави асосида харакат қилувчи бош директор Смирнов Т.В.',
    counterDir: 'Смирнов Т.В.',
    product: 'Бензин АИ-100-К5',
    qty: '2',
    price: '18 645 000,00',
    sum: '37 290 000,00',
    sumWords: 'ўттиз етти миллион икки юз тўқсон минг',
    shipment: 'терминал Чиноз',
    akcizOff: { from: 'акциз солиғи билан кўрсатилган', to: 'акциз солиғисиз кўрсатилган' },
    reqs: [
      { from: 'Манзил: Тошкент шахри, Чилонзор тумани, Бунёдкор шох кўчаси, 47-уй.', to: (c) => `Манзил: ${c.address || ''}` },
      { from: 'Банк: АКБ «Узсаноаткурилишбанк»', to: (c) => `Банк: ${c.bank || ''}` },
      { from: 'х/р: 2021 4000 7007 8111 6001', to: (c) => `ҳ/р: ${c.account || ''}` },
      { from: 'МФО: 00440, СТИР: 304936120', to: (c) => `МФО: ${c.mfo || ''}, СТИР: ${c.inn || ''}` },
      { from: 'ИФАК: 06100', to: (c) => (c.oked ? `ИФАК: ${c.oked}` : '') },
      { from: 'РКП НДС: 326040004278', to: (c) => `РКП НДС: ${c.vat || ''}` },
      { from: 'Телефон: (78) 150-00-57', to: (c) => `Телефон: ${c.phone || ''}` },
    ],
  },
  'SEG TASCO': {
    file: 'tasco-dogovor.docx',
    number: '238/26-TASCO',
    date: '«02» июнь 2026',
    introName: '«SEG MOTOL» МЧЖ',
    introMid: 'ўз Устави асосида ҳаракат қилувчи унинг номидан бош директор Асланов С.Р.',
    counterDir: 'Асланов С.Р.',
    product: 'Масло индустриальное И12А',
    qty: '230',
    price: '10 500 000,00',
    sum: '2 415 000 000,00',
    sumWords: 'икки миллиард тўрт юз ўн беш миллион',
    shipment: null, // FCA-станция клаузула специфична; по умолчанию оставляем как в шаблоне
    akcizOn: {
      from: 'ҚҚС ҳисобга олган ҳолда кўрсатилган',
      to: 'ҚҚС ҳисобга олган ҳолда ва акциз солиғи билан кўрсатилган',
    },
    reqs: [
      { from: 'Манзил: Тошкент шахри, Чилонзор тумани, Бунёдкор кўчаси, 47-уй ', to: (c) => `Манзил: ${c.address || ''}` },
      { from: 'Банк: АКБ "Узпромстройбанк"', to: (c) => `Банк: ${c.bank || ''}` },
      { from: 'ҳ/р: 2020 8000 9054 7432 2001 ', to: (c) => `ҳ/р: ${c.account || ''}` },
      { from: 'МФО: 00440, СТИР: 309162955', to: (c) => `МФО: ${c.mfo || ''}, СТИР: ${c.inn || ''}` },
      { from: 'РКП НДС: 326040180149', to: (c) => `РКП НДС: ${c.vat || ''}` },
      { from: 'ОКЭД: 19200', to: (c) => (c.oked ? `ОКЭД: ${c.oked}` : '') },
      { from: 'Телефон: (78) 150-00-57 ', to: (c) => `Телефон: ${c.phone || ''}` },
    ],
  },
};

const LIST = { file: 'tasco-list.docx', number: '238/26-TASCO', date: '02.06.2026', counter: 'SEG MOTOL' };

// --- build the договор replacements -----------------------------------------
function dogovorReplacements(t, d) {
  const c = d.counterparty || {};
  const name = cleanName(c.name);
  const form = (c.form || 'МЧЖ').trim();
  const title = (c.directorTitle || 'директор').trim();
  const introMid = `${basisUz(c.directorBasis)} унинг номидан ${title} ${c.director || ''}`;
  const sum = money(d.sum);
  const R = [
    { from: t.number, to: d.number }, // header shows the number exactly as typed
    { from: t.date, to: dateContract(d.date) },
    { from: t.introName, to: `«${name}» ${form}` },
    { from: t.introMid, to: introMid },
    { from: t.counterDir, to: c.director || '' },
    { from: t.product, to: d.product },
    { from: t.price, to: money(d.pricePerTon) },
    { from: t.sum, to: sum },
    { from: t.sumWords, to: integerToWordsUz(Math.round(d.sum)) },
    { para: t.qty, to: String(d.qty) },
  ];
  // акциз toggle (per-template)
  if (d.akciz && t.akcizOn) R.push(t.akcizOn);
  if (!d.akciz && t.akcizOff) R.push(t.akcizOff);
  // пункт отгрузки (optional override)
  if (t.shipment && d.shipment && d.shipment.trim() && d.shipment.trim() !== t.shipment) {
    R.push({ from: t.shipment, to: d.shipment.trim() });
  }
  // counterparty requisites — replace the LAST occurrence (the «Харидор» block)
  for (const r of t.reqs) R.push({ from: r.from, to: r.to(c), where: 'last' });
  return R;
}

// --- public API -------------------------------------------------------------
/**
 * @param {object} d  drafting-form data (company, number, date, counterparty,
 *                    product, qty, pricePerTon, akciz, shipment)
 * @param {string} templatesDir  folder holding the .docx templates
 * @returns {{ folder:string, files:{name:string,buffer:Buffer}[] }}
 */
function generate(d, templatesDir) {
  const company = DOGOVOR[d.company] ? d.company : 'SEGNUM';
  const t = DOGOVOR[company];
  d = { ...d, sum: Number(d.qty) * Number(d.pricePerTon) };

  const read = (f) => fs.readFileSync(path.join(templatesDir, f));
  const files = [];

  const dogovorBuf = fillDocx(read(t.file), dogovorReplacements(t, d), { strict: true });
  const cname = fileSafe(d.counterparty && d.counterparty.name);
  const stem = `Договор № ${numDash(d.number)} от ${dateDots(d.date)} ${cname}`.trim();
  files.push({ name: `${stem}.docx`, buffer: dogovorBuf });

  // Лист согласования — только SEG TASCO.
  if (company === 'SEG TASCO') {
    const listBuf = fillDocx(read(LIST.file), [
      { from: LIST.number, to: d.number },
      { from: LIST.date, to: dateDots(d.date) },
      { from: LIST.counter, to: cleanName(d.counterparty && d.counterparty.name) },
    ], { strict: true });
    files.push({ name: `Лист согласований к Договору № ${numDash(d.number)} от ${dateDots(d.date)} ${cname}.docx`, buffer: listBuf });
  }

  const folder = path.join(company, `${seqOf(d.number)}. ${stem}`.trim());
  return { folder, files };
}

module.exports = { generate, money, DOGOVOR };
