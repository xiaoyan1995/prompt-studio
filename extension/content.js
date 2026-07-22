// Prompt Studio Desktop Companion - Content Script
// Shows a floating toolbar on hover over images/videos
(function () {
  'use strict';
  if (window.__pscInjected) return;
  window.__pscInjected = true;

  // ── Styles ────────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    #psc-bar {
      position: fixed;
      z-index: 2147483647;
      display: none;
      align-items: center;
      gap: 3px;
      padding: 4px 5px;
      background: rgba(15, 23, 42, 0.82);
      border-radius: 9px;
      backdrop-filter: blur(10px);
      box-shadow: 0 3px 14px rgba(0,0,0,.35);
      pointer-events: auto;
      transition: opacity .15s;
    }
    #psc-bar.visible { display: flex; }
    .psc-btn {
      width: 28px; height: 28px;
      border: none;
      background: transparent;
      border-radius: 6px;
      cursor: pointer;
      font-size: 15px;
      display: flex; align-items: center; justify-content: center;
      transition: background .12s;
      line-height: 1;
    }
    .psc-btn:hover { background: rgba(255,255,255,.18); }
    .psc-sep { width: 1px; height: 16px; background: rgba(255,255,255,.18); margin: 0 1px; }
    .psc-label {
      font-size: 10px; font-weight: 700; color: rgba(255,255,255,.5);
      font-family: Inter, system-ui, sans-serif;
      padding: 0 3px 0 1px; letter-spacing: .04em;
    }
  `;
  document.head.appendChild(style);

  // ── Toolbar Element ────────────────────────────────────────────────────────
  const bar = document.createElement('div');
  bar.id = 'psc-bar';
  bar.innerHTML = `
    <button class="psc-btn" data-mode="save"    title="💾 保存到 Prompt Studio Desktop">💾</button>
    <button class="psc-btn" data-mode="reverse" title="✨ 反推提示词">✨</button>
  `;
  document.body.appendChild(bar);

  const DEFAULT_SERVER_URL = 'http://127.0.0.1:8768';

  let currentEl     = null;
  let hideTimer     = null;
  let showTimer     = null;
  let cardAnalysis  = '';
  let cardAnchorEl  = null;

  // ── Domain Blacklist ────────────────────────────────────────────────────────
  let blockedDomains = [];
  let blockedDomainsReady = false;
  let blockedDomainsLoadVersion = 0;
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

  function isHostBlocked() {
    const host = location.hostname.toLowerCase();
    const pageUrl = (() => {
      try {
        const u = new URL(location.href);
        u.hash = '';
        return u.href.toLowerCase();
      } catch {
        return location.href.toLowerCase().replace(/#.*$/, '');
      }
    })();
    return blockedDomains.some(rule => {
      const d = normalizeRule(rule);
      if (!d) return false;
      if (location.protocol === 'file:') {
        if (d === 'file://') return true;
        if (!d.startsWith('file://')) return false;
        return d.endsWith('/') ? pageUrl.startsWith(d) : pageUrl === d;
      }
      if (d.startsWith('file://')) return false;
      return host === d || host.endsWith('.' + d);
    });
  }
  function isRecognitionEnabled() {
    return blockedDomainsReady && !isHostBlocked();
  }

  function hideRecognitionUi() {
    clearTimers();
    bar.classList.remove('visible');
    currentEl = null;
  }

  function applyBlockedDomains(value) {
    blockedDomains = String(value || '').split('\n').map(normalizeRule).filter(Boolean);
    blockedDomainsReady = true;
    if (isHostBlocked()) hideRecognitionUi();
  }

  const blockedDomainsLoad = blockedDomainsLoadVersion;
  chrome.storage.sync.get({ domainBlacklist: '' }, s => {
    if (chrome.runtime.lastError || blockedDomainsLoad !== blockedDomainsLoadVersion) return;
    applyBlockedDomains(s.domainBlacklist);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.domainBlacklist) return;
    blockedDomainsLoadVersion += 1;
    applyBlockedDomains(changes.domainBlacklist.newValue);
  });

  function pscLocalApi(path, options = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'local-api',
        path,
        method: options.method || 'GET',
        headers: options.headers || undefined,
        body: options.body,
        responseType: options.responseType,
        timeoutMs: options.timeoutMs,
      }, (res) => {
        const err = chrome.runtime.lastError;
        if (err) { reject(new Error(err.message)); return; }
        if (!res) { reject(new Error('No response from extension background')); return; }
        if (res.error) { reject(new Error(res.error)); return; }
        resolve(res);
      });
    });
  }

  async function pscLocalJson(path, options = {}) {
    const res = await pscLocalApi(path, options);
    if (!res.ok) {
      throw new Error(res.data?.error || res.text || `HTTP ${res.status || 0}`);
    }
    return res.data;
  }

  function pscIsConfiguredLocalUrl(rawUrl) {
    try {
      const target = new URL(rawUrl, location.href);
      const base = new URL((typeof _pqiServerUrl === 'string' && _pqiServerUrl) || DEFAULT_SERVER_URL);
      return target.origin === base.origin &&
        (target.pathname.startsWith('/uploads/') ||
         target.pathname.startsWith('/exports/') ||
         target.pathname.startsWith('/api/'));
    } catch {
      return false;
    }
  }

  async function pscLoadImageAsDataUrl(rawUrl) {
    if (pscIsConfiguredLocalUrl(rawUrl)) {
      const res = await pscLocalApi(rawUrl, { responseType: 'dataUrl', timeoutMs: 60000 });
      if (!res.ok) throw new Error(res.data?.error || res.text || `HTTP ${res.status || 0}`);
      return res.dataUrl;
    }
    const r = await fetch(rawUrl);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const blob = await r.blob();
    return URL.createObjectURL(blob);
  }

  function bgMsg(msg) {
    return new Promise(resolve => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve({});
      }, 900);
      try {
        chrome.runtime.sendMessage(msg, res => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (chrome.runtime.lastError) resolve({});
          else resolve(res || {});
        });
      } catch {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({});
      }
    });
  }

  async function resolveMedia(mediaUrl, mediaType) {
    if (mediaType !== 'video') {
      return { mediaUrl, referer: location.href, cookie: '' };
    }
    try {
      const res = await bgMsg({
        type: 'resolve-media-url',
        mediaUrl,
        mediaType,
        referer: location.href
      });
      return {
        mediaUrl: res.mediaUrl || mediaUrl,
        referer: res.referer || location.href,
        cookie: res.cookie || ''
      };
    } catch {
      return { mediaUrl, referer: location.href, cookie: '' };
    }
  }

  function clearTimers() {
    clearTimeout(hideTimer);
    clearTimeout(showTimer);
  }

  function isBlocked(left, top, w, h) {
    const pts = [
      [left + w/2, top + h/2], [left+6, top+6], [left+w-6, top+6],
      [left+6, top+h-6], [left+w-6, top+h-6]
    ];
    for (const [x, y] of pts) {
      const hit = document.elementFromPoint(x, y);
      if (!hit) continue;
      if (hit === bar || bar.contains(hit)) continue;
      if (currentEl && (hit === currentEl || currentEl.contains(hit) || hit.contains(currentEl))) continue;
      return true;
    }
    return false;
  }

  function positionBar(el) {
    const r  = el.getBoundingClientRect();
    const BW = bar.offsetWidth  || 72;
    const BH = bar.offsetHeight || 38;
    const PAD = Math.max(8, Math.min(16, r.width * 0.03));
    function clamp(p) {
      return {
        left: Math.max(4, Math.min(window.innerWidth  - BW - 4, p.left)),
        top:  Math.max(4, Math.min(window.innerHeight - BH - 4, p.top))
      };
    }
    const candidates = [
      clamp({ left: r.right - BW - PAD, top: r.top    + PAD }),      // top-right  ← preferred
      clamp({ left: r.left  + PAD,      top: r.top    + PAD }),      // top-left
      clamp({ left: r.right - BW - PAD, top: r.bottom - BH - PAD }), // bottom-right
      clamp({ left: r.left  + PAD,      top: r.bottom - BH - PAD }), // bottom-left
    ];
    const chosen = candidates.find(p => !isBlocked(p.left, p.top, BW, BH)) || candidates[0];
    bar.style.left = `${Math.round(chosen.left)}px`;
    bar.style.top  = `${Math.round(chosen.top)}px`;
  }

  function showBar(el) {
    if (!isRecognitionEnabled()) return;
    clearTimers();
    // Re-inject bar if detached (SPA navigation edge case, e.g. Twitter/X)
    if (!bar.isConnected) (document.body || document.documentElement).appendChild(bar);
    currentEl = el;
    positionBar(el);
    bar.classList.add('visible');
  }

  function scheduleHide() {
    clearTimers();
    hideTimer = setTimeout(() => {
      bar.classList.remove('visible');
      currentEl = null;
    }, 320);
  }

  // ── Toolbar Clicks ─────────────────────────────────────────────────────────
  bar.addEventListener('mouseenter', clearTimers);
  bar.addEventListener('mouseleave', scheduleHide);

  bar.addEventListener('click', async (e) => {
    const btn = e.target.closest('.psc-btn');
    if (!btn || !currentEl || !isRecognitionEnabled()) return;
    e.stopPropagation();
    e.preventDefault();
    bar.classList.remove('visible');

    const bestImgUrl = currentEl.tagName === 'IMG' ? getBestUrl(currentEl) : '';
    const src = bestImgUrl || currentEl.currentSrc || currentEl.src || currentEl.getAttribute('src') || currentEl.getAttribute('data-src') || '';
    // Try to resolve relative URLs
    let mediaUrl = src;
    try { mediaUrl = new URL(src, location.href).href; } catch {}

    const mediaType = currentEl.tagName.toLowerCase() === 'video' ? 'video' : 'image';
    const resolved = await resolveMedia(mediaUrl, mediaType);
    mediaUrl = resolved.mediaUrl;
    if (btn.dataset.mode === 'reverse') {
      showCard(mediaUrl, mediaType, currentEl, resolved.referer, resolved.cookie);
    } else {
      chrome.runtime.sendMessage({
        type: 'open-dialog', mediaUrl, mediaType, mode: 'save',
        pageUrl: location.href, pageTitle: document.title,
        referer: resolved.referer, cookie: resolved.cookie
      });
    }
  });

  // ── Message Handler ───────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'get-selection') { sendResponse(window.getSelection().toString()); return; }
    if (msg.type === 'psc-show-panel') {
      if (!isRecognitionEnabled()) return;
      resolveMedia(msg.mediaUrl, msg.mediaType).then(res => {
        showCard(res.mediaUrl, msg.mediaType, null, res.referer || msg.referer, res.cookie || msg.cookie);
      });
      return;
    }
    if (msg.type === 'psc-reverse-result') {
      if (isRecognitionEnabled()) deliverResult(msg);
      return;
    }
    if (msg.type === 'scan-images') {
      sendResponse({ images: isRecognitionEnabled() ? scanPageImages() : [] });
      return;
    }
  });

  // ── Batch Scan ────────────────────────────────────────────────────────────
  function getBestUrl(img) {
    // 1. srcset — pick highest declared width
    const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
    if (srcset) {
      const entries = srcset.split(',').map(s => s.trim().split(/\s+/)).filter(p => p[0]);
      if (entries.length) {
        entries.sort((a, b) => {
          const wA = parseFloat((a[1] || '0').replace(/[wx]/i, '')) || 0;
          const wB = parseFloat((b[1] || '0').replace(/[wx]/i, '')) || 0;
          return wB - wA;
        });
        const best = entries[0][0];
        try { return new URL(best, location.href).href; } catch {}
      }
    }
    // 2. data-* lazy-load attributes (common frameworks)
    const dataAttrs = ['data-src','data-original','data-lazy-src','data-full',
                       'data-large','data-hi-res','data-image','data-url'];
    for (const attr of dataAttrs) {
      const v = img.getAttribute(attr);
      if (!v) continue;
      try { return new URL(v, location.href).href; } catch {}
    }
    // 3. currentSrc (respects srcset already chosen by browser)
    if (img.currentSrc) {
      try { return new URL(img.currentSrc, location.href).href; } catch {}
    }
    // 4. plain src
    const src = img.getAttribute('src') || '';
    if (!src) return null;
    try { return new URL(src, location.href).href; } catch { return null; }
  }

  function cleanCdnUrl(url) {
    try {
      const u = new URL(url);
      const host = u.hostname;

      // ── 小红书 xhscdn.com ──────────────────────────────────────────────
      // https://sns-img-bd.xhscdn.com/abc?imageView2/2/w/300/format/webp
      if (host.includes('xhscdn.com') || host.includes('xiaohongshu.com')) {
        u.search = '';
        return u.href;
      }

      // ── 微博 sinaimg.cn ────────────────────────────────────────────────
      // /thumb180/ /thumb300/ /orj360/ /orj480/ → /large/
      if (host.includes('sinaimg.cn') || host.includes('weibo.com')) {
        u.pathname = u.pathname.replace(/\/(thumb\d+|orj\d+|woriginal|mw\d+)\//, '/large/');
        u.search = '';
        return u.href;
      }

      // ── B站 hdslb.com / biliimg.com ────────────────────────────────────
      // image.jpg@200w_200h_1c.webp  →  image.jpg
      if (host.includes('hdslb.com') || host.includes('biliimg.com') || host.includes('bilibili.com')) {
        u.pathname = u.pathname.replace(/@[^/]*$/, '');
        u.search = '';
        return u.href;
      }

      // ── 抖音 / TikTok douyinpic.com ───────────────────────────────────
      // ~tplv-dy-resize-originx:0:0:q75.jpeg  →  strip tplv suffix
      if (host.includes('douyinpic.com') || host.includes('tiktokcdn.com') || host.includes('byteimg.com')) {
        u.pathname = u.pathname.replace(/~tplv-[^.]+(\.[a-z]+)$/i, '$1');
        u.search = '';
        return u.href;
      }

      if (host.includes('twimg.com')) {
        if (u.searchParams.has('name')) u.searchParams.set('name', 'orig');
        return u.href;
      }

      // ── 通用：去掉常见尺寸查询参数 ────────────────────────────────────
      // ?w=300&h=300  ?width=400  ?size=small  ?imageView...  ?x-oss-process=...
      const sizeParams = ['w','h','width','height','size','quality','q',
                          'imageview','imagemogr','x-oss-process','x-image-process',
                          'format','thumb','resize','crop','scale'];
      let stripped = false;
      sizeParams.forEach(p => {
        if (u.searchParams.has(p)) { u.searchParams.delete(p); stripped = true; }
      });
      // If URL path has thumbnail indicators like /s/ /thumb/ /small/
      const thumbPath = u.pathname.replace(/\/(s|sm|thumb|thumbnail|small|preview|mini|icon)(\/|_)/, '/');
      if (thumbPath !== u.pathname) { u.pathname = thumbPath; stripped = true; }

      return stripped ? u.href : url;
    } catch {
      return url;
    }
  }

  function scanPageImages() {
    if (!isRecognitionEnabled()) return [];
    const seen = new Set();
    const draft = [];

    function addEntry(originalUrl, width, height) {
      if (!originalUrl || !/^https?:\/\//i.test(originalUrl)) return;
      const saveUrl = cleanCdnUrl(originalUrl);
      if (!saveUrl || seen.has(saveUrl)) return;
      seen.add(saveUrl);
      draft.push({
        url: saveUrl,
        probeUrl: originalUrl,
        width: width || 0,
        height: height || 0,
      });
    }

    // 1. Performance API — ALL resources the browser actually loaded
    try {
      for (const entry of performance.getEntriesByType('resource')) {
        if (entry.initiatorType === 'img') {
          addEntry(entry.name, 0, 0);
        } else if (entry.initiatorType === 'css') {
          if (/\.(jpe?g|png|webp|gif|avif|svg|bmp)([?#]|$)/i.test(entry.name)) {
            addEntry(entry.name, 0, 0);
          }
        }
      }
    } catch {}

    // 2. DOM <img> elements — naturalWidth/Height is reliable and free
    document.querySelectorAll('img').forEach(img => {
      if (img.naturalWidth < 2 || img.naturalHeight < 2) return;
      const raw = getBestUrl(img);
      if (!raw) return;
      const saveUrl = cleanCdnUrl(raw);
      if (!saveUrl) return;
      if (seen.has(saveUrl)) {
        const existing = draft.find(d => d.url === saveUrl);
        if (existing && img.naturalWidth > existing.width) {
          existing.width  = img.naturalWidth;
          existing.height = img.naturalHeight;
        }
        return;
      }
      seen.add(saveUrl);
      draft.push({
        url: saveUrl,
        probeUrl: raw,
        width:  img.naturalWidth,
        height: img.naturalHeight,
      });
    });

    // 3. CSS background-image
    try {
      const bgUrlRe = /url\(["']?(https?:\/\/[^"')]+)["']?\)/gi;
      document.querySelectorAll('*').forEach(el => {
        try {
          const bg = getComputedStyle(el).backgroundImage;
          if (!bg || !bg.includes('url(')) return;
          let m;
          while ((m = bgUrlRe.exec(bg))) {
            if (/\.(jpe?g|png|webp|gif|avif|bmp)([?#]|$)/i.test(m[1])) {
              addEntry(m[1], 0, 0);
            }
          }
        } catch {}
      });
    } catch {}

    // 4. Hard-coded URLs in page HTML/JS source (finds full-size URLs in XHS/Weibo JSON data)
    try {
      const content = (document.documentElement?.innerHTML || '') + '\n\n' + document.body?.textContent;
      const urlRe = /\b(https?:\/\/[-A-Z0-9+&@#/%?=~_|!:,.;]*[-A-Z0-9+&@#/%=~_|])/ig;
      const urls = content.match(urlRe) || [];
      for (const raw of urls) {
        const url = raw.replace(/&amp;/g, '&').replace(/\\+$/, '').split(/['")]/)[0].split('</')[0];
        if (/\.(jpe?g|png|webp|gif|avif|bmp)([?#]|$)/i.test(url)) {
          addEntry(url, 0, 0);
        }
      }
    } catch {}

    // Return all items — probing for 0×0 items will be done by background.js
    return draft;
  }

  // ── Floating Reverse Card ─────────────────────────────────────────────────────
  let cardHost = null;

  function removeCard() {
    if (cardHost) { cardHost.remove(); cardHost = null; }
  }

  function deliverResult(msg) {
    if (!cardHost) return;
    const s = cardHost.shadowRoot;
    s.getElementById('loading').style.display = 'none';
    if (msg.error) {
      const err = s.getElementById('error');
      err.style.display = 'flex';
      err.querySelector('.emsg').textContent = msg.error;
    } else {
      const res = s.getElementById('result');
      res.style.display = 'flex';
      res.querySelector('textarea').value = msg.prompt || '';
      cardAnalysis = msg.analysis || '';
      // Pre-fill title if AI returned one
      if (msg.title) {
        const titleIn = s.getElementById('titleIn');
        if (titleIn && !titleIn.value.trim()) titleIn.value = msg.title;
      }
    }
  }

  const REVERSE_MODES = {
    auto:    { label: '全面', instruction: null },
    outfit:  { label: '服装', instruction: '请仔细分析图片中人物的穿着，【必须从头到脚逐部位覆盖，画面内可见的部位一个不能漏】：头饰/帽子→发型→颈部装饰/颈甲→上衣/外套/内搭（款式/面料/颜色/图案）→手套/臂甲/手部装饰→下装（裤子/裙子款式/长度）→腰部/腰带→袜子/腿部（丝袜/过膝袜/腿甲等）→鞋子（款式/颜色/鞋跟）。同时注明：①各部位露肤程度（如实描述）②面料质感（棉/丝绸/皮革/蕾丝/透明纱等）③整体穿搭风格与叠穿层次。直接输出描述词，不要解释。' },
    char:    { label: '人物', instruction: '请仔细分析图片中所有人物，每个人物单独描述，覆盖以下全部内容：①画面中的位置（画面左/中/右、前景/中景/背景）②面朝方向（正面朝向镜头/斜45°小侧脸/正侧面/斜45°背面/完全背对镜头）③若多人则描述站位关系及相互朝向④外貌特征（发型发色/脸部特征/肤色/表情/体型）⑤姿态与动作——【重要：描述四肢位置时必须用画面方位而非人体左右，例如"画面右侧的手握着…""画面左侧的腿踩在…"，禁止直接说"左手""右脚"，因为角色面对镜头时人体左右与画面左右相反，AI容易判断错误】⑥【服装从头到脚逐部位，不得遗漏】：头饰→颈部→上衣/外套/内搭→手部/臂部→下装→腰带→袜子/腿部→鞋子，每部位描述款式/颜色/图案/材质⑦【铁律：画面中所有道具/物品必须描述，一个不漏】：人物手持/接触/身旁的每一件物品都要写清楚——物品名称、颜色、款式、上面的文字或标识、放置位置（握在画面某侧手中/靠在某处/踩在某物上/放置于旁边等），不得以"滑板""水壶"等一笔带过，必须描述完整细节⑧整体人物气质。直接输出描述词，不要解释。' },
    scene:   { label: '场景', instruction: '请仔细分析图片场景，按以下顺序输出：【第一步：先综合判断场所类型】不要只说「室外楼梯」这种表面信息，必须根据所有视觉线索（建筑结构/地面质地/周围设施/文化背景等）判断具体地点类型（如：滑板公园/地铁入口楼梯/商展中心外境/学校进入口/城市广场/天台山小道等），越具体越好。【第二步：层次描述】前景/中景/背景的具体元素、空间纵深感、背景与主体的距离关系。【第三步：氛围与时间】时间（日间/夜晚/黄昏等）、天气、季节、整体地点文化属性。直接输出描述词，不要解释。' },
    style:   { label: '画风', instruction: '请仔细分析图片画风，按以下顺序判断：【第一步：先判断渲染真实度】是否存在真实皮肤质感（毛孔/血管/次表面散射）、真实布料纹理、真实环境光源？→若是：这是【超写实/写实动漯风格】，应输出 hyperrealistic anime / photorealistic anime illustration，渲染技术为 PBR-based rendering + anime aesthetics，不得证写赛璐璐/厚涂。【第二步：检查描线】富有明显黑色描边→ thick outlines/lineart，无描边→ no outlines (painterly/realistic)。【第三步：着色风格】是平涂（cel-shading/flat shading）还是厂涂（painterly）还是写实（PBR/photo-real）。【第四步：作品引用】仅当痛痛识别时才引用具体作品/艺术家，不確定则写通用风格描述，不得猜测。最终输出英文关键词，不要解释。' },
    cam:     { label: '运镜', instruction: '请仔细分析图片的镜头语言，输出完整的镜头/运镜提示词。必须覆盖：①景别（大远景/远景/全景/中景/中近景/近景/特写/大特写）②垂直视角（仰视感→低角度仰拍；俯视感→高角度俯拍；否则→平视，描述倾斜程度）③水平视角（正面/正侧面/斜45°/背面/过肩）④焦距感（鱼眼/超广角/广角/标准/中长焦/长焦/超长焦）⑤景深与散景（浅/中/深，虚化程度）⑥透视感（强透视/正常/压缩透视）⑦构图方式（居中/三分/对角线/框架/引导线等）⑧画幅（竖/横/方/宽银幕及比例）⑨推荐镜头运动方式（推/拉/摇/移/跟/环绕/固定等）⑩镜头特效（光晕/眩光/色散/暗角，有则描述）。直接输出描述词，不要解释。' },
  };

  function showCard(mediaUrl, mediaType, anchorEl, referer = '', cookie = '') {
    cardAnalysis = '';
    cardAnchorEl = anchorEl || null;
    const mediaReferer = referer || location.href;
    const mediaCookie = cookie || '';
    removeCard();

    // Position
    const W = 290, PAD = 10;
    let left = 0, top = 0;
    if (anchorEl) {
      const r = anchorEl.getBoundingClientRect();
      left = r.right + PAD;
      top  = r.top;
      if (left + W > window.innerWidth - PAD) left = r.left - W - PAD;
      if (left < PAD) { left = r.left; top = r.bottom + PAD; }
      top = Math.max(PAD, Math.min(top, window.innerHeight - 320));
    } else {
      left = window.innerWidth - W - PAD;
      top  = 80;
    }

    cardHost = document.createElement('div');
    cardHost.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647';
    document.documentElement.appendChild(cardHost);

    const shadow = cardHost.attachShadow({ mode: 'open' });
    const isVideo = mediaType === 'video';
    const chipCls = isVideo ? 'chip-video' : 'chip-img';
    const chipTxt = isVideo ? '🎬 视频' : '🖼️ 图片';

    shadow.innerHTML = `
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :host{all:initial}
  .card{
    position:fixed;left:${left}px;top:${top}px;width:${W}px;
    background:#fff;border-radius:14px;
    box-shadow:0 8px 32px rgba(0,0,0,.18),0 2px 8px rgba(0,0,0,.08);
    font-family:Inter,system-ui,sans-serif;font-size:13px;color:#1a2340;
    display:flex;flex-direction:column;overflow:hidden;
    animation:pop .15s cubic-bezier(.34,1.56,.64,1);
    pointer-events:all;
  }
  @keyframes pop{from{opacity:0;transform:scale(.9)}to{opacity:1;transform:scale(1)}}
  .head{
    display:flex;align-items:center;gap:6px;
    padding:10px 12px 8px;
    border-bottom:1px solid #f0f0f0;
    background:linear-gradient(135deg,#1d4ed8,#6d28d9);
    color:#fff;
  }
  .head-title{font-size:12px;font-weight:700;flex:1}
  .chip{padding:2px 7px;border-radius:99px;font-size:10px;font-weight:700}
  .chip-img{background:rgba(255,255,255,.2)}
  .chip-video{background:rgba(255,255,255,.2)}
  .close-btn{
    background:rgba(255,255,255,.15);border:none;color:#fff;
    width:20px;height:20px;border-radius:50%;cursor:pointer;
    font-size:12px;display:flex;align-items:center;justify-content:center;
  }
  .close-btn:hover{background:rgba(255,255,255,.3)}
  .body{padding:12px;display:flex;flex-direction:column;gap:10px;max-height:420px;overflow-y:auto}
  /* loading */
  #loading{display:flex;flex-direction:column;align-items:center;gap:8px;padding:16px 0}
  .spin{
    width:24px;height:24px;border:3px solid #e0e7ff;border-top-color:#1b67da;
    border-radius:50%;animation:spin .7s linear infinite;
  }
  @keyframes spin{to{transform:rotate(360deg)}}
  .lmsg{font-size:11px;color:#6b7a99;text-align:center}
  /* error */
  #error{display:none;flex-direction:column;gap:8px;align-items:center}
  .emsg{font-size:12px;color:#dc2626;line-height:1.5;text-align:center}
  /* result */
  #result{display:none;flex-direction:column;gap:8px}
  textarea{
    width:100%;min-height:130px;border:1px solid #e4e8ef;border-radius:8px;
    padding:8px;font-size:12px;font-family:'Consolas',monospace;
    line-height:1.6;resize:vertical;outline:none;color:#1a2340;
    background:#fafbff;
  }
  textarea:focus{border-color:#1b67da}
  .row{display:flex;gap:6px}
  .btn{
    flex:1;padding:7px 10px;border-radius:7px;border:none;
    font-size:12px;font-weight:600;cursor:pointer;
    font-family:inherit;transition:all .12s;
  }
  .btn-copy{background:#f1f5f9;color:#334155}
  .btn-copy:hover{background:#e2e8f0}
  .btn-save{background:#1b67da;color:#fff}
  .btn-save:hover{background:#1558c0}
  .btn-retry{background:#fef2f2;color:#dc2626;border:1px solid #fecaca}
  .btn-retry:hover{background:#fee2e2}
  .btn-start{background:#1b67da;color:#fff;width:100%;border-radius:7px;padding:8px}
  .btn-start:hover{background:#1558c0}
  .copied{font-size:11px;color:#16a34a;text-align:center;height:14px}
  /* save form */
  #saveForm{display:none;flex-direction:column;gap:8px;border-top:1px solid #f0f0f0;padding-top:8px}
  label{font-size:11px;font-weight:600;color:#6b7a99}
  select,input{
    width:100%;border:1px solid #e4e8ef;border-radius:7px;
    padding:7px 8px;font-size:12px;font-family:inherit;
    color:#1a2340;outline:none;background:#fff;
  }
  select:focus,input:focus{border-color:#1b67da}
  .cats{display:flex;gap:5px;flex-wrap:wrap}
  .cat{
    flex:1;min-width:60px;padding:5px 6px;border:1px solid #e4e8ef;border-radius:6px;
    background:#fff;cursor:pointer;text-align:center;font-size:11px;
    font-weight:600;color:#6b7a99;transition:all .12s;
  }
  .cat.on{border-color:#1b67da;background:#eef4ff;color:#1b67da}
  .btn-confirm{background:#16a34a;color:#fff;border:none;border-radius:7px;
    padding:7px 10px;width:100%;font-size:12px;font-weight:600;
    cursor:pointer;font-family:inherit;transition:background .12s;}
  .btn-confirm:hover{background:#15803d}
  .btn-confirm:disabled{opacity:.5;cursor:default}
  /* mode chips */
  .modes{display:flex;gap:4px;padding:8px 12px 0;flex-wrap:wrap}
  .mode-btn{
    padding:3px 10px;border-radius:99px;border:1px solid #e4e8ef;
    background:#f8faff;color:#6b7a99;font-size:11px;font-weight:600;
    cursor:pointer;transition:all .12s;font-family:inherit;
  }
  .mode-btn.on{border-color:#1b67da;background:#eef4ff;color:#1b67da}
  .mode-btn:hover:not(.on){background:#f0f4ff}
</style>
<div class="card">
  <div class="head">
    <span>✨</span>
    <span class="head-title">反推提示词</span>
    <span class="chip ${chipCls}">${chipTxt}</span>
    <button class="close-btn" id="closeBtn">×</button>
  </div>
  <div class="modes" id="modeRow"></div>
  <div class="body">
    <div id="idle" style="display:flex;flex-direction:column;align-items:center;padding:12px 0 4px;gap:8px">
      <div style="font-size:11px;color:#6b7a99">选择模式后点击开始分析</div>
      <button class="btn btn-start" id="startBtn">🔍 开始分析</button>
    </div>
    <div id="loading" style="display:none"><div class="spin"></div><div class="lmsg">AI 分析中…</div></div>
    <div id="error"><div class="emsg"></div><button class="btn btn-retry" id="retryBtn">重试</button></div>
    <div id="result">
      <textarea id="promptTa" spellcheck="false"></textarea>
      <div class="row">
        <button class="btn btn-copy" id="copyBtn">📋 复制</button>
        <button class="btn btn-save" id="saveBtn">💾 保存…</button>
      </div>
      <div class="copied" id="copiedHint"></div>
      <div id="saveForm">
        <label>项目</label>
        <select id="projSel"><option value="">加载中…</option></select>
        <label>分类</label>
        <div class="cats" id="catRow"></div>
        <label>标题（选填）</label>
        <input id="titleIn" placeholder="留空自动生成">
        <button class="btn-confirm" id="confirmBtn">✔ 确认保存</button>
      </div>
    </div>
  </div>
</div>`;

    // ── Wiring ──────────────────────────────────────────────────────────────────
    const s = shadow;
    let selectedMode = 'auto';

    // Mode chips
    const modeRow = s.getElementById('modeRow');
    Object.entries(REVERSE_MODES).forEach(([key, m]) => {
      const b = document.createElement('button');
      b.className = 'mode-btn' + (key === 'auto' ? ' on' : '');
      b.textContent = m.label;
      b.onclick = () => {
        selectedMode = key;
        modeRow.querySelectorAll('.mode-btn').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
      };
      modeRow.appendChild(b);
    });

    s.getElementById('closeBtn').onclick = removeCard;

    // Start button
    s.getElementById('startBtn').onclick = () => {
      s.getElementById('idle').style.display = 'none';
      s.getElementById('loading').style.display = 'flex';
      doReverse();
    };

    // Retry
    s.getElementById('retryBtn').onclick = () => {
      s.getElementById('error').style.display = 'none';
      s.getElementById('result').style.display = 'none';
      s.getElementById('loading').style.display = 'flex';
      doReverse();
    };

    // Copy
    s.getElementById('copyBtn').onclick = () => {
      const txt = s.getElementById('promptTa').value;
      navigator.clipboard.writeText(txt).then(() => {
        const h = s.getElementById('copiedHint');
        h.textContent = '✅ 已复制';
        setTimeout(() => { h.textContent = ''; }, 1800);
      });
    };

    // Save toggle
    let selectedCat = isVideo ? 'video_prompts' : 'image_prompts';
    s.getElementById('saveBtn').onclick = async () => {
      const form = s.getElementById('saveForm');
      if (form.style.display === 'flex') { form.style.display = 'none'; return; }
      form.style.display = 'flex';
      // Load projects
      try {
        const projects = await pscLocalJson('/api/projects');
        const sel = s.getElementById('projSel');
        sel.innerHTML = projects.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
      } catch { s.getElementById('projSel').innerHTML = '<option value="">⚠️ 连接失败</option>'; }
      // Categories
      const catRow = s.getElementById('catRow');
      catRow.innerHTML = '';
      [{ id:'image_prompts',l:'🖼️ 图片' },{ id:'video_prompts',l:'🎬 视频' },{ id:'skill_prompts',l:'🤖 Skills' }].forEach(c => {
        const b = document.createElement('button');
        b.className = 'cat' + (c.id === selectedCat ? ' on' : '');
        b.textContent = c.l;
        b.onclick = () => {
          selectedCat = c.id;
          catRow.querySelectorAll('.cat').forEach(x => x.classList.remove('on'));
          b.classList.add('on');
        };
        catRow.appendChild(b);
      });
    };

    // Confirm save
    s.getElementById('confirmBtn').onclick = async () => {
      const projectId = s.getElementById('projSel').value;
      if (!projectId) { alert('请选择项目'); return; }
      const prompt = s.getElementById('promptTa').value.trim();
      const title  = s.getElementById('titleIn').value.trim();
      const conf   = s.getElementById('confirmBtn');
      conf.disabled = true; conf.textContent = '保存中…';
      try {
        const d = await pscLocalJson('/api/save-media', {
          method: 'POST',
          timeoutMs: 300000,
          body: (() => {
            const MODE_FIELD = { auto:'prompt', outfit:'outfit_prompt', char:'char_prompt', scene:'scene_prompt', style:'style_prompt', cam:'cam_prompt' };
            const field = MODE_FIELD[selectedMode] || 'prompt';
            const payload = {
              url: mediaUrl, mediaType, projectId, category: selectedCat, title, tags: [],
              referer: mediaReferer, pageUrl: location.href, pageTitle: document.title, cookie: mediaCookie,
              [field]: prompt
            };
            if (selectedMode === 'auto') { payload.prompt = prompt; payload.analysis = cardAnalysis; }
            return payload;
          })()
        });
        if (!d.ok) throw new Error(d.error);
        conf.textContent = '✅ 已保存！'; conf.style.background = '#16a34a';
        setTimeout(removeCard, 1200);
      } catch(e) {
        conf.disabled = false; conf.textContent = '✔ 确认保存';
        alert('保存失败：' + e.message);
      }
    };

    // Kick off reverse through the extension background so page origins cannot hit the local API directly.
    async function doReverse() {
      try {
        const cfg = await new Promise(r =>
          chrome.runtime.sendMessage({ type: 'get-settings' }, res => r(res?.settings || {
            serverUrl: 'http://127.0.0.1:8768',
            imageApiBase: 'https://api.openai.com/v1', imageApiKey: '', imageModel: 'gpt-4o',
            videoApiBase: 'https://generativelanguage.googleapis.com/v1beta', videoApiKey: '', videoModel: 'gemini-2.5-pro',
            imageReverseInstruction: '', videoReverseInstruction: ''
          }))
        );
        // Determine instruction: preset mode overrides custom setting
        const modeInstr = REVERSE_MODES[selectedMode]?.instruction;
        const customInstr = modeInstr ||
          (isVideo ? cfg.videoReverseInstruction : cfg.imageReverseInstruction) || undefined;
        const data = await pscLocalJson('/api/reverse-prompt', {
          method: 'POST',
          timeoutMs: 300000,
          body: {
            url: mediaUrl, mediaType,
            referer: mediaReferer,
            pageUrl: location.href,
            cookie: mediaCookie,
            apiKey:  isVideo ? cfg.videoApiKey  : cfg.imageApiKey,
            apiBase: isVideo ? cfg.videoApiBase : cfg.imageApiBase,
            model:   isVideo ? cfg.videoModel   : cfg.imageModel,
            lang: 'zh',
            customInstruction: customInstr,
            imgWidth:  cardAnchorEl?.naturalWidth  || cardAnchorEl?.videoWidth  || 0,
            imgHeight: cardAnchorEl?.naturalHeight || cardAnchorEl?.videoHeight || 0,
          }
        });
        deliverResult(data.ok ? { prompt: data.prompt, title: data.title || '', analysis: data.analysis || '' } : { error: data.error || '反推失败' });
      } catch(e) {
        deliverResult({ error: e.message });
      }
    }
    // Don't auto-start – user picks mode first
  }

  // ── Mouse Tracking ─────────────────────────────────────────────────────────
  const HIT_SLOP = 64; // px – keep toolbar visible while cursor is within this zone
  let _scanTime = 0; let _scanCache = null;

  function isEligible(el) {
    if (!el || !el.isConnected) return false;
    const tag = el.tagName;
    if (tag !== 'IMG' && tag !== 'VIDEO') return false;
    const src = el.currentSrc || el.src || el.getAttribute('src') || el.getAttribute('data-src') || '';
    const hasSrcset = !!el.getAttribute('srcset');
    if (!src && !hasSrcset) return false;
    if (src && (src.startsWith('data:') || src.startsWith('blob:chrome-extension'))) return false;
    // Reject bare page URLs (img with empty src resolves to page URL)
    if (src && (src === location.href || src === location.origin + '/') && !hasSrcset) return false;
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') < 0.01) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) return false;
    if (r.bottom < 8 || r.right < 8 || r.top > window.innerHeight - 8 || r.left > window.innerWidth - 8) return false;
    return true;
  }

  function isEligibleRelaxed(el) {
    if (!el || !el.isConnected || (el.tagName !== 'IMG' && el.tagName !== 'VIDEO')) return false;
    const src = el.currentSrc || el.src || el.getAttribute('src') || el.getAttribute('data-src') || '';
    const hasSrcset = !!el.getAttribute('srcset');
    if (!src && !hasSrcset) return false;
    if (src && (src.startsWith('data:') || src.startsWith('blob:chrome-extension'))) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 8 && r.height >= 8;
  }

  function eligibleAncestor(target, cx, cy) {
    let el = target;
    while (el && el !== document.documentElement) {
      if (isEligible(el)) return el;
      el = el.parentElement;
    }
    // Fallback 1: scan all elements under cursor
    if (cx !== undefined && cy !== undefined) {
      for (const h of document.elementsFromPoint(cx, cy)) {
        if (h === bar || bar.contains(h)) continue;
        if (isEligible(h)) return h;
      }
      // Fallback 2: direct coordinate scan of all imgs/videos (throttled 100ms)
      // handles visibility:hidden, heavy overlays, etc. (e.g. Twitter/X)
      const now = Date.now();
      if (_scanCache) {
        const r = _scanCache.getBoundingClientRect();
        if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) return _scanCache;
        _scanCache = null;
      }
      if (now - _scanTime > 100) {
        _scanTime = now;
        for (const m of document.querySelectorAll('img,video')) {
          if (m === bar || bar.contains(m)) continue;
          const r = m.getBoundingClientRect();
          if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom && isEligibleRelaxed(m)) {
            _scanCache = m; break;
          }
        }
        if (_scanCache) return _scanCache;
      }
    }
    return null;
  }

  function isInHitSlop(x, y) {
    if (!currentEl) return false;
    const r = currentEl.getBoundingClientRect();
    return x >= r.left - HIT_SLOP && x <= r.right  + HIT_SLOP
        && y >= r.top  - HIT_SLOP && y <= r.bottom + HIT_SLOP;
  }

  document.addEventListener('pointermove', (e) => {
    if (!isRecognitionEnabled()) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    // Over the bar itself – cancel any pending hide
    if (bar.contains(target)) { clearTimers(); return; }
    // Within hit-slop zone of current image – stay visible
    if (currentEl && bar.classList.contains('visible') && isInHitSlop(e.clientX, e.clientY)) {
      clearTimers(); return;
    }
    const el = eligibleAncestor(target, e.clientX, e.clientY);
    if (el) {
      clearTimers();
      if (el !== currentEl) showTimer = setTimeout(() => showBar(el), 100);
    } else {
      scheduleHide();
    }
  }, { capture: true, passive: true });

  document.addEventListener('pointerleave', scheduleHide, true);

  // Reposition on scroll
  window.addEventListener('scroll', () => {
    if (currentEl && bar.classList.contains('visible')) positionBar(currentEl);
  }, { passive: true });

  // ══════════════════════════════════════════════════════════════════════════
  // ── Prompt Quick-Insert (whitelist-based) ─────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════
  let insertWhitelist = [];
  let _pqiServerUrl = DEFAULT_SERVER_URL;
  chrome.storage.sync.get({ promptInsertWhitelist: '', serverUrl: DEFAULT_SERVER_URL }, s => {
    insertWhitelist = (s.promptInsertWhitelist || '').split('\n').map(d => d.trim().toLowerCase()).filter(Boolean);
    _pqiServerUrl = s.serverUrl || DEFAULT_SERVER_URL;
  });
  chrome.storage.onChanged.addListener(changes => {
    if (changes.promptInsertWhitelist) {
      insertWhitelist = (changes.promptInsertWhitelist.newValue || '').split('\n').map(d => d.trim().toLowerCase()).filter(Boolean);
    }
    if (changes.serverUrl) _pqiServerUrl = changes.serverUrl.newValue || DEFAULT_SERVER_URL;
  });

  function isInsertWhitelisted() {
    const host = location.hostname.toLowerCase();
    return insertWhitelist.some(d => host === d || host.endsWith('.' + d));
  }

  // ── Floating insert icon ──────────────────────────────────────────────────
  const pqiStyle = document.createElement('style');
  pqiStyle.textContent = `
    #pqi-icon {
      position: fixed; z-index: 2147483646; display: none;
      width: 22px; height: 22px; border-radius: 5px;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      color: #fff; border: none; cursor: pointer;
      font-size: 12px; line-height: 1;
      display: none; align-items: center; justify-content: center;
      box-shadow: 0 1px 4px rgba(0,0,0,.2);
      transition: opacity .12s, transform .12s;
      pointer-events: auto;
      font-family: system-ui, sans-serif;
      opacity: .85;
    }
    #pqi-icon:hover { opacity: 1; transform: scale(1.08); }
    #pqi-icon.visible { display: flex; }
    #pqi-panel {
      position: fixed; z-index: 2147483647; display: none;
      width: 460px; max-height: 520px;
      background: #fff; border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,.18), 0 2px 8px rgba(0,0,0,.08);
      font-family: Inter, system-ui, sans-serif; font-size: 13px; color: #1a2340;
      overflow: hidden; flex-direction: column;
      animation: pqi-pop .15s cubic-bezier(.34,1.56,.64,1);
      pointer-events: auto;
    }
    @keyframes pqi-pop { from { opacity: 0; transform: scale(.95); } to { opacity: 1; transform: scale(1); } }
    #pqi-panel.visible { display: flex; }
    .pqi-head {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 14px; border-bottom: 1px solid #f0f0f0;
      background: linear-gradient(135deg, #1d4ed8, #6d28d9); color: #fff;
    }
    .pqi-head-title { font-size: 13px; font-weight: 700; flex: 1; }
    .pqi-close { background: rgba(255,255,255,.15); border: none; color: #fff; width: 22px; height: 22px; border-radius: 50%; cursor: pointer; font-size: 13px; display: flex; align-items: center; justify-content: center; }
    .pqi-close:hover { background: rgba(255,255,255,.3); }
    .pqi-search-row { display: flex; align-items: center; border-bottom: 1px solid #f0f0f0; padding: 0 10px; gap: 6px; }
    .pqi-search-label { font-size: 11px; color: #6b7a99; font-weight: 600; white-space: nowrap; }
    .pqi-search { border: none; outline: none; padding: 7px 4px; font-size: 12px; font-family: inherit; flex: 1; color: #1a2340; min-width: 0; }
    .pqi-search::placeholder { color: #b0b8cc; }
    .pqi-rewrite-row { display: flex; align-items: center; border-bottom: 1px solid #f0f0f0; padding: 0 10px; gap: 6px; }
    .pqi-rewrite-input { border: none; outline: none; padding: 7px 4px; font-size: 12px; font-family: inherit; flex: 1; color: #1a2340; min-width: 0; }
    .pqi-rewrite-input::placeholder { color: #b0b8cc; }
    .pqi-rewrite-label { font-size: 11px; color: #6366f1; font-weight: 600; white-space: nowrap; }
    .pqi-body { display: flex; flex: 1; min-height: 0; overflow: hidden; }
    .pqi-sidebar {
      width: 110px; border-right: 1px solid #f0f0f0; overflow-y: auto;
      padding: 6px 0; flex-shrink: 0;
    }
    .pqi-sidebar-item {
      padding: 6px 12px; font-size: 11px; color: #6b7a99; cursor: pointer;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      border-left: 2px solid transparent; transition: all .1s;
    }
    .pqi-sidebar-item:hover { background: #f8faff; color: #1d4ed8; }
    .pqi-sidebar-item.on { background: #eef4ff; color: #1d4ed8; border-left-color: #1d4ed8; font-weight: 600; }
    .pqi-folder-item {
      padding: 4px 12px 4px 24px; font-size: 10px; color: #8895ad; cursor: pointer;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      transition: all .1s;
    }
    .pqi-folder-item:hover { color: #1d4ed8; background: #f8faff; }
    .pqi-folder-item.on { color: #1d4ed8; font-weight: 600; }
    .pqi-list { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-wrap: wrap; gap: 8px; align-content: start; }
    .pqi-item {
      box-sizing: border-box !important;
      width: calc(50% - 4px) !important; border-radius: 8px !important; cursor: pointer !important;
      border: 1px solid #eee !important; transition: all .12s !important;
      overflow: hidden !important; background: #fff !important;
      display: flex !important; flex-direction: column !important;
    }
    .pqi-item:hover { border-color: #c7d8f4 !important; box-shadow: 0 2px 8px rgba(0,0,0,.08) !important; }
    .pqi-item-thumb-wrap {
      box-sizing: border-box !important;
      width: 100% !important; height: 140px !important; position: relative !important;
      overflow: hidden !important; background: #f0f4fc !important;
    }
    .pqi-item-thumb {
      position: absolute !important; top: 0 !important; left: 0 !important;
      width: 100% !important; height: 100% !important; object-fit: cover !important; display: block !important;
    }
    .pqi-item-thumb-placeholder {
      position: absolute !important; top: 0 !important; left: 0 !important;
      width: 100% !important; height: 100% !important;
      background: linear-gradient(135deg, #eef4ff, #e2ebff) !important;
      display: flex !important; align-items: center !important; justify-content: center !important;
      font-size: 28px !important; color: #9fb8e9 !important;
    }
    .pqi-item-info { box-sizing: border-box !important; padding: 7px 8px 8px !important; display: flex !important; flex-direction: column !important; gap: 3px !important; }
    .pqi-item-title { font-size: 12px !important; font-weight: 700 !important; color: #1a2340 !important; overflow: hidden !important; text-overflow: ellipsis !important; white-space: nowrap !important; }
    .pqi-item-prompt { font-size: 11px !important; color: #6b7a99 !important; line-height: 1.4 !important; display: -webkit-box !important; -webkit-line-clamp: 2 !important; -webkit-box-orient: vertical !important; overflow: hidden !important; word-break: break-all !important; }
    .pqi-item-tags { display: flex !important; gap: 3px !important; flex-wrap: wrap !important; }
    .pqi-item-tag { font-size: 9px !important; background: #f0f4fc !important; color: #5b6eae !important; padding: 1px 5px !important; border-radius: 4px !important; }
    .pqi-ribbon { box-sizing: border-box !important; display: flex !important; height: 5px !important; width: 100% !important; border-bottom: 1px solid #eee !important; overflow: hidden !important; }
    .pqi-ribbon div { box-sizing: border-box !important; min-width: 0 !important; flex-shrink: 1 !important; flex-grow: 1 !important; }
    .pqi-empty { padding: 24px !important; text-align: center !important; color: #9ca3af !important; font-size: 12px !important; grid-column: 1 / -1 !important; }
    .pqi-toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: rgba(15,23,42,.85); color: #fff; padding: 8px 18px; border-radius: 8px; font-size: 12px; font-weight: 600; z-index: 2147483647; pointer-events: none; animation: pqi-pop .15s; }
  `;
  document.head.appendChild(pqiStyle);

  const pqiIcon = document.createElement('button');
  pqiIcon.id = 'pqi-icon';
  pqiIcon.textContent = '📋';
  pqiIcon.title = '插入提示词';
  document.body.appendChild(pqiIcon);

  const pqiPanel = document.createElement('div');
  pqiPanel.id = 'pqi-panel';
  document.body.appendChild(pqiPanel);

  let _pqiFocusedEl = null;
  let _pqiSavedRange = null; // Save selection range for contenteditable
  let _pqiProjects = null;
  let _pqiSelectedProjIdx = 0;
  let _pqiSelectedCat = 'image_prompts';
  let _pqiFolderFilter = null; // null = root (all non-folder items without folder_id)
  let _pqiSearch = '';
  let _pqiInjectPalette = true;

  function pqiGetVisibleRect(el) {
    // For contenteditable, use the [contenteditable] container itself
    const ce = el.closest && el.closest('[contenteditable="true"]');
    const target = ce || el;
    return target.getBoundingClientRect();
  }

  function pqiShowIcon(el) {
    const r = pqiGetVisibleRect(el);
    const iconW = 22, iconH = 22, gap = 4;
    // Place icon outside the input, to its left, vertically centered
    let left = r.left - iconW - gap;
    let top = r.top + Math.max(0, (r.height - iconH) / 2);
    // If no room on the left, place outside the right edge
    if (left < 4) { left = r.right + gap; }
    left = Math.max(4, Math.min(window.innerWidth - iconW - 4, left));
    top = Math.max(4, Math.min(window.innerHeight - iconH - 4, top));
    pqiIcon.style.left = left + 'px';
    pqiIcon.style.top = top + 'px';
    pqiIcon.classList.add('visible');
  }

  function pqiHideIcon() {
    pqiIcon.classList.remove('visible');
  }

  function pqiHidePanel() {
    pqiPanel.classList.remove('visible');
    pqiPanel.innerHTML = '';
  }

  function pqiToast(msg) {
    const t = document.createElement('div');
    t.className = 'pqi-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1800);
  }

  function pqiInsertText(text) {
    const el = _pqiFocusedEl;
    if (!el) return;
    pqiHidePanel();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const start = el.selectionStart || 0;
      const end = el.selectionEnd || 0;
      const before = el.value.substring(0, start);
      const after = el.value.substring(end);
      el.value = before + text + after;
      el.selectionStart = el.selectionEnd = start + text.length;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.focus();
    } else if (el.isContentEditable || el.contentEditable === 'true' || el.closest('[contenteditable="true"]')) {
      const target = el.closest('[contenteditable="true"]') || el;
      target.focus();
      // Restore saved selection so cursor is in the right place
      if (_pqiSavedRange) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        try { sel.addRange(_pqiSavedRange); } catch(e) {}
      }
      // Try execCommand first (works in most browsers for contenteditable)
      let ok = false;
      try { ok = document.execCommand('insertText', false, text); } catch(e) {}
      if (!ok) {
        // Fallback: insert text node at selection or end
        const sel = window.getSelection();
        if (sel.rangeCount) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          range.insertNode(document.createTextNode(text));
          range.collapse(false);
        } else {
          target.textContent += text;
        }
      }
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }
    pqiToast('✅ 已插入');
  }

  function pqiRenderPanel() {
    if (!_pqiProjects || !_pqiProjects.length) {
      pqiPanel.innerHTML = '<div class="pqi-head"><span>📋</span><span class="pqi-head-title">提示词库</span><button class="pqi-close" id="pqiClose">×</button></div><div class="pqi-empty">⚠️ 没有项目或连接失败</div>';
      pqiPanel.querySelector('#pqiClose').onclick = pqiHidePanel;
      return;
    }
    const proj = _pqiProjects[_pqiSelectedProjIdx] || _pqiProjects[0];
    const cats = [
      { id: 'image_prompts', label: '🖼️ 图片' },
      { id: 'video_prompts', label: '🎬 视频' },
      { id: 'skill_prompts', label: '🤖 Skills' }
    ];
    let items = (proj[_pqiSelectedCat] || []).slice();
    if (_pqiSearch) {
      const q = _pqiSearch.toLowerCase();
      items = items.filter(it => {
        const hay = ((it.title || '') + ' ' + (it.prompt || '') + ' ' + (it.tags || []).join(' ')).toLowerCase();
        return hay.includes(q);
      });
    }
    items.sort((a, b) => (b.updated_at || b.created_at || '').localeCompare(a.updated_at || a.created_at || ''));

    pqiPanel.innerHTML = `
      <div class="pqi-head">
        <span>📋</span>
        <span class="pqi-head-title">提示词库</span>
        <button class="pqi-close" id="pqiClose">×</button>
      </div>
      <div class="pqi-search-row">
        <span class="pqi-search-label">🔍 搜索</span>
        <input class="pqi-search" id="pqiSearch" placeholder="输入关键词过滤…" value="${_pqiSearch.replace(/"/g, '&quot;')}">
      </div>
      <div class="pqi-rewrite-row">
        <span class="pqi-rewrite-label">✨ 改写</span>
        <input class="pqi-rewrite-input" id="pqiRewriteInput" placeholder="输入改写指令（如“把主体换成猫”），然后点卡片…">
      </div>
      <div class="pqi-palette-toggle" style="display:flex!important;align-items:center!important;gap:6px!important;padding:2px 10px 4px!important;font-size:11px!important;color:#666!important;user-select:none!important;">
        <label style="display:flex!important;align-items:center!important;gap:4px!important;cursor:pointer!important;margin:0!important;">
          <input type="checkbox" id="pqiPaletteToggle" ${_pqiInjectPalette ? 'checked' : ''} style="margin:0!important;cursor:pointer!important;">
          <span>🎨 注入色彩配方</span>
        </label>
      </div>
      <div class="pqi-body">
        <div class="pqi-sidebar" id="pqiSidebar"></div>
        <div class="pqi-list" id="pqiList"></div>
      </div>`;

    pqiPanel.querySelector('#pqiClose').onclick = pqiHidePanel;

    // Search
    const searchInput = pqiPanel.querySelector('#pqiSearch');
    searchInput.addEventListener('input', () => {
      _pqiSearch = searchInput.value;
      pqiRenderList();
    });
    // Don't auto-focus search to avoid stealing _pqiFocusedEl

    // Palette toggle
    const palToggle = pqiPanel.querySelector('#pqiPaletteToggle');
    if (palToggle) palToggle.addEventListener('change', () => { _pqiInjectPalette = palToggle.checked; });

    // Sidebar
    const sidebar = pqiPanel.querySelector('#pqiSidebar');
    _pqiProjects.forEach((p, pi) => {
      const projDiv = document.createElement('div');
      projDiv.className = 'pqi-sidebar-item' + (pi === _pqiSelectedProjIdx ? ' on' : '');
      projDiv.textContent = '📁 ' + (p.name || '未命名');
      projDiv.style.fontWeight = '700';
      projDiv.style.fontSize = '12px';
      projDiv.onclick = () => { _pqiSelectedProjIdx = pi; pqiRenderPanel(); };
      sidebar.appendChild(projDiv);
    });
    // Separator
    const sep = document.createElement('div');
    sep.style.cssText = 'height:1px;background:#f0f0f0;margin:4px 0';
    sidebar.appendChild(sep);
    cats.forEach(c => {
      const allItems = proj[c.id] || [];
      const folders = allItems.filter(it => it.is_folder);
      const nonFolderCount = allItems.filter(it => !it.is_folder).length;
      const div = document.createElement('div');
      div.className = 'pqi-sidebar-item' + (_pqiSelectedCat === c.id && _pqiFolderFilter === null ? ' on' : '');
      div.textContent = c.label + ` (${nonFolderCount})`;
      div.onclick = () => { _pqiSelectedCat = c.id; _pqiFolderFilter = null; pqiRenderPanel(); };
      sidebar.appendChild(div);
      // Show folders as sub-items under this category
      if (_pqiSelectedCat === c.id && folders.length) {
        folders.forEach(f => {
          const fCount = allItems.filter(it => !it.is_folder && it.folder_id === f.id).length;
          const fd = document.createElement('div');
          fd.className = 'pqi-folder-item' + (_pqiFolderFilter === f.id ? ' on' : '');
          fd.textContent = '📂 ' + (f.title || f.name || '未命名') + ` (${fCount})`;
          fd.onclick = () => { _pqiSelectedCat = c.id; _pqiFolderFilter = f.id; pqiRenderPanel(); };
          sidebar.appendChild(fd);
        });
      }
    });

    pqiRenderList();
  }

  // ── CIE L*a*b* Perceptual color translator inside Extension ──
  function pqiRgbToLab(r,g,b) {
    let R=r/255,G=g/255,B=b/255;
    R=R<=0.04045?R/12.92:Math.pow((R+0.055)/1.055,2.4);
    G=G<=0.04045?G/12.92:Math.pow((G+0.055)/1.055,2.4);
    B=B<=0.04045?B/12.92:Math.pow((B+0.055)/1.055,2.4);
    let X=R*0.4124564+G*0.3575761+B*0.1804375;
    let Y=R*0.2126729+G*0.7151522+B*0.0721750;
    let Z=R*0.0193339+G*0.1191920+B*0.9503041;
    X/=0.95047; Z/=1.08883;
    const f=t=>t>0.008856?Math.cbrt(t):7.787*t+16/116;
    return [116*f(Y)-16, 500*(f(X)-f(Y)), 200*(f(Y)-f(Z))];
  }
  function pqiHexToLab(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(x => x + x).join('');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    return pqiRgbToLab(r, g, b);
  }
  function pqiDeltaE(lab1, lab2) {
    return Math.sqrt(Math.pow(lab1[0]-lab2[0], 2) + Math.pow(lab1[1]-lab2[1], 2) + Math.pow(lab1[2]-lab2[2], 2));
  }
  const PQI_COLOR_TARGETS = {
    'rich ruby crimson red': [53, 80, 67],
    'warm amber tangerine orange': [65, 48, 75],
    'soft golden marigold yellow': [81, 10, 80],
    'emerald botanical sage green': [66, -60, 43],
    'vibrant aquatic teal cyan': [68, -43, -15],
    'celestial cobalt indigo blue': [55, 11, -73],
    'velvet amethyst violet purple': [50, 58, -65],
    'deep obsidian charcoal black': [15, 3, -4],
    'pure minimalist alabaster white': [98, -1, -2]
  };
  function pqiTranslateHexToAesthetic(hex) {
    const lab = pqiHexToLab(hex);
    let bestName = 'color';
    let minDiff = 999;
    for (const [name, target] of Object.entries(PQI_COLOR_TARGETS)) {
      const diff = pqiDeltaE(lab, target);
      if (diff < minDiff) {
        minDiff = diff;
        bestName = name;
      }
    }
    return bestName;
  }

  function pqiRenderList() {
    const proj = _pqiProjects[_pqiSelectedProjIdx] || _pqiProjects[0];
    let items = (proj[_pqiSelectedCat] || []).filter(it => !it.is_folder);
    // Filter by folder (skip during search to show all results)
    if (!_pqiSearch) {
      if (_pqiFolderFilter) {
        items = items.filter(it => it.folder_id === _pqiFolderFilter);
      } else {
        items = items.filter(it => !it.folder_id);
      }
    }
    if (_pqiSearch) {
      const q = _pqiSearch.toLowerCase();
      items = items.filter(it => {
        const hay = ((it.title || '') + ' ' + (it.prompt || '') + ' ' + (it.tags || []).join(' ')).toLowerCase();
        return hay.includes(q);
      });
    }
    items.sort((a, b) => (b.updated_at || b.created_at || '').localeCompare(a.updated_at || a.created_at || ''));

    const list = pqiPanel.querySelector('#pqiList');
    if (!list) return;
    if (!items.length) {
      list.innerHTML = '<div class="pqi-empty">暂无提示词</div>';
      return;
    }
    list.innerHTML = '';
    items.forEach(it => {
      const div = document.createElement('div');
      div.className = 'pqi-item';
      const promptText = it.prompt || '';
      const titleText = it.title || promptText.substring(0, 40) || '无标题';
      const tags = (it.tags || []).slice(0, 3);
      const imgPath = it.image || (it.gallery && it.gallery[0]) || '';

      const imgUrl = imgPath ? ( /^https?:\/\//i.test(imgPath) ? imgPath : (_pqiServerUrl + (imgPath.startsWith('/') ? '' : '/uploads/') + imgPath) ) : '';
      const placeholderEmoji = _pqiSelectedCat === 'video_prompts' ? '🎬' : _pqiSelectedCat === 'skill_prompts' ? '🤖' : '🖼️';
      const thumbInner = imgUrl
        ? `<img referrerpolicy="no-referrer" class="pqi-item-thumb" src="" data-pqi-src="${esc(imgUrl)}">`
        : `<div class="pqi-item-thumb-placeholder">${placeholderEmoji}</div>`;

      const palette = it.palette_cache || [];
      const ribbonHtml = palette.length > 0
        ? `<div class="pqi-ribbon">${palette.map(c => `<div style="background:${c.hex};flex:${c.pct};height:100%" title="${c.hex} (${c.pct}%)"></div>`).join('')}</div>`
        : '';

      div.innerHTML = `<div class="pqi-item-thumb-wrap">${thumbInner}</div>${ribbonHtml}<div class="pqi-item-info"><div class="pqi-item-title">${esc(titleText)}</div>${promptText ? `<div class="pqi-item-prompt">${esc(promptText.substring(0, 120))}</div>` : ''}</div>`;
      div.onclick = () => pqiHandleCardClick(it);
      list.appendChild(div);
    });
    // Bypass page CSP: fetch images via content script and set blob URLs
    list.querySelectorAll('img[data-pqi-src]').forEach(img => {
      const realSrc = img.getAttribute('data-pqi-src');
      Promise.resolve()
        .then(() => pscLoadImageAsDataUrl(realSrc))
        .then(src => {
          img.src = src;
        })
        .catch(err => {
          if (String(err?.message || err).includes('Extension context invalidated')) return;
          const wrap = img.closest('.pqi-item-thumb-wrap');
          if (wrap) wrap.innerHTML = '<div class="pqi-item-thumb-placeholder">🖼️</div>';
        });
    });
  }

  async function pqiHandleCardClick(item) {
    const promptText = item.prompt || '';
    const palette = item.palette_cache || [];
    let injectText = promptText;

    // 智能提取全部色卡颜色生成美学色彩提示词，并融合成一条注入
    if (_pqiInjectPalette && palette.length > 0 && (_pqiSelectedCat === 'image_prompts' || _pqiSelectedCat === 'video_prompts')) {
      const sorted = palette.slice().sort((a,b) => b.pct - a.pct);
      const parts = sorted.map((c, i) => {
        const desc = pqiTranslateHexToAesthetic(c.hex);
        return i === 0 ? `dominant ${desc} (${Math.round(c.pct)}%)` : `${desc} (${Math.round(c.pct)}%)`;
      });
      if (parts.length > 0) {
        injectText += `, color palette: [ ${parts.join(', ')} ]`;
      }
    }

    const rewriteInput = pqiPanel.querySelector('#pqiRewriteInput');
    const instruction = rewriteInput ? rewriteInput.value.trim() : '';
    if (!instruction) {
      // No rewrite instruction → insert original with palette recipe
      pqiInsertText(injectText);
      return;
    }
    // AI rewrite
    const origBtnText = rewriteInput.value;
    rewriteInput.value = '⏳ AI 改写中…';
    rewriteInput.disabled = true;
    try {
      const d = await pscLocalJson('/api/rewrite-prompt', {
        method: 'POST',
        timeoutMs: 300000,
        body: { prompt: injectText, instruction }
      });
      if (!d.ok) throw new Error(d.error || 'rewrite failed');
      pqiInsertText(d.prompt);
      pqiToast('✅ AI 改写并插入');
    } catch (e) {
      pqiToast('❌ 改写失败：' + e.message);
      rewriteInput.value = origBtnText;
    } finally {
      if (rewriteInput) { rewriteInput.disabled = false; }
    }
  }

  function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  async function pqiOpenPanel() {
    const r = pqiIcon.getBoundingClientRect();
    const PW = 460, PH = 520;
    let left = r.left;
    let top = r.bottom + 6;
    if (left + PW > window.innerWidth - 8) left = window.innerWidth - PW - 8;
    if (left < 8) left = 8;
    if (top + PH > window.innerHeight - 8) top = r.top - PH - 6;
    if (top < 8) top = 8;
    pqiPanel.style.left = left + 'px';
    pqiPanel.style.top = top + 'px';
    pqiPanel.classList.add('visible');
    pqiPanel.innerHTML = '<div class="pqi-head"><span>📋</span><span class="pqi-head-title">提示词库</span></div><div class="pqi-empty">加载中…</div>';

    try {
      const d = await pscLocalJson('/api/data');
      _pqiProjects = d.projects || [];
    } catch {
      _pqiProjects = [];
    }
    pqiRenderPanel();
  }

  pqiIcon.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (pqiPanel.classList.contains('visible')) { pqiHidePanel(); return; }
    pqiOpenPanel();
  });

  // ── Focus/blur tracking ────────────────────────────────────────────────
  function isInsertTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT' && (!el.type || el.type === 'text' || el.type === 'search' || el.type === 'url')) return true;
    if (el.isContentEditable || el.contentEditable === 'true') return true;
    if (el.closest && el.closest('[contenteditable="true"]')) return true;
    return false;
  }

  document.addEventListener('focusin', (e) => {
    if (!isInsertWhitelisted()) return;
    // Ignore focus events inside our own panel/icon
    if (pqiPanel.contains(e.target) || e.target === pqiIcon) return;
    if (isInsertTarget(e.target)) {
      _pqiFocusedEl = e.target;
      // Save selection for contenteditable so we can restore it later
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        _pqiSavedRange = sel.getRangeAt(0).cloneRange();
      }
      pqiShowIcon(e.target);
    } else {
      // Focused a non-input element → hide icon
      pqiHideIcon();
      pqiHidePanel();
    }
  }, true);

  // Reposition icon on scroll / resize so it stays pinned to the input
  function pqiRepositionIcon() {
    if (!_pqiFocusedEl || !pqiIcon.classList.contains('visible')) return;
    if (!document.body.contains(_pqiFocusedEl)) { pqiHideIcon(); return; }
    pqiShowIcon(_pqiFocusedEl);
  }
  window.addEventListener('scroll', pqiRepositionIcon, true);
  window.addEventListener('resize', pqiRepositionIcon);

  // Close panel on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pqiPanel.classList.contains('visible')) {
      pqiHidePanel();
    }
  }, true);

  // Close panel on outside click
  document.addEventListener('mousedown', (e) => {
    if (!pqiPanel.classList.contains('visible')) return;
    if (pqiPanel.contains(e.target) || e.target === pqiIcon) return;
    pqiHidePanel();
  }, true);

})();
