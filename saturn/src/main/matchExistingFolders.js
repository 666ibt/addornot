'use strict';

/**
 * Pure matching logic for the "сопоставление с существующими папками" mode of
 * the Сортировка накладных tool.
 *
 * The destination is a shared drive with hundreds of hand-named contract
 * folders (e.g. "425. Договор № ST-425-25-K от 25.07.2025 E-OIL"). Instead of
 * creating a fresh folder per contract, we must find the EXISTING folder a
 * waybill belongs to and drop it into that folder's «ТТН» subfolder.
 *
 * Matching is done on the contract's NUMERIC CORE — the first "\d+-\d+" pair —
 * ignoring the letters around it (ST-, -K, -TASCO, -АЗС), and comparing those
 * cores as whole values (so "09-22" never matches "109-22"). The «АЗС» category
 * is kept separate: an -АЗС waybill only matches an -АЗС folder, and vice versa.
 *
 * No I/O and no Electron here — the caller passes in the already-listed folders
 * (name + path) and the good items from buildSortPlan; scanning the disk and
 * locating the «ТТН» subfolder stay in main.js (see there).
 */

// Cyrillic letters that look like Latin ones — people sometimes type part of a
// code in the wrong keyboard layout. Uppercase-only; callers uppercase first.
const OMOGLYPH = {
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O',
  Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X',
};

/** Uppercase a string and fold Cyrillic look-alikes to their Latin twins. */
function normalizeOmoglyphs(s) {
  return String(s == null ? '' : s)
    .toUpperCase()
    .split('')
    .map((ch) => OMOGLYPH[ch] || ch)
    .join('');
}

// The «АЗС» marker, run through the same normalization so a mixed-layout
// "AЗC"/"АЗС" is detected the same way on both files and folders.
const AZS_MARK = normalizeOmoglyphs('АЗС');

/** True when the string carries the «АЗС» category marker. */
function isAzs(s) {
  return normalizeOmoglyphs(s).includes(AZS_MARK);
}

/**
 * The numeric core of a contract/folder string — the first "\d+-\d+" pair.
 * Letters and leading index numbers without a following dash are ignored.
 *   "ST-425-25-K" → "425-25",  "290-25-TASCO" → "290-25",  "09-22" → "09-22"
 * @returns {string|null}
 */
function numericCore(s) {
  const m = normalizeOmoglyphs(s).match(/(\d+)-(\d+)/);
  return m ? `${m[1]}-${m[2]}` : null;
}

/**
 * Index the destination folders by numeric core, split into the «АЗС» and the
 * ordinary category. Several folders may share a core — that is not an error by
 * itself, but makes a file matching that core AMBIGUOUS.
 * @param {{name:string, path:string}[]} folders
 */
function indexFolders(folders) {
  const azs = new Map();
  const normal = new Map();
  for (const f of folders || []) {
    const core = numericCore(f.name);
    if (!core) continue;
    const entry = { name: f.name, path: f.path, core, azs: isAzs(f.name) };
    const map = entry.azs ? azs : normal;
    if (!map.has(core)) map.set(core, []);
    map.get(core).push(entry);
  }
  return { azs, normal };
}

/**
 * Match each waybill item to an existing folder.
 *
 * @param {{fileName:string, dogovor:string}[]} items  good items (from buildSortPlan)
 * @param {{name:string, path:string}[]} folders       destination subfolders
 * @returns {{
 *   matched:{fileName,dogovor,core,folder}[],
 *   ambiguous:{fileName,dogovor,core,candidates}[],
 *   notFound:{fileName,dogovor,core,isAzs,similar:string[]}[]
 * }}
 */
function matchWaybills(items, folders) {
  const idx = indexFolders(folders);
  const matched = [];
  const ambiguous = [];
  const notFound = [];

  for (const it of items || []) {
    const core = numericCore(it.dogovor);
    const azs = isAzs(it.dogovor);
    const map = azs ? idx.azs : idx.normal;
    const candidates = (core && map.get(core)) || [];

    if (candidates.length === 1) {
      matched.push({ fileName: it.fileName, dogovor: it.dogovor, core, folder: candidates[0] });
    } else if (candidates.length > 1) {
      ambiguous.push({ fileName: it.fileName, dogovor: it.dogovor, core, candidates });
    } else {
      // NOT FOUND — surface folders across BOTH categories that share this core,
      // so the user can see a wrong-category / typo case at a glance.
      const similar = core
        ? (folders || []).filter((f) => numericCore(f.name) === core).map((f) => f.name)
        : [];
      notFound.push({ fileName: it.fileName, dogovor: it.dogovor, core, isAzs: azs, similar: similar.slice(0, 3) });
    }
  }

  return { matched, ambiguous, notFound };
}

module.exports = { normalizeOmoglyphs, isAzs, numericCore, indexFolders, matchWaybills };
