// ext-i18n.js – shared i18n for dialog / result / settings pages
window._extLang = 'cn';

window.EXT_I18N = {
  cn: {
    // dialog
    save_image_title: '保存到 Prompt Studio',
    save_skill_title: '保存 Skills 提示词',
    reverse_title: '反推提示词 → Prompt Studio',
    chip_image: '图片', chip_video: '视频',
    skill_content_label: '提示词内容（可编辑）',
    vid_source_label: '🎬 检测到多个视频，请选择正确的来源',
    aspect_label: '尺寸 / 宽高比',
    aspect_placeholder: '检测中…',
    save_to_proj: '保存到项目',
    add_proj: '+ 新建',
    loading_projs: '⏳ 加载项目列表…',
    proj_name_placeholder: '项目名称…',
    create_btn: '创建', cancel_btn: '取消',
    cat_label: '分类',
    cat_image: '🖼️ 图片提示词', cat_video: '🎬 视频提示词', cat_skill: '🤖 Skills',
    title_label: '标题（选填）',
    title_placeholder: '留空自动生成',
    gen_title_btn: '✨ 生成',
    prompt_label: '提示词（选填）',
    prompt_placeholder: '不反推时可在此手动输入提示词…',
    reverse_toggle: '✨ 同时用 AI 反推提示词',
    mode_label: '模式：',
    mode_auto: '全面', mode_outfit: '服装', mode_char: '人物',
    mode_scene: '场景', mode_style: '画风', mode_cam: '运镜',
    ai_config_title: 'AI 配置（来自设置）',
    model_label: '模型', api_base_label: 'API 地址',
    api_key_hint: 'API Key 已保存在插件设置中 · ',
    modify_settings: '修改设置',
    ffmpeg_needed: '需要安装 ffmpeg 才能下载视频',
    ffmpeg_sub: '一次性下载，约 80 MB，保存在本地',
    ffmpeg_start: '点击按钮开始安装',
    install_ffmpeg: '⬇️ 安装 ffmpeg',
    skip_ffmpeg: '取消下载',
    downloading_video: '正在下载视频…',
    ffmpeg_merging: 'ffmpeg 合并中，请勿关闭窗口',
    processing: '处理中…',
    cancel: '取消', save: '💾 保存',
    reverse_save: '✨ 开始反推并保存',
    reverse_save_short: '✨ 反推并保存',
    close_x: '✕ 关闭', back: '← 返回',
    error_title: '出错了',
    no_proj_alert: '请先选择一个项目',
    no_media_alert: '没有媒体 URL',
    skill_empty_alert: '提示词内容不能为空',
    step_download: '下载媒体文件', step_ai: 'AI 分析中…',
    step_ai_video: 'AI 分析中…（视频处理较慢，请耐心等待）',
    step_save: '保存到 Prompt Studio',
    step_done: '✅ 已保存到 Prompt Studio', step_ai_done: 'AI 分析完成',
    analyzing: (m, t) => `正在让 <strong>${m||'AI'}</strong> 分析${t==='video'?'视频':'图片'}…`,
    saving: '正在保存…',
    save_success: (r) => `${r?'反推完成并已':''}保存到项目！`,
    creating: '创建中…',
    api_key_missing: 'API Key 未配置，请先在桌面端「设置」里填写',
    no_projects: '（暂无项目，请先在 Prompt Studio 创建）',
    server_unreachable: '❌ 无法连接服务器，请检查设置',
    gen_title_no_prompt: '请先填写提示词内容',
    gen_title_fail: '生成失败：',
    no_preview: '（无媒体 URL）', no_img_preview: '🖼️ 无法预览',
    create_fail: '创建失败：', save_fail: '保存失败',
    reverse_fail: 'AI 反推失败', ffmpeg_dl_fail: 'ffmpeg 下载失败',
    ffmpeg_dling: '下载中…', ffmpeg_extracting: '解压中…',
    ffmpeg_done: '安装完成！', ffmpeg_err_prefix: '安装失败: ',
    // result
    result_title: '反推提示词',
    loading_ai: '正在连接 AI，请稍候…',
    retry: '重试',
    result_label: '生成的提示词',
    copy: '📋 复制', copied: '✅ 已复制',
    save_to_studio: '💾 保存到 Prompt Studio Desktop…',
    save_proj_label: '保存到项目',
    loading_proj_short: '⏳ 加载中…',
    close_btn: '关闭', confirm_save: '💾 确认保存',
    saving_short: '保存中…', saved_ok: '✅ 已保存！',
    save_fail_alert: '保存失败：',
    no_proj_alert_result: '请先选择一个项目',
    api_missing_result: '未配置 API Key，请先在桌面端「设置」里填写。',
    ai_fail_result: 'AI 反推失败',
    conn_fail_result: '⚠️ 无法连接服务器',
    analyzing_short: (m, t) => `正在让 ${m} 分析${t==='video'?'视频':'图片'}…`,
    cat_image: '🖼️ 图片提示词', cat_video: '🎬 视频提示词', cat_skill_short: '🤖 Skills',
    // settings
    settings_title: '⚙️ Prompt Studio Desktop Companion 设置',
    settings_subtitle: '插件只负责网页采集和页面工具栏。AI Key、模型、反推指令、预设库全部以桌面端「设置」为准。',
    whose_settings: '按谁的？',
    settings_hint_text: '插件反推时会从 /api/desktop/settings 读取桌面端配置。这里不再保存 AI Key，避免两边配置冲突。',
    open_desktop: '打开桌面端',
    test_connection: '测试连接',
    server_section: '本地服务器',
    server_label: 'Prompt Studio Desktop 地址',
    server_hint: '默认端口 8768。只有你改了桌面端端口时才需要改这里。',
    blacklist_section: '站点黑名单',
    blacklist_label: '不显示悬浮工具栏的网站（每行一个域名）',
    blacklist_hint_text: '这是浏览器侧行为，所以保留在插件里。填写 twitter.com 会匹配它的子域名；填写 file:// 会屏蔽所有本地 HTML，或填写具体 file:// 地址只屏蔽单个本地文件。',
    insert_whitelist_section: '提示词快速插入',
    insert_whitelist_label: '启用输入框插入图标的网站（每行一个域名）',
    insert_whitelist_hint: '在这些网站上，点击输入框时会浮出一个小图标，点击可从你的资产库快速插入提示词。填写 lovart.ai 会匹配它的子域名。',
    save_settings: '保存插件设置',
    saved: '已保存', connecting: '连接中...',
    connect_ok: (n) => `连接成功，${n} 个项目`,
    connect_fail: (m) => `连接失败：${m}`,
    api_error: '桌面端 API 响应异常',
  },
  en: {
    // dialog
    save_image_title: 'Save to Prompt Studio',
    save_skill_title: 'Save Skills Prompt',
    reverse_title: 'Reverse Prompt → Prompt Studio',
    chip_image: 'Image', chip_video: 'Video',
    skill_content_label: 'Prompt content (editable)',
    vid_source_label: '🎬 Multiple videos detected — select the correct source',
    aspect_label: 'Size / Aspect Ratio',
    aspect_placeholder: 'Detecting…',
    save_to_proj: 'Save to Project',
    add_proj: '+ New',
    loading_projs: '⏳ Loading projects…',
    proj_name_placeholder: 'Project name…',
    create_btn: 'Create', cancel_btn: 'Cancel',
    cat_label: 'Category',
    cat_image: '🖼️ Image Prompts', cat_video: '🎬 Video Prompts', cat_skill: '🤖 Skills',
    title_label: 'Title (optional)',
    title_placeholder: 'Leave blank to auto-generate',
    gen_title_btn: '✨ Generate',
    prompt_label: 'Prompt (optional)',
    prompt_placeholder: 'Enter prompt manually if not reversing…',
    reverse_toggle: '✨ Also use AI to reverse prompt',
    mode_label: 'Mode: ',
    mode_auto: 'Full', mode_outfit: 'Outfit', mode_char: 'Character',
    mode_scene: 'Scene', mode_style: 'Style', mode_cam: 'Camera',
    ai_config_title: 'AI Config (from settings)',
    model_label: 'Model', api_base_label: 'API Base',
    api_key_hint: 'API Key saved in extension settings · ',
    modify_settings: 'Edit Settings',
    ffmpeg_needed: 'ffmpeg is required to download video',
    ffmpeg_sub: 'One-time download, ~80 MB, saved locally',
    ffmpeg_start: 'Click button to install',
    install_ffmpeg: '⬇️ Install ffmpeg',
    skip_ffmpeg: 'Cancel download',
    downloading_video: 'Downloading video…',
    ffmpeg_merging: 'ffmpeg merging, do not close this window',
    processing: 'Processing…',
    cancel: 'Cancel', save: '💾 Save',
    reverse_save: '✨ Start Reverse & Save',
    reverse_save_short: '✨ Reverse & Save',
    close_x: '✕ Close', back: '← Back',
    error_title: 'Error',
    no_proj_alert: 'Please select a project first',
    no_media_alert: 'No media URL',
    skill_empty_alert: 'Prompt content cannot be empty',
    step_download: 'Downloading media', step_ai: 'AI analyzing…',
    step_ai_video: 'AI analyzing… (video takes longer, please wait)',
    step_save: 'Saving to Prompt Studio',
    step_done: '✅ Saved to Prompt Studio', step_ai_done: 'AI analysis complete',
    analyzing: (m, t) => `Letting <strong>${m||'AI'}</strong> analyze the ${t==='video'?'video':'image'}…`,
    saving: 'Saving…',
    save_success: (r) => `${r?'Reversed and ':''}Saved to project!`,
    creating: 'Creating…',
    api_key_missing: 'API Key not configured — please set it in desktop Settings.',
    no_projects: '(No projects yet — create one in Prompt Studio first)',
    server_unreachable: '❌ Cannot connect to server, check Settings',
    gen_title_no_prompt: 'Please fill in the prompt first',
    gen_title_fail: 'Generation failed: ',
    no_preview: '(No media URL)', no_img_preview: '🖼️ Cannot preview',
    create_fail: 'Creation failed: ', save_fail: 'Save failed',
    reverse_fail: 'AI reverse prompt failed', ffmpeg_dl_fail: 'ffmpeg download failed',
    ffmpeg_dling: 'Downloading…', ffmpeg_extracting: 'Extracting…',
    ffmpeg_done: 'Installation complete!', ffmpeg_err_prefix: 'Install failed: ',
    // result
    result_title: 'Reverse Prompt',
    loading_ai: 'Connecting to AI, please wait…',
    retry: 'Retry',
    result_label: 'Generated Prompt',
    copy: '📋 Copy', copied: '✅ Copied',
    save_to_studio: '💾 Save to Prompt Studio Desktop…',
    save_proj_label: 'Save to Project',
    loading_proj_short: '⏳ Loading…',
    close_btn: 'Close', confirm_save: '💾 Confirm Save',
    saving_short: 'Saving…', saved_ok: '✅ Saved!',
    save_fail_alert: 'Save failed: ',
    no_proj_alert_result: 'Please select a project first',
    api_missing_result: 'API Key not configured — please set it in desktop Settings.',
    ai_fail_result: 'AI reverse prompt failed',
    conn_fail_result: '⚠️ Cannot connect to server',
    analyzing_short: (m, t) => `Letting ${m} analyze the ${t==='video'?'video':'image'}…`,
    cat_image: '🖼️ Image Prompts', cat_video: '🎬 Video Prompts', cat_skill_short: '🤖 Skills',
    // settings
    settings_title: '⚙️ Prompt Studio Desktop Companion Settings',
    settings_subtitle: 'This extension handles web capture and page toolbar only. AI Key, model, reverse instructions, and presets are managed in the desktop Settings.',
    whose_settings: 'Which settings apply?',
    settings_hint_text: 'When reversing prompts, the extension reads config from /api/desktop/settings. API Keys are not stored here to avoid conflicts.',
    open_desktop: 'Open Desktop App',
    test_connection: 'Test Connection',
    server_section: 'Local Server',
    server_label: 'Prompt Studio Desktop URL',
    server_hint: 'Default port 8768. Only change this if you modified the desktop app port.',
    blacklist_section: 'Site Blocklist',
    blacklist_label: 'Sites where the floating toolbar is hidden (one domain per line)',
    blacklist_hint_text: 'This is browser-side behavior. Adding twitter.com also matches subdomains. Add file:// to block all local HTML pages, or add a specific file:// URL to block one local file.',
    insert_whitelist_section: 'Prompt Quick Insert',
    insert_whitelist_label: 'Sites where the insert icon appears on input focus (one domain per line)',
    insert_whitelist_hint: 'On these sites, focusing an input field shows a small icon to quickly insert prompts from your library. Adding lovart.ai also matches its subdomains.',
    save_settings: 'Save Extension Settings',
    saved: 'Saved', connecting: 'Connecting...',
    connect_ok: (n) => `Connected · ${n} projects`,
    connect_fail: (m) => `Connection failed: ${m}`,
    api_error: 'Desktop API response error',
  }
};

window.dt = function(key, ...args) {
  const s = window.EXT_I18N[window._extLang] || window.EXT_I18N.cn;
  const v = s[key];
  return typeof v === 'function' ? v(...args) : (v !== undefined ? v : key);
};

window.applyExtLang = function() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = window.dt(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    el.innerHTML = window.dt(el.dataset.i18nHtml);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = window.dt(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = window.dt(el.dataset.i18nTitle);
  });
};

window._extLangReady = new Promise(function(resolve) {
  if (typeof chrome !== 'undefined' && chrome.storage) {
    chrome.storage.local.get({ extLang: 'cn' }, function(r) {
      window._extLang = r.extLang || 'cn';
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() { window.applyExtLang(); resolve(); });
      } else {
        window.applyExtLang(); resolve();
      }
    });
  } else {
    resolve();
  }
});
