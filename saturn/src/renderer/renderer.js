'use strict';

/* global window, document */
// Wrapped in an IIFE with a re-entry guard: in some packaged Electron builds
// this script can be evaluated twice in the same page, and a top-level
// `const` would then throw "Identifier already declared", killing the whole
// script (dead buttons). The guard makes a second evaluation a harmless no-op.
(function () {
if (window.__ttnRendererLoaded) return;
window.__ttnRendererLoaded = true;

const api = window.api;

// Make any uncaught error visible on screen instead of silently killing the UI.
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

const state = {
  jobId: null,
  outputDir: '',
  pages: new Map(), // pageId -> record + user edits
  total: 0,
  done: 0,
  processing: false,
};

// --- filename preview (mirrors src/main/extract.js) -----------------------
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

// --- element helpers -------------------------------------------------------
const $ = (id) => document.getElementById(id);

function toast(msg, kind) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast ${kind || ''}`;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 3500);
}

// --- processing ------------------------------------------------------------
async function startProcessing(filePaths) {
  if (!filePaths || !filePaths.length) return;
  $('dropzone').classList.add('hidden');
  $('workarea').classList.remove('hidden');
  $('progressWrap').classList.remove('hidden');
  state.processing = true;
  updateSaveButton();
  try {
    await api.startProcessing(filePaths);
  } catch (err) {
    toast(`Ошибка обработки: ${err.message || err}`, 'err');
  }
}

function registerEvents() {
  api.on('process:meta', (p) => {
    if (!state.processing) return; // ignore a stray meta after restart
    state.jobId = p.jobId;
    state.total += p.totalPages;
    updateProgress();
  });

  api.on('process:error', (p) => {
    toast(`Не удалось прочитать ${p.filePath}: ${p.message}`, 'err');
  });

  api.on('process:page', (p) => {
    if (p.jobId !== state.jobId) return; // ignore stray events after restart
    state.pages.set(p.pageId, { ...p, editNak: p.nakladnaya, editDog: p.dogovor });
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
    toast('Распознавание завершено. Проверьте значения и сохраните.', 'ok');
  });
}

function updateProgress() {
  const pct = state.total ? Math.round((state.done / state.total) * 100) : 0;
  $('progressBar').style.width = `${pct}%`;
  $('progressText').textContent = `Обработано ${state.done} из ${state.total} страниц…`;
}

// --- cards -----------------------------------------------------------------
// Pages finish out of order (parallel OCR); keep cards sorted by page index.
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
  const srcLabel = { ocr: 'OCR', ai: 'Claude AI', error: 'ошибка' }[rec.source] || rec.source;
  const preview = makeFilename(rec.editNak, rec.editDog);
  const warn = preview.includes('NA') ? ' warn' : '';

  card.innerHTML = `
    <div class="thumb">${rec.thumb ? `<img src="${rec.thumb}" alt="страница" />` : '<span class="placeholder">нет превью</span>'}</div>
    <div class="body">
      <div class="meta">
        <span class="badge ${conf}">${confLabel}</span>
        <span class="badge ${rec.source === 'ai' ? 'ai' : ''}">${srcLabel}</span>
        <span class="src">${rec.fileName} · стр. ${rec.pageIndex + 1}</span>
      </div>
      <div class="row">
        <label class="small field">накладная
          <input data-f="nak" value="${escapeHtml(rec.editNak || '')}" placeholder="напр. 37" />
        </label>
        <label class="small field">договор
          <input data-f="dog" value="${escapeHtml(rec.editDog || '')}" placeholder="напр. SGN-158/25 или Перемещение" />
        </label>
      </div>
      <div class="fname">→ <span class="name${warn}">${escapeHtml(preview)}</span></div>
      ${rec.aiError ? `<div class="src" style="color:var(--red)">AI: ${escapeHtml(rec.aiError)}</div>` : ''}
      ${rec.error ? `<div class="src" style="color:var(--red)">${escapeHtml(rec.error)}</div>` : ''}
      <div class="actions"><button class="save-one" data-save>💾 Сохранить этот</button></div>
    </div>`;

  card.querySelector('[data-f="nak"]').addEventListener('input', (e) => {
    rec.editNak = e.target.value;
    updatePreview(card, rec);
  });
  card.querySelector('[data-f="dog"]').addEventListener('input', (e) => {
    rec.editDog = e.target.value;
    updatePreview(card, rec);
  });
  const thumb = card.querySelector('.thumb');
  if (thumb) thumb.addEventListener('click', () => openZoom(pageId));
  const saveBtn = card.querySelector('[data-save]');
  if (saveBtn) saveBtn.addEventListener('click', () => saveOne(pageId));
}

function updatePreview(card, rec) {
  const preview = makeFilename(rec.editNak, rec.editDog);
  const el = card.querySelector('.name');
  el.textContent = preview;
  el.className = 'name' + (preview.includes('NA') ? ' warn' : '');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Push edits made anywhere back onto the card (inputs + filename preview).
function syncCardInputs(rec) {
  const card = document.querySelector(`[data-page="${rec.pageId}"]`);
  if (!card) return;
  const nak = card.querySelector('[data-f="nak"]');
  const dog = card.querySelector('[data-f="dog"]');
  if (nak && nak.value !== (rec.editNak || '')) nak.value = rec.editNak || '';
  if (dog && dog.value !== (rec.editDog || '')) dog.value = rec.editDog || '';
  updatePreview(card, rec);
}

// --- zoom / review modal ---------------------------------------------------
function updateZoomFilename(rec) {
  const preview = makeFilename(rec.editNak, rec.editDog);
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
  $('zoomBadges').innerHTML = `<span class="badge ${conf}">${escapeHtml(confLabel)}</span>`;
  $('zoomNak').value = rec.editNak || '';
  $('zoomDog').value = rec.editDog || '';
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

  // Render a high-resolution image of this page on demand; fall back to thumb.
  try {
    const dataUrl = await api.pageImage(rec.filePath, rec.pageIndex, rec.rotation || 0);
    if (state.zoomPageId !== pageId) return; // closed/switched while loading
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
  rec.editNak = $('zoomNak').value;
  rec.editDog = $('zoomDog').value;
  updateZoomFilename(rec);
  syncCardInputs(rec);
}

// --- start over ------------------------------------------------------------
function restart() {
  // If a run is still going, cancel it so it stops producing cards.
  if (state.processing) api.cancel();
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

// --- saving ----------------------------------------------------------------
function updateSaveButton() {
  $('saveBtn').disabled = state.processing || state.pages.size === 0 || !state.outputDir;
}

async function save() {
  if (!state.outputDir) return toast('Сначала выберите папку вывода.', 'err');
  const edits = [...state.pages.values()].map((r) => ({
    pageId: r.pageId, nakladnaya: r.editNak, dogovor: r.editDog,
  }));
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
      jobId: state.jobId, pageId, outputDir: state.outputDir,
      nakladnaya: rec.editNak, dogovor: rec.editDog,
    });
    const card = document.querySelector(`[data-page="${pageId}"]`);
    if (card) card.classList.add('saved');
    toast(`Сохранён ${res.name}`, 'ok');
  } catch (err) {
    toast(`Ошибка сохранения: ${err.message || err}`, 'err');
  }
}

// Russian pluralization for "файл".
function pluralFiles(n) {
  const m10 = n % 10;
  const m100 = n % 100;
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

// --- pickers & wiring ------------------------------------------------------
async function pickFiles() {
  const files = await api.pickFiles();
  if (files.length) startProcessing(files);
}
async function pickOutput() {
  const dir = await api.pickOutputDir();
  if (dir) {
    state.outputDir = dir;
    $('outDirLabel').textContent = dir;
    $('outDirLabel').classList.remove('muted');
    updateSaveButton();
  }
}

function wireDropzone() {
  const dz = $('dropzone');
  ['dragenter', 'dragover'].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  // Allow dropping anywhere in the window too.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const paths = [...(e.dataTransfer?.files || [])]
      .filter((f) => f.name.toLowerCase().endsWith('.pdf'))
      .map((f) => f.path)
      .filter(Boolean);
    if (paths.length) startProcessing(paths);
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  // If the preload bridge is missing, tell the user plainly rather than
  // leaving dead buttons.
  if (!api || typeof api.on !== 'function') {
    showFatal(
      'Приложение не инициализировалось (мост preload недоступен). ' +
      'Переустановите/обновите приложение до последней версии.');
    return;
  }

  // Wire the UI first, so buttons work even if a later step fails.
  wireDropzone();
  $('pickBtn').addEventListener('click', pickFiles);
  $('restartBtn').addEventListener('click', restart);
  $('pickOutBtn').addEventListener('click', pickOutput);
  $('saveBtn').addEventListener('click', save);
  $('settingsBtn').addEventListener('click', openSettings);
  $('settingsSave').addEventListener('click', saveSettings);
  $('settingsCancel').addEventListener('click', () => $('settingsModal').classList.add('hidden'));

  // Zoom modal
  $('zoomClose').addEventListener('click', closeZoom);
  $('zoomNak').addEventListener('input', onZoomEdit);
  $('zoomDog').addEventListener('input', onZoomEdit);
  $('zoomImageWrap').addEventListener('click', () =>
    $('zoomImageWrap').classList.toggle('actual'));
  $('zoomModal').addEventListener('click', (e) => {
    if (e.target.id === 'zoomModal') closeZoom();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('zoomModal').classList.contains('hidden')) closeZoom();
  });

  registerEvents();

  try {
    const s = await api.getSettings();
    if (s && s.lastOutputDir) {
      state.outputDir = s.lastOutputDir;
      $('outDirLabel').textContent = s.lastOutputDir;
      $('outDirLabel').classList.remove('muted');
    }
  } catch (err) {
    showFatal('Не удалось загрузить настройки: ' + (err.message || err));
  }
});
})();
