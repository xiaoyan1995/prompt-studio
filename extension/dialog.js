// dialog.js – Save / Reverse-prompt dialog logic
const params   = new URLSearchParams(location.search);
let launchParams = Object.fromEntries(params.entries());
let mediaUrl    = '';
let mediaType   = 'image';  // 'image' | 'video'
let mode        = 'save';   // 'save' | 'reverse'
let tabId       = '';
let referer     = '';
let requestCookie = '';

let serverUrl = 'http://127.0.0.1:8768';
let settings  = {};
let selectedCategory = 'image_prompts';

function readLaunchParams() {
  mediaUrl = launchParams.mediaUrl || '';
  mediaType = launchParams.mediaType || 'image';
  mode = launchParams.mode || 'save';
  tabId = launchParams.tabId || '';
  referer = launchParams.referer || launchParams.pageUrl || '';
  requestCookie = launchParams.cookie || '';
  selectedCategory = mediaType === 'video' ? 'video_prompts' : 'image_prompts';
}

async function hydrateLaunchParams() {
  const key = params.get('payloadKey');
  if (!key) {
    readLaunchParams();
    return;
  }
  try {
    const stored = await new Promise(r => chrome.storage.local.get(key, r));
    if (stored && stored[key]) launchParams = { ...launchParams, ...stored[key] };
    chrome.storage.local.remove(key, () => void chrome.runtime.lastError);
  } catch {}
  readLaunchParams();
}

readLaunchParams();

// ── Init ────────────────────────────────────────────────────────────
async function init() {
  await window._extLangReady;
  await hydrateLaunchParams();
  // Load settings from background
  const res = await bgMsg({ type: 'get-settings' });
  settings  = res.settings || {};
  serverUrl = settings.serverUrl || 'http://127.0.0.1:8768';
  if (mediaType === 'video') await resolveVideoMedia();

  // UI – media type chip
  const chip = document.getElementById('mediaChip');

  if (mediaType === 'text') {
    // ── Skill / text mode ──────────────────────────────────
    document.getElementById('headerTitle').textContent = dt('save_skill_title');
    document.getElementById('modeIcon').textContent = '🤖';
    chip.textContent = 'Skills'; chip.className = 'chip chip-video';
    document.getElementById('previewBox').style.display    = 'none';
    document.getElementById('skillTextWrap').style.display = 'flex';
    document.getElementById('reverseToggleRow').style.display = 'none';
    document.getElementById('aiConfig').classList.remove('visible');
    document.getElementById('projField').style.gridColumn = '1 / -1';
    setCategory('skill_prompts');
    // Load captured text from storage
    chrome.storage.local.get('_psc_skill_text', ({ _psc_skill_text }) => {
      document.getElementById('skillTextarea').value = _psc_skill_text || '';
      chrome.storage.local.remove('_psc_skill_text');
    });
  } else {
    // ── Image / video mode ─────────────────────────────────
    chip.textContent = mediaType === 'video' ? dt('chip_video') : dt('chip_image');
    chip.className = `chip ${mediaType === 'video' ? 'chip-video' : 'chip-image'}`;
    document.getElementById('previewBox').style.display    = 'flex';
    document.getElementById('skillTextWrap').style.display = 'none';
    document.getElementById('promptInputWrap').style.display = 'flex';
    setCategory(selectedCategory);
    if (mode === 'reverse') {
      document.getElementById('headerTitle').textContent = dt('reverse_title');
      document.getElementById('modeIcon').textContent = '✨';
      document.getElementById('reverseToggleRow').style.display = 'none';
      document.getElementById('promptInputWrap').style.display = 'none';
      document.getElementById('aiConfig').classList.add('visible');
      document.getElementById('actionBtn').textContent = dt('reverse_save');
    }
    const displayModel = mediaType === 'video' ? (settings.videoModel || 'gemini-2.5-pro') : (settings.imageModel || 'gpt-4o');
    const displayBase  = mediaType === 'video' ? (settings.videoApiBase || '') : (settings.imageApiBase || '');
    document.getElementById('cfgModel').value = displayModel;
    document.getElementById('cfgBase').value  = displayBase;
    renderPreview();
  }

  // Fetch projects
  await loadProjects();
}

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

function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function candLabel(item) {
  try {
    const url = new URL(item.url);
    const segs = url.pathname.split('/').filter(Boolean);
    return segs[segs.length - 1] || url.hostname;
  } catch { return item.url.slice(-60); }
}

function renderVidPicker(candidates) {
  const wrap = document.getElementById('vidPickerWrap');
  const list = document.getElementById('vidPicker');
  if (!wrap || !list) return;
  if (candidates.length < 2) { wrap.style.display = 'none'; return; }

  wrap.style.display = '';
  list.innerHTML = candidates.map((c, i) => {
    const active = c.url === mediaUrl;
    const ext = (c.ext || '').toUpperCase() || (c.kind === 'stream' ? 'HLS' : 'VIDEO');
    const size = fmtSize(c.size);
    const meta = [ext, size].filter(Boolean).join(' · ');
    return `<label class="vid-candidate${active ? ' active' : ''}">
      <input type="radio" name="vidCand" value="${i}" ${active ? 'checked' : ''}>
      <div class="vid-cand-info">
        <div class="vid-cand-name" title="${c.url}">${candLabel(c)}</div>
        <div class="vid-cand-meta">${meta}</div>
      </div>
    </label>`;
  }).join('');

  // Keep the list scrollable, but don't hide valid candidates by truncating them.
  list.style.maxHeight = '240px';
  list.style.overflowY = 'auto';

  list.querySelectorAll('input[type=radio]').forEach((radio, i) => {
    radio.addEventListener('change', () => {
      const chosen = candidates[i];
      mediaUrl = chosen.url;
      referer = chosen.referer || referer;
      requestCookie = chosen.cookie || requestCookie;
      list.querySelectorAll('.vid-candidate').forEach((el, j) => el.classList.toggle('active', j === i));
      renderPreview();
    });
  });
}

async function resolveVideoMedia() {
  try {
    // Get the best resolved URL
    const res = await bgMsg({ type: 'resolve-media-url', tabId, mediaUrl, mediaType, referer });
    if (res?.mediaUrl) mediaUrl = res.mediaUrl;
    if (res?.referer) referer = res.referer;
    if (res?.cookie) requestCookie = res.cookie;
  } catch {}

  // Also fetch all candidates and show picker if multiple exist
  try {
    const candRes = await bgMsg({ type: 'get-media-candidates', tabId });
    const priority = { m3u8: 0, mpd: 1, m4s: 2, ts: 3, mp4: 4, webm: 5, mov: 6, flv: 7 };
    const candidates = (candRes?.items || [])
      .filter(item => item && item.url)
      .sort((a, b) => {
        const extA = (a.ext || '').toLowerCase();
        const extB = (b.ext || '').toLowerCase();
        const pA = priority[extA] ?? 99;
        const pB = priority[extB] ?? 99;
        if (pA !== pB) return pA - pB;
        const kindA = a.kind === 'stream' ? 0 : 1;
        const kindB = b.kind === 'stream' ? 0 : 1;
        if (kindA !== kindB) return kindA - kindB;
        const sizeA = Number(a.size || 0);
        const sizeB = Number(b.size || 0);
        if (sizeA !== sizeB) return sizeB - sizeA;
        return String(a.url || '').localeCompare(String(b.url || ''));
      });
    renderVidPicker(candidates);
  } catch {}
}

// ── Aspect Ratio Helpers ──────────────────────────────────────────────────────────────
function gcd(a, b) { return b ? gcd(b, a % b) : a; }
function calcAspect(w, h) {
  if (!w || !h) return '';
  const COMMON = [
    [1,1,'1:1'],[4,3,'4:3'],[3,4,'3:4'],[3,2,'3:2'],[2,3,'2:3'],
    [16,9,'16:9'],[9,16,'9:16'],[21,9,'21:9'],[9,21,'9:21'],[2,1,'2:1'],[1,2,'1:2']
  ];
  const ratio = w / h;
  for (const [rw, rh, label] of COMMON) {
    if (Math.abs(ratio - rw/rh) < 0.02) return label;
  }
  const g = gcd(Math.round(w), Math.round(h));
  return `${Math.round(w)/g}:${Math.round(h)/g}`;
}
function setAspect(w, h) {
  document.getElementById('aspectWrap').style.display = 'flex';
  document.getElementById('aspectInput').value = calcAspect(w, h);
  document.getElementById('aspectDims').textContent = w && h ? `${w} × ${h}` : '';
}

// ── Preview ───────────────────────────────────────────────────────────────
function renderPreview() {
  const box = document.getElementById('previewBox');
  if (!mediaUrl) {
    const hint = mediaType === 'video'
      ? '（未检测到视频流）<br><small style="color:#888;font-size:11px">💡 请先在页面上点击播放视频，再右键保存</small>'
      : '（无媒体 URL）';
    box.innerHTML = `<div class="preview-url" style="text-align:center;padding:16px;line-height:1.8">${hint}</div>`;
    return;
  }
  if (mediaType === 'video') {
    const vid = document.createElement('video');
    vid.src = mediaUrl; vid.controls = true; vid.muted = true;
    vid.style.cssText = 'max-width:100%;max-height:200px';
    vid.addEventListener('loadedmetadata', () => {
      if (vid.videoWidth) setAspect(vid.videoWidth, vid.videoHeight);
    });
    box.innerHTML = ''; box.appendChild(vid);
  } else {
    const img = new Image();
    img.onload  = () => {
      box.innerHTML = ''; box.appendChild(img);
      setAspect(img.naturalWidth, img.naturalHeight);
    };
    img.onerror = () => { box.innerHTML = `<div class="preview-url">🖼️ 无法预览<br>${mediaUrl}</div>`; };
    img.src = mediaUrl;
    img.style.cssText = 'max-width:100%;max-height:200px;object-fit:contain';
    box.innerHTML = '<div class="spinner"></div>';
  }
}

// ── Offline mode ─────────────────────────────────────────────────────────────
let isOfflineMode = false;

function showOfflineBanner() {
  let banner = document.getElementById('offlineBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'offlineBanner';
    banner.style.cssText = 'background:#ff9800;color:#fff;padding:6px 12px;text-align:center;font-size:12px;border-radius:6px;margin:8px 16px 0';
    banner.textContent = '⚡ 离线模式：桌面端未运行，将直接下载到本地';
    const header = document.querySelector('.header') || document.body.firstElementChild;
    if (header) header.after(banner);
  }
}

// ── Projects ──────────────────────────────────────────────────────────────────
async function loadProjects() {
  const sel = document.getElementById('projectSel');
  try {
    const r = await fetch(`${serverUrl}/api/projects`, { signal: AbortSignal.timeout(3000) });
    const projects = await r.json();
    isOfflineMode = false;
    if (!projects.length) {
      sel.innerHTML = `<option value="">${dt('no_projects')}</option>`;
      return;
    }
    sel.innerHTML = projects.map(p =>
      `<option value="${p.id}">${p.name}</option>`
    ).join('');
  } catch {
    isOfflineMode = true;
    showOfflineBanner();
    sel.innerHTML = `<option value="offline">离线模式</option>`;
    const actionBtn = document.getElementById('actionBtn');
    if (actionBtn) actionBtn.textContent = '📥 下载到本地';
  }
}

// ── Category ──────────────────────────────────────────────────────────────────
function setCategory(cat) {
  selectedCategory = cat;
  document.querySelectorAll('#categoryRow .radio-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.cat === cat);
  });
}
document.getElementById('categoryRow').addEventListener('click', e => {
  const btn = e.target.closest('[data-cat]');
  if (btn) setCategory(btn.dataset.cat);
});

// ── AI Title Generation ───────────────────────────────────────────────────────────
document.getElementById('genTitleBtn').addEventListener('click', async () => {
  const promptText = (document.getElementById('promptInput')?.value || '').trim();
  if (!promptText) {
    document.getElementById('titleInput').placeholder = dt('gen_title_no_prompt');
    return;
  }
  const btn = document.getElementById('genTitleBtn');
  btn.textContent = '…'; btn.disabled = true;
  try {
    const res = await fetch(`${serverUrl}/api/gen-title`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: promptText,
        apiKey:  settings.imageApiKey  || settings.videoApiKey,
        apiBase: settings.imageApiBase || 'https://api.openai.com/v1',
        model:   settings.imageModel   || settings.videoModel || 'gpt-4o-mini'
      })
    });
    const data = await res.json();
    if (data.ok) document.getElementById('titleInput').value = data.title;
    else throw new Error(data.error);
  } catch (e) {
    document.getElementById('titleInput').placeholder = dt('gen_title_fail') + e.message;
  } finally {
    btn.textContent = dt('gen_title_btn'); btn.disabled = false;
  }
});

// ── Reverse mode chips ───────────────────────────────────────────────────────────
const DIALOG_REVERSE_MODES = {
  auto:   { label: '全面',  instruction: null },
  outfit: { label: '服装',  instruction: '请仔细分析图片中人物的穿着，【必须从头到脚逐部位覆盖，画面内可见的部位一个不能漏】：头饰/帽子→发型→颈部装饰/颈甲→上衣/外套/内搭（款式/面料/颜色/图案）→手套/臂甲/手部装饰→下装（裤子/裙子款式/长度）→腰部/腰带→袜子/腿部（丝袜/过膝袜/腿甲等）→鞋子（款式/颜色/鞋跟）。同时注明：①各部位露肤程度（如实描述）②面料质感（棉/丝绸/皮革/蕾丝/透明纱等）③整体穿搭风格与叠穿层次。直接输出描述词，不要解释。' },
  char:   { label: '人物',  instruction: '请仔细分析图片中所有人物，每个人物单独描述，覆盖以下全部内容：①画面中的位置（画面左/中/右、前景/中景/背景）②面朝方向（正面朝向镜头/斜45°小侧脸/正侧面/斜45°背面/完全背对镜头）③若多人则描述站位关系及相互朝向④外貌特征（发型发色/脸部特征/肤色/表情/体型）⑤姿态与动作——【重要：描述四肢位置时必须用画面方位而非人体左右，例如"画面右侧的手握着…""画面左侧的腿踩在…"，禁止直接说"左手""右脚"，因为角色面对镜头时人体左右与画面左右相反，AI容易判断错误】⑥【服装从头到脚逐部位，不得遗漏】：头饰→颈部→上衣/外套/内搭→手部/臂部→下装→腰带→袜子/腿部→鞋子，每部位描述款式/颜色/图案/材质⑦【铁律：画面中所有道具/物品必须描述，一个不漏】：人物手持/接触/身旁的每一件物品都要写清楚——物品名称、颜色、款式、上面的文字或标识、放置位置（握在画面某侧手中/靠在某处/踩在某物上/放置于旁边等），不得以"滑板""水壶"等一笔带过，必须描述完整细节⑧整体人物气质。直接输出描述词，不要解释。' },
  scene:  { label: '场景',  instruction: '请仔细分析图片场景，按以下顺序输出：【第一步：先综合判断场所类型】不要只说「室外楼梯」这种表面信息，必须根据所有视觉线索（建筑结构/地面质地/周围设施/文化背景等）判断具体地点类型（如：滑板公园/地铁入口楼梯/商展中心外境/学校进入口/城市广场/天台山小道等），越具体越好。【第二步：层次描述】前景/中景/背景的具体元素、空间纵深感、背景与主体的距离关系。【第三步：氛围与时间】时间（日间/夜晚/黄昏等）、天气、季节、整体地点文化属性。直接输出描述词，不要解释。' },
  style:  { label: '画风',  instruction: '请仔细分析图片画风，按以下顺序判断：【第一步：先判断渲染真实度】是否存在真实皮肤质感（毛孔/血管/次表面散射）、真实布料纹理、真实环境光源？→若是：这是【超写实/写实动漯风格】，应输出 hyperrealistic anime / photorealistic anime illustration，渲染技术为 PBR-based rendering + anime aesthetics，不得证写赛璐璐/厚涂。【第二步：检查描线】富有明显黑色描边→ thick outlines/lineart，无描边→ no outlines (painterly/realistic)。【第三步：着色风格】是平涂（cel-shading/flat shading）还是厚涂（painterly）还是写实（PBR/photo-real）。【第四步：作品引用】仅当明确识别时才引用具体作品/艺术家，不確定则写通用风格描述，不得猜测。最终输出英文关键词，不要解释。' },
  cam:    { label: '运镜',  instruction: '请仔细分析图片的镜头语言，输出完整的镜头/运镜提示词。必须覆盖：①景别（大远景/远景/全景/中景/中近景/近景/特写/大特写）②垂直视角（仰视感→低角度仰拍；俯视感→高角度俯拍；否则→平视，描述倾斜程度）③水平视角（正面/正侧面/斜45°/背面/过肩）④焦距感（鱼眼/超广角/广角/标准/中长焦/长焦/超长焦）⑤景深与散景（浅/中/深，虚化程度）⑥透视感（强透视/正常/压缩透视）⑦构图方式（居中/三分/对角线/框架/引导线等）⑧画幅（竖/横/方/宽银幕及比例）⑨推荐镜头运动方式（推/拉/摇/移/跟/环绕/固定等）⑩镜头特效（光晕/眩光/色散/暗角，有则描述）。直接输出描述词，不要解释。' },
};
let dialogReverseMode = 'auto';
document.querySelectorAll('#reverseModeRow .mode-chip').forEach(btn => {
  btn.addEventListener('click', () => {
    dialogReverseMode = btn.dataset.mode;
    document.querySelectorAll('#reverseModeRow .mode-chip').forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
  });
});

// ── Reverse toggle ───────────────────────────────────────────────────────────────
document.getElementById('reverseToggle').addEventListener('change', e => {
  document.getElementById('aiConfig').classList.toggle('visible', e.target.checked);
  document.getElementById('reverseModeRow').style.display = e.target.checked ? 'flex' : 'none';
  document.getElementById('promptInputWrap').style.display = e.target.checked ? 'none' : 'flex';
  document.getElementById('actionBtn').textContent = e.target.checked
    ? dt('reverse_save_short') : dt('save');
});

// ── Inline project creation ───────────────────────────────────────────────────────
document.getElementById('addProjBtn').addEventListener('click', () => {
  document.getElementById('newProjRow').style.display = 'flex';
  document.getElementById('newProjName').focus();
});
document.getElementById('cancelProjBtn').addEventListener('click', () => {
  document.getElementById('newProjRow').style.display = 'none';
  document.getElementById('newProjName').value = '';
});
document.getElementById('createProjBtn').addEventListener('click', async () => {
  const name = document.getElementById('newProjName').value.trim();
  if (!name) return;
  const btn = document.getElementById('createProjBtn');
  btn.disabled = true; btn.textContent = dt('creating');
  try {
    const r = await fetch(`${serverUrl}/api/create-project`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error);
    const sel = document.getElementById('projectSel');
    const opt = document.createElement('option');
    opt.value = d.project.id; opt.textContent = d.project.name;
    sel.appendChild(opt); sel.value = d.project.id;
    document.getElementById('newProjRow').style.display = 'none';
    document.getElementById('newProjName').value = '';
  } catch(e) { alert(dt('create_fail') + e.message); }
  btn.disabled = false; btn.textContent = dt('create_btn');
});

// ── Go to settings ────────────────────────────────────────────────────────────
document.getElementById('goSettings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// ── Cancel ────────────────────────────────────────────────────────────────────
document.getElementById('cancelBtn').addEventListener('click', () => window.close());

// ── Main Action ───────────────────────────────────────────────────────────────
document.getElementById('actionBtn').addEventListener('click', async () => {
  const projectId = document.getElementById('projectSel').value;
  if (!projectId) { alert(dt('no_proj_alert')); return; }
  if (!mediaUrl && mediaType !== 'text') { alert(dt('no_media_alert')); return; }

  const doReverse = mode === 'reverse' || document.getElementById('reverseToggle').checked;
  const title     = document.getElementById('titleInput').value.trim();

  setUiState('loading');

  try {
    // ── Offline mode: direct download ────────────────────
    if (isOfflineMode && mediaType !== 'text') {
      setSteps([{ text: '📥 正在下载到本地…', active: true }]);
      const result = await bgMsg({
        type: 'offline-download',
        mediaUrl,
        mediaType,
        filename: title || undefined,
      });
      if (result && result.ok) {
        setUiState('success', '已下载到本地 Prompt Studio Offline 文件夹');
      } else {
        setUiState('error', result?.error || '下载失败');
      }
      return;
    }

    let prompt = '';

    // ── Skill text mode: direct save ──────────────────────
    if (mediaType === 'text') {
      const skillText = document.getElementById('skillTextarea').value.trim();
      if (!skillText) { setUiState('error', dt('skill_empty_alert')); return; }
      setSteps([{ text: dt('step_save'), active: true }]);
      const res = await fetch(`${serverUrl}/api/save-prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId, category: selectedCategory,
          title, prompt: skillText,
          model: settings.imageModel || '', tags: []
        })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || dt('save_fail'));
      setUiState('success', dt('save_success', false));
      return;
    }

    // ── Video: download the real file first, then save the local /uploads path.
    if (mediaType === 'video' && !doReverse && !isLocalUploadUrl(mediaUrl)) {
      let shouldDownload = true;
      if (isStreamUrl(mediaUrl)) {
        setUiState('form');
        shouldDownload = await checkAndDownloadViaFfmpeg(projectId) === 'ready';
        if (!shouldDownload) {
          setUiState('error', '未安装 ffmpeg，无法下载该视频流。');
          return;
        }
      }
      if (shouldDownload) {
        try {
          const dlData = await doFfmpegDownload(projectId);
          mediaUrl = dlData.path;
        } catch (dlErr) {
          setUiState('error', String(dlErr.message || dlErr));
          return;
        }
      }
      setUiState('loading');
    }

    // Use manually entered prompt when reverse is off
    const manualPrompt = (document.getElementById('promptInput')?.value || '').trim();
    let analysis = '';

    if (doReverse) {
      const apiKey = mediaType === 'video' ? settings.videoApiKey : settings.imageApiKey;
      const apiBase = mediaType === 'video' ? settings.videoApiBase : settings.imageApiBase;
      const model   = mediaType === 'video' ? (settings.videoModel || 'gemini-2.5-pro') : (settings.imageModel || 'gpt-4o');
      if (!apiKey) {
        setUiState('error', dt('api_key_missing'));
        return;
      }

      setSteps([
        { text: dt('step_download'), active: true },
        { text: mediaType === 'video' ? dt('step_ai_video') : dt('step_ai'), active: false },
        { text: dt('step_save'), active: false }
      ]);

      setLoadingMsg(dt('analyzing', model, mediaType));

      const reverseRes = await fetch(`${serverUrl}/api/reverse-prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: mediaUrl, mediaType,
          referer,
          pageUrl: launchParams.pageUrl || '',
          cookie: requestCookie,
          apiKey, apiBase, model,
          lang: 'zh',
          customInstruction: DIALOG_REVERSE_MODES[dialogReverseMode]?.instruction
            || (mediaType === 'video'
              ? settings.videoReverseInstruction
              : settings.imageReverseInstruction) || undefined
        })
      });
      const reverseData = await reverseRes.json();
      if (!reverseData.ok) throw new Error(reverseData.error || dt('reverse_fail'));
      prompt   = reverseData.prompt;
      analysis = reverseData.analysis || '';
      // Auto-fill title: use AI-returned title, or auto-generate one from the prompt
      const titleEl = document.getElementById('titleInput');
      if (reverseData.title) {
        if (titleEl && !titleEl.value.trim()) titleEl.value = reverseData.title;
      } else if (prompt && titleEl && !titleEl.value.trim()) {
        try {
          const genRes = await fetch(`${serverUrl}/api/gen-title`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt: prompt.slice(0, 800),
              apiKey:  mediaType === 'video' ? settings.videoApiKey : settings.imageApiKey,
              apiBase: mediaType === 'video' ? settings.videoApiBase : settings.imageApiBase,
              model:   mediaType === 'video' ? (settings.videoModel || 'gpt-4o-mini') : (settings.imageModel || 'gpt-4o-mini')
            })
          });
          const genData = await genRes.json();
          if (genData.ok && genData.title) titleEl.value = genData.title;
        } catch {}
      }

      setSteps([
        { text: dt('step_download'), done: true },
        { text: dt('step_ai_done'), done: true },
        { text: dt('step_save'), active: true }
      ]);
    } else {
      prompt = manualPrompt;
      setSteps([{ text: dt('step_save'), active: true }]);
    }

    setLoadingMsg(dt('saving'));

    const saveData = await localJson('/api/save-media', {
      method: 'POST',
      timeoutMs: 300000,
      body: {
        url: mediaUrl, mediaType, projectId,
        category: selectedCategory,
        title, prompt, analysis,
        referer,
        pageUrl: launchParams.pageUrl || '',
        pageTitle: launchParams.pageTitle || '',
        cookie: requestCookie,
        aspect: document.getElementById('aspectInput')?.value || '',
        model: mediaType === 'video' ? (settings.videoModel || '') : (settings.imageModel || ''),
        tags: []
      }
    });
    if (!saveData.ok) throw new Error(saveData.error || dt('save_fail'));

    setSteps([{ text: dt('step_done'), done: true }]);
    setUiState('success', dt('save_success', doReverse),
      prompt ? prompt : null
    );

  } catch (err) {
    setUiState('error', err.message || dt('error_title'));
  }
});

// ── ffmpeg install helpers ────────────────────────────────────────────────────
function isStreamUrl(url) {
  return /\.(m3u8|mpd|ts)(\?|$)/i.test(url) || /mpegurl|dash\+xml/i.test(url);
}

function isLocalUploadUrl(url) {
  return /^\/uploads\//.test(url || '') || /^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/uploads\//i.test(url || '');
}

async function checkAndDownloadViaFfmpeg(projectId) {
  // 1. check server has ffmpeg
  let status;
  try {
    const statusRes = await fetch(`${serverUrl}/api/ffmpeg-status`);
    if (!statusRes.ok) return 'skip'; // server doesn't support endpoint yet
    status = await statusRes.json();
  } catch {
    return 'skip'; // server unreachable or old version
  }
  if (!status.ok) {
    // Show ffmpeg install UI
    return new Promise((resolve) => {
      setUiState('ffmpeg');
      const installBtn = document.getElementById('installFfmpegBtn');
      const skipBtn    = document.getElementById('skipFfmpegBtn');
      skipBtn.onclick = () => resolve('skip');
      installBtn.onclick = async () => {
        installBtn.disabled = true;
        installBtn.textContent = dt('creating');
        await fetch(`${serverUrl}/api/install-ffmpeg`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' });
        // Poll until done
        const poll = setInterval(async () => {
          try {
            const r = await fetch(`${serverUrl}/api/ffmpeg-status`);
            const s = await r.json();
            const prog = s.install || {};
            document.getElementById('ffmpegBar').style.width = (prog.percent || 0) + '%';
            const labels = { downloading: dt('ffmpeg_dling'), extracting: dt('ffmpeg_extracting'), done: dt('ffmpeg_done'), error: dt('ffmpeg_err_prefix') + prog.error };
            document.getElementById('ffmpegMsg').textContent = labels[prog.status] || prog.status;
            if (prog.status === 'done') {
              clearInterval(poll);
              resolve('ready');
            } else if (prog.status === 'error') {
              clearInterval(poll);
              resolve('skip');
            }
          } catch { clearInterval(poll); resolve('skip'); }
        }, 800);
      };
    });
  }
  return 'ready';
}

async function doFfmpegDownload(projectId) {
  setUiState('downloading');
  const res = await fetch(`${serverUrl}/api/download-video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: mediaUrl,
      projectId,
      referer,
      pageUrl: launchParams.pageUrl || '',
      cookie: requestCookie
    })
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || dt('ffmpeg_dl_fail'));
  return data; // {path, filename, size}
}

// ── UI State Helpers ──────────────────────────────────────────────────────────
function setUiState(state, msg = '', extra = null) {
  document.getElementById('formBody').style.display    = state === 'form'    ? 'flex' : 'none';
  document.getElementById('loadingState').classList.toggle('visible', state === 'loading');
  document.getElementById('successState').classList.toggle('visible', state === 'success');
  document.getElementById('errorState').classList.toggle('visible',   state === 'error');
  document.getElementById('ffmpegState').classList.toggle('visible',  state === 'ffmpeg');
  document.getElementById('downloadState').classList.toggle('visible', state === 'downloading');
  const hideFooter = ['loading', 'ffmpeg', 'downloading'].includes(state);
  document.getElementById('footer').style.display = hideFooter ? 'none' : 'flex';

  if (state === 'form') {
    document.getElementById('formBody').style.display = 'flex';
  }
  if (state === 'success') {
    document.getElementById('successMsg').innerHTML = `<strong>${msg}</strong>`;
    const rb = document.getElementById('resultBox');
    if (extra) { rb.textContent = extra; rb.style.display = 'block'; }
    else { rb.style.display = 'none'; }
    document.getElementById('actionBtn').textContent = dt('close_x');
    document.getElementById('actionBtn').onclick = () => window.close();
    document.getElementById('cancelBtn').style.display = 'none';
  }
  if (state === 'error') {
    document.getElementById('errorMsg').innerHTML = `<strong>${dt('error_title')}</strong><br>${msg}`;
    document.getElementById('actionBtn').textContent = dt('back');
    document.getElementById('actionBtn').onclick = () => {
      setUiState('form');
      document.getElementById('actionBtn').textContent = mode === 'reverse' ? dt('reverse_save') : dt('save');
      document.getElementById('actionBtn').onclick = null;
      document.getElementById('actionBtn').addEventListener('click', handleAction);
    };
  }
}

function setLoadingMsg(html) {
  document.getElementById('loadingMsg').innerHTML = html;
}

function setSteps(steps) {
  document.getElementById('progressSteps').innerHTML = steps.map(s => `
    <div class="progress-step ${s.done ? 'done' : s.active ? 'active' : ''}">
      <span class="progress-step-icon">${s.done ? '✅' : s.active ? '⏳' : '○'}</span>
      <span>${s.text}</span>
    </div>
  `).join('');
}

// Needed for the error-state back button re-binding
function handleAction() {
  document.getElementById('actionBtn').click();
}

// ── Boot ──────────────────────────────────────────────────────────────────────
// Start in form state
document.getElementById('formBody').style.display = 'flex';
['loadingState','successState','errorState','ffmpegState','downloadState'].forEach(id => {
  document.getElementById(id).classList.remove('visible');
});

init();
