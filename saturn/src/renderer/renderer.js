'use strict';

/* global window, document */
// Wrapped in an IIFE with a re-entry guard: in some packaged Electron builds
// this script can be evaluated twice in the same page, and a top-level `const`
// would then throw "Identifier already declared", killing the whole script.
(function () {
if (window.__ttnRendererLoaded) return;
window.__ttnRendererLoaded = true;

const api = window.api;

function showFatal(message) {
  let el = document.getElementById('fatalBanner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fatalBanner';
    el.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:9999;background:#7f1d1d;color:#fff;' +
      'padding:10px 16px;font:13px system-ui;white-space:pre-wrap;';
    (document.body || document.documentElement).appendChild(el);
  }
  el.textContent = '⚠ ' + message;
}
window.addEventListener('error', (e) =>
  showFatal('Ошибка интерфейса: ' + (e.message || e.error)));
window.addEventListener('unhandledrejection', (e) =>
  showFatal('Ошибка: ' + (e.reason && (e.reason.message || e.reason))));

const TOOLS = {
  ttn: {
    title: 'Обработка ТТН',
    hint: 'Поддерживаются: Товарно-транспортная накладная (форма 1-т) и «Накладная на отпуск материалов» (ФНПЗ). Распознаются накладная и договор.',
  },
  split: {
    title: 'Разделитель PDF',
    hint: 'PDF делится по страницам. Имя по умолчанию {имя}_splitted_1,2,3… — можно переписать вручную.',
  },
  approval: {
    title: 'Определитель листов согласования',
    hint: 'Читает шапку листа согласования и формирует имя: «Лист согласований к Договору № … от … Контрагент».',
  },
  img: { title: 'Фото → PDF', hint: '' },
};

const state = {
  view: 'home',   // 'home' | 'pdf' | 'img'
  mode: 'ttn',    // pdf tool: 'ttn' | 'split' | 'approval'
  jobId: null,
  outputDir: '',
  pages: new Map(),
  total: 0,
  done: 0,
  processing: false,
  zoomPageId: null,
};
const imgState = { items: [], mode: 'one' };

// --- filename helpers ------------------------------------------------------
function contractToFilename(d) {
  return String(d || '').replace(/[\/\\]/g, '-').replace(/\s+/g, '').trim();
}
function sanitize(v) {
  return String(v == null ? '' : v).replace(/[\\/:*?"<>| -]/g, '-').replace(/\s+/g, ' ').trim();
}
function makeFilename(nakladnaya, dogovor) {
  const inv = sanitize(nakladnaya) || 'NA';
  const con = sanitize(contractToFilename(dogovor)) || 'NA';
  return `${inv}_${con}.pdf`;
}
function ensurePdf(name) {
  let n = String(name || '').trim();
  if (!n) n = 'NA';
  return /\.pdf$/i.test(n) ? n : n + '.pdf';
}
// Final output filename for a page record, per tool mode.
function finalName(rec) {
  if (state.mode === 'ttn') return makeFilename(rec.editNak, rec.editDog);
  return ensurePdf(rec.editName);
}

const $ = (id) => document.getElementById(id);

function toast(msg, kind) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast ${kind || ''}`;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 3500);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- routing ---------------------------------------------------------------
function showHome() {
  cancelActive();
  state.view = 'home';
  $('homeView').classList.remove('hidden');
  $('pdfView').classList.add('hidden');
  $('imgView').classList.add('hidden');
  $('dbView').classList.add('hidden');
  $('contractView').classList.add('hidden');
  $('homeBtn').classList.add('hidden');
  $('subTitle').textContent = 'Набор инструментов для документов';
}

function openTool(tool) {
  $('homeView').classList.add('hidden');
  $('dbView').classList.add('hidden');
  $('contractView').classList.add('hidden');
  $('homeBtn').classList.remove('hidden');
  $('subTitle').textContent = TOOLS[tool].title;

  if (tool === 'img') {
    state.view = 'img';
    $('pdfView').classList.add('hidden');
    $('imgView').classList.remove('hidden');
    imgReset();
    return;
  }
  // pdf tools
  state.view = 'pdf';
  state.mode = tool;
  $('imgView').classList.add('hidden');
  $('pdfView').classList.remove('hidden');
  $('dzHint').textContent = TOOLS[tool].hint;
  resetPdf();
}

function cancelActive() {
  if (state.processing) { try { api.cancel(); } catch (_) {} }
}

// --- PDF tools processing --------------------------------------------------
async function startProcessing(filePaths) {
  if (!filePaths || !filePaths.length) return;
  $('dropzone').classList.add('hidden');
  $('workarea').classList.remove('hidden');
  $('progressWrap').classList.remove('hidden');
  state.processing = true;
  updateSaveButton();
  try {
    await api.startProcessing(filePaths, state.mode);
  } catch (err) {
    toast(`Ошибка обработки: ${err.message || err}`, 'err');
  }
}

function registerEvents() {
  api.on('process:meta', (p) => {
    if (!state.processing) return;
    state.jobId = p.jobId;
    state.total += p.totalPages;
    updateProgress();
  });
  api.on('process:error', (p) => {
    toast(`Не удалось прочитать ${p.filePath}: ${p.message}`, 'err');
  });
  api.on('process:page', (p) => {
    if (p.jobId !== state.jobId) return;
    state.pages.set(p.pageId, {
      ...p,
      editNak: p.nakladnaya, editDog: p.dogovor,
      editName: (p.name || '').replace(/\.pdf$/i, ''),
    });
    state.done = p.done;
    renderCard(p.pageId);
    updateProgress();
    updateResultCount();
  });
  api.on('process:complete', (p) => {
    if (p.jobId !== state.jobId) return;
    state.processing = false;
    $('progressWrap').classList.add('hidden');
    updateSaveButton();
    toast('Обработка завершена. Проверьте значения и сохраните.', 'ok');
  });
}

function updateProgress() {
  const pct = state.total ? Math.round((state.done / state.total) * 100) : 0;
  $('progressBar').style.width = `${pct}%`;
  $('progressText').textContent = `Обработано ${state.done} из ${state.total} страниц…`;
}

// --- cards -----------------------------------------------------------------
function pageIndexOf(pageId) {
  const n = parseInt(String(pageId).split(':').pop(), 10);
  return Number.isFinite(n) ? n : 0;
}
function insertCardInOrder(card) {
  const idx = Number(card.dataset.index);
  const cards = $('cards');
  const after = [...cards.children].find((c) => Number(c.dataset.index) > idx);
  cards.insertBefore(card, after || null);
}

function fieldsHtml(rec) {
  if (state.mode === 'ttn') {
    return `
      <div class="row">
        <label class="small field">накладная
          <input data-f="nak" value="${escapeHtml(rec.editNak || '')}" placeholder="напр. 37" />
        </label>
        <label class="small field">договор
          <input data-f="dog" value="${escapeHtml(rec.editDog || '')}" placeholder="напр. SGN-158/25 или Перемещение" />
        </label>
      </div>`;
  }
  return `
    <label class="small field">имя файла
      <input data-f="name" value="${escapeHtml(rec.editName || '')}" placeholder="имя файла" />
    </label>`;
}

function renderCard(pageId) {
  const rec = state.pages.get(pageId);
  let card = document.querySelector(`[data-page="${pageId}"]`);
  if (!card) {
    card = document.createElement('div');
    card.className = 'card';
    card.dataset.page = pageId;
    card.dataset.index = String(pageIndexOf(pageId));
    insertCardInOrder(card);
  }
  const conf = rec.confidence || 'low';
  const confLabel = { high: 'высокая', medium: 'средняя', low: 'низкая' }[conf] || conf;
  const srcLabel = { ocr: 'OCR', ai: 'Claude AI', split: 'PDF', error: 'ошибка' }[rec.source] || rec.source;
  const preview = finalName(rec);
  const warn = preview.includes('NA') ? ' warn' : '';
  const showBadges = state.mode !== 'split';

  card.innerHTML = `
    <div class="thumb">${rec.thumb ? `<img src="${rec.thumb}" alt="страница" />` : '<span class="placeholder">нет превью</span>'}</div>
    <div class="body">
      <div class="meta">
        ${showBadges ? `<span class="badge ${conf}">${confLabel}</span>
        <span class="badge ${rec.source === 'ai' ? 'ai' : ''}">${srcLabel}</span>` : ''}
        <span class="src">${escapeHtml(rec.fileName)} · стр. ${rec.pageIndex + 1}</span>
      </div>
      ${fieldsHtml(rec)}
      <div class="fname">→ <span class="name${warn}">${escapeHtml(preview)}</span></div>
      ${rec.aiError ? `<div class="src" style="color:var(--red)">AI: ${escapeHtml(rec.aiError)}</div>` : ''}
      ${rec.error ? `<div class="src" style="color:var(--red)">${escapeHtml(rec.error)}</div>` : ''}
      <div class="actions">
        <button class="del-one" data-del title="Убрать из списка — эта страница не будет сохранена">🗑 Удалить</button>
        <button class="save-one" data-save>💾 Сохранить этот</button>
      </div>
    </div>`;

  const nak = card.querySelector('[data-f="nak"]');
  if (nak) nak.addEventListener('input', (e) => { rec.editNak = e.target.value; updatePreview(card, rec); });
  const dog = card.querySelector('[data-f="dog"]');
  if (dog) dog.addEventListener('input', (e) => { rec.editDog = e.target.value; updatePreview(card, rec); });
  const name = card.querySelector('[data-f="name"]');
  if (name) name.addEventListener('input', (e) => { rec.editName = e.target.value; updatePreview(card, rec); });

  const thumb = card.querySelector('.thumb');
  if (thumb) thumb.addEventListener('click', () => openZoom(pageId));
  const saveBtn = card.querySelector('[data-save]');
  if (saveBtn) saveBtn.addEventListener('click', () => saveOne(pageId));
  const delBtn = card.querySelector('[data-del]');
  if (delBtn) delBtn.addEventListener('click', () => removePage(pageId));
}

// Drop a processed page from the list so «Сохранить всё» skips it. The source
// PDF is untouched — this only removes the card/record from the review list.
function removePage(pageId) {
  state.pages.delete(pageId);
  const card = document.querySelector(`[data-page="${pageId}"]`);
  if (card) card.remove();
  if (state.zoomPageId === pageId) { state.zoomPageId = null; closeZoom(); }
  updateResultCount();
  updateSaveButton();
}

function updatePreview(card, rec) {
  const preview = finalName(rec);
  const el = card.querySelector('.name');
  el.textContent = preview;
  el.className = 'name' + (preview.includes('NA') ? ' warn' : '');
}

function syncCardInputs(rec) {
  const card = document.querySelector(`[data-page="${rec.pageId}"]`);
  if (!card) return;
  const nak = card.querySelector('[data-f="nak"]');
  const dog = card.querySelector('[data-f="dog"]');
  const name = card.querySelector('[data-f="name"]');
  if (nak) nak.value = rec.editNak || '';
  if (dog) dog.value = rec.editDog || '';
  if (name) name.value = rec.editName || '';
  updatePreview(card, rec);
}

// --- zoom / review modal ---------------------------------------------------
function updateZoomFilename(rec) {
  const preview = finalName(rec);
  const el = $('zoomFilename');
  el.textContent = preview;
  el.className = 'name' + (preview.includes('NA') ? ' warn' : '');
}

async function openZoom(pageId) {
  const rec = state.pages.get(pageId);
  if (!rec) return;
  state.zoomPageId = pageId;

  $('zoomTitle').textContent = `${rec.fileName} · стр. ${rec.pageIndex + 1}`;
  const conf = rec.confidence || 'low';
  const confLabel = { high: 'высокая', medium: 'средняя', low: 'низкая' }[conf] || conf;
  $('zoomBadges').innerHTML = state.mode === 'split' ? ''
    : `<span class="badge ${conf}">${escapeHtml(confLabel)}</span>`;

  if (state.mode === 'ttn') {
    $('zoomTtnFields').classList.remove('hidden');
    $('zoomNameField').classList.add('hidden');
    $('zoomNak').value = rec.editNak || '';
    $('zoomDog').value = rec.editDog || '';
  } else {
    $('zoomTtnFields').classList.add('hidden');
    $('zoomNameField').classList.remove('hidden');
    $('zoomName').value = rec.editName || '';
  }
  updateZoomFilename(rec);

  const img = $('zoomImg');
  const loading = $('zoomLoading');
  $('zoomImageWrap').classList.remove('actual');
  img.style.display = 'none';
  loading.style.display = '';
  loading.textContent = 'Загрузка изображения…';
  img.onload = () => { loading.style.display = 'none'; img.style.display = ''; };
  img.onerror = () => { loading.textContent = 'Не удалось загрузить изображение.'; };
  $('zoomModal').classList.remove('hidden');

  try {
    const dataUrl = await api.pageImage(rec.filePath, rec.pageIndex, rec.rotation || 0);
    if (state.zoomPageId !== pageId) return;
    img.src = dataUrl;
  } catch (err) {
    img.src = rec.thumb || '';
  }
}

function closeZoom() {
  $('zoomModal').classList.add('hidden');
  $('zoomImg').src = '';
  state.zoomPageId = null;
}

function onZoomEdit() {
  const rec = state.pages.get(state.zoomPageId);
  if (!rec) return;
  if (state.mode === 'ttn') {
    rec.editNak = $('zoomNak').value;
    rec.editDog = $('zoomDog').value;
  } else {
    rec.editName = $('zoomName').value;
  }
  updateZoomFilename(rec);
  syncCardInputs(rec);
}

// --- start over ------------------------------------------------------------
function resetPdf() {
  cancelActive();
  // Free the finished job in the main process so memory doesn't pile up
  // across batches (big batches were hanging the app on the second run).
  if (state.jobId && api.release) api.release(state.jobId);
  state.jobId = null;
  state.pages.clear();
  state.total = 0;
  state.done = 0;
  state.processing = false;
  state.zoomPageId = null;
  closeZoom();
  $('cards').innerHTML = '';
  $('progressWrap').classList.add('hidden');
  $('workarea').classList.add('hidden');
  $('dropzone').classList.remove('hidden');
  updateResultCount();
  updateSaveButton();
}

// --- saving (PDF tools) ----------------------------------------------------
function updateSaveButton() {
  $('saveBtn').disabled = state.processing || state.pages.size === 0 || !state.outputDir;
}

async function save() {
  if (!state.outputDir) return toast('Сначала выберите папку вывода.', 'err');
  const edits = [...state.pages.values()].map((r) => ({ pageId: r.pageId, name: finalName(r) }));
  $('saveBtn').disabled = true;
  try {
    const res = await api.save({ jobId: state.jobId, outputDir: state.outputDir, edits });
    let ok = 0, fail = 0;
    for (const r of res.results) {
      const card = document.querySelector(`[data-page="${r.pageId}"]`);
      if (card) card.classList.add(r.ok ? 'saved' : 'error');
      r.ok ? ok++ : fail++;
    }
    toast(`Сохранено ${ok} файлов${fail ? `, ошибок: ${fail}` : ''}. Папка: ${res.outputDir}`, fail ? 'err' : 'ok');
    api.openPath(res.outputDir);
  } catch (err) {
    toast(`Ошибка сохранения: ${err.message || err}`, 'err');
  } finally {
    updateSaveButton();
  }
}

async function saveOne(pageId) {
  if (!state.outputDir) return toast('Сначала выберите папку вывода.', 'err');
  const rec = state.pages.get(pageId);
  if (!rec) return;
  try {
    const res = await api.saveOne({
      jobId: state.jobId, pageId, outputDir: state.outputDir, name: finalName(rec),
    });
    const card = document.querySelector(`[data-page="${pageId}"]`);
    if (card) card.classList.add('saved');
    toast(`Сохранён ${res.name}`, 'ok');
  } catch (err) {
    toast(`Ошибка сохранения: ${err.message || err}`, 'err');
  }
}

function pluralFiles(n) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'файл';
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return 'файла';
  return 'файлов';
}
function updateResultCount() {
  const n = state.pages.size;
  const el = $('resultCount');
  if (!n) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = `Итого будет сохранено: <b>${n}</b> ${pluralFiles(n)}`;
}

// --- Image -> PDF tool -----------------------------------------------------
function imgReset() {
  imgState.items = [];
  $('imgCards').innerHTML = '';
  $('imgArea').classList.add('hidden');
  $('imgDrop').classList.remove('hidden');
  updateImgCount();
  updateImgSaveButton();
}

function imgShow(items) {
  if (!items || !items.length) return;
  for (const it of items) {
    imgState.items.push({ ...it, editName: (it.fileName || 'image').replace(/\.[^.]+$/, '') });
  }
  $('imgDrop').classList.add('hidden');
  $('imgArea').classList.remove('hidden');
  renderImgCards();
  updateImgCount();
  updateImgSaveButton();
}

function renderImgCards() {
  const wrap = $('imgCards');
  wrap.innerHTML = '';
  imgState.items.forEach((it, i) => {
    const card = document.createElement('div');
    card.className = 'card';
    const nameField = imgState.mode === 'each' ? `
      <label class="small field">имя файла
        <input data-i="${i}" value="${escapeHtml(it.editName)}" placeholder="имя файла" />
      </label>
      <div class="fname">→ <span class="name">${escapeHtml(ensurePdf(it.editName))}</span></div>` : '';
    card.innerHTML = `
      <div class="thumb">${it.thumb ? `<img src="${it.thumb}" alt="фото" />` : '<span class="placeholder">нет превью</span>'}</div>
      <div class="body">
        <div class="meta"><span class="src">${escapeHtml(it.fileName)}</span></div>
        ${nameField}
      </div>`;
    const inp = card.querySelector('input[data-i]');
    if (inp) inp.addEventListener('input', (e) => {
      it.editName = e.target.value;
      const el = card.querySelector('.name');
      if (el) el.textContent = ensurePdf(it.editName);
    });
    wrap.appendChild(card);
  });
}

function imgSetMode(mode) {
  imgState.mode = mode;
  $('imgModeOne').classList.toggle('active', mode === 'one');
  $('imgModeEach').classList.toggle('active', mode === 'each');
  $('combinedNameRow').style.display = mode === 'one' ? '' : 'none';
  renderImgCards();
}

function updateImgCount() {
  const n = imgState.items.length;
  const el = $('imgCount');
  if (!n) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const out = imgState.mode === 'one' ? '1 PDF' : `${n} ${pluralFiles(n)}`;
  el.innerHTML = `Изображений: <b>${n}</b> → на выходе ${out}`;
}
function updateImgSaveButton() {
  $('imgSaveBtn').disabled = imgState.items.length === 0 || !state.outputDir;
}

async function imgPick() {
  const items = await api.pickImages();
  imgShow(items);
}

async function imgSave() {
  if (!state.outputDir) return toast('Сначала выберите папку вывода.', 'err');
  $('imgSaveBtn').disabled = true;
  try {
    const res = await api.saveImages({
      images: imgState.items.map((i) => ({ filePath: i.filePath, name: i.editName })),
      mode: imgState.mode,
      outputDir: state.outputDir,
      combinedName: $('combinedName').value,
    });
    const ok = res.results.filter((r) => r.ok).length;
    const fail = res.results.length - ok;
    toast(`Сохранено ${ok} PDF${fail ? `, ошибок: ${fail}` : ''}. Папка: ${res.outputDir}`, fail ? 'err' : 'ok');
    api.openPath(res.outputDir);
  } catch (err) {
    toast(`Ошибка сохранения: ${err.message || err}`, 'err');
  } finally {
    updateImgSaveButton();
  }
}

// --- settings --------------------------------------------------------------
async function openSettings() {
  const s = await api.getSettings();
  $('apiKey').value = s.apiKey || '';
  $('model').value = s.model || '';
  $('useAiFallback').checked = !!s.useAiFallback;
  $('aiOnConfidence').value = s.aiOnConfidence || 'low';
  $('settingsModal').classList.remove('hidden');
}
async function saveSettings() {
  await api.setSettings({
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim() || 'claude-opus-4-8',
    useAiFallback: $('useAiFallback').checked,
    aiOnConfidence: $('aiOnConfidence').value,
  });
  $('settingsModal').classList.add('hidden');
  toast('Настройки сохранены.', 'ok');
}

// --- database screens: контрагенты / продукты ------------------------------
const CONTRACTOR_FIELDS = [
  { key: 'name', label: 'Название', ph: 'напр. SANOAT ENERGETIKA GURUHI' },
  { key: 'form', label: 'Форма', ph: 'МЧЖ / ҚК МЧЖ / АЖ …' },
  { key: 'director', label: 'Директор (ФИО)', ph: 'напр. Смирнов Т.В.' },
  { key: 'directorTitle', label: 'Должность директора', ph: 'директор / бош директор' },
  { key: 'directorBasis', label: 'Действует на основании', type: 'toggle',
    options: [['ustav', 'по уставу'], ['dover', 'по доверенности']] },
  { key: 'address', label: 'Адрес', ph: 'юридический адрес' },
  { key: 'bank', label: 'Банк', ph: 'напр. АКБ «Узсаноаткурилишбанк»' },
  { key: 'account', label: 'Расчётный счёт', ph: '2021 4000 …' },
  { key: 'mfo', label: 'МФО', ph: '00440' },
  { key: 'inn', label: 'ИНН (СТИР)', ph: '304936120' },
  { key: 'oked', label: 'ИФУТ / ОКЭД', ph: 'необязательно' },
  { key: 'vat', label: 'РКП НДС', ph: '326040004278' },
  { key: 'phone', label: 'Телефон', ph: '(78) 150-00-57' },
];
const PRODUCT_FIELDS = [
  { key: 'name', label: 'Наименование', ph: 'напр. Бензин АИ-95-К4' },
  { key: 'pricePerTon', label: 'Цена за тонну (сум)', type: 'number', ph: '19 500 000' },
];

const dbState = { entity: 'contractors', company: 'SEGNUM', items: [], editId: null };

function fieldsFor() { return dbState.entity === 'contractors' ? CONTRACTOR_FIELDS : PRODUCT_FIELDS; }

async function openDb(entity) {
  dbState.entity = entity;
  dbState.editId = null;
  $('homeView').classList.add('hidden');
  $('homeBtn').classList.remove('hidden');
  for (const id of ['pdfView', 'imgView', 'contractView']) $(id).classList.add('hidden');
  $('dbView').classList.remove('hidden');
  state.view = 'db';
  $('subTitle').textContent = entity === 'contractors' ? 'Контрагенты' : 'Продукты';
  $('dbCompanySwitch').classList.toggle('hidden', entity !== 'contractors');
  await dbReload();
}

async function dbReload() {
  dbState.items = dbState.entity === 'contractors'
    ? await api.db.contractors(dbState.company)
    : await api.db.products();
  renderDbList();
}

function money(v) {
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n.toLocaleString('ru-RU') : (v || '');
}

function renderDbList() {
  const wrap = $('dbList');
  wrap.innerHTML = '';
  if (!dbState.items.length) {
    $('dbEmpty').classList.remove('hidden');
    $('dbEmpty').textContent = 'Пока пусто. Нажмите «＋ Добавить».';
    return;
  }
  $('dbEmpty').classList.add('hidden');
  for (const rec of dbState.items) {
    const row = document.createElement('div');
    row.className = 'db-row';
    const sub = dbState.entity === 'contractors'
      ? [rec.director, rec.inn && `ИНН ${rec.inn}`, rec.bank].filter(Boolean).join(' · ')
      : `${money(rec.pricePerTon)} сум/тн`;
    row.innerHTML = `
      <div class="db-main">
        <div class="db-name">${escapeHtml(rec.name || '—')}</div>
        <div class="db-sub">${escapeHtml(sub)}</div>
      </div>
      <div class="db-actions">
        <button class="ghost" data-edit>✎</button>
        <button class="ghost" data-del>🗑</button>
      </div>`;
    row.querySelector('[data-edit]').addEventListener('click', () => openDbEditor(rec));
    row.querySelector('[data-del]').addEventListener('click', () => dbDelete(rec));
    wrap.appendChild(row);
  }
}

function openDbEditor(rec) {
  dbState.editId = rec ? rec.id : null;
  rec = rec || {};
  $('dbModalTitle').textContent = (dbState.entity === 'contractors' ? 'Контрагент' : 'Продукт')
    + (dbState.editId ? '' : ' — новый');
  const form = $('dbForm');
  form.innerHTML = fieldsFor().map((f) => {
    const v = rec[f.key] == null ? '' : rec[f.key];
    if (f.type === 'toggle') {
      const cur = v || f.options[0][0];
      return `<div class="field"><span>${f.label}</span><div class="seg" data-toggle="${f.key}">${
        f.options.map(([val, lbl]) =>
          `<button class="seg-btn${cur === val ? ' active' : ''}" data-val="${val}">${lbl}</button>`).join('')
      }</div></div>`;
    }
    return `<label class="field"><span>${f.label}</span>
      <input data-k="${f.key}" type="text" inputmode="${f.type === 'number' ? 'numeric' : 'text'}"
        value="${escapeHtml(v)}" placeholder="${escapeHtml(f.ph || '')}" /></label>`;
  }).join('');
  form.querySelectorAll('[data-toggle]').forEach((seg) => {
    seg.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => {
      seg.querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    }));
  });
  $('dbModal').classList.remove('hidden');
}

function collectDbForm() {
  const data = dbState.editId ? { id: dbState.editId } : {};
  for (const f of fieldsFor()) {
    if (f.type === 'toggle') {
      const active = $('dbForm').querySelector(`[data-toggle="${f.key}"] .seg-btn.active`);
      data[f.key] = active ? active.dataset.val : f.options[0][0];
    } else {
      data[f.key] = $('dbForm').querySelector(`[data-k="${f.key}"]`).value.trim();
    }
  }
  return data;
}

async function dbSave() {
  const data = collectDbForm();
  if (!data.name) return toast('Укажите название.', 'err');
  if (dbState.entity === 'contractors') await api.db.saveContractor(dbState.company, data);
  else await api.db.saveProduct(data);
  $('dbModal').classList.add('hidden');
  await dbReload();
  toast('Сохранено.', 'ok');
}

async function dbDelete(rec) {
  if (dbState.entity === 'contractors') await api.db.deleteContractor(dbState.company, rec.id);
  else await api.db.deleteProduct(rec.id);
  await dbReload();
  toast('Удалено.', 'ok');
}

// --- contract drafting: Оформление договора --------------------------------
const cState = { company: 'SEGNUM', contractors: [], products: [], types: {} };

// Виды договора — шаблоны № договора. {n} — номер (цифры из поля), {yy} — год
// (2 цифры из даты заключения). Пользователь может добавить свой вид (сохранится).
const DEFAULT_TYPES = {
  SEGNUM: ['SGN-{n}/{yy}', 'SGN-{n}/{yy}-P', 'SGN-{n}/{yy}-K'],
  'SEG TASCO': ['{n}/{yy}-TASCO', 'ST-{n}/{yy}-KS', 'ST-{n}/{yy}-K'],
};
// Пункт отгрузки — пока два варианта; текст в договоре донастроим позже.
const SHIPMENTS = [
  { label: '— как в шаблоне —', value: '' },
  { label: 'Чиноз', value: 'терминал Чиноз' },
  { label: 'ФНПЗ', value: 'Фарғона НПЗ' },
];

function contractYear2() {
  const v = $('cDate').value;
  const y = v ? new Date(v).getFullYear() : new Date().getFullYear();
  return String(y % 100).padStart(2, '0');
}
function buildContractNumber() {
  const pattern = $('cType').value || '';
  const digits = String($('cNumber').value).replace(/\D/g, '');
  return pattern.replace(/\{n\}/gi, digits).replace(/\{yy\}/gi, contractYear2());
}
function updateNumberPreview() {
  const full = buildContractNumber();
  const digits = String($('cNumber').value).replace(/\D/g, '');
  $('cNumberPreview').textContent = digits ? `→ ${full}` : '';
}

// Адресаты служебной записки (из реальных образцов). Обращение подставляется
// автоматически по выбранному адресату.
const ADDRESSEES = {
  SEGNUM: [
    { komu: 'Директору ООО «SEGNUM» Закирову Ш.Ш.', greet: 'Уважаемый Шерзод Шавкатович!' },
  ],
  'SEG TASCO': [
    { komu: 'Генеральному директору ООО «SEG TASCO» Шерназарову У.Э.', greet: 'Уважаемый Улугбек Элмурадович!' },
    { komu: 'Исполнительному директору ООО «SEG TASCO» Закирову Ш.Ш.', greet: 'Уважаемый Шерзод Шавкатович!' },
  ],
};

function refreshAddressees() {
  const list = ADDRESSEES[cState.company] || [];
  $('cAddressee').innerHTML = list.map((a, i) => `<option value="${i}">${escapeHtml(a.komu)}</option>`).join('');
}

// Основание в служебной записке — зависит от компании/вида (текст «в счёт …»).
function refreshZapiskaBasis() {
  const co = cState.company;
  const own = `в счет прогнозных выработок из собственного сырья ООО «${co}» на Ферганском НПЗ`;
  const opts = [
    ['в счет собственных импортных объёмов', 'в счёт собственных импортных объёмов'],
    [own, 'в счёт прогнозных выработок (собственное сырьё)'],
  ];
  $('cBasis').innerHTML = opts.map(([v, l]) => `<option value="${escapeHtml(v)}">${escapeHtml(l)}</option>`).join('');
  $('cBasis').value = co === 'SEGNUM' ? opts[0][0] : opts[1][0];
}

function groupMoney(n) {
  n = Math.round(Math.abs(Number(n) || 0));
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

async function openContract() {
  $('homeView').classList.add('hidden');
  $('dbView').classList.add('hidden');
  for (const id of ['pdfView', 'imgView']) $(id).classList.add('hidden');
  $('homeBtn').classList.remove('hidden');
  $('contractView').classList.remove('hidden');
  state.view = 'contract';
  $('subTitle').textContent = 'Оформление договора';
  if (!$('cContractorFields').children.length) renderContractorFields();
  if (!$('cShipment').children.length) {
    $('cShipment').innerHTML = SHIPMENTS.map((s) => `<option value="${escapeHtml(s.value)}">${escapeHtml(s.label)}</option>`).join('');
  }
  let all = await api.db.all();
  // Seed default contract types the first time each company is empty.
  let seeded = false;
  for (const co of Object.keys(DEFAULT_TYPES)) {
    if (!(all.contractTypes[co] || []).length) {
      for (const t of DEFAULT_TYPES[co]) await api.db.addContractType(co, t);
      seeded = true;
    }
  }
  if (seeded) all = await api.db.all();
  cState.contractors = all.contractors;
  cState.products = all.products;
  cState.types = all.contractTypes;
  if (!$('cDate').value) $('cDate').value = new Date().toISOString().slice(0, 10);
  refreshContractLists();
  refreshAddressees();
  refreshZapiskaBasis();
}

function renderContractorFields() {
  $('cContractorFields').innerHTML = CONTRACTOR_FIELDS.map((f) => {
    if (f.type === 'toggle') {
      return `<div class="field"><span>${f.label}</span><div class="seg" data-cf-toggle="${f.key}">${
        f.options.map(([val, lbl], i) =>
          `<button class="seg-btn${i === 0 ? ' active' : ''}" data-val="${val}">${lbl}</button>`).join('')
      }</div></div>`;
    }
    return `<label class="field"><span>${f.label}</span>
      <input data-cf="${f.key}" placeholder="${escapeHtml(f.ph || '')}" /></label>`;
  }).join('');
  $('cContractorFields').querySelectorAll('[data-cf-toggle]').forEach((seg) =>
    seg.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => {
      seg.querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    })));
}

function refreshContractLists() {
  // contractors for the current company
  const cs = cState.contractors[cState.company] || [];
  $('cContractorSel').innerHTML = '<option value="">— ввести вручную —</option>'
    + cs.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  // products (shared)
  $('cProductSel').innerHTML = '<option value="">— ввести вручную —</option>'
    + cState.products.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  // contract types (виды договора) for the company
  const types = (cState.types && cState.types[cState.company]) || [];
  const cur = $('cType').value;
  $('cType').innerHTML = types.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  if (types.includes(cur)) $('cType').value = cur;
  updateNumberPreview();
}

function setContractorFields(c) {
  for (const f of CONTRACTOR_FIELDS) {
    if (f.type === 'toggle') {
      const val = (c && c[f.key]) || f.options[0][0];
      $('cContractorFields').querySelectorAll(`[data-cf-toggle="${f.key}"] .seg-btn`).forEach((b) =>
        b.classList.toggle('active', b.dataset.val === val));
    } else {
      const inp = $('cContractorFields').querySelector(`[data-cf="${f.key}"]`);
      if (inp) inp.value = (c && c[f.key]) || '';
    }
  }
}

function collectContractor() {
  const c = {};
  for (const f of CONTRACTOR_FIELDS) {
    if (f.type === 'toggle') {
      const active = $('cContractorFields').querySelector(`[data-cf-toggle="${f.key}"] .seg-btn.active`);
      c[f.key] = active ? active.dataset.val : f.options[0][0];
    } else {
      c[f.key] = $('cContractorFields').querySelector(`[data-cf="${f.key}"]`).value.trim();
    }
  }
  const sel = $('cContractorSel').value;
  if (sel) c.id = sel;
  return c;
}

function openAddType() {
  $('typeInput').value = '';
  $('typeModal').classList.remove('hidden');
  $('typeInput').focus();
}
async function saveNewType() {
  const t = $('typeInput').value.trim();
  if (!t) return toast('Введите шаблон.', 'err');
  await api.db.addContractType(cState.company, t);
  cState.types = (await api.db.all()).contractTypes;
  $('typeModal').classList.add('hidden');
  refreshContractLists();
  $('cType').value = t;
  updateNumberPreview();
  toast('Вид договора добавлен.', 'ok');
}

function updateContractSummary() {
  const qty = Number(String($('cQty').value).replace(/\s/g, '').replace(',', '.'));
  const price = Number(String($('cPrice').value).replace(/\s/g, '').replace(',', '.'));
  const el = $('cSummary');
  if (!qty || !price) { el.textContent = 'Итоговая сумма: —'; return; }
  const sum = Math.round(qty * price);
  el.innerHTML = `Итоговая сумма: <b>${groupMoney(sum)},00</b> сум<br>`
    + `<span class="muted">прописью: ${escapeHtml(api.amountUz(sum))} сўм</span>`;
}

async function generateContractDocs() {
  const company = cState.company;
  const contractor = collectContractor();
  const digits = String($('cNumber').value).replace(/\D/g, '');
  const data = {
    company,
    contractType: $('cType').value.trim(),
    number: buildContractNumber(),
    date: $('cDate').value,
    shipment: $('cShipment').value,
    counterparty: contractor,
    product: $('cProduct').value.trim(),
    pricePerTon: Number(String($('cPrice').value).replace(/\s/g, '').replace(',', '.')),
    qty: Number(String($('cQty').value).replace(/\s/g, '').replace(',', '.')),
    akciz: $('cAkciz').querySelector('.seg-btn.active').dataset.v === 'yes',
    manufacturer: $('cP13').value === 'yes',
    addressee: (ADDRESSEES[company] || [])[Number($('cAddressee').value) || 0],
    requestNo: $('cRequestNo').value.trim(),
    zapiskaBasis: $('cBasis').value,
    outputDir: state.outputDir,
  };
  if (!digits) return toast('Укажите № договора (цифры).', 'err');
  if (!$('cType').value) return toast('Выберите вид договора.', 'err');
  if (!data.date) return toast('Укажите дату заключения.', 'err');
  if (!contractor.name) return toast('Укажите наименование контрагента.', 'err');
  if (!data.product) return toast('Укажите наименование товара.', 'err');
  if (!data.qty || !data.pricePerTon) return toast('Укажите объём и цену за тонну.', 'err');
  if (!data.outputDir) return toast('Сначала выберите папку вывода.', 'err');

  $('cGenerate').disabled = true;
  try {
    const res = await api.generateContract(data);
    toast(`Готово: ${res.files.length} документ(ов). Папка: ${res.folder}`, 'ok');
    api.openPath(res.folder);
    // refresh lists (new autosaved entries)
    const all = await api.db.all();
    cState.contractors = all.contractors; cState.products = all.products; cState.types = all.contractTypes;
    refreshContractLists();
  } catch (err) {
    toast(`Ошибка формирования: ${err.message || err}`, 'err');
  } finally {
    $('cGenerate').disabled = false;
  }
}

// --- output folder (shared) ------------------------------------------------
function setOutputDir(dir) {
  state.outputDir = dir;
  for (const id of ['outDirLabel', 'imgOutDirLabel', 'cOutLabel']) {
    const el = $(id);
    if (el) { el.textContent = dir; el.classList.remove('muted'); }
  }
  updateSaveButton();
  updateImgSaveButton();
}
async function pickOutput() {
  const dir = await api.pickOutputDir();
  if (dir) setOutputDir(dir);
}

// --- pickers & drag/drop ---------------------------------------------------
async function pickFiles() {
  const files = await api.pickFiles();
  if (files.length) startProcessing(files);
}

function wireDropzone() {
  const marks = ['dragenter', 'dragover'];
  const clears = ['dragleave', 'drop'];
  for (const dz of [$('dropzone'), $('imgDrop')]) {
    marks.forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
    clears.forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  }
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files || [])];
    if (state.view === 'img') {
      const imgs = files.filter((f) => /\.(jpe?g|png)$/i.test(f.name)).map((f) => f.path).filter(Boolean);
      // Dropped image paths need previews; route through the same handler as the picker.
      if (imgs.length) imgShow(imgs.map((p) => ({ filePath: p, fileName: p.split(/[\\/]/).pop(), thumb: '' })));
    } else if (state.view === 'pdf') {
      const paths = files.filter((f) => f.name.toLowerCase().endsWith('.pdf')).map((f) => f.path).filter(Boolean);
      if (paths.length) startProcessing(paths);
    }
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  if (!api || typeof api.on !== 'function') {
    showFatal('Приложение не инициализировалось (мост preload недоступен). ' +
      'Переустановите/обновите приложение до последней версии.');
    return;
  }

  wireDropzone();
  document.querySelectorAll('.tile').forEach((t) =>
    t.addEventListener('click', () => {
      const tool = t.dataset.tool;
      if (tool === 'contractors' || tool === 'products') openDb(tool);
      else if (tool === 'contract') openContract();
      else openTool(tool);
    }));
  $('homeBtn').addEventListener('click', showHome);

  // Contract drafting
  $('cCompany').querySelectorAll('.seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      $('cCompany').querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      cState.company = b.dataset.company;
      $('cContractorSel').value = '';
      setContractorFields(null);
      refreshContractLists();
      refreshAddressees();
      refreshZapiskaBasis();
    }));
  $('cContractorSel').addEventListener('change', (e) => {
    const c = (cState.contractors[cState.company] || []).find((x) => x.id === e.target.value);
    setContractorFields(c || null);
  });
  $('cProductSel').addEventListener('change', (e) => {
    const p = cState.products.find((x) => x.id === e.target.value);
    if (p) { $('cProduct').value = p.name; $('cPrice').value = groupMoney(p.pricePerTon); updateContractSummary(); }
  });
  $('cAkciz').querySelectorAll('.seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      $('cAkciz').querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    }));
  $('cQty').addEventListener('input', updateContractSummary);
  $('cPrice').addEventListener('input', updateContractSummary);
  $('cType').addEventListener('change', updateNumberPreview);
  $('cNumber').addEventListener('input', updateNumberPreview);
  $('cDate').addEventListener('change', updateNumberPreview);
  $('cAddType').addEventListener('click', openAddType);
  $('typeSave').addEventListener('click', saveNewType);
  $('typeCancel').addEventListener('click', () => $('typeModal').classList.add('hidden'));
  $('typeModal').addEventListener('click', (e) => { if (e.target.id === 'typeModal') $('typeModal').classList.add('hidden'); });
  $('cPickOut').addEventListener('click', pickOutput);
  $('cGenerate').addEventListener('click', generateContractDocs);

  // Database screens
  $('dbAddBtn').addEventListener('click', () => openDbEditor(null));
  $('dbSave').addEventListener('click', dbSave);
  $('dbCancel').addEventListener('click', () => $('dbModal').classList.add('hidden'));
  $('dbModal').addEventListener('click', (e) => { if (e.target.id === 'dbModal') $('dbModal').classList.add('hidden'); });
  $('dbCompanySwitch').querySelectorAll('.seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      $('dbCompanySwitch').querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      dbState.company = b.dataset.company;
      dbReload();
    }));

  $('pickBtn').addEventListener('click', pickFiles);
  $('restartBtn').addEventListener('click', resetPdf);
  $('pickOutBtn').addEventListener('click', pickOutput);
  $('saveBtn').addEventListener('click', save);
  $('settingsBtn').addEventListener('click', openSettings);
  $('settingsSave').addEventListener('click', saveSettings);
  $('settingsCancel').addEventListener('click', () => $('settingsModal').classList.add('hidden'));

  // Image tool
  $('imgPickBtn').addEventListener('click', imgPick);
  $('imgRestartBtn').addEventListener('click', imgReset);
  $('imgPickOutBtn').addEventListener('click', pickOutput);
  $('imgSaveBtn').addEventListener('click', imgSave);
  $('imgModeOne').addEventListener('click', () => imgSetMode('one'));
  $('imgModeEach').addEventListener('click', () => imgSetMode('each'));

  // Zoom modal
  $('zoomClose').addEventListener('click', closeZoom);
  $('zoomNak').addEventListener('input', onZoomEdit);
  $('zoomDog').addEventListener('input', onZoomEdit);
  $('zoomName').addEventListener('input', onZoomEdit);
  $('zoomImageWrap').addEventListener('click', () => $('zoomImageWrap').classList.toggle('actual'));
  $('zoomModal').addEventListener('click', (e) => { if (e.target.id === 'zoomModal') closeZoom(); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('zoomModal').classList.contains('hidden')) closeZoom();
  });

  registerEvents();

  try {
    const s = await api.getSettings();
    if (s && s.lastOutputDir) setOutputDir(s.lastOutputDir);
  } catch (err) {
    showFatal('Не удалось загрузить настройки: ' + (err.message || err));
  }
});
})();
