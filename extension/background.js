// Prompt Studio Desktop Companion - Background Service Worker

const DEFAULT_SERVER = 'http://127.0.0.1:8768';
const MEDIA_CACHE_LIMIT = 80;
const IMAGE_CACHE_LIMIT = 500;
const PLAYLIST_EXT_RE = /\.(m3u8|mpd)(?:[?#]|$)/i;
const SAVE_RETRY_QUEUE_KEY = 'promptStudioSaveRetryQueue';
const mediaByTab = new Map();
const imagesByTab = new Map();
const refererByRequest = new Map();
const tabUrlMap = new Map();
let blockedRules = [];
let blockedRulesReady = false;
let blockedRulesLoadVersion = 0;

const IMAGE_MIME_RE = /^image\/(jpeg|png|webp|gif|avif|svg\+xml|bmp)/i;
const IMAGE_EXT_RE  = /\.(jpe?g|png|webp|gif|avif|svg|bmp)(?:[?#]|$)/i;

function isImageResponse(data) {
  if (!data.url || !data.url.startsWith('http')) return false;
  const ct = headerValue(data.responseHeaders, 'content-type').split(';')[0].trim();
  const size = parseInt(headerValue(data.responseHeaders, 'content-length') || '0', 10) || 0;
  if (size > 0 && size < 2048) return false; // skip tiny icons/tracking pixels
  return IMAGE_MIME_RE.test(ct) || IMAGE_EXT_RE.test(data.url);
}

function cleanImageCdnUrl(url) {
  try {
    const u = new URL(url);
    const h = u.hostname;
    if (h.includes('xhscdn.com') || h.includes('xiaohongshu.com')) { u.search = ''; return u.href; }
    if (h.includes('sinaimg.cn') || h.includes('weibo.com')) {
      u.pathname = u.pathname.replace(/\/(thumb\d+|orj\d+|woriginal|mw\d+)\//, '/large/');
      u.search = ''; return u.href;
    }
    if (h.includes('hdslb.com') || h.includes('biliimg.com') || h.includes('bilibili.com')) {
      u.pathname = u.pathname.replace(/@[^/]*$/, '');
      u.search = ''; return u.href;
    }
    if (h.includes('douyinpic.com') || h.includes('tiktokcdn.com') || h.includes('byteimg.com')) {
      u.pathname = u.pathname.replace(/~tplv-[^.]+(\.\w+)$/i, '$1');
      u.search = ''; return u.href;
    }
    if (h.includes('twimg.com')) {
      if (u.searchParams.has('name')) u.searchParams.set('name', 'orig');
      return u.href;
    }
    return url;
  } catch { return url; }
}

function rememberImage(data) {
  if (!blockedRulesReady || isTabBlocked(data.tabId, data.initiator || '')) return;
  if (!isImageResponse(data)) return;
  const tabId = data.tabId;
  if (tabId == null || tabId < 0) return;
  const url = cleanImageCdnUrl(data.url);
  const size = parseInt(headerValue(data.responseHeaders, 'content-length') || '0', 10) || 0;
  const list = imagesByTab.get(tabId) || [];
  if (list.some(x => x.url === url)) return; // deduplicate
  list.unshift({ url, size, time: Date.now() });
  imagesByTab.set(tabId, list.slice(0, IMAGE_CACHE_LIMIT));
}

chrome.action.setBadgeText({ text: '' }, () => void chrome.runtime.lastError);

// ── Binary image header parsers (ported from Download All Images / size.js) ──
function parsePngSize(b) {
  if (b.byteLength < 24) return null;
  if (b[1] !== 0x50 || b[2] !== 0x4E || b[3] !== 0x47) return null; // .PNG
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { w: v.getUint32(16, false), h: v.getUint32(20, false) };
}
function parseGifSize(b) {
  if (b.byteLength < 10) return null;
  if (b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) return null; // GIF
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { w: v.getUint16(6, true), h: v.getUint16(8, true) };
}
function parseJpgSize(b) {
  if (b.byteLength < 12) return null;
  if (b[0] !== 0xFF || b[1] !== 0xD8) return null; // JPEG SOI
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let off = 4; off < b.byteLength - 10;) {
    const segLen = v.getUint16(off, false);
    if (segLen < 2 || off + segLen + 2 > b.byteLength) break;
    const marker = b[off + segLen + 1];
    if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
      const base = off + segLen + 2; // start of SOFn payload
      if (base + 7 > b.byteLength) break;
      return { w: v.getUint16(base + 5, false), h: v.getUint16(base + 3, false) };
    }
    off += segLen + 2;
  }
  return null;
}
function parseWebpSize(b) {
  if (b.byteLength < 30) return null;
  // RIFF....WEBP
  if (b[0] !== 0x52 || b[8] !== 0x57 || b[9] !== 0x45 || b[10] !== 0x42 || b[11] !== 0x50) return null;
  const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (chunk === 'VP8 ') {
    // Lossy: width & height at bytes 26-29 as uint16 LE, masked to 14 bits
    return { w: v.getUint16(26, true) & 0x3FFF, h: v.getUint16(28, true) & 0x3FFF };
  }
  if (chunk === 'VP8L') {
    // Lossless: 14-bit packed in bytes 21-24
    return {
      w: 1 + (((b[22] & 0x3F) << 8) | b[21]),
      h: 1 + (((b[24] & 0xF) << 10) | (b[23] << 2) | ((b[22] & 0xC0) >> 6))
    };
  }
  if (chunk === 'VP8X') {
    // Extended: 24-bit canvas size at bytes 24-26 (w) and 27-29 (h), LE
    return {
      w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)),
      h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16))
    };
  }
  return null;
}
function parseSizeFromBytes(bytes) {
  return parsePngSize(bytes) || parseJpgSize(bytes) || parseWebpSize(bytes) || parseGifSize(bytes);
}

function headerValue(headers = [], name) {
  const found = headers.find(h => h.name && h.name.toLowerCase() === name.toLowerCase());
  return found ? (found.value || '') : '';
}

function normalizeBlockRule(rule) {
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

function parseBlockedRules(value) {
  return String(value || '').split('\n').map(normalizeBlockRule).filter(Boolean);
}

function purgeBlockedTabCaches() {
  chrome.tabs.query({}, tabs => {
    if (chrome.runtime.lastError) return;
    for (const tab of tabs || []) {
      if (!Number.isInteger(tab.id)) continue;
      if (tab.url) tabUrlMap.set(tab.id, tab.url);
      if (isUrlBlocked(tab.url || tabUrlMap.get(tab.id) || '')) clearTabMedia(tab.id);
    }
  });
}

function applyBlockedRules(value) {
  blockedRules = parseBlockedRules(value);
  blockedRulesReady = true;
  purgeBlockedTabCaches();
}

function loadBlockedRules() {
  const loadVersion = blockedRulesLoadVersion;
  chrome.storage.sync.get({ domainBlacklist: '' }, result => {
    if (chrome.runtime.lastError) {
      console.warn('Prompt Studio blocklist load failed', chrome.runtime.lastError.message);
      return;
    }
    if (loadVersion !== blockedRulesLoadVersion) return;
    applyBlockedRules(result?.domainBlacklist);
  });
}

loadBlockedRules();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.domainBlacklist) {
    blockedRulesLoadVersion += 1;
    applyBlockedRules(changes.domainBlacklist.newValue);
  }
});

function isUrlBlocked(pageUrl) {
  if (!pageUrl || blockedRules.length === 0) return false;
  let u;
  try {
    u = new URL(pageUrl);
    u.hash = '';
  } catch {
    return false;
  }
  const host = (u.hostname || '').toLowerCase().replace(/^www\./, '');
  const href = u.href.toLowerCase();
  return blockedRules.some(rule => {
    if (!rule) return false;
    if (u.protocol === 'file:') {
      if (rule === 'file://') return true;
      if (!rule.startsWith('file://')) return false;
      return rule.endsWith('/') ? href.startsWith(rule) : href === rule;
    }
    if (rule.startsWith('file://')) return false;
    return host === rule || host.endsWith('.' + rule);
  });
}

function isTabBlocked(tabId, fallbackUrl = '') {
  return isUrlBlocked(tabUrlMap.get(tabId) || '') || isUrlBlocked(fallbackUrl);
}

function mediaExt(url = '') {
  try {
    const path = new URL(url).pathname;
    const m = path.match(/\.([a-z0-9]{2,5})$/i);
    return m ? m[1].toLowerCase() : '';
  } catch {
    const m = String(url).match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i);
    return m ? m[1].toLowerCase() : '';
  }
}

function isUsableMediaUrl(url) {
  return !!url && !url.startsWith('blob:') && !url.startsWith('data:') && !url.startsWith('chrome-extension:');
}

function isXTwitterContext(data) {
  const pageUrl = String(data.referer || data.initiator || data.originUrl || '').toLowerCase();
  const requestUrl = String(data.url || '').toLowerCase();
  return /(^|\.)x\.com\b/.test(pageUrl) ||
    /(^|\.)twitter\.com\b/.test(pageUrl) ||
    /video\.twimg\.com/.test(requestUrl) ||
    /pbs\.twimg\.com/.test(requestUrl);
}

function isPlaylistUrl(url) {
  return /(?:[?&](?:url|src|media|playlist|manifest)=|[/.])(m3u8|mpd|m4s|ts)(?:[?#]|$)/i.test(url);
}

function isMediaResponse(data) {
  const url = data.url || '';
  if (!/^https?:\/\//i.test(url)) return false;
  const contentType = headerValue(data.responseHeaders, 'content-type').split(';')[0].trim().toLowerCase();
  const ext = mediaExt(url);
  const xContext = isXTwitterContext(data);
  if (['mp4', 'webm', 'mov', 'm4v', 'm3u8', 'mpd', 'ts', 'flv', 'm4s'].includes(ext)) return true;
  if (isPlaylistUrl(url)) return true;
  if (/^(video|audio)\//i.test(contentType)) return true;
  if (/mpegurl|m3u8|dash\+xml|mpd|x-flv/i.test(contentType)) return true;
  if (xContext && /json|octet-stream|text\/plain|application\/binary/i.test(contentType)) {
    return /m3u8|mpd|m4s|ts|video\.twimg\.com|pbs\.twimg\.com/i.test(url);
  }
  if (/octet-stream/i.test(contentType)) {
    if (data.type === 'media') return true;
    if (/[/.](m3u8|ts|mp4|flv|mpd|m4s)([?#]|$)/i.test(url)) return true;
    if (/[?&](format|type|media)=(hls|ts|mp4|m3u8|video|stream)/i.test(url)) return true;
  }
  return false;
}

function mediaKind(item) {
  if (PLAYLIST_EXT_RE.test(item.url) || /mpegurl|dash\+xml|mpd/i.test(item.mime || '')) return 'stream';
  if (/^audio\//i.test(item.mime || '')) return 'audio';
  return 'video';
}

function scoreMedia(item) {
  const ext = item.ext || mediaExt(item.url);
  const extScore = { mp4: 120, webm: 115, mov: 110, m4v: 105, m3u8: 95, mpd: 85, flv: 100, ts: 70 }[ext] || 50;
  const sizeScore = Math.min(40, Math.floor((item.size || 0) / (1024 * 1024)));
  return extScore + sizeScore + Math.min(20, Math.floor((Date.now() - item.time) / -30000) + 20);
}

function rememberMedia(data) {
  if (!blockedRulesReady || isTabBlocked(data.tabId, data.initiator || '')) return;
  if (!isMediaResponse(data)) return;
  const tabId = data.tabId;
  if (tabId == null || tabId < 0) return;
  const mime = headerValue(data.responseHeaders, 'content-type').split(';')[0].trim().toLowerCase();
  const size = parseInt(headerValue(data.responseHeaders, 'content-length') || '0', 10) || 0;
  const requestInfo = refererByRequest.get(data.requestId) || {};
  const referer = requestInfo.referer || data.initiator || '';
  refererByRequest.delete(data.requestId);

  const item = {
    url: data.url,
    ext: mediaExt(data.url),
    mime,
    size,
    kind: '',
    tabId,
    referer,
    cookie: requestInfo.cookie || '',
    time: Date.now()
  };
  item.kind = mediaKind(item);

  const list = mediaByTab.get(tabId) || [];
  const existing = list.find(x => x.url === item.url);
  if (existing) Object.assign(existing, item);
  else list.unshift(item);
  list.sort((a, b) => scoreMedia(b) - scoreMedia(a));
  mediaByTab.set(tabId, list.slice(0, MEDIA_CACHE_LIMIT));
  const publicItems = mediaByTab.get(tabId).map(({ cookie, ...rest }) => rest);
  chrome.storage.local.set({ [`psc_media_${tabId}`]: publicItems }, () => void chrome.runtime.lastError);
}

function mediaForTab(tabId) {
  return (mediaByTab.get(Number(tabId)) || []).filter(item => item.kind === 'video' || item.kind === 'stream');
}

function bestMediaForTab(tabId) {
  const items = mediaForTab(tabId);
  if (!items.length) return null;
  const stream = items.find(item => item.kind === 'stream' && /\.(m3u8|mpd)([?#]|$)/i.test(item.url || ''));
  if (stream) return stream;
  return items[0] || null;
}

function addWebRequestListener(event, handler, filter, specs) {
  try {
    event.addListener(handler, filter, specs);
  } catch (e) {
    const fallbackSpecs = (specs || []).filter(s => s !== 'extraHeaders');
    try {
      event.addListener(handler, filter, fallbackSpecs);
    } catch (err) {
      console.warn('Prompt Studio webRequest listener disabled', err?.message || err);
    }
  }
}

addWebRequestListener(chrome.webRequest.onSendHeaders, (data) => {
  const referer = headerValue(data.requestHeaders, 'referer') || headerValue(data.requestHeaders, 'origin');
  if (!blockedRulesReady || isTabBlocked(data.tabId, referer || data.initiator || '')) return;
  const cookie = headerValue(data.requestHeaders, 'cookie');
  if (referer || cookie) {
    refererByRequest.set(data.requestId, { referer, cookie, tabId: data.tabId });
    setTimeout(() => refererByRequest.delete(data.requestId), 30000);
  }
}, { urls: ['<all_urls>'] }, ['requestHeaders', 'extraHeaders']);

addWebRequestListener(chrome.webRequest.onResponseStarted, (data) => {
  try { rememberMedia(data); } catch (e) { console.warn('Prompt Studio media sniff failed', e); }
  try { rememberImage(data); } catch (e) {}
}, { urls: ['<all_urls>'] }, ['responseHeaders', 'extraHeaders']);

function clearTabMedia(tabId) {
  mediaByTab.delete(tabId);
  imagesByTab.delete(tabId);
  for (const [requestId, requestInfo] of refererByRequest) {
    if (requestInfo.tabId === tabId) refererByRequest.delete(requestId);
  }
  chrome.storage.local.remove(`psc_media_${tabId}`, () => void chrome.runtime.lastError);
}

// Full page navigation
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, url }) => {
  if (frameId !== 0) return;
  clearTabMedia(tabId);
  tabUrlMap.set(tabId, url);
});

// SPA navigation (pushState / replaceState) — catches YouTube, Bilibili, etc.
chrome.webNavigation.onHistoryStateUpdated.addListener(({ tabId, frameId, url }) => {
  if (frameId !== 0) return;
  const prev = tabUrlMap.get(tabId);
  // Only clear if the URL actually changed (not just hash fragment)
  const prevOriginPath = prev ? prev.replace(/#.*$/, '') : '';
  const newOriginPath = url.replace(/#.*$/, '');
  if (prevOriginPath !== newOriginPath) {
    clearTabMedia(tabId);
  }
  tabUrlMap.set(tabId, url);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabMedia(tabId);
  tabUrlMap.delete(tabId);
});

// ── Context Menus ────────────────────────────────────────────────────────────
const MENU_TITLES = {
  cn: {
    'save-image':    '💾 保存图片到 Prompt Studio Desktop',
    'reverse-image': '✨ 反推提示词 → Prompt Studio Desktop',
    'save-video':    '💾 保存视频到 Prompt Studio Desktop',
    'reverse-video': '✨ 反推提示词 → Prompt Studio Desktop',
    'save-skill':    '🤖 保存为 Skills 提示词 → Prompt Studio Desktop',
  },
  en: {
    'save-image':    '💾 Save image to Prompt Studio Desktop',
    'reverse-image': '✨ Reverse Prompt → Prompt Studio Desktop',
    'save-video':    '💾 Save video to Prompt Studio Desktop',
    'reverse-video': '✨ Reverse Prompt → Prompt Studio Desktop',
    'save-skill':    '🤖 Save as Skill Prompt → Prompt Studio Desktop',
  }
};
function createContextMenus(lang) {
  const titles = MENU_TITLES[lang] || MENU_TITLES.cn;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'save-image',    title: titles['save-image'],    contexts: ['image'] });
    chrome.contextMenus.create({ id: 'reverse-image', title: titles['reverse-image'], contexts: ['image'] });
    chrome.contextMenus.create({ id: 'save-video',    title: titles['save-video'],    contexts: ['video'] });
    chrome.contextMenus.create({ id: 'reverse-video', title: titles['reverse-video'], contexts: ['video'] });
    chrome.contextMenus.create({ id: 'save-skill',    title: titles['save-skill'],    contexts: ['selection'] });
  });
}
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get({ extLang: 'cn' }, ({ extLang }) => createContextMenus(extLang));
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const id = info.menuItemId;

  if (id === 'save-skill') {
    // Get full selection text from content script, fall back to info.selectionText
    chrome.tabs.sendMessage(tab.id, { type: 'get-selection' }, (text) => {
      const selText = (text && text.length > 0) ? text : (info.selectionText || '');
      chrome.storage.local.set({ _psc_skill_text: selText }, () => {
        openDialog({ mediaType: 'text', mode: 'skill', pageUrl: tab.url, pageTitle: tab.title });
      });
    });
    return;
  }

  const rawMediaUrl = info.srcUrl || info.mediaUrl || '';
  const mediaType = (id.includes('video') || (info.mediaType || '').includes('video')) ? 'video' : 'image';
  const sniffed = mediaType === 'video' ? bestMediaForTab(tab?.id) : null;
  const mediaUrl = mediaType === 'video' && !isUsableMediaUrl(rawMediaUrl) && sniffed ? sniffed.url : rawMediaUrl;
  const baseParams = {
    mediaUrl,
    mediaType,
    pageUrl: tab.url,
    pageTitle: tab.title,
    tabId: tab.id || '',
    referer: sniffed?.referer || tab.url || ''
  };
  if (id.startsWith('reverse')) {
    chrome.tabs.sendMessage(tab.id, { type: 'psc-show-panel', ...baseParams });
  } else {
    openDialog({ ...baseParams, mode: 'save' });
  }
});

// ── Window helpers ────────────────────────────────────────────────────────────
function buildQs(params) {
  return new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
  ).toString();
}

function openLaunchPage(page, params, size) {
  const key = `psc_payload_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  chrome.storage.local.set({ [key]: params }, () => {
    const stored = !chrome.runtime.lastError;
    const qs = stored ? `payloadKey=${encodeURIComponent(key)}` : buildQs(params);
    chrome.windows.create({
      url: chrome.runtime.getURL(`${page}?${qs}`),
      type: 'popup',
      width: size.width,
      height: size.height,
      focused: true
    }, () => {
      if (chrome.runtime.lastError) {
        console.warn('Prompt Studio popup open failed', chrome.runtime.lastError.message);
      }
    });
  });
}

function openDialog(params) {
  openLaunchPage('dialog.html', params, { width: 500, height: 640 });
}

function openResult(params) {
  openLaunchPage('result.html', params, { width: 480, height: 520 });
}

function getConfiguredServerUrl() {
  return new Promise(resolve => {
    chrome.storage.sync.get({ serverUrl: DEFAULT_SERVER }, ({ serverUrl }) => {
      resolve((serverUrl || DEFAULT_SERVER).replace(/\/$/, ''));
    });
  });
}

function buildLocalServerUrl(serverUrl, pathOrUrl) {
  const base = new URL((serverUrl || DEFAULT_SERVER).replace(/\/$/, ''));
  const target = new URL(String(pathOrUrl || ''), base);
  if (target.origin !== base.origin) {
    throw new Error('local API proxy target must stay on the configured server');
  }
  if (!target.pathname.startsWith('/api/') &&
      !target.pathname.startsWith('/uploads/') &&
      !target.pathname.startsWith('/exports/')) {
    throw new Error('local API proxy path is not allowed');
  }
  return target.href;
}

function isSaveRetryRequest(msg) {
  const method = String(msg.method || 'GET').toUpperCase();
  if (method !== 'POST') return false;
  try {
    const path = new URL(String(msg.path || msg.url || ''), DEFAULT_SERVER).pathname;
    return path === '/api/save-media' || path === '/api/cli/push';
  } catch {
    return false;
  }
}

function retryBodyFromMsg(msg) {
  let body = msg.body;
  try {
    if (typeof body === 'string') body = JSON.parse(body);
    else body = JSON.parse(JSON.stringify(body || {}));
  } catch {
    return body || null;
  }
  if (body && typeof body === 'object') {
    // Never persist login cookies in the retry queue.
    delete body.cookie;
  }
  return body;
}

function readRetryQueue() {
  return new Promise(resolve => {
    chrome.storage.local.get({ [SAVE_RETRY_QUEUE_KEY]: [] }, data => {
      const list = Array.isArray(data[SAVE_RETRY_QUEUE_KEY]) ? data[SAVE_RETRY_QUEUE_KEY] : [];
      resolve(list);
    });
  });
}

function writeRetryQueue(list) {
  return new Promise(resolve => chrome.storage.local.set({ [SAVE_RETRY_QUEUE_KEY]: list.slice(-50) }, resolve));
}

async function recordSaveRetry(msg, result) {
  if (!isSaveRetryRequest(msg) || msg.noRetryRecord) return;
  const body = retryBodyFromMsg(msg);
  if (!body) return;
  const queue = await readRetryQueue();
  queue.push({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    path: msg.path || msg.url || '',
    method: String(msg.method || 'POST').toUpperCase(),
    body,
    error: result?.error || result?.data?.error || result?.text || `HTTP ${result?.status || 0}`,
    attempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await writeRetryQueue(queue);
}

async function retrySaveQueue() {
  const queue = await readRetryQueue();
  const remaining = [];
  let ok = 0;
  for (const item of queue) {
    const result = await proxyLocalApi({
      path: item.path,
      method: item.method || 'POST',
      body: item.body,
      timeoutMs: 300000,
      noRetryRecord: true,
    }).catch(err => ({ ok: false, error: err?.message || String(err) }));
    if (result.ok) {
      ok++;
    } else {
      remaining.push({
        ...item,
        attempts: Number(item.attempts || 0) + 1,
        error: result.error || result.data?.error || result.text || `HTTP ${result.status || 0}`,
        updatedAt: new Date().toISOString(),
      });
    }
  }
  await writeRetryQueue(remaining);
  return { ok: true, retried: queue.length, saved: ok, remaining: remaining.length, items: remaining };
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function proxyLocalApi(msg) {
  const serverUrl = await getConfiguredServerUrl();
  const url = buildLocalServerUrl(serverUrl, msg.path || msg.url || '/');
  const method = String(msg.method || 'GET').toUpperCase();
  const headers = { ...(msg.headers || {}) };
  let body = msg.body;
  if (body !== undefined && body !== null && typeof body !== 'string') {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    body = JSON.stringify(body);
  }
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Math.min(Number(msg.timeoutMs || 120000), 300000));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method, headers, body, signal: controller.signal });
    const contentType = response.headers.get('content-type') || '';
    if (msg.responseType === 'dataUrl') {
      const buffer = await response.arrayBuffer();
      return {
        ok: response.ok,
        status: response.status,
        contentType,
        dataUrl: `data:${contentType || 'application/octet-stream'};base64,${arrayBufferToBase64(buffer)}`,
      };
    }
    if (/json/i.test(contentType)) {
      const data = await response.json();
      return { ok: response.ok, status: response.status, data };
    }
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } finally {
    clearTimeout(timer);
  }
}

// ── Message Handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'set-lang') {
    createContextMenus(msg.lang);
    return false;
  }

  // From content.js: hover toolbar button clicked
  if (msg.type === 'open-dialog') {
    const pageUrl   = msg.pageUrl   || sender.tab?.url   || '';
    const pageTitle = msg.pageTitle || sender.tab?.title || '';
    const tabId = msg.tabId || sender.tab?.id || '';
    if (blockedRulesReady && isTabBlocked(Number(tabId), pageUrl)) return false;
    const cookie = msg.cookie || '';
    if (msg.mode === 'reverse') {
      openResult({ mediaUrl: msg.mediaUrl, mediaType: msg.mediaType, pageUrl, pageTitle, tabId, referer: msg.referer || pageUrl, cookie });
    } else {
      openDialog({ mediaUrl: msg.mediaUrl, mediaType: msg.mediaType, mode: msg.mode, pageUrl, pageTitle, tabId, referer: msg.referer || pageUrl, cookie });
    }
    return false;
  }

  if (msg.type === 'get-captured-images') {
    const tabId = Number(msg.tabId || sender.tab?.id || -1);
    if (!blockedRulesReady || isTabBlocked(tabId, msg.pageUrl || sender.tab?.url || '')) {
      if (tabId >= 0) clearTabMedia(tabId);
      sendResponse({ images: [] });
      return false;
    }
    const list = (imagesByTab.get(tabId) || []).map(({ url, size }) => ({ url, size }));
    sendResponse({ images: list });
    return false;
  }

  if (msg.type === 'get-media-candidates') {
    const tabId = Number(msg.tabId || sender.tab?.id || -1);
    if (!blockedRulesReady || isTabBlocked(tabId, msg.pageUrl || sender.tab?.url || '')) {
      if (tabId >= 0) clearTabMedia(tabId);
      sendResponse({ items: [] });
      return false;
    }
    sendResponse({ items: mediaForTab(tabId) });
    return false;
  }

  if (msg.type === 'resolve-media-url') {
    const tabId = Number(msg.tabId || sender.tab?.id || -1);
    if (!blockedRulesReady || isTabBlocked(tabId, msg.pageUrl || msg.referer || sender.tab?.url || '')) {
      if (tabId >= 0) clearTabMedia(tabId);
      sendResponse({ mediaUrl: msg.mediaUrl || '', referer: '', cookie: '', item: null });
      return false;
    }
    const best = bestMediaForTab(tabId);
    const currentExt = mediaExt(msg.mediaUrl || '');
    const useBest = msg.mediaType === 'video' && best && (
      !isUsableMediaUrl(msg.mediaUrl || '') ||
      !['mp4', 'webm', 'mov', 'm4v', 'm3u8', 'mpd'].includes(currentExt)
    );
    sendResponse({
      mediaUrl: useBest && best ? best.url : (msg.mediaUrl || ''),
      referer: best?.referer || msg.referer || '',
      cookie: best?.cookie || '',
      item: best ? (({ cookie, ...rest }) => rest)(best) : null
    });
    return false;
  }

  if (msg.type === 'get-server-url') {
    chrome.storage.sync.get({ serverUrl: DEFAULT_SERVER }, ({ serverUrl }) => {
      sendResponse({ serverUrl });
    });
    return true;
  }

  if (msg.type === 'local-api') {
    proxyLocalApi(msg)
      .then(async result => {
        if (!result.ok) await recordSaveRetry(msg, result);
        sendResponse(result);
      })
      .catch(async err => {
        const result = { ok: false, error: err?.message || String(err) };
        await recordSaveRetry(msg, result);
        sendResponse(result);
      });
    return true;
  }

  if (msg.type === 'get-save-retry-queue') {
    readRetryQueue().then(items => sendResponse({ ok: true, items }));
    return true;
  }

  if (msg.type === 'retry-save-queue') {
    retrySaveQueue().then(sendResponse).catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (msg.type === 'clear-save-retry-queue') {
    writeRetryQueue([]).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'get-settings') {
    chrome.storage.sync.get({
      serverUrl:    DEFAULT_SERVER,
      imageApiBase: 'https://api.openai.com/v1',
      imageApiKey:  '',
      imageModel:   'gpt-4o',
      videoApiBase: 'https://generativelanguage.googleapis.com/v1beta',
      videoApiKey:  '',
      videoModel:   'gemini-2.5-pro',
      imageReverseInstruction: '',
      videoReverseInstruction: '',
      domainBlacklist: '',
      toolPath:     ''
    }, async (settings) => {
      try {
        const r = await fetch(`${settings.serverUrl}/api/desktop/settings`, { signal: AbortSignal.timeout(2500) });
        const data = await r.json();
        if (data.ok && data.settings) settings = { ...settings, ...data.settings, serverUrl: settings.serverUrl };
      } catch {}
      sendResponse({ settings });
    });
    return true;
  }

  if (msg.type === 'notify') {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon48.png'),
      title: 'Prompt Studio Desktop',
      message: msg.message || ''
    });
    return false;
  }

  // ── Image dimension probing (runs in background = no CORS, no page side-effects) ──
  if (msg.type === 'probe-image-sizes') {
    const items = msg.items || []; // [{ probeUrl, referer }]
    (async () => {
      const results = [];
      for (const { probeUrl, referer } of items) {
        let ruleId = -1;
        try {
          // Apply referer header
          ruleId = await new Promise(r => {
            const id = Math.floor(Math.random() * 1000000);
            const rule = {
              id, priority: 2,
              action: { type: 'modifyHeaders', requestHeaders: [
                { operation: 'set', header: 'referer', value: referer || '' },
                { operation: 'remove', header: 'origin' }
              ]},
              condition: { urlFilter: probeUrl, resourceTypes: ['xmlhttprequest'] }
            };
            chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule] })
              .then(() => r(id)).catch(() => r(-1));
          });
          const controller = new AbortController();
          setTimeout(() => controller.abort(), 8000);
          const resp = await fetch(probeUrl, { signal: controller.signal });
          if (!resp.ok) { results.push(null); continue; }
          const reader = resp.body.getReader();
          const { value } = await reader.read();
          reader.cancel();
          if (!value || value.byteLength < 30) { results.push(null); continue; }
          const sz = parseSizeFromBytes(value);
          results.push(sz);
        } catch {
          results.push(null);
        } finally {
          if (ruleId > 0) chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => {});
        }
      }
      sendResponse({ results });
    })();
    return true; // async
  }

  // ── Referer injection for image probing (same mechanism as Download All Images) ──
  if (msg.type === 'apply-referer') {
    const id = Math.floor(Math.random() * 1000000);
    const rule = {
      id,
      priority: 2,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { operation: 'set', header: 'referer', value: msg.referer || '' },
          { operation: 'remove', header: 'origin' }
        ]
      },
      condition: {
        urlFilter: msg.src,
        resourceTypes: ['xmlhttprequest', 'image'],
        tabIds: [sender.tab?.id].filter(Boolean)
      }
    };
    chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule] })
      .then(() => sendResponse(id))
      .catch(() => sendResponse(-1));
    return true;
  }

  if (msg.type === 'revoke-referer') {
    if (msg.id > 0) {
      chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [msg.id] }).catch(() => {});
    }
    sendResponse();
    return false;
  }

  if (msg.type === 'check-server') {
    isServerOnline(msg.serverUrl || DEFAULT_SERVER).then(online => sendResponse({ online }));
    return true;
  }

  if (msg.type === 'offline-download') {
    const url = msg.mediaUrl;
    const filename = msg.filename || guessFilename(url, msg.mediaType);
    const subfolder = msg.mediaType === 'video' ? 'videos' : 'images';
    chrome.downloads.download({
      url,
      filename: `Prompt Studio Offline/${subfolder}/${filename}`,
      conflictAction: 'uniquify',
      saveAs: false,
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ ok: true, downloadId });
      }
    });
    return true;
  }

  if (msg.type === 'offline-batch-download') {
    const items = msg.items || [];
    let completed = 0;
    const results = [];
    if (items.length === 0) { sendResponse({ ok: true, results: [] }); return true; }
    for (const item of items) {
      const filename = item.filename || guessFilename(item.url, 'image');
      chrome.downloads.download({
        url: item.url,
        filename: `Prompt Studio Offline/images/${filename}`,
        conflictAction: 'uniquify',
        saveAs: false,
      }, (downloadId) => {
        results.push({ url: item.url, downloadId, error: chrome.runtime.lastError?.message });
        completed++;
        if (completed === items.length) {
          sendResponse({ ok: true, results });
        }
      });
    }
    return true;
  }

  if (msg.type === 'save-skill-from-popup') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab) return;
      chrome.tabs.sendMessage(tab.id, { type: 'get-selection' }, (text) => {
        const selText = (typeof text === 'string' && text.length > 0) ? text : '';
        if (!selText.trim()) { sendResponse({ ok: false, reason: 'empty' }); return; }
        chrome.storage.local.set({ _psc_skill_text: selText }, () => {
          openDialog({ mediaType: 'text', mode: 'skill', pageUrl: tab.url, pageTitle: tab.title });
          sendResponse({ ok: true });
        });
      });
    });
    return true;
  }
});

// ── Offline download (when server is unavailable) ────────────────────────────
async function isServerOnline(serverUrl) {
  try {
    const r = await fetch(`${serverUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

function guessFilename(url, mediaType) {
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1] || '';
    if (last && /\.\w{2,5}$/.test(last)) {
      return decodeURIComponent(last).replace(/[<>:"/\\|?*]/g, '_');
    }
  } catch {}
  const ext = mediaType === 'video' ? '.mp4' : '.jpg';
  return `prompt-studio-${Date.now()}${ext}`;
}

// ── Keyboard shortcut: Alt+S → save selected text as Skill ───────────────────
chrome.commands.onCommand.addListener((command) => {
  if (command !== 'save-skill-shortcut') return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, { type: 'get-selection' }, (text) => {
      if (chrome.runtime.lastError) return;
      const selText = (typeof text === 'string' && text.length > 0) ? text : '';
      if (!selText.trim()) return;
      chrome.storage.local.set({ _psc_skill_text: selText }, () => {
        openDialog({ mediaType: 'text', mode: 'skill', pageUrl: tab.url, pageTitle: tab.title });
      });
    });
  });
});
