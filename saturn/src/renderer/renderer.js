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
  if (typeof hideSplash === 'function') hideSplash(); // never hide errors behind the loader
}
window.addEventListener('error', (e) =>
  showFatal('Ошибка интерфейса: ' + (e.message || e.error)));
window.addEventListener('unhandledrejection', (e) =>
  showFatal('Ошибка: ' + (e.reason && (e.reason.message || e.reason))));

// Startup loader: keep the animated logo on screen for at least a moment so it
// doesn't flash, then fade it out. Idempotent, and revealed on any fatal error.
const SPLASH_MIN_MS = 1500;
const splashStart = Date.now();
let splashHidden = false;
function hideSplash() {
  if (splashHidden) return;
  splashHidden = true;
  const el = document.getElementById('splash');
  if (!el) return;
  const wait = Math.max(0, SPLASH_MIN_MS - (Date.now() - splashStart));
  setTimeout(() => {
    el.classList.add('hide');
    setTimeout(() => el.remove(), 500); // after the CSS fade
  }, wait);
}
// Safety net: never let the loader get stuck, whatever happens during init.
setTimeout(hideSplash, 8000);

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
  merge: { title: 'Объединить PDF', hint: '' },
  sort: { title: 'Сортировка накладных', hint: '' },
  compress: { title: 'Сжатие PDF', hint: '' },
};

const state = {
  view: 'home',   // 'home' | 'pdf' | 'img'
  mode: 'ttn',    // pdf tool: 'ttn' | 'split' | 'approval'
  jobId: null,
  outputDir: '',
  staged: [],     // file paths chosen, awaiting «Начать обработку»
  undo: [],       // stack of {label, undo} for «↶ Отменить»
  paused: false,  // TTN processing paused by the user
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
  hideProcLoader();
  state.view = 'home';
  $('homeView').classList.remove('hidden');
  $('pdfView').classList.add('hidden');
  $('imgView').classList.add('hidden');
  $('mergeView').classList.add('hidden');
  $('sortView').classList.add('hidden');
  $('compressView').classList.add('hidden');
  $('homeBtn').classList.add('hidden');
  $('subTitle').textContent = 'Набор инструментов для документов';
}

function openTool(tool) {
  $('homeView').classList.add('hidden');
  $('homeBtn').classList.remove('hidden');
  $('subTitle').textContent = TOOLS[tool].title;

  if (tool === 'img') {
    state.view = 'img';
    $('pdfView').classList.add('hidden');
    $('mergeView').classList.add('hidden');
    $('imgView').classList.remove('hidden');
    imgReset();
    return;
  }
  if (tool === 'merge') {
    state.view = 'merge';
    $('pdfView').classList.add('hidden');
    $('imgView').classList.add('hidden');
    $('sortView').classList.add('hidden');
    $('mergeView').classList.remove('hidden');
    mergeReset();
    return;
  }
  if (tool === 'sort') {
    state.view = 'sort';
    $('pdfView').classList.add('hidden');
    $('imgView').classList.add('hidden');
    $('mergeView').classList.add('hidden');
    $('compressView').classList.add('hidden');
    $('sortView').classList.remove('hidden');
    sortReset();
    return;
  }
  if (tool === 'compress') {
    state.view = 'compress';
    $('pdfView').classList.add('hidden');
    $('imgView').classList.add('hidden');
    $('mergeView').classList.add('hidden');
    $('sortView').classList.add('hidden');
    $('compressView').classList.remove('hidden');
    cmpReset();
    return;
  }
  // pdf tools
  state.view = 'pdf';
  state.mode = tool;
  $('imgView').classList.add('hidden');
  $('mergeView').classList.add('hidden');
  $('sortView').classList.add('hidden');
  $('compressView').classList.add('hidden');
  $('pdfView').classList.remove('hidden');
  $('dzHint').textContent = TOOLS[tool].hint;
  resetPdf();
}

function cancelActive() {
  if (state.processing) { try { api.cancel(); } catch (_) {} }
}

// --- PDF tools: staging (choose files → review → start) --------------------
// Files are NOT processed on drop/pick. They collect in a staging list so the
// user can see the selection, add more, then press «Начать обработку».
function stagePdf(paths) {
  const added = (paths || []).filter((p) => p && !state.staged.includes(p));
  if (!added.length && !state.staged.length) return;
  state.staged.push(...added);
  $('dropzone').classList.add('hidden');
  $('workarea').classList.add('hidden');
  $('stageArea').classList.remove('hidden');
  renderStage();
}

function baseName(p) {
  return String(p).split(/[\\/]/).pop();
}

function renderStage() {
  const n = state.staged.length;
  $('stageCount').innerHTML = `Выбрано: <b>${n}</b> ${pluralFiles(n)}. Добавьте ещё при необходимости и нажмите «Начать обработку».`;
  const list = $('stageList');
  list.innerHTML = '';
  state.staged.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'stage-file';
    row.innerHTML = `
      <span class="doc-icon">📄</span>
      <span class="fname-txt">${escapeHtml(baseName(p))}</span>
      <button class="del-one" data-i="${i}" title="Убрать из списка">🗑</button>`;
    row.querySelector('[data-i]').addEventListener('click', () => removeStaged(i));
    list.appendChild(row);
  });
}

function removeStaged(i) {
  state.staged.splice(i, 1);
  if (!state.staged.length) return clearStage();
  renderStage();
}

function clearStage() {
  state.staged = [];
  $('stageArea').classList.add('hidden');
  $('dropzone').classList.remove('hidden');
}

async function stageAddFiles() {
  const files = await api.pickFiles();
  if (files.length) stagePdf(files);
}

// --- PDF tools processing --------------------------------------------------
async function startProcessing(filePaths) {
  if (!filePaths || !filePaths.length) return;
  $('dropzone').classList.add('hidden');
  $('stageArea').classList.add('hidden');
  $('workarea').classList.remove('hidden');
  $('progressWrap').classList.remove('hidden');
  state.processing = true;
  state.paused = false;
  clearUndo(); // a fresh batch — old undo entries reference the previous run
  showProcLoader();
  updatePauseButton();
  updateSaveButton();
  try {
    await api.startProcessing(filePaths, state.mode);
  } catch (err) {
    state.processing = false;
    state.paused = false;
    hideProcLoader();
    updatePauseButton();
    toast(`Ошибка обработки: ${err.message || err}`, 'err');
  }
}

function showProcLoader() { $('procLoader').classList.add('on'); }
function hideProcLoader() { $('procLoader').classList.remove('on'); }

// Pause / resume the running batch. Pages already in flight finish; no NEW
// pages start until resumed.
async function togglePause() {
  if (!state.processing) return;
  state.paused = !state.paused;
  updatePauseButton();
  try {
    if (state.paused) {
      await api.pause();
      hideProcLoader(); // stop the "working" watermark while on hold
      toast('Обработка приостановлена. Уже начатые страницы допишутся.', 'ok');
    } else {
      await api.resume();
      showProcLoader();
      toast('Обработка продолжена.', 'ok');
    }
  } catch (err) {
    toast(`Ошибка: ${err.message || err}`, 'err');
  }
}
function updatePauseButton() {
  const b = $('pauseBtn');
  if (!b) return;
  b.classList.toggle('hidden', !state.processing);
  b.textContent = state.paused ? '▶ Продолжить' : '⏸ Пауза';
  b.classList.toggle('primary', state.paused); // stand out while paused
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
  api.on('compress:progress', (p) => {
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    $('cmpProgressBar').style.width = `${pct}%`;
    const pageInfo = p.page ? ` (стр. ${p.page}/${p.pageTotal})` : '';
    $('cmpProgressText').textContent = `Сжатие ${p.done + 1} из ${p.total}: ${p.fileName}${pageInfo}`;
  });
  api.on('process:complete', (p) => {
    if (p.jobId !== state.jobId) return;
    state.processing = false;
    state.paused = false;
    hideProcLoader();
    updatePauseButton();
    sortCards(); // low → medium → high, then page order (done once, not per card)
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
// Cards are ordered by confidence first (низкая → средняя → высокая) so the
// pages that need checking float to the top, then by original page order.
// During processing cards are simply appended (O(1) each — scanning all cards
// on every insert made big batches lag badly, O(n²)); the final order is
// applied once with sortCards() when the batch finishes.
const CONF_RANK = { low: 0, medium: 1, high: 2 };
function confRank(rec) {
  return CONF_RANK[(rec && rec.confidence) || 'low'] ?? 0;
}
function sortCards() {
  const cards = $('cards');
  const ordered = [...cards.children].sort((a, b) =>
    (Number(a.dataset.confrank) - Number(b.dataset.confrank))
    || (Number(a.dataset.index) - Number(b.dataset.index)));
  const frag = document.createDocumentFragment();
  ordered.forEach((c) => frag.appendChild(c));
  cards.appendChild(frag);
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
    card.dataset.confrank = String(confRank(rec));
    $('cards').appendChild(card); // append now; sortCards() orders once at the end
  }
  const conf = rec.confidence || 'low';
  const confLabel = { high: 'высокая', medium: 'средняя', low: 'низкая' }[conf] || conf;
  const srcLabel = { ocr: 'OCR', ai: 'Claude AI', split: 'PDF', error: 'ошибка' }[rec.source] || rec.source;
  const preview = finalName(rec);
  const warn = preview.includes('NA') ? ' warn' : '';
  const showBadges = state.mode !== 'split';
  // Set by the ТТН pipeline when no waybill markers were found at any
  // orientation — most likely a stray page that got into the batch.
  const notWaybill = state.mode === 'ttn' && rec.looksLikeWaybill === false;

  card.innerHTML = `
    <div class="thumb">${rec.thumb ? `<img src="${rec.thumb}" alt="страница" />` : '<span class="placeholder">нет превью</span>'}</div>
    <div class="body">
      <div class="meta">
        ${showBadges ? `<span class="badge ${conf}">${confLabel}</span>
        <span class="badge ${rec.source === 'ai' ? 'ai' : ''}">${srcLabel}</span>` : ''}
        ${notWaybill ? '<span class="badge notttn" title="На странице не найдено признаков накладной (ни на одном повороте). Похоже, это посторонний документ — проверьте и удалите его из списка.">не похоже на ТТН</span>' : ''}
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

// --- undo (last action) ----------------------------------------------------
// A small stack of reversible actions. Each entry knows how to put things back.
function pushUndo(label, undoFn) {
  state.undo.push({ label, undo: undoFn });
  updateUndoButton();
}
function performUndo() {
  const action = state.undo.pop();
  if (!action) return;
  action.undo();
  updateUndoButton();
  toast(`Отменено: ${action.label}`, 'ok');
}
function clearUndo() {
  state.undo = [];
  updateUndoButton();
}
function updateUndoButton() {
  const b = $('undoBtn');
  if (b) b.classList.toggle('hidden', state.undo.length === 0);
}

// Drop a processed page from the list so «Сохранить всё» skips it. The source
// PDF is untouched — this only removes the card/record from the review list.
// Reversible via «↶ Отменить»: the card node and its record are kept so undo
// can put the card back exactly where it was.
function removePage(pageId) {
  const rec = state.pages.get(pageId);
  const card = document.querySelector(`[data-page="${pageId}"]`);
  const parent = card ? card.parentNode : $('cards');
  const nextSibling = card ? card.nextSibling : null;

  state.pages.delete(pageId);
  if (card) card.remove();
  if (state.zoomPageId === pageId) { state.zoomPageId = null; closeZoom(); }
  updateResultCount();
  updateSaveButton();

  if (rec) {
    pushUndo('удаление карточки', () => {
      state.pages.set(pageId, rec);
      if (card) {
        const before = nextSibling && nextSibling.parentNode === parent ? nextSibling : null;
        parent.insertBefore(card, before); // same spot if the neighbour is still there
      }
      updateResultCount();
      updateSaveButton();
    });
    toast('Карточка убрана. «↶ Отменить» — вернуть.', 'ok');
  }
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
  const notWaybill = state.mode === 'ttn' && rec.looksLikeWaybill === false;
  $('zoomBadges').innerHTML = (state.mode === 'split' ? ''
    : `<span class="badge ${conf}">${escapeHtml(confLabel)}</span>`)
    + (notWaybill ? '<span class="badge notttn" title="Признаков накладной не найдено ни на одном повороте">не похоже на ТТН</span>' : '');

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
  updateZoomNav(pageId);

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

// Order of cards as shown on screen (the DOM order in #cards).
function orderedPageIds() {
  return [...$('cards').children].map((c) => c.dataset.page);
}

// Enable/disable the side arrows and refresh the «N / всего» counter for the
// card currently open in the zoom modal.
function updateZoomNav(pageId) {
  const ids = orderedPageIds();
  const i = ids.indexOf(pageId);
  const prev = $('zoomPrev');
  const next = $('zoomNext');
  if (prev) prev.disabled = i <= 0;
  if (next) next.disabled = i < 0 || i >= ids.length - 1;
  const c = $('zoomCounter');
  if (c) c.textContent = ids.length ? `${i + 1} / ${ids.length}` : '';
}

// Step to the previous (-1) or next (+1) card without leaving the zoom view.
function zoomStep(delta) {
  const ids = orderedPageIds();
  const i = ids.indexOf(state.zoomPageId);
  if (i < 0) return;
  const target = ids[i + delta];
  if (target) openZoom(target);
}

// Delete the card open in the zoom modal and move on to the next one (or the
// previous, if this was the last). Removal stays reversible via «↶ Отменить».
function zoomDelete() {
  const pageId = state.zoomPageId;
  if (!pageId) return;
  const ids = orderedPageIds();
  const i = ids.indexOf(pageId);
  const jumpTo = ids[i + 1] || ids[i - 1] || null;
  state.zoomPageId = null; // keep removePage from auto-closing the modal
  removePage(pageId);
  if (jumpTo) openZoom(jumpTo);
  else closeZoom();
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
  state.staged = [];
  clearUndo();
  state.pages.clear();
  state.total = 0;
  state.done = 0;
  state.processing = false;
  state.paused = false;
  state.zoomPageId = null;
  closeZoom();
  hideProcLoader();
  updatePauseButton();
  $('cards').innerHTML = '';
  $('progressWrap').classList.add('hidden');
  $('workarea').classList.add('hidden');
  $('stageArea').classList.add('hidden');
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
  hideProcLoader();
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
        <div class="meta"><span class="src">${escapeHtml(it.fileName)}</span>${it.reoriented ? '<span class="badge reor" title="У фото был EXIF-поворот — в PDF оно будет выправлено автоматически">↻ авто-поворот</span>' : ''}</div>
        ${nameField}
        <div class="actions">
          <button class="save-one" data-save-i>💾 Сохранить этот</button>
        </div>
      </div>`;
    const inp = card.querySelector('input[data-i]');
    if (inp) inp.addEventListener('input', (e) => {
      it.editName = e.target.value;
      const el = card.querySelector('.name');
      if (el) el.textContent = ensurePdf(it.editName);
    });
    const saveBtn = card.querySelector('[data-save-i]');
    if (saveBtn) saveBtn.addEventListener('click', () => imgSaveOne(i, card));
    wrap.appendChild(card);
  });
}

// Save a single image as its own PDF, independent of the "Сохранить" batch.
async function imgSaveOne(i, card) {
  if (!state.outputDir) return toast('Сначала выберите папку вывода.', 'err');
  const it = imgState.items[i];
  if (!it) return;
  showProcLoader();
  try {
    const res = await api.saveImages({
      images: [{ filePath: it.filePath, name: it.editName }],
      mode: 'each',
      outputDir: state.outputDir,
    });
    const r = res.results && res.results[0];
    if (r && r.ok) {
      if (card) card.classList.add('saved');
      toast(`Сохранён ${r.name}`, 'ok');
    } else {
      toast(`Ошибка сохранения: ${(r && r.error) || 'неизвестно'}`, 'err');
    }
  } catch (err) {
    toast(`Ошибка сохранения: ${err.message || err}`, 'err');
  } finally {
    hideProcLoader();
  }
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
  showProcLoader();
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
    hideProcLoader();
    updateImgSaveButton();
  }
}

// --- Merge PDFs tool -------------------------------------------------------
const mergeState = { pages: [], dragFrom: null };

function mergeReset() {
  hideProcLoader();
  mergeState.pages = [];
  mergeState.dragFrom = null;
  $('mergeCards').innerHTML = '';
  $('mergeArea').classList.add('hidden');
  $('mergeDrop').classList.remove('hidden');
  updateMergeCount();
  updateMergeSaveButton();
}

async function mergePickFiles() {
  const paths = await api.mergePick();
  await mergeAddPaths(paths);
}

async function mergeAddPaths(paths) {
  if (!paths || !paths.length) return;
  if (mergeState.pages.length === 0) toast('Загрузка страниц…', 'ok');
  showProcLoader();
  let pages;
  try {
    pages = await api.mergePages(paths);
  } finally {
    hideProcLoader();
  }
  if (!pages || !pages.length) return;
  mergeState.pages.push(...pages);
  $('mergeDrop').classList.add('hidden');
  $('mergeArea').classList.remove('hidden');
  renderMergeCards();
  updateMergeCount();
  updateMergeSaveButton();
}

function moveMergePage(from, to) {
  const n = mergeState.pages.length;
  if (to < 0 || to >= n || from === to) return;
  const [it] = mergeState.pages.splice(from, 1);
  mergeState.pages.splice(to, 0, it);
  renderMergeCards();
}

function renderMergeCards() {
  const wrap = $('mergeCards');
  wrap.innerHTML = '';
  mergeState.pages.forEach((pg, i) => {
    const card = document.createElement('div');
    card.className = 'card merge-card';
    card.draggable = true;
    card.dataset.i = String(i);
    card.innerHTML = `
      <div class="thumb">${pg.thumb ? `<img src="${pg.thumb}" alt="страница" />` : '<span class="placeholder">нет превью</span>'}
        <span class="order-badge">${i + 1}</span>
      </div>
      <div class="body">
        <div class="meta"><span class="src">${escapeHtml(pg.fileName)} · стр. ${pg.pageIndex + 1}</span></div>
        <div class="actions merge-actions">
          <button class="ghost" data-up title="Выше">↑</button>
          <button class="ghost" data-down title="Ниже">↓</button>
          <button class="save-one" data-save title="Сохранить эту страницу отдельным PDF">💾 Сохранить этот</button>
          <button class="del-one" data-del title="Убрать страницу">🗑</button>
        </div>
      </div>`;
    card.querySelector('[data-up]').addEventListener('click', () => moveMergePage(i, i - 1));
    card.querySelector('[data-down]').addEventListener('click', () => moveMergePage(i, i + 1));
    card.querySelector('[data-save]').addEventListener('click', () => mergeSaveOne(i, card));
    card.querySelector('[data-del]').addEventListener('click', () => {
      mergeState.pages.splice(i, 1);
      renderMergeCards();
      updateMergeCount();
      updateMergeSaveButton();
    });
    card.addEventListener('dragstart', () => { mergeState.dragFrom = i; card.classList.add('dragging'); });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('dragover', (e) => e.preventDefault());
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      if (mergeState.dragFrom != null) moveMergePage(mergeState.dragFrom, i);
      mergeState.dragFrom = null;
    });
    wrap.appendChild(card);
  });
}

function updateMergeCount() {
  const n = mergeState.pages.length;
  const el = $('mergeCount');
  if (!n) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = `Страниц: <b>${n}</b> → 1 PDF`;
}
function updateMergeSaveButton() {
  const btn = $('mergeSaveBtn');
  if (btn) btn.disabled = mergeState.pages.length === 0 || !state.outputDir;
}

async function mergeSave() {
  if (!state.outputDir) return toast('Сначала выберите папку вывода.', 'err');
  if (!mergeState.pages.length) return;
  $('mergeSaveBtn').disabled = true;
  showProcLoader();
  try {
    const res = await api.mergeSave({
      pages: mergeState.pages.map((p) => ({ filePath: p.filePath, pageIndex: p.pageIndex })),
      outputDir: state.outputDir,
      name: $('mergeName').value,
    });
    toast(`Готово: ${res.name} (${mergeState.pages.length} стр.). Папка: ${res.outputDir}`, 'ok');
    api.openPath(res.outputDir);
  } catch (err) {
    toast(`Ошибка объединения: ${err.message || err}`, 'err');
  } finally {
    hideProcLoader();
    updateMergeSaveButton();
  }
}

// Save a single page from the merge list as its own one-page PDF, without
// building the combined file. Named after the source file + page number.
async function mergeSaveOne(i, card) {
  if (!state.outputDir) return toast('Сначала выберите папку вывода.', 'err');
  const pg = mergeState.pages[i];
  if (!pg) return;
  const base = (pg.fileName || 'page').replace(/\.[^.]+$/, '');
  showProcLoader();
  try {
    const res = await api.mergeSave({
      pages: [{ filePath: pg.filePath, pageIndex: pg.pageIndex }],
      outputDir: state.outputDir,
      name: `${base}_стр${pg.pageIndex + 1}`,
    });
    if (card) card.classList.add('saved');
    toast(`Сохранён ${res.name}`, 'ok');
  } catch (err) {
    toast(`Ошибка сохранения: ${err.message || err}`, 'err');
  } finally {
    hideProcLoader();
  }
}

// --- Сжатие PDF ------------------------------------------------------------
const cmpState = { files: [], preset: 'high', busy: false };

const CMP_HINTS = {
  lossless: 'Без потерь: только пересжатие потоков и очистка. Изображения и текст не трогаются — качество 100%, выигрыш обычно небольшой.',
  high: 'Высокое качество: сканы пережимаются с высоким качеством (≈200 DPI). Визуально без потерь, заметно меньше размер. Рекомендуется.',
  medium: 'Среднее: ≈150 DPI. Ещё меньше размер, для просмотра качество достаточное.',
  strong: 'Сильное: ≈120 DPI. Минимальный размер; для архивов и пересылки, при близком рассмотрении возможна мягкость.',
};

function formatBytes(n) {
  if (!n) return '0 Б';
  const mb = n / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} МБ`;
  return `${Math.max(1, Math.round(n / 1024))} КБ`;
}

function cmpReset() {
  hideProcLoader();
  cmpState.files = [];
  cmpState.busy = false;
  $('cmpList').innerHTML = '';
  $('cmpReport').classList.add('hidden');
  $('cmpReport').innerHTML = '';
  $('cmpProgress').classList.add('hidden');
  $('cmpArea').classList.add('hidden');
  $('cmpDrop').classList.remove('hidden');
  cmpSetPreset(cmpState.preset);
  cmpUpdateButtons();
}

function cmpAdd(paths) {
  const added = (paths || []).filter((p) => p && !cmpState.files.includes(p));
  if (!added.length && !cmpState.files.length) return;
  cmpState.files.push(...added);
  $('cmpDrop').classList.add('hidden');
  $('cmpArea').classList.remove('hidden');
  $('cmpReport').classList.add('hidden'); // a new selection invalidates the old report
  renderCmpList();
  cmpUpdateButtons();
}

function renderCmpList() {
  const n = cmpState.files.length;
  const list = $('cmpList');
  list.innerHTML = '';
  cmpState.files.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'stage-file';
    row.innerHTML = `
      <span class="doc-icon">📄</span>
      <span class="fname-txt">${escapeHtml(baseName(p))}</span>
      <button class="del-one" data-i="${i}" title="Убрать из списка">🗑</button>`;
    row.querySelector('[data-i]').addEventListener('click', () => {
      cmpState.files.splice(i, 1);
      if (!cmpState.files.length) return cmpReset();
      renderCmpList();
      cmpUpdateButtons();
    });
    list.appendChild(row);
  });
}

function cmpSetPreset(preset) {
  cmpState.preset = preset;
  document.querySelectorAll('#cmpModes .seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.preset === preset));
  $('cmpModeHint').textContent = CMP_HINTS[preset] || '';
}

function cmpUpdateButtons() {
  $('cmpRunBtn').disabled = cmpState.busy || cmpState.files.length === 0 || !state.outputDir;
}

async function cmpPick() {
  const files = await api.compressPick();
  if (files.length) cmpAdd(files);
}

async function cmpRun() {
  if (!state.outputDir) return toast('Сначала выберите папку вывода.', 'err');
  if (!cmpState.files.length) return;
  cmpState.busy = true;
  cmpUpdateButtons();
  showProcLoader();
  $('cmpProgress').classList.remove('hidden');
  $('cmpProgressBar').style.width = '0%';
  $('cmpProgressText').textContent = 'Подготовка…';
  try {
    const res = await api.compressRun({
      filePaths: cmpState.files, preset: cmpState.preset, outputDir: state.outputDir,
    });
    renderCmpReport(res);
    const ok = res.results.filter((r) => r.ok).length;
    const fail = res.results.length - ok;
    toast(`Готово. Сжато ${ok} файлов${fail ? `, ошибок: ${fail}` : ''}. Экономия: ${res.savingsTotal}%.`, fail ? 'err' : 'ok');
    api.openPath(res.outputDir);
  } catch (err) {
    toast(`Ошибка сжатия: ${err.message || err}`, 'err');
  } finally {
    cmpState.busy = false;
    hideProcLoader();
    $('cmpProgress').classList.add('hidden');
    cmpUpdateButtons();
  }
}

function renderCmpReport(res) {
  const wrap = $('cmpReport');
  const rows = res.results.map((r) => {
    if (!r.ok) {
      return `<div class="sort-file failed"><span class="sort-file-status">✗</span>
        <span class="sort-file-name">${escapeHtml(r.fileName)}</span>
        <span class="sort-file-reason">${escapeHtml(r.error || 'ошибка')}</span></div>`;
    }
    const unchanged = r.kept === 'original';
    const note = unchanged
      ? '<span class="sort-file-reason">без изменений (уже оптимально)</span>'
      : `<span class="cmp-sizes">${formatBytes(r.originalSize)} → <b>${formatBytes(r.newSize)}</b></span>
         <span class="cmp-save">−${r.savings}%</span>`;
    return `<div class="sort-file moved"><span class="sort-file-status">✓</span>
      <span class="sort-file-name">${escapeHtml(r.name)}</span>${note}</div>`;
  }).join('');

  wrap.innerHTML = `
    <div class="sort-stats">
      <div class="sort-stat"><div class="sort-stat-n">${res.results.length}</div><div class="sort-stat-l">файлов</div></div>
      <div class="sort-stat"><div class="sort-stat-n">${formatBytes(res.originalTotal)}</div><div class="sort-stat-l">было</div></div>
      <div class="sort-stat good"><div class="sort-stat-n">${formatBytes(res.newTotal)}</div><div class="sort-stat-l">стало</div></div>
      <div class="sort-stat good"><div class="sort-stat-n">−${res.savingsTotal}%</div><div class="sort-stat-l">экономия</div></div>
    </div>
    <div class="sort-group"><div class="sort-group-files">${rows}</div></div>`;
  wrap.classList.remove('hidden');
}

// --- Сортировка накладных --------------------------------------------------
const sortState = { source: '', dest: '', report: null, busy: false };

function sortReset() {
  sortState.source = '';
  sortState.dest = '';
  sortState.report = null;
  sortState.busy = false;
  $('sortSrcLabel').textContent = 'не выбрана';
  $('sortSrcLabel').classList.add('muted');
  $('sortDestLabel').textContent = 'не выбрана';
  $('sortDestLabel').classList.add('muted');
  $('sortMatchExisting').checked = false;
  $('sortReport').classList.add('hidden');
  $('sortReport').innerHTML = '';
  sortUpdateHint();
  sortUpdateButtons();
}

// The hint below the pickers reflects the current mode.
function sortUpdateHint() {
  const match = $('sortMatchExisting').checked;
  $('sortHint').innerHTML = match
    ? 'Режим сопоставления: приложение ищет уже существующую папку договора в папке назначения '
      + '(по числовому коду, напр. <code>425-25</code>) и кладёт файл в её подпапку <code>ТТН</code>. '
      + 'Новые папки НЕ создаются. Файлы <code>-АЗС</code> ищутся только среди папок с «АЗС». '
      + 'Ненайденные, неоднозначные и без подпапки ТТН уходят в <code>{источник}/неотсортированные/</code>.'
    : 'Файлы вида <code>{накладная}_{договор}.pdf</code> раскладываются по папкам договоров: '
      + '<code>{назначение}/{договор}/ТТН/</code>. Проблемные (договор или накладная = NA) уходят '
      + 'в <code>{источник}/неотсортированные/</code>. Сначала сделайте пробный прогон — ничего не двигается.';
}

// Toggling the mode invalidates any shown plan (targets differ per mode).
function sortOnModeChange() {
  sortState.report = null;
  $('sortReport').classList.add('hidden');
  sortUpdateHint();
  sortUpdateButtons();
}

function sortUpdateButtons() {
  const ready = !!sortState.source && !!sortState.dest && !sortState.busy;
  $('sortDryBtn').disabled = !ready;
  // Apply only after a dry run has produced a plan with something to move.
  $('sortApplyBtn').disabled = !ready || !sortState.report ||
    (sortState.report.toSort === 0 && sortState.report.problems === 0);
}

async function sortPickSource() {
  const dir = await api.sortPickSource();
  if (!dir) return;
  sortState.source = dir;
  sortState.report = null; // picking a new folder invalidates the old plan
  $('sortReport').classList.add('hidden');
  const el = $('sortSrcLabel');
  el.textContent = dir; el.classList.remove('muted');
  sortUpdateButtons();
}

async function sortPickDest() {
  const dir = await api.sortPickDest();
  if (!dir) return;
  sortState.dest = dir;
  sortState.report = null;
  $('sortReport').classList.add('hidden');
  const el = $('sortDestLabel');
  el.textContent = dir; el.classList.remove('muted');
  sortUpdateButtons();
}

async function sortDryRun() {
  if (!sortState.source || !sortState.dest) return;
  sortState.busy = true;
  sortUpdateButtons();
  showProcLoader();
  try {
    const report = await api.sortPlan({
      sourceDir: sortState.source, destDir: sortState.dest,
      matchExisting: $('sortMatchExisting').checked,
    });
    sortState.report = report;
    renderSortReport(report, false);
    toast(`План готов: к сортировке ${report.toSort}, проблемных ${report.problems}.`, 'ok');
  } catch (err) {
    toast(`Ошибка анализа: ${err.message || err}`, 'err');
  } finally {
    sortState.busy = false;
    hideProcLoader();
    sortUpdateButtons();
  }
}

async function sortApply() {
  if (!sortState.report) return;
  const n = sortState.report.toSort + sortState.report.problems;
  if (!window.confirm(`Переместить ${n} файлов? Действие изменит папки на диске.`)) return;
  sortState.busy = true;
  sortUpdateButtons();
  showProcLoader();
  try {
    const res = await api.sortApply({
      sourceDir: sortState.source, destDir: sortState.dest,
      matchExisting: $('sortMatchExisting').checked,
    });
    applySortResult(res);
    const msg = `Перемещено ${res.moved}` +
      (res.unsortedMoved ? `, в «неотсортированные» ${res.unsortedMoved}` : '') +
      (res.failed ? `, ошибок ${res.failed}` : '');
    toast(msg + '.', res.failed ? 'err' : 'ok');
    // Files have moved — the plan no longer reflects the source folder.
    sortState.report = null;
    $('sortApplyBtn').disabled = true;
  } catch (err) {
    toast(`Ошибка сортировки: ${err.message || err}`, 'err');
  } finally {
    sortState.busy = false;
    hideProcLoader();
  }
}

// Overlay per-file move outcomes (✓ / ✗) onto the already-rendered report.
function applySortResult(res) {
  const byName = new Map();
  for (const r of res.results || []) byName.set(r.fileName + '|' + r.folder, r);
  document.querySelectorAll('#sortReport .sort-file').forEach((row) => {
    const key = row.dataset.file + '|' + row.dataset.folder;
    const r = byName.get(key);
    if (!r) return;
    row.classList.add(r.ok ? 'moved' : 'failed');
    const st = row.querySelector('.sort-file-status');
    if (st) st.textContent = r.ok ? '✓' : '✗';
    if (!r.ok && r.error) row.title = r.error;
  });
  const opened = res.unsortedDir || (sortState.source + '/неотсортированные');
  const banner = document.querySelector('#sortReport .sort-done');
  if (banner) {
    banner.classList.remove('hidden');
    banner.textContent = `Готово. Перемещено ${res.moved}` +
      (res.unsortedMoved ? `; проблемных в «неотсортированные»: ${res.unsortedMoved}` : '') +
      (res.failed ? `; ошибок: ${res.failed}` : '') + '.';
  }
  if (res.unsortedMoved) { try { api.openPath(opened); } catch (_) {} }
}

function sortStat(label, value, kind) {
  return `<div class="sort-stat ${kind || ''}"><div class="sort-stat-n">${value}</div>` +
    `<div class="sort-stat-l">${label}</div></div>`;
}

function renderSortReport(report, applied) {
  const wrap = $('sortReport');
  const parts = [];

  const match = !!report.matchExisting;
  parts.push(`<div class="sort-stats">
    ${sortStat('всего PDF', report.totalPdf)}
    ${sortStat(match ? 'сопоставлено' : 'к сортировке', report.toSort, 'good')}
    ${sortStat(match ? 'папок найдено' : 'папок договоров', report.folderCount)}
    ${sortStat(match ? 'не сопоставлено' : 'проблемных', report.problems, report.problems ? 'warn' : '')}
    ${sortStat('совпадений имён', report.conflicts, report.conflicts ? 'warn' : '')}
  </div>`);

  if (match) {
    parts.push('<p class="hint" style="margin:0 0 12px">Режим сопоставления с существующими папками: '
      + 'новые папки не создаются, файлы кладутся в подпапку «ТТН» найденной папки договора.</p>');
  }

  parts.push(`<div class="sort-done ${applied ? '' : 'hidden'}"></div>`);

  if (report.groups.length) {
    parts.push(`<h3 class="sort-h">${match ? 'В существующие папки договоров' : 'По договорам'}</h3>`);
    for (const g of report.groups) {
      const rows = g.files.map((f) => `
        <div class="sort-file" data-file="${escapeHtml(f.fileName)}" data-folder="${escapeHtml(g.folder)}">
          <span class="sort-file-status"></span>
          <span class="sort-file-name">${escapeHtml(f.fileName)}</span>
          ${f.conflict ? `<span class="sort-file-note" title="В целевой папке уже есть такой файл — будет сохранён как ${escapeHtml(f.finalName)}">→ ${escapeHtml(f.finalName)}</span>` : ''}
        </div>`).join('');
      parts.push(`<div class="sort-group">
        <div class="sort-group-head"><span class="sort-folder">📁 ${escapeHtml(g.targetRel)}</span>
          <span class="sort-group-count">${g.files.length} ${pluralFiles(g.files.length)}</span></div>
        <div class="sort-group-files">${rows}</div>
      </div>`);
    }
  }

  if (report.unsorted.length) {
    const rows = report.unsorted.map((u) => `
      <div class="sort-file" data-file="${escapeHtml(u.fileName)}" data-folder="неотсортированные">
        <span class="sort-file-status"></span>
        <span class="sort-file-name">${escapeHtml(u.fileName)}</span>
        <span class="sort-file-reason">${escapeHtml(u.reason)}</span>
      </div>`).join('');
    parts.push(`<div class="sort-group problem">
      <div class="sort-group-head"><span class="sort-folder">🗃️ неотсортированные</span>
        <span class="sort-group-count">${report.unsorted.length} ${pluralFiles(report.unsorted.length)}</span></div>
      <div class="sort-group-files">${rows}</div>
    </div>`);
  }

  if (!report.groups.length && !report.unsorted.length) {
    parts.push('<p class="hint">В выбранной папке нет PDF-файлов накладных.</p>');
  }

  wrap.innerHTML = parts.join('');
  wrap.classList.remove('hidden');
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

// --- output folder (shared) ------------------------------------------------
function setOutputDir(dir) {
  state.outputDir = dir;
  for (const id of ['outDirLabel', 'imgOutDirLabel', 'mergeOutDirLabel', 'cmpOutDirLabel']) {
    const el = $(id);
    if (el) { el.textContent = dir; el.classList.remove('muted'); }
  }
  updateSaveButton();
  updateImgSaveButton();
  updateMergeSaveButton();
  cmpUpdateButtons();
}
async function pickOutput() {
  const dir = await api.pickOutputDir();
  if (dir) setOutputDir(dir);
}

// --- pickers & drag/drop ---------------------------------------------------
async function pickFiles() {
  const files = await api.pickFiles();
  if (files.length) stagePdf(files);
}

function wireDropzone() {
  const marks = ['dragenter', 'dragover'];
  const clears = ['dragleave', 'drop'];
  for (const dz of [$('dropzone'), $('imgDrop'), $('mergeDrop'), $('cmpDrop')]) {
    marks.forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
    clears.forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  }
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files || [])];
    if (state.view === 'img') {
      const imgs = files.filter((f) => /\.(jpe?g|png|tiff?)$/i.test(f.name)).map((f) => f.path).filter(Boolean);
      // Dropped image paths need previews; route through the same handler as the picker.
      if (imgs.length) imgShow(imgs.map((p) => ({ filePath: p, fileName: p.split(/[\\/]/).pop(), thumb: '' })));
    } else if (state.view === 'merge') {
      const paths = files.filter((f) => f.name.toLowerCase().endsWith('.pdf')).map((f) => f.path).filter(Boolean);
      if (paths.length) mergeAddPaths(paths);
    } else if (state.view === 'compress') {
      const paths = files.filter((f) => f.name.toLowerCase().endsWith('.pdf')).map((f) => f.path).filter(Boolean);
      if (paths.length) cmpAdd(paths);
    } else if (state.view === 'pdf' && !state.processing && state.pages.size === 0) {
      // Collect dropped PDFs into the staging list (don't start yet); ignore
      // drops while a batch is running or results are already on screen.
      const paths = files.filter((f) => f.name.toLowerCase().endsWith('.pdf')).map((f) => f.path).filter(Boolean);
      if (paths.length) stagePdf(paths);
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
    t.addEventListener('click', () => openTool(t.dataset.tool)));
  $('homeBtn').addEventListener('click', showHome);

  $('pickBtn').addEventListener('click', pickFiles);
  $('stageAddBtn').addEventListener('click', stageAddFiles);
  $('stageClearBtn').addEventListener('click', clearStage);
  $('stageStartBtn').addEventListener('click', () => startProcessing(state.staged));
  $('restartBtn').addEventListener('click', resetPdf);
  $('pauseBtn').addEventListener('click', togglePause);
  $('undoBtn').addEventListener('click', performUndo);
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

  // Merge tool
  $('mergePickBtn').addEventListener('click', mergePickFiles);
  $('mergeAddBtn').addEventListener('click', mergePickFiles);
  $('mergeRestartBtn').addEventListener('click', mergeReset);
  $('mergePickOutBtn').addEventListener('click', pickOutput);
  $('mergeSaveBtn').addEventListener('click', mergeSave);

  // Сжатие PDF
  $('cmpPickBtn').addEventListener('click', cmpPick);
  $('cmpAddBtn').addEventListener('click', cmpPick);
  $('cmpRestartBtn').addEventListener('click', cmpReset);
  $('cmpPickOutBtn').addEventListener('click', pickOutput);
  $('cmpRunBtn').addEventListener('click', cmpRun);
  document.querySelectorAll('#cmpModes .seg-btn').forEach((b) =>
    b.addEventListener('click', () => cmpSetPreset(b.dataset.preset)));

  // Сортировка накладных
  $('sortSrcBtn').addEventListener('click', sortPickSource);
  $('sortMatchExisting').addEventListener('change', sortOnModeChange);
  $('sortDestBtn').addEventListener('click', sortPickDest);
  $('sortDryBtn').addEventListener('click', sortDryRun);
  $('sortApplyBtn').addEventListener('click', sortApply);
  $('sortRestartBtn').addEventListener('click', sortReset);

  // Zoom modal
  $('zoomClose').addEventListener('click', closeZoom);
  $('zoomPrev').addEventListener('click', () => zoomStep(-1));
  $('zoomNext').addEventListener('click', () => zoomStep(1));
  $('zoomDelete').addEventListener('click', zoomDelete);
  $('zoomNak').addEventListener('input', onZoomEdit);
  $('zoomDog').addEventListener('input', onZoomEdit);
  $('zoomName').addEventListener('input', onZoomEdit);
  $('zoomImageWrap').addEventListener('click', () => $('zoomImageWrap').classList.toggle('actual'));
  $('zoomModal').addEventListener('click', (e) => { if (e.target.id === 'zoomModal') closeZoom(); });
  window.addEventListener('keydown', (e) => {
    const zoomOpen = !$('zoomModal').classList.contains('hidden');
    if (e.key === 'Escape' && zoomOpen) closeZoom();
    // ← / → step between cards while the zoom modal is open (not while typing
    // in a field — there the arrows move the text cursor).
    if (zoomOpen && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
      e.preventDefault();
      zoomStep(e.key === 'ArrowLeft' ? -1 : 1);
    }
    // Ctrl/⌘+Z undoes the last action — but not while typing in a field (there
    // it should do the browser's text-undo) and only for the PDF-tools view.
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
      if (state.view === 'pdf' && state.undo.length) { e.preventDefault(); performUndo(); }
    }
  });

  registerEvents();

  try {
    const s = await api.getSettings();
    if (s && s.lastOutputDir) setOutputDir(s.lastOutputDir);
  } catch (err) {
    showFatal('Не удалось загрузить настройки: ' + (err.message || err));
  }

  hideSplash(); // UI is ready — fade the loader out
});
})();
