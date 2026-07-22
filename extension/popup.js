// popup.js
const DEFAULT_SERVER = 'http://127.0.0.1:8768';

// ── i18n ─────────────────────────────────────────────────────────────────────
let _extLang = 'cn';
const EXT_STRINGS = {
  cn: {
    header_sub: '右键图片/视频使用完整功能',
    checking: '正在检查服务器…',
    block_title: '屏蔽此网站工具栏',
    insert_toggle_title: '启用提示词快速插入',
    insert_on_toast: '✅ 已启用快速插入',
    insert_off_toast: '✅ 已关闭快速插入',
    quick_actions: '快捷操作',
    open_studio: '打开桌面端',
    batch_collect: '批量采集图片',
    collect_sub: '扫描 · 筛选 · 批量保存',
    fmt: '格式', size: '尺寸', all: '全部', other: '其他',
    min_w: '最小宽', min_h: '最小高',
    sel_all: '全选', sel_none: '取消',
    loading_proj: '⏳ 加载项目…',
    scan: '🔍 扫描',
    total_pre: '共', total_suf: '张',
    filtered_pre: '筛选', filtered_suf: '张',
    selected_pre: '已选', selected_suf: '张',
    scan_hint: '点击「扫描」获取页面图片',
    scanning: '扫描中…',
    no_result: '当前筛选无结果',
    gallery_mode: '合并到同一卡片',
    gallery_mode_tip: '勾选：所有图片合并到一张卡片的画廊\n取消：每张图片单独创建一张卡片',
    send_btn: '💾 发送到 Prompt Studio',
    retry_saves: '重试失败保存',
    safety_ok: 'API 已限制来源',
    safety_blocked: (n) => `已拦截 ${n} 次可疑访问`,
    integrity_ok: '离线素材完整',
    integrity_warn: (n) => `离线素材异常 ${n} 项`,
    ext_settings: '插件设置',
    ext_settings_sub: '连接 · 黑名单',
    how_to_use: '使用方法',
    usage_html: '在任意网页上 <strong style="color:var(--text)">右键点击图片或视频</strong>，选择：<br>・💾 <strong style="color:var(--text)">保存到桌面端</strong><br>・✨ <strong style="color:var(--text)">反推提示词</strong> → AI 自动分析并生成',
    wake_studio: '唤起桌面端',
    refresh: '刷新状态',
    server_ok: (n) => `✅ 服务器运行中 · ${n} 个项目`,
    server_err: '❌ 桌面端未运行',
  },
  en: {
    header_sub: 'Right-click any image/video for full features',
    checking: 'Checking server…',
    block_title: 'Block toolbar on this site',
    insert_toggle_title: 'Enable prompt quick-insert',
    insert_on_toast: '✅ Quick insert enabled',
    insert_off_toast: '✅ Quick insert disabled',
    quick_actions: 'Quick Actions',
    open_studio: 'Open Desktop App',
    batch_collect: 'Batch Collect Images',
    collect_sub: 'Scan · Filter · Save All',
    fmt: 'Format', size: 'Size', all: 'All', other: 'Other',
    min_w: 'Min W', min_h: 'Min H',
    sel_all: 'All', sel_none: 'None',
    loading_proj: '⏳ Loading projects…',
    scan: '🔍 Scan',
    total_pre: 'Total', total_suf: '',
    filtered_pre: 'Filtered', filtered_suf: '',
    selected_pre: 'Selected', selected_suf: '',
    scan_hint: 'Click "Scan" to get images on this page',
    scanning: 'Scanning…',
    no_result: 'No results for current filter',
    gallery_mode: 'Merge into one card',
    gallery_mode_tip: 'Checked: all images merged into one card gallery\nUnchecked: create one card per image',
    send_btn: '💾 Send to Prompt Studio',
    retry_saves: 'Retry failed saves',
    safety_ok: 'API origin-locked',
    safety_blocked: (n) => `Blocked ${n} suspicious request(s)`,
    integrity_ok: 'Offline media OK',
    integrity_warn: (n) => `${n} offline media issue(s)`,
    ext_settings: 'Extension Settings',
    ext_settings_sub: 'Connection · Blocklist',
    how_to_use: 'How to Use',
    usage_html: 'On any webpage, <strong style="color:var(--text)">right-click an image or video</strong> and choose:<br>・💾 <strong style="color:var(--text)">Save to Desktop</strong><br>・✨ <strong style="color:var(--text)">Reverse Prompt</strong> → AI auto-analyzes and generates',
    wake_studio: 'Launch Desktop App',
    refresh: 'Refresh',
    server_ok: (n) => `✅ Server running · ${n} projects`,
    server_err: '❌ Desktop app not running',
  }
};
function et(key, ...args) {
  const s = EXT_STRINGS[_extLang] || EXT_STRINGS.cn;
  const v = s[key];
  return typeof v === 'function' ? v(...args) : (v ?? key);
}
function applyExtLang() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = et(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    el.innerHTML = et(el.dataset.i18nHtml);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = et(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = et(el.dataset.i18nTitle);
  });
  const btnCN = document.getElementById('extLangBtnCN');
  const btnEN = document.getElementById('extLangBtnEN');
  if (btnCN) { btnCN.style.background = _extLang === 'cn' ? 'var(--primary)' : 'none'; btnCN.style.color = _extLang === 'cn' ? '#fff' : 'var(--subtle)'; }
  if (btnEN) { btnEN.style.background = _extLang === 'en' ? 'var(--primary)' : 'none'; btnEN.style.color = _extLang === 'en' ? '#fff' : 'var(--subtle)'; }
}
chrome.storage.local.get({ extLang: 'cn' }, ({ extLang }) => {
  _extLang = extLang;
  applyExtLang();
});
document.getElementById('extLangBtnCN').addEventListener('click', () => {
  _extLang = 'cn'; chrome.storage.local.set({ extLang: 'cn' }); applyExtLang();
  chrome.runtime.sendMessage({ type: 'set-lang', lang: 'cn' });
});
document.getElementById('extLangBtnEN').addEventListener('click', () => {
  _extLang = 'en'; chrome.storage.local.set({ extLang: 'en' }); applyExtLang();
  chrome.runtime.sendMessage({ type: 'set-lang', lang: 'en' });
});

function bgMsg(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
}

async function localApi(path, options = {}) {
  return await bgMsg({
    type: 'local-api',
    path,
    method: options.method || 'GET',
    body: options.body,
    timeoutMs: options.timeoutMs,
  });
}

async function localJson(path, options = {}) {
  const res = await localApi(path, options);
  if (!res?.ok) throw new Error(res?.data?.error || res?.error || res?.text || `HTTP ${res?.status || 0}`);
  return res.data;
}

async function checkServer() {
  const dot     = document.getElementById('statusDot');
  const text    = document.getElementById('statusText');
  const startSec = document.getElementById('startSection');

  dot.className = 'dot checking';
  text.textContent = et('checking');
  startSec.style.display = 'none';

  try {
    const projects = await localJson('/api/projects', { timeoutMs: 3000 });
    dot.className = 'dot ok';
    text.textContent = et('server_ok', projects.length);
    await refreshSafetyStatus();
  } catch {
    dot.className = 'dot err';
    text.textContent = et('server_err');
    startSec.style.display = 'block';
    document.getElementById('safetyStatus').style.display = 'none';
  }
  await refreshRetryQueueStatus();
}

async function refreshRetryQueueStatus() {
  const btn = document.getElementById('retryQueueBtn');
  const count = document.getElementById('retryQueueCount');
  const res = await bgMsg({ type: 'get-save-retry-queue' });
  const n = res?.items?.length || 0;
  btn.style.display = n ? 'flex' : 'none';
  count.textContent = String(n);
}

async function refreshSafetyStatus() {
  const box = document.getElementById('safetyStatus');
  try {
    const [security, integrityRes] = await Promise.all([
      localJson('/api/security/status', { timeoutMs: 3000 }),
      localJson('/api/media/integrity', { timeoutMs: 3000 }),
    ]);
    const s = integrityRes.integrity?.summary || {};
    const issueCount = Number(s.missing_files || 0) + Number(s.remote_urls || 0);
    const securityText = security.blocked_count ? et('safety_blocked', security.blocked_count) : et('safety_ok');
    const integrityText = issueCount ? et('integrity_warn', issueCount) : et('integrity_ok');
    box.textContent = `${securityText} · ${integrityText}`;
    box.style.display = 'block';
  } catch {
    box.style.display = 'none';
  }
}

document.getElementById('openStudioBtn').addEventListener('click', async () => {
  const { serverUrl = DEFAULT_SERVER } = await new Promise(r =>
    chrome.storage.sync.get({ serverUrl: DEFAULT_SERVER }, r)
  );
  chrome.tabs.create({ url: serverUrl });
});

document.getElementById('retryQueueBtn').addEventListener('click', async () => {
  const btn = document.getElementById('retryQueueBtn');
  const count = document.getElementById('retryQueueCount');
  btn.disabled = true;
  count.textContent = '...';
  const res = await bgMsg({ type: 'retry-save-queue' });
  count.textContent = res?.remaining != null ? String(res.remaining) : '!';
  btn.disabled = false;
  await refreshRetryQueueStatus();
});

document.getElementById('openSettingsBtn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// Show assigned shortcut (if any) and link to shortcut settings
(async () => {
  const cmds = await chrome.commands.getAll();
  const cmd = cmds.find(c => c.name === 'save-skill-shortcut');
  const label = document.getElementById('skillShortcutLabel');
  if (cmd && cmd.shortcut) {
    label.innerHTML = `<kbd style="font-size:11px;font-family:monospace;background:#e4e8ef;border:1px solid #c8cdd8;border-radius:4px;padding:1px 6px;color:#1a2340">${cmd.shortcut}</kbd>`;
  }
})();
document.getElementById('skillShortcutTip').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});


// ── Inline Batch Collect ──────────────────────────────────────────────────────
let cAllImages = [], cSelected = new Set(), cFilters = { fmt: 'all', size: 0, minW: 0, minH: 0 };

function fmtFromUrl(url) {
  const m = url.toLowerCase().split('?')[0].match(/\.(jpe?g|png|webp|gif|avif|svg)(\b|$)/);
  if (!m) return 'other';
  return m[1] === 'jpeg' ? 'jpg' : m[1];
}
function cApplyFilters() {
  const { fmt, size, minW, minH } = cFilters;
  cAllImages.forEach(img => {
    img.visible = (fmt === 'all' || img.fmt === fmt)
      && (size === 0 || Math.min(img.width, img.height) >= size)
      && (minW === 0 || img.width >= minW)
      && (minH === 0 || img.height >= minH);
  });
  cSelected.forEach(i => { if (!cAllImages[i]?.visible) cSelected.delete(i); });
  cUpdateStats(); cRenderGrid();
}
function cUpdateStats() {
  const vis = cAllImages.filter(i => i.visible).length;
  document.getElementById('cTotal').textContent    = cAllImages.length;
  document.getElementById('cFiltered').textContent = vis;
  document.getElementById('cSelected').textContent = cSelected.size;
  document.getElementById('cStats').style.display  = cAllImages.length ? '' : 'none';
  const sendBtn = document.getElementById('cSendBtn');
  sendBtn.disabled = cSelected.size === 0;
  sendBtn.style.opacity = cSelected.size ? '1' : '.4';
}
function cRenderGrid() {
  const grid = document.getElementById('cGrid');
  const visible = cAllImages.filter(i => i.visible);
  document.getElementById('cNoResult').style.display = (visible.length === 0 && cAllImages.length > 0) ? '' : 'none';
  if (visible.length === 0) { grid.style.display = 'none'; return; }
  grid.style.display = 'grid';
  grid.innerHTML = '';
  cAllImages.forEach((img, idx) => {
    if (!img.visible) return;
    const card = document.createElement('div');
    card.style.cssText = `position:relative;border-radius:6px;overflow:hidden;cursor:pointer;border:2px solid ${cSelected.has(idx) ? 'var(--primary)' : 'var(--border)'};aspect-ratio:1`;
    card.innerHTML = `<img src="${img.url.replace(/"/g,'')}" style="width:100%;height:100%;object-fit:cover" loading="lazy" onerror="this.style.background='#eee'">
      <div style="position:absolute;inset:0;background:${cSelected.has(idx)?'rgba(27,103,218,.15)':'transparent'}"></div>
      <div style="position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:4px;background:${cSelected.has(idx)?'var(--primary)':'rgba(0,0,0,.4)'};border:1.5px solid ${cSelected.has(idx)?'var(--primary)':'rgba(255,255,255,.7)'};display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff">${cSelected.has(idx)?'✓':''}</div>
      <div style="position:absolute;bottom:2px;right:3px;font-size:9px;font-weight:700;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.8)">${img.width}×${img.height}</div>`;
    card.addEventListener('click', () => {
      if (cSelected.has(idx)) cSelected.delete(idx); else cSelected.add(idx);
      cUpdateStats(); cRenderGrid();
    });
    grid.appendChild(card);
  });
}

// Toggle panel
document.getElementById('batchCollectBtn').addEventListener('click', () => {
  const panel = document.getElementById('collectPanel');
  const arrow = document.getElementById('collectArrow');
  const isOpen = panel.style.display !== 'none';
  panel.style.display = isOpen ? 'none' : '';
  arrow.style.transform = isOpen ? '' : 'rotate(90deg)';
  document.body.classList.toggle('collect-open', !isOpen);
  if (!isOpen) cLoadProjects();
});

// Filter tags
document.querySelectorAll('.ctag[data-fmt]').forEach(tag => {
  tag.addEventListener('click', () => {
    document.querySelectorAll('.ctag[data-fmt]').forEach(t => t.classList.remove('on'));
    tag.classList.add('on'); cFilters.fmt = tag.dataset.fmt; cApplyFilters();
  });
});
document.querySelectorAll('.ctag[data-size]').forEach(tag => {
  tag.addEventListener('click', () => {
    const val = parseInt(tag.dataset.size);
    if (cFilters.size === val) { cFilters.size = 0; tag.classList.remove('on'); }
    else { document.querySelectorAll('.ctag[data-size]').forEach(t => t.classList.remove('on')); tag.classList.add('on'); cFilters.size = val; }
    cApplyFilters();
  });
});
['cMinW','cMinH'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    cFilters.minW = parseInt(document.getElementById('cMinW').value) || 0;
    cFilters.minH = parseInt(document.getElementById('cMinH').value) || 0;
    cApplyFilters();
  });
});

// Scan
document.getElementById('cScanBtn').addEventListener('click', async () => {
  const scanBtn = document.getElementById('cScanBtn');
  scanBtn.disabled = true;
  document.getElementById('cEmpty').style.display = 'none';
  document.getElementById('cNoResult').style.display = 'none';
  document.getElementById('cGrid').style.display = 'none';
  document.getElementById('cScanning').style.display = '';
  cAllImages = []; cSelected.clear(); cUpdateStats();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const pageUrl = tab.url || '';

    // 1. Content script scan (DOM + Performance API)
    let scanned = [];
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'scan-images' });
      scanned = resp?.images || [];
    } catch {}

    // 2. Network-captured images from background
    const captured = await new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'get-captured-images', tabId: tab.id, pageUrl }, r => resolve(r?.images || []));
    });

    // 3. Merge: scanned first (has DOM dimensions), then network fills gaps
    const seen = new Set();
    const merged = [];
    scanned.forEach(img => {
      if (!img.url || seen.has(img.url)) return;
      seen.add(img.url);
      merged.push({ ...img, fmt: fmtFromUrl(img.url), visible: true });
    });
    captured.forEach(({ url, size }) => {
      if (!url || seen.has(url)) return;
      seen.add(url);
      merged.push({ url, probeUrl: url, width: 0, height: 0, size, fmt: fmtFromUrl(url), visible: true });
    });
    cAllImages = merged;

    // 4. Show results immediately (some may have 0×0)
    document.getElementById('cScanning').style.display = 'none';
    if (cAllImages.length === 0) {
      document.getElementById('cEmpty').style.display = '';
      document.getElementById('cEmpty').textContent = '未找到图片';
    }
    cApplyFilters();

    // 5. Probe 0×0 items via background (fetch + binary header, no CORS issues)
    const needProbe = cAllImages
      .map((img, i) => ({ idx: i, probeUrl: img.probeUrl || img.url, referer: pageUrl }))
      .filter(x => cAllImages[x.idx].width < 1);
    if (needProbe.length > 0) {
      const BATCH = 8;
      for (let i = 0; i < needProbe.length; i += BATCH) {
        const batch = needProbe.slice(i, i + BATCH);
        const { results } = await new Promise(resolve => {
          chrome.runtime.sendMessage({
            type: 'probe-image-sizes',
            items: batch.map(b => ({ probeUrl: b.probeUrl, referer: b.referer }))
          }, r => resolve(r || { results: [] }));
        });
        (results || []).forEach((sz, j) => {
          if (sz && sz.w > 0) {
            cAllImages[batch[j].idx].width  = sz.w;
            cAllImages[batch[j].idx].height = sz.h;
          }
        });
        // Update UI after each batch
        cApplyFilters();
      }
    }
  } catch(e) {
    document.getElementById('cScanning').style.display = 'none';
    document.getElementById('cEmpty').style.display = '';
    document.getElementById('cEmpty').textContent = '扫描失败，请刷新页面后重试';
    scanBtn.disabled = false; return;
  }
  scanBtn.disabled = false;
});

// Select all / none
document.getElementById('cSelAll').addEventListener('click', () => {
  cAllImages.forEach((img, i) => { if (img.visible) cSelected.add(i); });
  cUpdateStats(); cRenderGrid();
});
document.getElementById('cSelNone').addEventListener('click', () => {
  cSelected.clear(); cUpdateStats(); cRenderGrid();
});

// Load projects
async function cLoadProjects() {
  const sel = document.getElementById('cProjSel');
  try {
    const data = await localJson('/api/projects');
    const projects = data.projects || data;
    sel.innerHTML = projects.map((p, i) =>
      `<option value="${p.id}"${i===0?' selected':''}>${p.name}</option>`).join('');
    if (!projects.length) sel.innerHTML = '<option value="">⚠️ 无项目</option>';
  } catch { sel.innerHTML = '<option value="">⚠️ 未连接</option>'; }
}

// Send
document.getElementById('cSendBtn').addEventListener('click', async () => {
  const list = [...cSelected].map(i => cAllImages[i]).filter(Boolean);
  if (!list.length) return;
  const projId = document.getElementById('cProjSel').value;
  const galleryMode = document.getElementById('cGalleryMode').checked;
  const sendBtn = document.getElementById('cSendBtn');
  sendBtn.disabled = true;
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const pageUrl = activeTab?.url || '';
  const pageTitle = activeTab?.title || '';
  let ok = 0;
  let serverOnline = true;
  try {
    const health = await localApi('/api/health', { timeoutMs: 2000 });
    serverOnline = !!health?.ok;
  } catch { serverOnline = false; }

  try {
    if (!serverOnline) {
      sendBtn.textContent = `📥 离线下载中…`;
      const result = await new Promise(resolve => chrome.runtime.sendMessage({
        type: 'offline-batch-download',
        items: list.map(img => ({ url: img.url })),
      }, resolve));
      ok = result?.results?.filter(r => !r.error).length || 0;
    } else if (galleryMode) {
      sendBtn.textContent = `发送中…`;
      const res = await localJson('/api/cli/push', {
        method: 'POST',
        timeoutMs: 300000,
        body: {
          project_id: projId || undefined,
          type: 'image',
          image_url: list[0].url,
          gallery_images: list.map(img => img.url),
          title: '',
          prompt: '',
          pageUrl,
          pageTitle,
        },
      });
      if (res.ok) ok = list.length;
    } else {
      for (let i = 0; i < list.length; i++) {
        sendBtn.textContent = `发送中 ${i+1}/${list.length}…`;
        try {
          const res = await localJson('/api/cli/push', {
            method: 'POST',
            timeoutMs: 300000,
            body: {
              project_id: projId || undefined,
              type: 'image',
              image_url: list[i].url,
              title: '',
              prompt: '',
              pageUrl,
              pageTitle,
            },
          });
          if (res.ok) ok++;
        } catch {}
      }
    }
  } catch {}
  sendBtn.textContent = serverOnline ? `✅ 已保存 ${ok}/${list.length} 张` : `📥 已下载 ${ok}/${list.length} 张`;
  sendBtn.style.background = '#166534';
  setTimeout(() => {
    sendBtn.textContent = '💾 发送到 Prompt Studio';
    sendBtn.style.background = '#16a34a';
    cSelected.clear(); cUpdateStats(); cRenderGrid();
  }, 2000);
});

document.getElementById('startServerBtn').addEventListener('click', () => {
  // Trigger the desktop app protocol.
  chrome.tabs.create({ url: 'promptstudio-desktop://start' }, (tab) => {
    // Close the tab immediately after protocol dispatch (it won't load any page)
    setTimeout(() => {
      chrome.tabs.remove(tab.id).catch(() => {});
    }, 1500);
  });
  // Poll until server is up
  const dot  = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  dot.className = 'dot checking';
  text.textContent = '正在启动工具，请稍候…';
  document.getElementById('startSection').style.display = 'none';
  let tries = 0;
  const poll = setInterval(async () => {
    tries++;
    const { serverUrl = DEFAULT_SERVER } = await new Promise(r =>
      chrome.storage.sync.get({ serverUrl: DEFAULT_SERVER }, r)
    );
    try {
      const r = await fetch(`${serverUrl}/api/projects`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) { clearInterval(poll); checkServer(); }
    } catch {}
    if (tries >= 20) { clearInterval(poll); checkServer(); }
  }, 1500);
});

document.getElementById('reloadBtn').addEventListener('click', checkServer);

// ── Block / Unblock current site ──────────────────────────────────────────────
let currentHost = '';
let currentScope = null;
let siteBlocked = false;

function normalizeRule(rule) {
  const value = String(rule || '').trim().toLowerCase();
  if (!value) return '';
  if (value === 'file:' || value === 'file://') return 'file://';
  if (value.startsWith('file://')) {
    try {
      const u = new URL(value);
      u.hash = '';
      return u.href.toLowerCase();
    } catch {
      return value.replace(/#.*$/, '');
    }
  }
  return value.replace(/^www\./, '');
}

function scopeForTabUrl(tabUrl) {
  try {
    const url = new URL(tabUrl);
    if (url.protocol.startsWith('chrome')) return null;
    if (url.protocol === 'file:') {
      url.hash = '';
      const fileName = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '本地文件');
      return { type: 'file', key: url.href.toLowerCase(), label: fileName };
    }
    if (!url.hostname) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    return { type: 'host', key: host, label: host };
  } catch {
    return null;
  }
}

function ruleMatchesScope(rule, scope) {
  if (!scope) return false;
  const d = normalizeRule(rule);
  if (!d) return false;
  if (scope.type === 'file') {
    if (d === 'file://') return true;
    if (!d.startsWith('file://')) return false;
    return d.endsWith('/') ? scope.key.startsWith(d) : scope.key === d;
  }
  if (d.startsWith('file://')) return false;
  return scope.key === d || scope.key.endsWith('.' + d) || d.endsWith('.' + scope.key);
}

function updateBlockBtn() {
  const btn  = document.getElementById('blockSiteBtn');
  const icon = document.getElementById('blockIcon');
  icon.textContent  = siteBlocked ? '✅' : '🚫';
  btn.title         = siteBlocked ? `取消屏蔽 ${currentHost}` : `屏蔽 ${currentHost} 工具栏`;
  btn.style.display = 'inline-block';
}

async function initBlockBtn() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;
    currentScope = scopeForTabUrl(tab.url);
    if (!currentScope) return;
    currentHost = currentScope.label;
    const { domainBlacklist = '' } = await new Promise(r =>
      chrome.storage.sync.get({ domainBlacklist: '' }, r)
    );
    const domains = (domainBlacklist || '').split('\n').map(normalizeRule).filter(Boolean);
    siteBlocked = domains.some(d => ruleMatchesScope(d, currentScope));
    updateBlockBtn();
  } catch {}
}

document.getElementById('blockSiteBtn').addEventListener('click', async () => {
  const { domainBlacklist = '' } = await new Promise(r =>
    chrome.storage.sync.get({ domainBlacklist: '' }, r)
  );
  if (!currentScope) return;
  let domains = (domainBlacklist || '').split('\n').map(normalizeRule).filter(Boolean);
  if (siteBlocked) {
    domains = domains.filter(d => !ruleMatchesScope(d, currentScope));
  } else {
    if (!domains.includes(currentScope.key)) domains.push(currentScope.key);
  }
  try {
    await chrome.storage.sync.set({ domainBlacklist: domains.join('\n') });
    siteBlocked = !siteBlocked;
    updateBlockBtn();
    const btn = document.getElementById('blockSiteBtn');
    const orig = btn.title;
    btn.title = siteBlocked ? '✅ 已屏蔽' : '✅ 已取消屏蔽';
    setTimeout(() => { btn.title = orig; }, 1500);
  } catch(e) {
    console.error('blockSite save failed', e);
  }
});

// ── Insert toggle for current site ──────────────────────────────────────────
let insertEnabled = false;

function updateInsertBtn() {
  const btn  = document.getElementById('insertToggleBtn');
  const icon = document.getElementById('insertToggleIcon');
  icon.textContent  = insertEnabled ? '✅' : '📋';
  btn.title         = insertEnabled ? `关闭 ${currentHost} 快速插入` : `启用 ${currentHost} 快速插入`;
  btn.style.display = 'inline-block';
}

async function initInsertBtn() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;
    currentScope = currentScope || scopeForTabUrl(tab.url);
    if (!currentScope) return;
    currentHost = currentHost || currentScope.label;
    const { promptInsertWhitelist = '' } = await new Promise(r =>
      chrome.storage.sync.get({ promptInsertWhitelist: '' }, r)
    );
    const domains = (promptInsertWhitelist || '').split('\n').map(normalizeRule).filter(Boolean);
    insertEnabled = domains.some(d => ruleMatchesScope(d, currentScope));
    updateInsertBtn();
  } catch {}
}

document.getElementById('insertToggleBtn').addEventListener('click', async () => {
  const { promptInsertWhitelist = '' } = await new Promise(r =>
    chrome.storage.sync.get({ promptInsertWhitelist: '' }, r)
  );
  if (!currentScope) return;
  let domains = (promptInsertWhitelist || '').split('\n').map(normalizeRule).filter(Boolean);
  if (insertEnabled) {
    domains = domains.filter(d => !ruleMatchesScope(d, currentScope));
  } else {
    if (!domains.includes(currentScope.key)) domains.push(currentScope.key);
  }
  try {
    await chrome.storage.sync.set({ promptInsertWhitelist: domains.join('\n') });
    insertEnabled = !insertEnabled;
    updateInsertBtn();
    const btn = document.getElementById('insertToggleBtn');
    const orig = btn.title;
    btn.title = insertEnabled ? et('insert_on_toast') : et('insert_off_toast');
    setTimeout(() => { btn.title = orig; }, 1500);
  } catch(e) {
    console.error('insertToggle save failed', e);
  }
});

// ── Detected Video Section ────────────────────────────────────────────────────
function candFileName(url) {
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean);
    return segs[segs.length - 1] || url.slice(-40);
  } catch { return url.slice(-40); }
}
function candFmtBadge(item) {
  const ext = (item.ext || '').toLowerCase();
  const colors = { mpd: '#7c3aed', m3u8: '#0369a1', mp4: '#15803d', flv: '#b45309', webm: '#0e7490', ts: '#6b7280' };
  const label = item.kind === 'stream' ? (ext === 'mpd' ? 'DASH' : 'HLS') : (ext.toUpperCase() || 'VIDEO');
  const bg = colors[ext] || '#475569';
  return `<span style="font-size:9px;font-weight:700;color:#fff;background:${bg};padding:1px 5px;border-radius:4px;flex-shrink:0">${label}</span>`;
}
function fmtFileSize(bytes) {
  if (!bytes) return '';
  return bytes < 1048576 ? (bytes / 1024).toFixed(0) + ' KB' : (bytes / 1048576).toFixed(1) + ' MB';
}

async function initVideoDetect() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const res = await new Promise(r =>
      chrome.runtime.sendMessage({ type: 'get-media-candidates', tabId: tab.id, pageUrl: tab.url || '' }, r)
    );
    const items = (res?.items || []).filter(i => i.kind === 'video' || i.kind === 'stream');
    if (!items.length) return;

    const priority = { m3u8: 0, mpd: 1, m4s: 2, ts: 3, mp4: 4, webm: 5, mov: 6, flv: 7 };
    const sortedItems = items.slice().sort((a, b) => {
      const extA = (a.ext || '').toLowerCase();
      const extB = (b.ext || '').toLowerCase();
      const pA = priority[extA] ?? 99;
      const pB = priority[extB] ?? 99;
      if (pA !== pB) return pA - pB;
      const sizeA = Number(a.size || 0);
      const sizeB = Number(b.size || 0);
      if (sizeA !== sizeB) return sizeB - sizeA;
      return String(a.url || '').localeCompare(String(b.url || ''));
    });

    const section = document.getElementById('videoDetectSection');
    const list    = document.getElementById('videoDetectList');
    const count   = document.getElementById('videoDetectCount');
    section.style.display = '';
    count.textContent = `${items.length} 条`;

    list.innerHTML = '';
    sortedItems.forEach(item => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:5px 6px;border-radius:6px;background:#fff;border:1px solid #fed7aa;cursor:pointer;transition:background .1s';
      row.innerHTML = `
        ${candFmtBadge(item)}
        <span style="flex:1;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#1a2340" title="${item.url}">${candFileName(item.url)}</span>
        ${item.size ? `<span style="font-size:10px;color:#9a3412;flex-shrink:0">${fmtFileSize(item.size)}</span>` : ''}
        <span style="font-size:11px;flex-shrink:0">💾</span>`;
      row.addEventListener('mouseenter', () => { row.style.background = '#ffedd5'; });
      row.addEventListener('mouseleave', () => { row.style.background = '#fff'; });
      row.addEventListener('click', () => {
        chrome.runtime.sendMessage({
          type: 'open-dialog',
          mediaUrl: item.url,
          mediaType: 'video',
          mode: 'save',
          pageUrl: tab.url,
          pageTitle: tab.title,
          tabId: tab.id,
          referer: item.referer || tab.url,
          cookie: item.cookie || ''
        });
        window.close();
      });
      list.appendChild(row);
    });
  } catch {}
}

checkServer();
initBlockBtn();
initInsertBtn();
initVideoDetect();
