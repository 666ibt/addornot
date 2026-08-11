'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseWaybillName, buildSortPlan } = require('../src/main/sort');

// --- parseWaybillName ------------------------------------------------------
test('normal name → contract folder', () => {
  const p = parseWaybillName('1125_SGN-158-25.pdf');
  assert.equal(p.problem, false);
  assert.equal(p.nakladnaya, '1125');
  assert.equal(p.dogovor, 'SGN-158-25');
  assert.equal(p.folder, 'SGN-158-25');
});

test('contract with grade suffix keeps the suffix in the folder', () => {
  const p = parseWaybillName('80130800_ST-248-26-KS.pdf');
  assert.equal(p.folder, 'ST-248-26-KS');
  assert.equal(p.problem, false);
});

test('Перемещение is a valid contract folder', () => {
  const p = parseWaybillName('37_Перемещение.pdf');
  assert.equal(p.problem, false);
  assert.equal(p.folder, 'Перемещение');
});

test('invoice suffix (тч) is kept, folder is the contract', () => {
  const p = parseWaybillName('1125тч_SGN-225-26.pdf');
  assert.equal(p.nakladnaya, '1125тч');
  assert.equal(p.folder, 'SGN-225-26');
});

test('dedupe copy index "_2" does not spawn its own folder', () => {
  const p = parseWaybillName('1125_SGN-158-25_2.pdf');
  assert.equal(p.dogovor, 'SGN-158-25');
  assert.equal(p.folder, 'SGN-158-25');
});

test('NA contract → problem', () => {
  const p = parseWaybillName('1125_NA.pdf');
  assert.equal(p.problem, true);
  assert.match(p.reason, /договор/i);
});

test('NA invoice → problem', () => {
  const p = parseWaybillName('NA_SGN-158-25.pdf');
  assert.equal(p.problem, true);
  assert.match(p.reason, /накладная/i);
});

test('no underscore → problem', () => {
  const p = parseWaybillName('scan001.pdf');
  assert.equal(p.problem, true);
  assert.match(p.reason, /формат/i);
});

test('non-pdf is skipped, not counted', () => {
  const p = parseWaybillName('notes.txt');
  assert.equal(p.skip, true);
});

// --- buildSortPlan ---------------------------------------------------------
test('groups by contract, sorts, and collects problems', () => {
  const plan = buildSortPlan([
    '1125_SGN-158-25.pdf',
    '37_SGN-158-25.pdf',
    '80130800_ST-248-26-KS.pdf',
    '9_NA.pdf',
    'randomscan.pdf',
    'readme.md', // skipped entirely
  ]);
  assert.equal(plan.totalPdf, 5); // 5 pdfs (md skipped)
  assert.equal(plan.groups.length, 2); // SGN-158-25, ST-248-26-KS
  assert.equal(plan.unsorted.length, 2); // 9_NA + randomscan

  const sgn = plan.groups.find((g) => g.folder === 'SGN-158-25');
  assert.equal(sgn.items.length, 2);
  // natural numeric sort: 37 before 1125
  assert.equal(sgn.items[0].nakladnaya, '37');
  assert.equal(sgn.items[1].nakladnaya, '1125');
});

test('empty list → empty plan', () => {
  const plan = buildSortPlan([]);
  assert.equal(plan.totalPdf, 0);
  assert.equal(plan.groups.length, 0);
  assert.equal(plan.unsorted.length, 0);
});
