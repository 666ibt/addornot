'use strict';

const PizZip = require('pizzip');

/**
 * Minimal .docx (OOXML) text surgery. Word splits a single logical string into
 * many <w:r>/<w:t> runs, so a naive string replace on word/document.xml fails.
 * We concatenate all <w:t> texts into one stream, find the target substring
 * there, then rewrite only the runs it spans — leaving every other run (and all
 * formatting) untouched. This lets us drop the user's values into the real
 * contract templates without changing anything else.
 *
 * Our search/replace values are plain text (Cyrillic, digits, « » “ ”), never
 * XML metacharacters, so we can match against the raw (escaped) run text
 * directly without decoding.
 */

const T_RE = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;

function parseRuns(xml) {
  const runs = [];
  let m;
  let concat = '';
  T_RE.lastIndex = 0;
  while ((m = T_RE.exec(xml))) {
    const full = m[0];
    const inner = m[1];
    const openEnd = full.indexOf('>') + 1;
    runs.push({
      openTag: full.slice(0, openEnd),
      inner,
      elemStart: m.index,
      elemEnd: T_RE.lastIndex,
      textStart: concat.length,
      textEnd: concat.length + inner.length,
    });
    concat += inner;
  }
  return { runs, concat };
}

function ensurePreserve(openTag) {
  if (/xml:space=/.test(openTag)) return openTag;
  return openTag.replace(/^<w:t\b/, '<w:t xml:space="preserve"');
}

/** Rebuild document xml from run records whose `inner`/`openTag` may have changed. */
function rebuild(xml, runs) {
  let out = '';
  let cursor = 0;
  for (const r of runs) {
    out += xml.slice(cursor, r.elemStart);
    out += `${r.openTag}${r.inner}</w:t>`;
    cursor = r.elemEnd;
  }
  out += xml.slice(cursor);
  return out;
}

/**
 * Replace `from` with `to` in the concatenated run text.
 * `where`: 'all' (default), 'first', or 'last'. 'last' is used for counterparty
 * requisites lines that are byte-identical to the supplier's — the counterparty
 * («Харидор») block always comes later in the document, so the last hit is it.
 * Returns { xml, count }.
 */
function replaceText(xml, from, to, { where = 'all' } = {}) {
  if (!from || from === to) return { xml, count: 0 };
  let count = 0;
  // Safety cap: never loop more than the original number of occurrences, so a
  // replacement whose `to` re-contains `from` can't spin forever.
  const cap = where === 'all' ? (documentText(xml).split(from).length - 1) : 1;
  // Re-parse after each hit because run boundaries shift.
  for (;;) {
    if (count >= cap) break;
    const { runs, concat } = parseRuns(xml);
    const idx = where === 'last' ? concat.lastIndexOf(from) : concat.indexOf(from);
    if (idx < 0) break;
    const mStart = idx;
    const mEnd = idx + from.length;
    let first = true;
    for (const r of runs) {
      if (r.textEnd <= mStart || r.textStart >= mEnd) continue; // no overlap
      const ls = Math.max(mStart, r.textStart) - r.textStart;
      const le = Math.min(mEnd, r.textEnd) - r.textStart;
      const before = r.inner.slice(0, ls);
      const after = r.inner.slice(le);
      const insert = first ? to : '';
      r.inner = before + insert + after;
      if (insert || before || after) r.openTag = ensurePreserve(r.openTag);
      first = false;
    }
    xml = rebuild(xml, runs);
    count += 1;
    if (where !== 'all') break;
  }
  return { xml, count };
}

/** Full concatenated text of the document (for tests / inspection). */
function documentText(xml) {
  return parseRuns(xml).concat;
}

const P_RE = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;

/**
 * Replace whole paragraphs whose entire (trimmed) run text equals `exact`.
 * Used for table cells that hold a bare value (e.g. the quantity "2"), which
 * a plain substring search can't target safely. Returns { xml, count }.
 */
function replaceParagraphExact(xml, exact, to, { all = true } = {}) {
  exact = String(exact).trim();
  if (!exact) return { xml, count: 0 };
  let count = 0;
  let out = '';
  let cursor = 0;
  let m;
  P_RE.lastIndex = 0;
  while ((m = P_RE.exec(xml))) {
    const pXml = m[0];
    if ((all || count === 0) && parseRuns(pXml).concat.trim() === exact) {
      const { runs } = parseRuns(pXml);
      let first = true;
      for (const r of runs) {
        r.inner = first ? String(to) : '';
        if (first) r.openTag = ensurePreserve(r.openTag);
        first = false;
      }
      out += xml.slice(cursor, m.index) + rebuild(pXml, runs);
      cursor = P_RE.lastIndex;
      count += 1;
    }
  }
  out += xml.slice(cursor);
  return { xml: out, count };
}

// ---------------------------------------------------------------------------

function readDocumentXml(buffer) {
  return new PizZip(buffer).file('word/document.xml').asText();
}

/**
 * Load a .docx buffer, apply a list of {from,to} replacements (in order), and
 * return a new .docx buffer. Unknown `from` values are skipped silently unless
 * `strict` is set, in which case a missing replacement throws (used to catch
 * template drift early).
 */
function fillDocx(buffer, replacements, { strict = false } = {}) {
  const zip = new PizZip(buffer);
  let xml = zip.file('word/document.xml').asText();
  for (const r of replacements) {
    const to = String(r.to == null ? '' : r.to);
    const anchor = r.para != null ? r.para : r.from;
    if (anchor == null || anchor === '') continue;
    const res = r.para != null
      ? replaceParagraphExact(xml, r.para, to)
      : replaceText(xml, r.from, to, { where: r.where || 'all' });
    if (res.count === 0 && strict) throw new Error(`docx: text not found: ${JSON.stringify(anchor)}`);
    xml = res.xml;
  }
  zip.file('word/document.xml', xml);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { replaceText, replaceParagraphExact, fillDocx, documentText, readDocumentXml };
