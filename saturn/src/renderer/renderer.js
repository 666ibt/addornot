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
      <div class="actions"><button class="save-one" data-save>💾 Сохранить этот</button></div>
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

// --- output folder (shared) ------------------------------------------------
function setOutputDir(dir) {
  state.outputDir = dir;
  for (const id of ['outDirLabel', 'imgOutDirLabel']) {
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
    t.addEventListener('click', () => openTool(t.dataset.tool)));
  $('homeBtn').addEventListener('click', showHome);

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
