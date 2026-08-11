'use strict';

/**
 * Pure planning logic for the "Сортировка накладных" tool.
 *
 * The source folder holds single-page PDFs already named by the ТТН tool as
 * "{накладная}_{договор}.pdf" (e.g. "1125_SGN-158-25.pdf"). This module reads
 * those names back and decides where each file belongs:
 *   - good file  → grouped under its contract (договор)
 *   - problem    → накладная or договор is "NA", or the name isn't in the
 *                  expected format → goes to "неотсортированные".
 *
 * No I/O here (no fs, no path) so it stays unit-testable; the actual moving and
 * on-disk collision handling live in main.js.
 */

const NA_RE = /^NA$/i;

/**
 * Parse an already-named waybill filename into its parts.
 *
 * Tolerates the dedupe suffix the saver adds on name collisions
 * ("1125_SGN-158-25_2.pdf"): a trailing "_<digits>" on the contract part is a
 * copy index, not part of the contract, so it doesn't spawn its own folder.
 *
 * @param {string} fileName
 * @returns {{fileName:string, nakladnaya:string, dogovor:string, folder:string,
 *            problem:boolean, skip:boolean, reason:string}}
 */
function parseWaybillName(fileName) {
  const raw = String(fileName || '');
  const out = {
    fileName: raw, nakladnaya: '', dogovor: '', folder: '',
    problem: true, skip: false, reason: '',
  };

  if (!/\.pdf$/i.test(raw)) { out.skip = true; out.reason = 'не PDF'; return out; }

  const base = raw.replace(/\.[^.]+$/, ''); // strip extension
  const us = base.indexOf('_');
  if (us < 0) { out.reason = 'имя не в формате {накладная}_{договор}'; return out; }

  const nak = base.slice(0, us).trim();
  let dog = base.slice(us + 1).trim().replace(/_\d+$/, ''); // drop copy index "_2"

  out.nakladnaya = nak;
  out.dogovor = dog;

  if (!nak || NA_RE.test(nak)) { out.reason = 'накладная не распознана (NA)'; return out; }
  if (!dog || NA_RE.test(dog)) { out.reason = 'договор не распознан (NA)'; return out; }

  out.problem = false;
  out.folder = dog;
  return out;
}

/**
 * Group a list of filenames into a sort plan. Non-PDF files are skipped;
 * problem files collect in `unsorted`. Groups and their files come back sorted
 * (contracts alphabetically, invoices naturally) so the report reads cleanly.
 *
 * @param {string[]} fileNames
 * @returns {{totalPdf:number, groups:{folder:string, items:object[]}[], unsorted:{fileName:string, reason:string}[]}}
 */
function buildSortPlan(fileNames) {
  const groups = new Map(); // folder -> parsed[]
  const unsorted = [];
  let totalPdf = 0;

  for (const name of fileNames || []) {
    const p = parseWaybillName(name);
    if (p.skip) continue;
    totalPdf += 1;
    if (p.problem) { unsorted.push({ fileName: p.fileName, reason: p.reason }); continue; }
    if (!groups.has(p.folder)) groups.set(p.folder, []);
    groups.get(p.folder).push(p);
  }

  const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });
  const groupList = [...groups.entries()]
    .sort((a, b) => collator.compare(a[0], b[0]))
    .map(([folder, items]) => ({
      folder,
      items: items.sort((x, y) => collator.compare(x.nakladnaya, y.nakladnaya)),
    }));

  return { totalPdf, groups: groupList, unsorted };
}

module.exports = { parseWaybillName, buildSortPlan };
