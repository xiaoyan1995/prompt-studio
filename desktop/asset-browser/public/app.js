const isEmbedded = document.documentElement.classList.contains("embedded");
const parentOrigin = (() => {
  try {
    return new URL(document.referrer).origin;
  } catch {
    return "*";
  }
})();
const INTERNAL_ASSET_DRAG_TYPE = "application/x-asset-browser-files";

const state = {
  workspaceView: isEmbedded ? "overview" : "project",
  projectRoot: "",
  configEnabled: true,
  projects: [],
  selectedProject: "",
  cases: [],
  selectedCase: "",
  assets: [],
  selectedAsset: null,
  selectedAssetIds: new Set(),
  selectionAnchorId: "",
  categoryFilter: "",
  statusFilter: "",
  typeFilter: "",
  query: "",
  sort: "newest",
  compactReverse: true
};

const els = {
  projectList: document.querySelector("#projectList"),
  projectOverview: document.querySelector("#projectOverview"),
  projectNameInput: document.querySelector("#projectNameInput"),
  projectPathInput: document.querySelector("#projectPathInput"),
  pickProjectFolderButton: document.querySelector("#pickProjectFolderButton"),
  projectScanRootsInput: document.querySelector("#projectScanRootsInput"),
  addProjectButton: document.querySelector("#addProjectButton"),
  sidebarAddProjectButton: document.querySelector("#sidebarAddProjectButton"),
  openAddProjectButton: document.querySelector("#openAddProjectButton"),
  addProjectDialog: document.querySelector("#addProjectDialog"),
  closeAddProjectButton: document.querySelector("#closeAddProjectButton"),
  cancelAddProjectButton: document.querySelector("#cancelAddProjectButton"),
  backToProjectsButton: document.querySelector("#backToProjectsButton"),
  caseList: document.querySelector("#caseList"),
  caseSelect: document.querySelector("#caseSelect"),
  categoryFilters: document.querySelector("#categoryFilters"),
  categorySelect: document.querySelector("#categorySelect"),
  statusFilters: document.querySelector("#statusFilters"),
  statusSelect: document.querySelector("#statusSelect"),
  typeFilters: document.querySelector("#typeFilters"),
  typeSelect: document.querySelector("#typeSelect"),
  refreshButton: document.querySelector("#refreshButton"),
  topRefreshButton: document.querySelector("#topRefreshButton"),
  refreshStatus: document.querySelector("#refreshStatus"),
  workflowEnabled: document.querySelector("#workflowEnabled"),
  compactReverse: document.querySelector("#compactReverse"),
  caseTitle: document.querySelector("#caseTitle"),
  assetCount: document.querySelector("#assetCount"),
  searchInput: document.querySelector("#searchInput"),
  sortSelect: document.querySelector("#sortSelect"),
  assetGrid: document.querySelector("#assetGrid"),
  detailName: document.querySelector("#detailName"),
  detailPreview: document.querySelector("#detailPreview"),
  detailBody: document.querySelector("#detailBody"),
  closeDetail: document.querySelector("#closeDetail"),
  assetContextMenu: document.querySelector("#assetContextMenu"),
  sendToPromptManager: document.querySelector("#sendToPromptManager")
};
let mediaObserver = null;
const thumbnailQueue = [];
let activeThumbnailLoads = 0;
let internalAssetDragActive = false;
let internalAssetDragReleaseTimer = null;
let assetContextAssets = [];

const userStatuses = ["可用", "局部可用", "参考可用", "暂存", "丢弃"];
const categoryLabels = {
  videoResult: "视频结果",
  generatedAsset: "生成资产",
  reference: "输入参考",
  reverse: "视频反推/抽帧",
  audio: "音频资产",
  "": "全部资产"
};

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function statusClass(status) {
  if (status === "可用") return "good";
  if (status === "可用但需优化" || status === "局部可用") return "partial";
  if (status === "参考可用" || status === "不通过但有参考价值") return "ref";
  if (status === "暂存" || status === "未评估") return "hold";
  if (status === "丢弃" || status === "不通过") return "drop";
  return "unknown";
}

function displayStatus(asset) {
  return asset.userStatus || asset.initialStatus || "待用户判断";
}

function includesAny(text, words) {
  return words.some((word) => text.includes(word));
}

function slashPath(text) {
  return String(text || "").replaceAll("\\", "/");
}

function pathTokens(asset) {
  const casePath = slashPath(`${asset.caseId}/${asset.caseRelPath || ""}/${asset.name || ""}`);
  const projectPath = slashPath(`${asset.relPath || ""}/${asset.name || ""}`);
  return {
    original: `${casePath} ${projectPath}`,
    lower: `${casePath} ${projectPath}`.toLowerCase()
  };
}

function assetCategory(asset) {
  const { original, lower } = pathTokens(asset);
  if (
    asset.kind === "contact" ||
    asset.kind === "frame" ||
    includesAny(original, ["反推", "抽帧", "拆帧", "视频学习", "contact_sheet", "逐帧"]) ||
    includesAny(lower, ["/frames/", "/frame_extract", "/reverse", "/storyboard_reverse", "/video_reverse", "frame_", "contact_sheet"])
  ) {
    return "reverse";
  }

  if (asset.kind === "audio") {
    return "audio";
  }

  if (
    includesAny(lower, [
      "/input/",
      "/inputs/",
      "/source/",
      "/sources/",
      "/reference/",
      "/references/",
      "/refs/",
      "/samples/",
      "/raw/",
      "/原始素材/",
      "/输入参考/",
      "/参考素材/"
    ]) ||
    includesAny(original, ["输入参考", "参考素材", "原始素材", "外部参考", "源素材"]) ||
    includesAny(lower, ["source_", "input_", "ref_", "_ref."])
  ) {
    return "reference";
  }

  if (
    asset.kind === "video" ||
    includesAny(lower, [
      "/videos/",
      "/video_results/",
      "/video-result/",
      "/video-result",
      "/final_videos/",
      "/exports/",
      "/renders/",
      "/rendered/"
    ]) ||
    includesAny(original, ["成片", "视频结果", "最终视频", "可用版", "实测"]) ||
    includesAny(lower, ["seedance", "dreamina", "higgsfield"])
  ) {
    return "videoResult";
  }

  if (
    includesAny(lower, [
      "/generated_covers/",
      "/generated/",
      "/generations/",
      "/outputs/",
      "/output/",
      "/assets/",
      "/images/",
      "/covers/",
      "/candidates/"
    ]) ||
    includesAny(original, ["母版", "机制母版", "首帧", "尾帧", "角色卡", "设定", "候选", "测试图", "资产图", "封面", "道具", "场景"]) ||
    includesAny(lower, ["generated", "candidate", "cover", "final", "regen", "character_design"])
  ) {
    return "generatedAsset";
  }

  if (asset.kind === "image") return "generatedAsset";
  return "generatedAsset";
}

function enrichAsset(asset) {
  if (asset.category) return asset;
  const category = assetCategory(asset);
  return {
    ...asset,
    category,
    categoryLabel: categoryLabels[category] || "全部资产"
  };
}

function absolutePath(asset) {
  if (asset.isGroup) return `${state.projectRoot}/${asset.groupDir}`;
  return `${state.projectRoot}/${asset.relPath}`;
}

async function api(path, options) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text);
  }
  return response.json();
}

async function loadConfig() {
  const data = await api("/api/config");
  state.configEnabled = data.enabled !== false;
  els.workflowEnabled.checked = state.configEnabled;
}

async function loadProjects() {
  const data = await api("/api/projects");
  state.projects = data.projects;
  if (state.selectedProject && !state.projects.some((item) => item.id === state.selectedProject)) {
    state.selectedProject = "";
  }
  if (!isEmbedded && !state.selectedProject && state.projects[0]) {
    state.selectedProject = state.projects[0].id;
  }
  renderProjects();
}

async function loadCases() {
  if (!state.selectedProject) {
    state.cases = [];
    state.selectedCase = "";
    renderCases();
    return;
  }
  const data = await api(`/api/cases?project=${encodeURIComponent(state.selectedProject)}`);
  state.projectRoot = data.projectRoot;
  state.cases = data.cases;
  if (!state.cases.some((item) => item.id === state.selectedCase)) {
    state.selectedCase = state.cases[0]?.id || "";
  }
  renderCases();
}

async function loadAssets(selectDefaultType = false) {
  if (!state.selectedCase) {
    state.assets = [];
    resetAssetSelection(false);
    render();
    return;
  }
  const data = await api(`/api/assets?project=${encodeURIComponent(state.selectedProject)}&case=${encodeURIComponent(state.selectedCase)}`);
  state.assets = data.assets;
  if (selectDefaultType) {
    state.typeFilter = ["image", "video", "frame", "contact", "audio"]
      .find((kind) => state.assets.some((asset) => asset.kind === kind)) || "";
    els.typeSelect.value = state.typeFilter;
    els.typeFilters.querySelectorAll("button").forEach((item) => {
      item.classList.toggle("active", item.dataset.type === state.typeFilter);
    });
  }
  const validIds = new Set(state.assets.map((asset) => asset.id));
  state.selectedAssetIds = new Set([...state.selectedAssetIds].filter((id) => validIds.has(id)));
  if (state.selectedAsset) {
    const current = state.assets.find((asset) => asset.id === state.selectedAsset.id);
    state.selectedAsset = current ? enrichAsset(current) : null;
  }
  if (!state.selectedAsset && state.selectedAssetIds.size) {
    const firstId = state.selectedAssetIds.values().next().value;
    const current = state.assets.find((asset) => asset.id === firstId);
    state.selectedAsset = current ? enrichAsset(current) : null;
  }
  render();
  els.refreshStatus.textContent = `上次刷新 ${new Date().toLocaleTimeString()}`;
}

async function selectCase(caseId) {
  state.selectedCase = String(caseId || "");
  resetAssetSelection(false);
  state.typeFilter = "";
  els.typeSelect.value = "";
  els.typeFilters.querySelectorAll("button").forEach((item) => item.classList.remove("active"));
  setCategoryFilter("");
  renderCases();
  await loadAssets();
}

function renderProjects() {
  els.projectList.innerHTML = "";
  for (const item of state.projects) {
    const button = document.createElement("button");
    button.className = item.id === state.selectedProject ? "active" : "";
    const name = document.createElement("span");
    const status = document.createElement("span");
    name.textContent = item.name;
    status.textContent = item.exists ? "在线" : "缺失";
    button.append(name, status);
    button.title = item.path;
    button.addEventListener("click", () => openProject(item.id));
    els.projectList.append(button);
  }
  renderProjectOverview();
}

function renderProjectCover(cover, item) {
  cover.classList.toggle("is-unavailable", !item.exists);

  const fallback = document.createElement("div");
  fallback.className = "project-cover-fallback";
  const folderMark = document.createElement("span");
  folderMark.className = "project-cover-folder";
  const fallbackLabel = document.createElement("span");
  fallbackLabel.textContent = item.exists ? "暂无图片预览" : "目录不可用";
  fallback.append(folderMark, fallbackLabel);
  cover.append(fallback);

  const previewUrls = item.exists && Array.isArray(item.previewUrls) ? item.previewUrls.slice(0, 4) : [];
  if (previewUrls.length) {
    const grid = document.createElement("div");
    grid.className = `project-cover-grid preview-count-${previewUrls.length}`;
    for (const url of previewUrls) {
      const image = document.createElement("img");
      image.src = url;
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      image.addEventListener("error", () => image.remove());
      grid.append(image);
    }
    cover.append(grid);
  } else if (item.exists && item.assetCount) {
    const types = document.createElement("div");
    types.className = "project-cover-types";
    const typeItems = [
      ["image", "▧", "图片"],
      ["video", "▶", "视频"],
      ["audio", "♪", "音频"]
    ];
    for (const [kind, icon, label] of typeItems) {
      const count = item.typeCounts?.[kind] || 0;
      if (!count) continue;
      const type = document.createElement("span");
      type.title = label;
      type.innerHTML = `<b>${icon}</b><small>${count}</small>`;
      types.append(type);
    }
    cover.append(types);
  }

  if (item.exists) {
    const count = document.createElement("span");
    count.className = "project-cover-count";
    count.textContent = `${item.assetCount || 0} 个资源`;
    cover.append(count);
  }
}

function renderProjectOverview() {
  els.projectOverview.innerHTML = "";
  const query = state.query.trim().toLowerCase();
  const projects = state.projects.filter((item) => {
    if (!query) return true;
    return `${item.name} ${item.path}`.toLowerCase().includes(query);
  });
  els.projectOverview.classList.toggle("is-empty", !projects.length);
  if (!projects.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const icon = document.createElement("div");
    icon.className = "empty-folder-icon";
    const title = document.createElement("h3");
    const copy = document.createElement("p");
    const button = document.createElement("button");
    title.textContent = state.projects.length ? "没有匹配的监控目录" : "还没有监控目录";
    copy.textContent = state.projects.length
      ? "换一个关键词试试。"
      : "点击右上角“添加项目”开始建立独立资产目录。";
    button.className = "toolbar-button primary";
    button.type = "button";
    button.textContent = "添加项目";
    button.addEventListener("click", openAddProjectDialog);
    empty.append(icon, title, copy, button);
    els.projectOverview.append(empty);
    return;
  }

  for (const item of projects) {
    const card = document.createElement("article");
    card.className = "project-card";
    card.tabIndex = 0;

    const cover = document.createElement("div");
    cover.className = "project-card-cover";
    renderProjectCover(cover, item);

    const body = document.createElement("div");
    body.className = "project-card-body";
    const title = document.createElement("h3");
    title.className = "project-card-title";
    title.textContent = item.name;
    const path = document.createElement("p");
    path.className = "project-card-path";
    path.textContent = item.path;
    const meta = document.createElement("div");
    meta.className = "project-card-meta";
    const roots = document.createElement("span");
    const status = document.createElement("span");
    roots.textContent = `${item.scanRoots.length} 个扫描目录`;
    status.textContent = item.exists ? "在线" : "缺失";
    meta.append(roots, status);
    body.append(title, path, meta);
    const remove = document.createElement("button");
    remove.className = "project-card-remove";
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "取消监控";
    remove.setAttribute("aria-label", `取消监控 ${item.name}`);
    remove.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (!confirm(`取消监控“${item.name}”？\n\n只会移除监控记录，不会删除本地目录或任何文件。`)) return;
      try {
        await api("/api/projects", {
          method: "DELETE",
          body: JSON.stringify({ projectId: item.id })
        });
        if (state.selectedProject === item.id) state.selectedProject = "";
        await loadProjects();
        render();
        els.refreshStatus.textContent = "已取消监控，本地文件未删除";
      } catch (error) {
        els.refreshStatus.textContent = `取消监控失败：${error.message}`;
      }
    });
    card.append(cover, body, remove);

    const enter = () => openProject(item.id);
    card.addEventListener("click", enter);
    card.addEventListener("keydown", (event) => {
      if (event.target !== card) return;
      if (event.key === "Enter" || event.key === " ") enter();
    });
    els.projectOverview.append(card);
  }
}

async function openProject(projectId) {
  state.workspaceView = "project";
  state.selectedProject = projectId;
  state.selectedCase = "";
  resetAssetSelection(false);
  state.query = "";
  state.typeFilter = "";
  els.searchInput.value = "";
  setCategoryFilter("");
  renderProjects();
  await loadCases();
  await loadAssets(true);
}

function showProjectOverview() {
  state.workspaceView = "overview";
  state.selectedProject = "";
  state.selectedCase = "";
  resetAssetSelection(false);
  state.assets = [];
  state.query = "";
  els.searchInput.value = "";
  renderProjects();
  render();
}

function renderCases() {
  els.caseList.innerHTML = "";
  els.caseSelect.innerHTML = "";
  for (const item of state.cases) {
    const button = document.createElement("button");
    button.className = item.id === state.selectedCase ? "active" : "";
    const name = document.createElement("span");
    const date = document.createElement("span");
    name.textContent = item.name;
    button.style.paddingLeft = `${8 + (item.depth || 0) * 14}px`;
    date.textContent = item.assetCount;
    button.append(name, date);
    button.addEventListener("click", () => selectCase(item.id));
    els.caseList.append(button);

    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = `${"— ".repeat(item.depth || 0)}${item.name} (${item.assetCount})`;
    option.selected = item.id === state.selectedCase;
    els.caseSelect.append(option);
  }
  if (!state.cases.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "暂无案例";
    els.caseSelect.append(option);
  }
}

function renderCategoryCounts() {
  const counts = getCategoryCounts();
  els.categoryFilters.querySelectorAll("[data-category]").forEach((button) => {
    const category = button.dataset.category;
    const label = categoryLabels[category] || "全部资产";
    button.innerHTML = `<span>${label}</span><small>${counts[category] || 0}</small>`;
  });
  els.categorySelect.querySelectorAll("option").forEach((option) => {
    const label = categoryLabels[option.value] || "全部资产";
    option.textContent = `${label} ${counts[option.value] || 0}`;
  });
}

function getCategoryCounts() {
  const counts = { videoResult: 0, generatedAsset: 0, reference: 0, reverse: 0, audio: 0, "": state.assets.length };
  for (const asset of state.assets.map(enrichAsset)) {
    counts[asset.category] = (counts[asset.category] || 0) + 1;
  }
  return counts;
}

function setCategoryFilter(category) {
  state.categoryFilter = category;
  els.categorySelect.value = category;
  els.categoryFilters.querySelectorAll("[data-category]").forEach((button) => {
    button.classList.toggle("active", button.dataset.category === category);
  });
}

function filteredAssets() {
  const q = state.query.trim().toLowerCase();
  const enriched = state.assets.map(enrichAsset);
  let assets = enriched.filter((asset) => {
    const status = displayStatus(asset);
    if (state.categoryFilter && asset.category !== state.categoryFilter) return false;
    if (state.typeFilter && asset.kind !== state.typeFilter) return false;
    if (state.statusFilter) {
      if (state.statusFilter === "待用户判断") {
        if (asset.userStatus) return false;
      } else if (status !== state.statusFilter) {
        return false;
      }
    }
    if (!q) return true;
    const haystack = [
      asset.name,
      asset.version,
      asset.relPath,
      asset.notes,
      asset.initialStatus,
      asset.userStatus,
      asset.kind
    ].join(" ").toLowerCase();
    return haystack.includes(q);
  });

  if (state.compactReverse && state.categoryFilter === "reverse" && !state.typeFilter) {
    assets = compactReverseAssets(assets);
  }

  assets = [...assets].sort((a, b) => {
    if (state.sort === "oldest") return a.mtimeMs - b.mtimeMs;
    if (state.sort === "name") return a.name.localeCompare(b.name);
    if (state.sort === "size") return b.size - a.size;
    return b.mtimeMs - a.mtimeMs;
  });
  return assets;
}

function compactReverseAssets(assets) {
  const standalone = [];
  const groups = new Map();

  for (const asset of assets) {
    if (!["frame", "contact", "image"].includes(asset.kind)) {
      standalone.push(asset);
      continue;
    }
    const key = `${asset.caseId}/${asset.dir}`;
    const group = groups.get(key) || {
      key,
      assets: [],
      latest: asset
    };
    group.assets.push(asset);
    if (asset.mtimeMs > group.latest.mtimeMs) group.latest = asset;
    groups.set(key, group);
  }

  const reverseGroups = [...groups.values()].map((group) => {
    if (group.assets.length === 1) return group.assets[0];
    const sorted = [...group.assets].sort((a, b) => {
      const byName = a.name.localeCompare(b.name, undefined, { numeric: true });
      if (byName) return byName;
      return a.mtimeMs - b.mtimeMs;
    });
    const contact = sorted.find((asset) => asset.kind === "contact");
    const frame = sorted.find((asset) => asset.kind === "frame");
    const representative = contact || frame || sorted[Math.floor((sorted.length - 1) / 2)] || group.latest;
    return {
      ...representative,
      id: `group:${group.key}`,
      isGroup: true,
      kind: "frame-group",
      category: "reverse",
      categoryLabel: "视频反推/抽帧",
      groupDir: representative.dir,
      groupAssets: sorted,
      groupCount: group.assets.length,
      groupFirst: sorted[0],
      groupLast: sorted[sorted.length - 1],
      name: `${representative.dir.split("/").pop()}（${group.assets.length} 项）`,
      size: group.assets.reduce((sum, item) => sum + item.size, 0),
      mtimeMs: group.latest.mtimeMs,
      notes: representative.notes || "",
      initialStatus: "抽帧文件夹",
      userStatus: ""
    };
  });

  return [...standalone, ...reverseGroups];
}

function mediaPreview(asset, controls = false) {
  if (asset.kind === "video") {
    return controls
      ? `<video controls preload="metadata" src="${asset.mediaUrl}"></video>`
      : `<video preload="none" data-src="${asset.mediaUrl}"></video>`;
  }
  if (asset.kind === "audio") {
    return `
      <div class="audio-preview">
        <div class="audio-mark">AUDIO</div>
        <audio ${controls ? `controls preload="metadata" src="${asset.mediaUrl}"` : `preload="none" data-src="${asset.mediaUrl}"`}></audio>
      </div>
    `;
  }
  return controls
    ? `<img src="${asset.mediaUrl}" alt="" decoding="async">`
    : `<canvas data-src="${asset.mediaUrl}"></canvas>`;
}

function drawThumbnailFallback(canvas) {
  if (!canvas.isConnected) return;
  canvas.width = 480;
  canvas.height = 270;
  const context = canvas.getContext("2d");
  context.fillStyle = "#dbe3ee";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#718096";
  context.font = "24px Segoe UI";
  context.textAlign = "center";
  context.fillText("无法预览", canvas.width / 2, canvas.height / 2 + 8);
}

async function drawThumbnail(canvas, src) {
  const image = new Image();
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("Thumbnail image failed to load"));
      image.src = src;
    });
    if (!canvas.isConnected) return;
    canvas.width = 480;
    canvas.height = 270;
    const scale = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
    const width = Math.round(image.naturalWidth * scale);
    const height = Math.round(image.naturalHeight * scale);
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, Math.round((canvas.width - width) / 2), Math.round((canvas.height - height) / 2), width, height);
    canvas.dataset.loaded = "true";
  } catch {
    drawThumbnailFallback(canvas);
    canvas.dataset.error = "true";
  } finally {
    image.src = "";
  }
}

function drainThumbnailQueue() {
  while (activeThumbnailLoads < 3 && thumbnailQueue.length) {
    const task = thumbnailQueue.shift();
    activeThumbnailLoads += 1;
    void drawThumbnail(task.canvas, task.src).finally(() => {
      activeThumbnailLoads -= 1;
      drainThumbnailQueue();
    });
  }
}

function queueThumbnail(canvas) {
  const src = canvas.dataset.src;
  if (!src) return;
  delete canvas.dataset.src;
  thumbnailQueue.push({ canvas, src });
  drainThumbnailQueue();
}

function observeCardMedia() {
  mediaObserver?.disconnect();
  mediaObserver = null;
  const media = [...els.assetGrid.querySelectorAll("[data-src]")];
  const load = (element) => {
    if (element instanceof HTMLCanvasElement) {
      queueThumbnail(element);
      return;
    }
    element.src = element.dataset.src;
    delete element.dataset.src;
    if (element instanceof HTMLMediaElement) element.load();
  };
  if (!("IntersectionObserver" in window)) {
    media.forEach(load);
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      load(entry.target);
    }
  }, {
    root: els.assetGrid,
    rootMargin: "240px 180px"
  });
  mediaObserver = observer;
  media.forEach((element) => observer.observe(element));
}

function renderAssetCard(asset) {
  const card = document.createElement("article");
  card.className = `asset-card ${asset.isGroup ? "group-card" : ""} ${state.selectedAssetIds.has(asset.id) ? "selected" : ""}`;
  card.dataset.assetId = asset.id;
  card.draggable = true;
  card.tabIndex = 0;
  card.setAttribute("role", "option");
  card.setAttribute("aria-selected", state.selectedAssetIds.has(asset.id) ? "true" : "false");
  const status = displayStatus(asset);
  const actionLabel = asset.isGroup ? "展开" : "详情";
  const downloadAction = asset.isGroup
    ? `<button data-action="folder">文件夹</button>`
    : `<a href="${asset.downloadUrl}" download>下载</a>`;
  card.innerHTML = `
    <div class="preview">
      ${mediaPreview(asset)}
      <div class="badge-row ${asset.isGroup ? "" : "category-only"}">
        ${asset.isGroup ? `<span class="badge">${asset.groupCount} 项</span>` : ""}
        <span class="badge">${asset.categoryLabel || asset.kind}</span>
      </div>
    </div>
    <div class="card-body">
      <p class="card-title">${asset.name}</p>
      <div class="card-meta">
        <span class="status ${statusClass(status)}">${status}</span>
        <span>${formatSize(asset.size)}</span>
      </div>
      <div class="card-actions">
        <button data-action="select">${actionLabel}</button>
        <button data-action="copy">复制</button>
        <button data-action="reveal">定位</button>
        ${downloadAction}
      </div>
    </div>
  `;
  card.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "copy") return copyPath(asset);
    if (action === "reveal") return reveal(asset);
    if (action === "folder") return openFolder(asset);
    if (event.target.closest("a[download]")) return;
    selectAsset(asset, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey });
  });
  card.addEventListener("keydown", (event) => {
    if (event.target !== card || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    selectAsset(asset, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey });
  });
  card.addEventListener("contextmenu", (event) => openAssetContextMenu(event, asset));
  card.addEventListener("dragstart", (event) => startAssetDrag(event, asset, card));
  card.addEventListener("dragend", () => {
    card.classList.remove("dragging");
    clearTimeout(internalAssetDragReleaseTimer);
    internalAssetDragReleaseTimer = setTimeout(() => {
      internalAssetDragActive = false;
      internalAssetDragReleaseTimer = null;
    }, 0);
  });
  return card;
}

function notifyParentState() {
  if (!isEmbedded) return;
  const currentProject = state.projects.find((item) => item.id === state.selectedProject);
  const currentCase = state.cases.find((item) => item.id === state.selectedCase);
  const typeCounts = state.assets.reduce((counts, asset) => {
    counts[asset.kind] = (counts[asset.kind] || 0) + 1;
    return counts;
  }, {});
  window.parent.postMessage({
    type: "asset-browser:state",
    state: {
      view: state.workspaceView,
      projectName: currentProject?.name || "",
      projectPath: currentProject?.path || "",
      caseName: currentCase?.name || "",
      cases: state.cases.map((item) => ({
        id: item.id,
        name: item.name,
        parentId: item.parentId,
        scanRoot: item.scanRoot,
        depth: item.depth,
        isRoot: item.isRoot,
        directAssetCount: item.directAssetCount,
        assetCount: item.assetCount
      })),
      selectedCase: state.selectedCase,
      assetCount: state.assets.length,
      typeCounts,
      categoryCounts: getCategoryCounts(),
      categoryFilter: state.categoryFilter,
      statusFilter: state.statusFilter,
      typeFilter: state.typeFilter,
      sort: state.sort,
      query: state.query
    }
  }, parentOrigin);
}

function render() {
  const showingOverview = isEmbedded && state.workspaceView === "overview";
  document.body.classList.toggle("asset-overview", showingOverview);
  document.body.classList.toggle("asset-project", isEmbedded && !showingOverview);
  els.backToProjectsButton.hidden = !isEmbedded || showingOverview;

  if (showingOverview) {
    els.caseTitle.textContent = "资产浏览器";
    els.assetCount.textContent = `${state.projects.length} 个监控目录，与其他板块独立`;
    renderProjectOverview();
    renderDetail();
    notifyParentState();
    return;
  }

  const currentCase = state.cases.find((item) => item.id === state.selectedCase);
  const currentProject = state.projects.find((item) => item.id === state.selectedProject);
  if (!currentProject) {
    els.caseTitle.textContent = "资产浏览器";
    els.assetCount.textContent = "尚未添加项目";
    els.assetGrid.innerHTML = `
      <div class="empty-state">
        <h3>先添加一个本地项目文件夹</h3>
        <p>在左侧展开“添加项目”，选择文件夹并填写需要扫描的子目录。</p>
      </div>
    `;
    renderDetail();
    return;
  }
  els.caseTitle.textContent = currentCase ? `${currentProject?.name || "项目"} / ${currentCase.name}` : "资产看板";
  const assets = filteredAssets();
  renderCategoryCounts();
  const categoryName = categoryLabels[state.categoryFilter] || "全部资产";
  const rawCategoryCount = state.categoryFilter
    ? state.assets.map(enrichAsset).filter((asset) => asset.category === state.categoryFilter).length
    : state.assets.length;
  if (state.compactReverse && state.categoryFilter === "reverse" && assets.length < rawCategoryCount) {
    els.assetCount.textContent = `${categoryName}：${assets.length} 组 / 原始 ${rawCategoryCount} 个（全案 ${state.assets.length}）`;
  } else {
    els.assetCount.textContent = `${categoryName}：${assets.length} / ${state.assets.length} 个资产`;
  }
  els.assetGrid.innerHTML = "";
  mediaObserver?.disconnect();
  mediaObserver = null;
  thumbnailQueue.length = 0;
  if (!assets.length) {
    els.assetGrid.innerHTML = `
      <div class="empty-state">
        <h3>${categoryName}暂无资产</h3>
        <p>可以切换其他资产视图，或在生成/整理完成后手动刷新。</p>
      </div>
    `;
  } else {
    for (const asset of assets) els.assetGrid.append(renderAssetCard(asset));
    observeCardMedia();
  }
  renderDetail();
  notifyParentState();
}

function selectedAssetsInView() {
  return filteredAssets().filter((asset) => state.selectedAssetIds.has(asset.id));
}

function updateSelectionVisuals() {
  for (const card of els.assetGrid.querySelectorAll(".asset-card")) {
    const selected = state.selectedAssetIds.has(card.dataset.assetId);
    card.classList.toggle("selected", selected);
    card.setAttribute("aria-selected", selected ? "true" : "false");
  }
}

function resetAssetSelection(renderUi = true) {
  state.selectedAsset = null;
  state.selectedAssetIds = new Set();
  state.selectionAnchorId = "";
  if (!renderUi) return;
  updateSelectionVisuals();
  renderDetail();
}

function selectAsset(asset, { toggle = false, range = false } = {}) {
  if (!asset) {
    resetAssetSelection();
    return;
  }

  const visibleAssets = filteredAssets();
  const next = new Set(state.selectedAssetIds);
  if (range && state.selectionAnchorId) {
    const anchorIndex = visibleAssets.findIndex((item) => item.id === state.selectionAnchorId);
    const targetIndex = visibleAssets.findIndex((item) => item.id === asset.id);
    if (anchorIndex !== -1 && targetIndex !== -1) {
      if (!toggle) next.clear();
      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      visibleAssets.slice(start, end + 1).forEach((item) => next.add(item.id));
    }
  } else if (toggle) {
    if (next.has(asset.id)) next.delete(asset.id);
    else next.add(asset.id);
    state.selectionAnchorId = asset.id;
  } else {
    next.clear();
    next.add(asset.id);
    state.selectionAnchorId = asset.id;
  }

  state.selectedAssetIds = next;
  if (next.has(asset.id)) {
    state.selectedAsset = asset;
  } else {
    const fallback = visibleAssets.find((item) => next.has(item.id));
    state.selectedAsset = fallback || null;
  }
  updateSelectionVisuals();
  renderDetail();
}

function filesForAsset(asset) {
  return asset.isGroup ? (asset.groupAssets || []) : [asset];
}

function isImageAsset(asset) {
  return asset && asset.kind !== "video" && asset.kind !== "audio";
}

function promptManagerImages(assets) {
  const byUrl = new Map();
  assets.flatMap(filesForAsset).filter(isImageAsset).forEach((asset) => {
    if (!asset.downloadUrl || byUrl.has(asset.downloadUrl)) return;
    byUrl.set(asset.downloadUrl, {
      name: asset.name || "image.png",
      downloadUrl: asset.downloadUrl
    });
  });
  return [...byUrl.values()];
}

function closeAssetContextMenu() {
  els.assetContextMenu.hidden = true;
  assetContextAssets = [];
}

function openAssetContextMenu(event, asset) {
  if (!isEmbedded) return;
  const selected = state.selectedAssetIds.has(asset.id) ? selectedAssetsInView() : [asset];
  if (!promptManagerImages(selected).length) return;
  event.preventDefault();
  if (!state.selectedAssetIds.has(asset.id)) selectAsset(asset);
  assetContextAssets = selected;
  const imageCount = promptManagerImages(selected).length;
  els.sendToPromptManager.textContent = imageCount > 1
    ? `发送 ${imageCount} 张图片到提示词管理`
    : "发送到提示词管理";
  els.assetContextMenu.hidden = false;
  const left = Math.min(event.clientX, window.innerWidth - els.assetContextMenu.offsetWidth - 8);
  const top = Math.min(event.clientY, window.innerHeight - els.assetContextMenu.offsetHeight - 8);
  els.assetContextMenu.style.left = `${Math.max(8, left)}px`;
  els.assetContextMenu.style.top = `${Math.max(8, top)}px`;
}

function wireAssetContextMenu() {
  els.sendToPromptManager.addEventListener("click", () => {
    const assets = assetContextAssets;
    closeAssetContextMenu();
    requestPromptProject(assets);
  });
  document.addEventListener("pointerdown", (event) => {
    if (!els.assetContextMenu.hidden && !els.assetContextMenu.contains(event.target)) closeAssetContextMenu();
  });
  window.addEventListener("blur", closeAssetContextMenu);
  window.addEventListener("resize", closeAssetContextMenu);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAssetContextMenu();
  });
}

function requestPromptProject(assets) {
  const images = promptManagerImages(assets);
  if (!images.length) {
    els.refreshStatus.textContent = "请选择图片后再发送";
    return;
  }
  const requestId = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  window.parent.postMessage({
    type: "asset-browser:send-request",
    requestId,
    images
  }, parentOrigin);
  els.refreshStatus.textContent = `已选择 ${images.length} 张图片，请选择提示词项目`;
}

function imageMimeType(filename) {
  const ext = filename.split(".").pop()?.toLowerCase();
  return {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif"
  }[ext] || "application/octet-stream";
}

async function exportPromptManagerImages(payload) {
  const requestId = String(payload?.requestId || "");
  const images = Array.isArray(payload?.images) ? payload.images : [];
  if (!requestId || !images.length) return;

  const files = [];
  const failed = [];
  els.refreshStatus.textContent = `正在准备 ${images.length} 张图片`;
  for (const image of images) {
    try {
      const response = await fetch(image.downloadUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      files.push(new File([blob], image.name || "image.png", {
        type: blob.type || imageMimeType(image.name || ""),
        lastModified: Date.now()
      }));
    } catch {
      failed.push(image.name || "未知图片");
    }
  }
  window.parent.postMessage({
    type: "asset-browser:send-files",
    requestId,
    files,
    failed
  }, parentOrigin);
  els.refreshStatus.textContent = failed.length
    ? `已准备 ${files.length} 张，${failed.length} 张读取失败`
    : `已准备 ${files.length} 张图片`;
}

function dragPathsForAssets(assets) {
  const paths = assets.flatMap(filesForAsset).map(absolutePath).filter(Boolean);
  return [...new Set(paths)];
}

function startAssetDrag(event, asset, card) {
  if (event.target.closest(".card-actions")) {
    event.preventDefault();
    return;
  }
  if (!state.selectedAssetIds.has(asset.id)) selectAsset(asset);
  const selected = selectedAssetsInView();
  const paths = dragPathsForAssets(selected.length ? selected : [asset]);
  if (!paths.length) {
    event.preventDefault();
    return;
  }

  card.classList.add("dragging");
  clearTimeout(internalAssetDragReleaseTimer);
  internalAssetDragReleaseTimer = null;
  internalAssetDragActive = true;
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData("text/plain", paths.join("\n"));
  event.dataTransfer.setData(INTERNAL_ASSET_DRAG_TYPE, String(paths.length));
  if (paths.length === 1 && !asset.isGroup) {
    const downloadUrl = new URL(asset.downloadUrl, location.href).href;
    event.dataTransfer.setData("DownloadURL", `application/octet-stream:${asset.name}:${downloadUrl}`);
  }

  if (window.assetBrowserDesktop?.startLocalFileDrag) {
    window.assetBrowserDesktop.startLocalFileDrag(paths);
  } else if (isEmbedded) {
    window.parent.postMessage({ type: "asset-browser:drag-out", paths }, parentOrigin);
  }
}

function renderDetail() {
  const selected = selectedAssetsInView();
  if (selected.length > 1) {
    const paths = dragPathsForAssets(selected);
    const totalSize = selected.reduce((sum, item) => sum + Number(item.size || 0), 0);
    els.detailName.textContent = `已选择 ${selected.length} 项`;
    els.detailPreview.innerHTML = `<div class="multi-selection-summary"><strong>${selected.length}</strong><span>项资产</span></div>`;
    els.detailBody.className = "detail-body";
    els.detailBody.innerHTML = `
      <div class="detail-row">
        <label>选择</label>
        <div class="mono">${paths.length} 个文件<br>总大小：${formatSize(totalSize)}</div>
      </div>
      <div class="detail-actions">
        <button id="copySelectedPaths">复制路径</button>
        <button id="clearSelectedAssets">清空选择</button>
      </div>
    `;
    els.detailBody.querySelector("#copySelectedPaths").addEventListener("click", async () => {
      await navigator.clipboard.writeText(paths.join("\n"));
      els.refreshStatus.textContent = `已复制 ${paths.length} 个文件路径`;
    });
    els.detailBody.querySelector("#clearSelectedAssets").addEventListener("click", () => resetAssetSelection());
    return;
  }

  const asset = state.selectedAsset;
  if (!asset) {
    els.detailName.textContent = "未选择资产";
    els.detailPreview.innerHTML = "";
    els.detailBody.innerHTML = "选择一个资产查看详情";
    els.detailBody.className = "detail-body muted";
    return;
  }

  const status = displayStatus(asset);
  els.detailName.textContent = asset.name;
  els.detailPreview.innerHTML = mediaPreview(asset, true);
  els.detailBody.className = "detail-body";
  if (asset.isGroup) {
    els.detailBody.innerHTML = `
      <div class="detail-row">
        <label>抽帧文件夹</label>
        <div class="mono">${absolutePath(asset)}<br>共 ${asset.groupCount} 项<br>代表资产：${asset.caseRelPath}</div>
      </div>
      <div class="detail-row">
        <label>首尾帧</label>
        <div class="mono">第一帧：${asset.groupFirst?.name || "-"}<br>最后帧：${asset.groupLast?.name || "-"}</div>
      </div>
      <div class="detail-actions">
        <button id="copyPath">复制文件夹路径</button>
        <button id="revealAsset">定位代表帧</button>
        <button id="openFolder">打开文件夹</button>
      </div>
    `;
    els.detailBody.querySelector("#copyPath").addEventListener("click", () => copyPath(asset));
    els.detailBody.querySelector("#revealAsset").addEventListener("click", () => reveal(asset));
    els.detailBody.querySelector("#openFolder").addEventListener("click", () => openFolder(asset));
    return;
  }

  els.detailBody.innerHTML = `
    <div class="detail-row">
      <label>完整路径</label>
      <div class="mono">${absolutePath(asset)}</div>
    </div>
    <div class="detail-row">
      <label>信息</label>
      <div class="mono">类型：${asset.kind}<br>版本：${asset.version || "-"}<br>大小：${formatSize(asset.size)}<br>修改：${new Date(asset.mtimeMs).toLocaleString()}<br>主代理初判：${asset.initialStatus}</div>
    </div>
    <div class="detail-row">
      <label>用户判断</label>
      <div class="status-grid">
        ${userStatuses.map((item) => `<button class="${asset.userStatus === item ? "active" : ""}" data-status="${item}">${item}</button>`).join("")}
      </div>
    </div>
    <div class="detail-row">
      <label>备注</label>
      <textarea id="notesInput" placeholder="这里记录你觉得它能怎么用，比如 B-roll、动作局部、封面、参考图...">${asset.notes || ""}</textarea>
    </div>
    <div class="detail-actions">
      <button id="saveMeta">保存标注</button>
      <button id="copyPath">复制路径</button>
      <button id="revealAsset">打开位置</button>
      <a href="${asset.downloadUrl}" download>下载文件</a>
      <button id="openFolder">打开文件夹</button>
    </div>
  `;

  els.detailBody.querySelectorAll("[data-status]").forEach((button) => {
    button.addEventListener("click", () => {
      asset.userStatus = button.dataset.status;
      renderDetail();
    });
  });
  els.detailBody.querySelector("#saveMeta").addEventListener("click", () => saveMeta(asset));
  els.detailBody.querySelector("#copyPath").addEventListener("click", () => copyPath(asset));
  els.detailBody.querySelector("#revealAsset").addEventListener("click", () => reveal(asset));
  els.detailBody.querySelector("#openFolder").addEventListener("click", () => openFolder(asset));
}

async function saveMeta(asset) {
  const notes = els.detailBody.querySelector("#notesInput")?.value || "";
  asset.notes = notes;
  await api("/api/mark", {
    method: "POST",
    body: JSON.stringify({
      caseId: asset.caseId,
      projectId: asset.projectId,
      assetId: asset.caseRelPath,
      userStatus: asset.userStatus,
      notes,
      favorite: asset.favorite,
      tags: asset.tags
    })
  });
  await loadAssets();
}

async function copyPath(asset) {
  await navigator.clipboard.writeText(absolutePath(asset));
  els.refreshStatus.textContent = "已复制路径";
}

async function reveal(asset) {
  await api("/api/reveal", {
    method: "POST",
    body: JSON.stringify({ projectId: asset.projectId, path: asset.relPath })
  });
}

async function openFolder(asset) {
  await api("/api/open-folder", {
    method: "POST",
    body: JSON.stringify({ projectId: asset.projectId, path: asset.relPath })
  });
}

function openAddProjectDialog() {
  els.addProjectDialog.hidden = false;
  els.projectNameInput.focus();
}

function closeAddProjectDialog() {
  els.addProjectDialog.hidden = true;
}

async function addProject() {
  const name = els.projectNameInput.value.trim();
  const projectPath = els.projectPathInput.value.trim();
  const scanRoots = els.projectScanRootsInput.value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!projectPath) {
    els.refreshStatus.textContent = "请填写项目文件夹路径";
    return;
  }
  const data = await api("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name, path: projectPath, scanRoots })
  });
  state.selectedProject = data.project.id;
  state.workspaceView = "project";
  state.selectedCase = "";
  state.typeFilter = "";
  els.projectNameInput.value = "";
  els.projectPathInput.value = "";
  closeAddProjectDialog();
  await loadProjects();
  await loadCases();
  await loadAssets(true);
  els.refreshStatus.textContent = "项目已添加并开始监听";
}

function hasExternalFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes("Files");
}

function isInternalAssetDrag(event) {
  return internalAssetDragActive
    || Array.from(event.dataTransfer?.types || []).includes(INTERNAL_ASSET_DRAG_TYPE);
}

async function importDroppedFiles(fileList) {
  if (state.workspaceView !== "project" || !state.selectedProject || !state.selectedCase) {
    els.refreshStatus.textContent = "请先进入一个资产目录";
    return;
  }

  const files = [...fileList];
  if (!files.length) return;
  const importedIds = [];
  let failed = 0;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    els.refreshStatus.textContent = `正在导入 ${index + 1} / ${files.length}`;
    try {
      const query = new URLSearchParams({
        project: state.selectedProject,
        case: state.selectedCase,
        name: file.name
      });
      const response = await fetch(`/api/import?${query}`, {
        method: "POST",
        headers: { "content-type": file.type || "application/octet-stream" },
        body: file
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "导入失败");
      if (result.imported?.caseRelPath) importedIds.push(result.imported.caseRelPath);
    } catch (error) {
      failed += 1;
      console.warn(`Import failed for ${file.name}:`, error.message);
    }
  }

  await loadProjects();
  await loadCases();
  await loadAssets();
  if (importedIds.length) {
    const importedSet = new Set(importedIds);
    state.selectedAssetIds = importedSet;
    const active = state.assets.find((asset) => importedSet.has(asset.id));
    state.selectedAsset = active ? enrichAsset(active) : null;
    state.selectionAnchorId = active?.id || "";
    updateSelectionVisuals();
    renderDetail();
  }
  els.refreshStatus.textContent = failed
    ? `已导入 ${importedIds.length} 个，失败 ${failed} 个`
    : `已导入 ${importedIds.length} 个文件`;
}

function wireAssetDrop() {
  let dragDepth = 0;
  const clearDropState = () => {
    dragDepth = 0;
    els.assetGrid.classList.remove("drop-active");
  };
  const ignoreInternalDrop = (event) => {
    if (!isInternalAssetDrag(event)) return false;
    event.preventDefault();
    clearDropState();
    return true;
  };
  els.assetGrid.addEventListener("dragenter", (event) => {
    if (ignoreInternalDrop(event)) return;
    if (!hasExternalFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    els.assetGrid.classList.add("drop-active");
  });
  els.assetGrid.addEventListener("dragover", (event) => {
    if (ignoreInternalDrop(event)) return;
    if (!hasExternalFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });
  els.assetGrid.addEventListener("dragleave", (event) => {
    if (ignoreInternalDrop(event)) return;
    if (!hasExternalFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) els.assetGrid.classList.remove("drop-active");
  });
  els.assetGrid.addEventListener("drop", (event) => {
    if (ignoreInternalDrop(event)) return;
    if (!hasExternalFiles(event)) return;
    event.preventDefault();
    const files = event.dataTransfer.files;
    clearDropState();
    void importDroppedFiles(files);
  });
  window.addEventListener("blur", clearDropState);
}

function wireMarqueeSelection() {
  els.assetGrid.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest(".asset-card,button,a,input,select,textarea")) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const additive = event.ctrlKey || event.metaKey;
    const baseline = new Set(additive ? state.selectedAssetIds : []);
    const selectionBox = document.createElement("div");
    selectionBox.className = "selection-rect";
    document.body.append(selectionBox);
    let moved = false;
    let lastHitId = "";

    if (!additive) {
      state.selectedAssetIds = new Set();
      state.selectedAsset = null;
      updateSelectionVisuals();
    }

    const move = (moveEvent) => {
      const left = Math.min(startX, moveEvent.clientX);
      const top = Math.min(startY, moveEvent.clientY);
      const right = Math.max(startX, moveEvent.clientX);
      const bottom = Math.max(startY, moveEvent.clientY);
      if (Math.abs(moveEvent.clientX - startX) > 3 || Math.abs(moveEvent.clientY - startY) > 3) moved = true;
      selectionBox.style.left = `${left}px`;
      selectionBox.style.top = `${top}px`;
      selectionBox.style.width = `${right - left}px`;
      selectionBox.style.height = `${bottom - top}px`;
      const next = new Set(baseline);
      lastHitId = "";
      for (const card of els.assetGrid.querySelectorAll(".asset-card")) {
        const rect = card.getBoundingClientRect();
        const intersects = rect.right >= left && rect.left <= right && rect.bottom >= top && rect.top <= bottom;
        if (intersects) {
          next.add(card.dataset.assetId);
          lastHitId = card.dataset.assetId;
        }
      }
      state.selectedAssetIds = next;
      updateSelectionVisuals();
    };

    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      selectionBox.remove();
      if (!moved && !additive) {
        resetAssetSelection();
        return;
      }
      const visibleAssets = filteredAssets();
      state.selectedAsset = visibleAssets.find((asset) => asset.id === lastHitId)
        || visibleAssets.find((asset) => state.selectedAssetIds.has(asset.id))
        || null;
      if (lastHitId) state.selectionAnchorId = lastHitId;
      renderDetail();
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  });
}

function wireFilters() {
  els.categoryFilters.addEventListener("click", (event) => {
    const button = event.target.closest("[data-category]");
    if (!button) return;
    setCategoryFilter(button.dataset.category);
    render();
  });

  els.statusFilters.addEventListener("click", (event) => {
    const button = event.target.closest("[data-status]");
    if (!button) return;
    state.statusFilter = button.dataset.status;
    els.statusSelect.value = state.statusFilter;
    els.statusFilters.querySelectorAll("button").forEach((item) => item.classList.toggle("active", item === button));
    render();
  });

  els.typeFilters.addEventListener("click", (event) => {
    const button = event.target.closest("[data-type]");
    if (!button) return;
    state.typeFilter = button.dataset.type;
    els.typeSelect.value = state.typeFilter;
    els.typeFilters.querySelectorAll("button").forEach((item) => item.classList.toggle("active", item === button));
    render();
  });

  els.searchInput.addEventListener("input", () => {
    state.query = els.searchInput.value;
    render();
  });

  els.sortSelect.addEventListener("change", () => {
    state.sort = els.sortSelect.value;
    render();
  });

  els.refreshButton.addEventListener("click", loadAssets);
  els.topRefreshButton.addEventListener("click", loadAssets);
  els.addProjectButton.addEventListener("click", addProject);
  els.sidebarAddProjectButton.addEventListener("click", openAddProjectDialog);
  els.openAddProjectButton.addEventListener("click", openAddProjectDialog);
  els.closeAddProjectButton.addEventListener("click", closeAddProjectDialog);
  els.cancelAddProjectButton.addEventListener("click", closeAddProjectDialog);
  els.addProjectDialog.addEventListener("click", (event) => {
    if (event.target === els.addProjectDialog) closeAddProjectDialog();
  });
  els.backToProjectsButton.addEventListener("click", showProjectOverview);
  els.caseSelect.addEventListener("change", () => selectCase(els.caseSelect.value));
  els.categorySelect.addEventListener("change", () => {
    setCategoryFilter(els.categorySelect.value);
    render();
  });
  els.statusSelect.addEventListener("change", () => {
    state.statusFilter = els.statusSelect.value;
    els.statusFilters.querySelectorAll("button").forEach((item) => {
      item.classList.toggle("active", item.dataset.status === state.statusFilter);
    });
    render();
  });
  els.typeSelect.addEventListener("change", () => {
    state.typeFilter = els.typeSelect.value;
    els.typeFilters.querySelectorAll("button").forEach((item) => {
      item.classList.toggle("active", item.dataset.type === state.typeFilter);
    });
    render();
  });
  els.pickProjectFolderButton?.addEventListener("click", () => {
    window.parent.postMessage({ type: "asset-browser:pick-folder" }, "*");
  });
  els.closeDetail.addEventListener("click", () => {
    selectAsset(null);
  });

  wireAssetDrop();
  wireMarqueeSelection();

  els.compactReverse.addEventListener("change", () => {
    state.compactReverse = els.compactReverse.checked;
    render();
  });
  els.workflowEnabled.addEventListener("change", async () => {
    state.configEnabled = els.workflowEnabled.checked;
    await api("/api/toggle-enabled", {
      method: "POST",
      body: JSON.stringify({ enabled: state.configEnabled })
    });
    els.refreshStatus.textContent = state.configEnabled ? "生产任务启用资产工作台" : "简单模式：不强制登记资产";
  });
}

window.addEventListener("message", async (event) => {
  if (event.source !== window.parent) return;
  if (parentOrigin !== "*" && event.origin !== parentOrigin) return;
  if (event.data?.type === "asset-browser:folder-picked") {
    if (event.data.path) els.projectPathInput.value = event.data.path;
    return;
  }
  if (event.data?.type !== "asset-browser:command") return;

  const { action, value } = event.data;
  if (action === "open-add-project") {
    openAddProjectDialog();
  } else if (action === "back") {
    showProjectOverview();
  } else if (action === "search") {
    state.query = String(value || "");
    els.searchInput.value = state.query;
    render();
  } else if (action === "refresh") {
    await loadProjects();
    await loadCases();
    await loadAssets();
  } else if (action === "case") {
    await selectCase(value);
  } else if (action === "category") {
    setCategoryFilter(String(value || ""));
    render();
  } else if (action === "status") {
    state.statusFilter = String(value || "");
    els.statusSelect.value = state.statusFilter;
    render();
  } else if (action === "type") {
    state.typeFilter = String(value || "");
    els.typeSelect.value = state.typeFilter;
    els.typeFilters.querySelectorAll("button").forEach((item) => {
      item.classList.toggle("active", item.dataset.type === state.typeFilter);
    });
    render();
  } else if (action === "sort") {
    state.sort = String(value || "newest");
    els.sortSelect.value = state.sort;
    render();
  } else if (action === "theme") {
    document.documentElement.classList.toggle("theme-dark", value === "dark");
  } else if (action === "card-scale") {
    const scale = Math.max(0.5, Math.min(1.8, Number(value) || 1));
    document.documentElement.style.setProperty("--asset-card-width", `${Math.round(200 * scale)}px`);
  } else if (action === "export-prompt-images") {
    await exportPromptManagerImages(value);
  }
});

function configureLiveEvents() {
  if (!window.EventSource) return;
  const source = new EventSource("/api/events");
  source.addEventListener("asset-change", async () => {
    els.refreshStatus.textContent = "检测到新资产，正在刷新";
    await loadProjects();
    await loadCases();
    await loadAssets();
  });
  source.addEventListener("project-change", async () => {
    els.refreshStatus.textContent = "项目清单已更新";
    await loadProjects();
    await loadCases();
    await loadAssets();
  });
  source.addEventListener("config-change", async () => {
    await loadConfig();
  });
  source.addEventListener("connected", () => {
    els.refreshStatus.textContent = "新文件监听已连接";
  });
  source.onerror = () => {
    els.refreshStatus.textContent = "新文件监听不可用，可手动刷新";
  };
}

wireFilters();
wireAssetContextMenu();
await loadConfig();
await loadProjects();
await loadCases();
setCategoryFilter(state.categoryFilter);
await loadAssets();
render();
configureLiveEvents();
