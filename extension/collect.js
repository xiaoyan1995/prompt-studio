// collect.js - Batch image collect for Prompt Studio Desktop
'use strict';

// ── State ────────────────────────────────────────────────────────────────────
let allImages = [];       // { url, width, height, fmt, visible }
let selected  = new Set();
let filters   = { fmt: 'all', size: 0, minW: 0, minH: 0, minPx: 0 };
let targetTabId = null;

function bgMsg(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
}

async function localJson(path, options = {}) {
  const res = await bgMsg({
    type: 'local-api',
    path,
    method: options.method || 'GET',
    body: options.body,
    timeoutMs: options.timeoutMs,
  });
  if (!res?.ok) throw new Error(res?.data?.error || res?.error || res?.text || `HTTP ${res?.status || 0}`);
  return res.data;
}

// ── DOM refs ─────────────────────────────────────────────────────────────────
const scanBtn       = document.getElementById('scanBtn');
const selAllBtn     = document.getElementById('selAllBtn');
const selNoneBtn    = document.getElementById('selNoneBtn');
const sendBtn       = document.getElementById('sendBtn');
const projSel       = document.getElementById('projSel');
const grid          = document.getElementById('grid');
const emptyState    = document.getElementById('emptyState');
const scanningState = document.getElementById('scanningState');
const noResultState = document.getElementById('noResultState');
const statTotal     = document.getElementById('statTotal');
const statFiltered  = document.getElementById('statFiltered');
const statSelected  = document.getElementById('statSelected');
const minW          = document.getElementById('minW');
const minH          = document.getElementById('minH');
const minPx         = document.getElementById('minPx');
const toastEl       = document.getElementById('toast');
const progOverlay   = document.getElementById('progOverlay');
const progTitle     = document.getElementById('progTitle');
const progBar       = document.getElementById('progBar');
const progMsg       = document.getElementById('progMsg');
const progOk        = document.getElementById('progOk');
const progFail      = document.getElementById('progFail');
const progTotal     = document.getElementById('progTotal');
const progClose     = document.getElementById('progClose');

// ── Toast ────────────────────────────────────────────────────────────────────
let toastTimer = null;
function toast(msg, type = '', ms = 2400) {
  clearTimeout(toastTimer);
  toastEl.textContent = msg;
  toastEl.className = 'toast show' + (type ? ' ' + type : '');
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

// ── Format detection ─────────────────────────────────────────────────────────
function fmtFromUrl(url) {
  const m = url.toLowerCase().split('?')[0].match(/\.(jpe?g|png|webp|gif|avif|svg)(\b|$)/);
  if (!m) return 'other';
  const e = m[1];
  if (e === 'jpeg' || e === 'jpg') return 'jpg';
  return e;
}

// ── Apply filters ─────────────────────────────────────────────────────────────
function applyFilters() {
  const { fmt, size, minW: mw, minH: mh, minPx: mp } = filters;
  let count = 0;
  allImages.forEach(img => {
    const fmtMatch = fmt === 'all' || img.fmt === fmt;
    const shortSide = Math.min(img.width, img.height);
    const sizeMatch = size === 0 || shortSide >= size;
    const wMatch    = mw === 0 || img.width  >= mw;
    const hMatch    = mh === 0 || img.height >= mh;
    const pxMatch   = mp === 0 || (img.width * img.height) >= mp;
    img.visible = fmtMatch && sizeMatch && wMatch && hMatch && pxMatch;
    if (img.visible) count++;
  });
  // remove hidden from selection
  selected.forEach(i => { if (!allImages[i]?.visible) selected.delete(i); });
  updateStats();
  renderGrid();
}

function updateStats() {
  statTotal.textContent    = allImages.length;
  const vis = allImages.filter(i => i.visible).length;
  statFiltered.textContent = vis;
  statSelected.textContent = selected.size;
  sendBtn.disabled = selected.size === 0;
}

// ── Render grid ───────────────────────────────────────────────────────────────
function renderGrid() {
  const visible = allImages.filter(i => i.visible);
  if (visible.length === 0 && allImages.length > 0) {
    grid.style.display = 'none';
    noResultState.style.display = 'flex';
    return;
  }
  noResultState.style.display = 'none';
  grid.style.display = 'grid';
  grid.innerHTML = '';

  allImages.forEach((img, idx) => {
    if (!img.visible) return;
    const card = document.createElement('div');
    card.className = 'card' + (selected.has(idx) ? ' selected' : '');
    card.dataset.idx = idx;

    const fmtColors = {
      jpg:'#f59e0b', jpeg:'#f59e0b', png:'#3b82f6', webp:'#8b5cf6',
      gif:'#ec4899', avif:'#06b6d4', svg:'#10b981', other:'#94a3b8'
    };
    const fmtColor = fmtColors[img.fmt] || '#94a3b8';

    card.innerHTML = `
      <div class="thumb-wrap">
        <img src="${escHtml(img.url)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
        <div class="thumb-placeholder" style="display:none">🖼</div>
        <div class="card-check">${selected.has(idx) ? '✓' : ''}</div>
        <div class="card-dims">${img.width}×${img.height}</div>
        <div class="card-fmt" style="background:${fmtColor}cc">${img.fmt.toUpperCase()}</div>
      </div>
      <div class="card-info" title="${escHtml(img.url)}">${escHtml(shortUrl(img.url))}</div>
    `;
    card.addEventListener('click', () => toggleCard(idx));
    grid.appendChild(card);
  });
}

function toggleCard(idx) {
  if (selected.has(idx)) selected.delete(idx);
  else selected.add(idx);
  updateStats();
  // update just this card's classes
  const card = grid.querySelector(`[data-idx="${idx}"]`);
  if (!card) return;
  card.classList.toggle('selected', selected.has(idx));
  card.querySelector('.card-check').textContent = selected.has(idx) ? '✓' : '';
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || u.hostname;
  } catch { return url.slice(0, 40); }
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Scan ─────────────────────────────────────────────────────────────────────
scanBtn.addEventListener('click', async () => {
  scanBtn.disabled = true;
  emptyState.style.display   = 'none';
  noResultState.style.display = 'none';
  grid.style.display         = 'none';
  scanningState.style.display = 'flex';
  allImages = [];
  selected.clear();
  updateStats();

  try {
    // Get the tab we opened from
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    // If this is the collect tab itself, use stored tabId
    let tabId = targetTabId;
    if (!tabId) {
      // fallback: use the tab that is not this extension page
      const tabs = await chrome.tabs.query({ currentWindow: false });
      const t2   = tabs.find(t => !t.url?.startsWith('chrome-extension://'));
      tabId = t2?.id || tab?.id;
    }
    if (!tabId) throw new Error('找不到目标页面');

    const resp = await chrome.tabs.sendMessage(tabId, { type: 'scan-images' });
    if (!resp || !Array.isArray(resp.images)) throw new Error('页面未响应，请刷新后重试');

    allImages = resp.images.map(img => ({
      ...img,
      fmt: fmtFromUrl(img.url),
      visible: true,
    }));
  } catch (e) {
    scanningState.style.display = 'none';
    emptyState.style.display = 'flex';
    emptyState.querySelector('.empty-title').textContent = '扫描失败';
    emptyState.querySelector('.empty-sub').textContent   = e.message || '请确认已在网页上打开此面板';
    scanBtn.disabled = false;
    return;
  }

  scanningState.style.display = 'none';
  if (allImages.length === 0) {
    emptyState.style.display = 'flex';
    emptyState.querySelector('.empty-title').textContent = '页面上没有找到图片';
    emptyState.querySelector('.empty-sub').textContent   = '当前页面没有可采集的图片';
  }
  applyFilters();
  scanBtn.disabled = false;
  toast(`扫描完成，共 ${allImages.length} 张图片`, 'success');
});

// ── Filter tag clicks ─────────────────────────────────────────────────────────
document.querySelectorAll('.ftag[data-fmt]').forEach(tag => {
  tag.addEventListener('click', () => {
    document.querySelectorAll('.ftag[data-fmt]').forEach(t => t.classList.remove('on'));
    tag.classList.add('on');
    filters.fmt = tag.dataset.fmt;
    applyFilters();
  });
});

document.querySelectorAll('.ftag[data-size]').forEach(tag => {
  tag.addEventListener('click', () => {
    const val = parseInt(tag.dataset.size);
    if (filters.size === val) {
      // toggle off
      filters.size = 0;
      tag.classList.remove('on');
    } else {
      document.querySelectorAll('.ftag[data-size]').forEach(t => t.classList.remove('on'));
      tag.classList.add('on');
      filters.size = val;
    }
    applyFilters();
  });
});

[minW, minH].forEach(inp => {
  inp.addEventListener('input', () => {
    filters.minW = parseInt(minW.value) || 0;
    filters.minH = parseInt(minH.value) || 0;
    applyFilters();
  });
});

minPx.addEventListener('change', () => {
  filters.minPx = parseInt(minPx.value) || 0;
  applyFilters();
});

// ── Select all / none ─────────────────────────────────────────────────────────
selAllBtn.addEventListener('click', () => {
  allImages.forEach((img, i) => { if (img.visible) selected.add(i); });
  updateStats();
  renderGrid();
});
selNoneBtn.addEventListener('click', () => {
  selected.clear();
  updateStats();
  renderGrid();
});

// ── Load projects ─────────────────────────────────────────────────────────────
async function loadProjects() {
  try {
    const data = await localJson('/api/projects');
    const projects = data.projects || data;
    projSel.innerHTML = '<option value="">（选择项目）</option>' +
      projects.map(p => `<option value="${escHtml(p.id)}">${escHtml(p.name)}</option>`).join('');
    // restore last used
    const { lastProject } = await chrome.storage.sync.get({ lastProject: '' });
    if (lastProject) projSel.value = lastProject;
  } catch {
    projSel.innerHTML = '<option value="">⚠️ 无法连接 Prompt Studio</option>';
  }
}

// ── Send ─────────────────────────────────────────────────────────────────────
sendBtn.addEventListener('click', async () => {
  const selectedList = [...selected].map(i => allImages[i]).filter(Boolean);
  if (selectedList.length === 0) return;
  const projectId = projSel.value;

  // save last project
  chrome.storage.sync.set({ lastProject: projectId });

  let ok = 0, fail = 0;
  const total = selectedList.length;
  progOk.textContent    = '0';
  progFail.textContent  = '0';
  progTotal.textContent = total;
  progBar.style.width   = '0%';
  progMsg.textContent   = '准备中…';
  progTitle.textContent = `正在发送 ${total} 张图片…`;
  progClose.style.display = 'none';
  progOverlay.classList.add('show');
  let pageUrl = '';
  let pageTitle = '';
  try {
    const tab = targetTabId ? await chrome.tabs.get(targetTabId) : null;
    pageUrl = tab?.url || '';
    pageTitle = tab?.title || '';
  } catch {}

  for (let i = 0; i < selectedList.length; i++) {
    const img = selectedList[i];
    progMsg.textContent = `(${i + 1}/${total}) ${shortUrl(img.url)}`;
    try {
      const body = {
        project_id: projectId || undefined,
        type: 'image',
        image_url: img.url,
        title: '',
        prompt: '',
        pageUrl,
        pageTitle,
      };
      const data = await localJson('/api/cli/push', {
        method: 'POST',
        timeoutMs: 300000,
        body,
      });
      if (!data.ok) throw new Error(data.error || 'save failed');
      ok++;
    } catch {
      fail++;
    }
    progOk.textContent   = ok;
    progFail.textContent = fail;
    progBar.style.width  = `${Math.round(((i + 1) / total) * 100)}%`;
  }

  progTitle.textContent   = `发送完成`;
  progMsg.textContent     = `成功 ${ok} 张${fail > 0 ? `，失败 ${fail} 张` : ''}`;
  progClose.style.display = 'inline-block';
  if (fail === 0) toast(`✅ 已保存 ${ok} 张图片`, 'success');
  else toast(`⚠️ 成功 ${ok} 张，失败 ${fail} 张`, '', 3000);
});

progClose.addEventListener('click', () => {
  progOverlay.classList.remove('show');
  selected.clear();
  updateStats();
  renderGrid();
});

// ── Init ─────────────────────────────────────────────────────────────────────
(async () => {
  // Grab the tab that opened us (stored by popup.js)
  const { collectTabSource } = await chrome.storage.session.get({ collectTabSource: null }).catch(() => ({}));
  if (collectTabSource) targetTabId = collectTabSource;

  loadProjects();
})();
