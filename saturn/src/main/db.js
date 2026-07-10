'use strict';

const Store = require('electron-store');

/**
 * Local database for the contract-drafting feature: контрагенты (per company),
 * продукты, and виды договора. Stored on the user's machine via electron-store,
 * separate from app settings.
 */
const store = new Store({
  name: 'saturn-db',
  defaults: {
    contractors: { SEGNUM: [], 'SEG TASCO': [] },
    products: [],
    contractTypes: { SEGNUM: [], 'SEG TASCO': [] },
  },
});

const COMPANIES = ['SEGNUM', 'SEG TASCO'];
const company = (c) => (COMPANIES.includes(c) ? c : 'SEGNUM');
const id = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// --- контрагенты (по компаниям) --------------------------------------------
function getContractors(c) {
  return store.get('contractors')[company(c)] || [];
}

/** Upsert by id, or by (case-insensitive) name if no id — returns the record. */
function saveContractor(c, data) {
  c = company(c);
  const all = store.get('contractors');
  const list = all[c] || [];
  const name = String(data.name || '').trim();
  let rec = data.id ? list.find((x) => x.id === data.id)
    : list.find((x) => x.name.trim().toLowerCase() === name.toLowerCase());
  if (rec) Object.assign(rec, data, { id: rec.id });
  else { rec = { ...data, id: id() }; list.push(rec); }
  all[c] = list;
  store.set('contractors', all);
  return rec;
}

function deleteContractor(c, recId) {
  c = company(c);
  const all = store.get('contractors');
  all[c] = (all[c] || []).filter((x) => x.id !== recId);
  store.set('contractors', all);
}

// --- продукты (общий список) -----------------------------------------------
function getProducts() {
  return store.get('products') || [];
}

function saveProduct(data) {
  const list = store.get('products') || [];
  const name = String(data.name || '').trim();
  let rec = data.id ? list.find((x) => x.id === data.id)
    : list.find((x) => x.name.trim().toLowerCase() === name.toLowerCase());
  if (rec) Object.assign(rec, data, { id: rec.id });
  else { rec = { ...data, id: id() }; list.push(rec); }
  store.set('products', list);
  return rec;
}

function deleteProduct(recId) {
  store.set('products', (store.get('products') || []).filter((x) => x.id !== recId));
}

// --- виды договора (по компаниям, редактируемый список строк) ----------------
function getContractTypes(c) {
  return store.get('contractTypes')[company(c)] || [];
}

function addContractType(c, type) {
  c = company(c);
  type = String(type || '').trim();
  if (!type) return getContractTypes(c);
  const all = store.get('contractTypes');
  const list = all[c] || [];
  if (!list.some((t) => t.toLowerCase() === type.toLowerCase())) list.push(type);
  all[c] = list;
  store.set('contractTypes', all);
  return list;
}

function setContractTypes(c, types) {
  c = company(c);
  const all = store.get('contractTypes');
  all[c] = [...new Set((types || []).map((t) => String(t).trim()).filter(Boolean))];
  store.set('contractTypes', all);
  return all[c];
}

/** Everything the drafting form needs to populate its selects. */
function getAll() {
  return {
    contractors: store.get('contractors'),
    products: getProducts(),
    contractTypes: store.get('contractTypes'),
  };
}

module.exports = {
  COMPANIES,
  getContractors, saveContractor, deleteContractor,
  getProducts, saveProduct, deleteProduct,
  getContractTypes, addContractType, setContractTypes,
  getAll,
};
