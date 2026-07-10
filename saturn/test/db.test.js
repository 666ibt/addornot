'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Stub electron-store so db.js runs outside Electron (in-memory).
class FakeStore {
  constructor(o) { this.d = JSON.parse(JSON.stringify((o && o.defaults) || {})); }
  get(k) { return this.d[k]; }
  set(k, v) { this.d[k] = v; }
}
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'electron-store') return FakeStore;
  return origLoad.call(this, req, ...rest);
};

const db = require('../src/main/db');

test('contractors are isolated per company and upsert by name', () => {
  const r = db.saveContractor('SEGNUM', { name: 'E-OIL', inn: '123' });
  assert.ok(r.id, 'gets an id');
  db.saveContractor('SEG TASCO', { name: 'SEG MOTOL' });
  assert.equal(db.getContractors('SEGNUM').length, 1);
  assert.equal(db.getContractors('SEG TASCO').length, 1);
  // same name (case-insensitive) updates in place, no duplicate
  db.saveContractor('SEGNUM', { name: 'e-oil', inn: '999' });
  assert.equal(db.getContractors('SEGNUM').length, 1);
  assert.equal(db.getContractors('SEGNUM')[0].inn, '999');
});

test('products dedupe by name and delete', () => {
  db.saveProduct({ name: 'Бензин АИ-95-К4', pricePerTon: '19500000' });
  db.saveProduct({ name: 'бензин аи-95-к4', pricePerTon: '20000000' });
  assert.equal(db.getProducts().length, 1);
  assert.equal(db.getProducts()[0].pricePerTon, '20000000');
  db.deleteProduct(db.getProducts()[0].id);
  assert.equal(db.getProducts().length, 0);
});

test('contract types are per-company and case-insensitively unique', () => {
  db.addContractType('SEG TASCO', 'ST-###-##-KS');
  db.addContractType('SEG TASCO', 'st-###-##-ks');
  assert.deepEqual(db.getContractTypes('SEG TASCO'), ['ST-###-##-KS']);
  assert.equal(db.getContractTypes('SEGNUM').length, 0);
});

test('getAll exposes the three collections', () => {
  assert.deepEqual(Object.keys(db.getAll()).sort(), ['contractTypes', 'contractors', 'products']);
});
