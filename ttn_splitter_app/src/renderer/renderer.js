'use strict';

/* global window, document */
const api = window.api;

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

api.on('process:meta', (p) => {
  state.jobId = p.jobId;
  state.total += p.totalPages;
  updateProgress();
});

api.on('process:error', (p) => {
  toast(`Не удалось прочитать ${p.filePath}: ${p.message}`, 'err');
});

api.on('process:page', (p) => {
  state.pages.set(p.pageId, { ...p, editNak: p.nakladnaya, editDog: p.dogovor });
  state.done = p.done;
  renderCard(p.pageId);
  updateProgress();
});

api.on('process:complete', () => {
  state.processing = false;
  $('progressWrap').classList.add('hidden');
  updateSaveButton();
  toast('Распознавание завершено. Проверьте значения и сохраните.', 'ok');
});

function updateProgress() {
  const pct = state.total ? Math.round((state.done / state.total) * 100) : 0;
  $('progressBar').style.width = `${pct}%`;
  $('progressText').textContent = `Обработано ${state.done} из ${state.total} страниц…`;
}

// --- cards -----------------------------------------------------------------
function renderCard(pageId) {
  const rec = state.pages.get(pageId);
  let card = document.querySelector(`[data-page="${pageId}"]`);
  if (!card) {
    card = document.createElement('div');
    card.className = 'card';
    card.dataset.page = pageId;
    $('cards').appendChild(card);
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
    </div>`;

  card.querySelector('[data-f="nak"]').addEventListener('input', (e) => {
    rec.editNak = e.target.value;
    updatePreview(card, rec);
  });
  card.querySelector('[data-f="dog"]').addEventListener('input', (e) => {
    rec.editDog = e.target.value;
    updatePreview(card, rec);
  });
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
  wireDropzone();
  $('pickBtn').addEventListener('click', pickFiles);
  $('addMoreBtn').addEventListener('click', pickFiles);
  $('pickOutBtn').addEventListener('click', pickOutput);
  $('saveBtn').addEventListener('click', save);
  $('settingsBtn').addEventListener('click', openSettings);
  $('settingsSave').addEventListener('click', saveSettings);
  $('settingsCancel').addEventListener('click', () => $('settingsModal').classList.add('hidden'));

  const s = await api.getSettings();
  if (s.lastOutputDir) {
    state.outputDir = s.lastOutputDir;
    $('outDirLabel').textContent = s.lastOutputDir;
    $('outDirLabel').classList.remove('muted');
  }
});
