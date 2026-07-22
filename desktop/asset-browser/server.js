import { createServer } from "node:http";
import { createReadStream, promises as fs, watch } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(__dirname, "public");
const configPath = process.env.ASSET_BROWSER_CONFIG_PATH || path.join(__dirname, "asset-browser.config.json");
const port = Number(process.env.PORT || 5177);

const imageExts = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const videoExts = new Set([".mp4", ".mov", ".m4v", ".webm"]);
const audioExts = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".oga", ".opus"]);
const sseClients = new Set();
let watchTimer = null;
const watcherHandles = new Map();

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function sendText(res, text, status = 200) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".m4a") return "audio/mp4";
  if (ext === ".aac") return "audio/aac";
  if (ext === ".flac") return "audio/flac";
  if (ext === ".ogg" || ext === ".oga") return "audio/ogg";
  if (ext === ".opus") return "audio/opus";
  if (ext === ".md") return "text/markdown; charset=utf-8";
  if (ext === ".txt") return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function safeResolve(root, requestedPath) {
  const decoded = decodeURIComponent(requestedPath || "");
  const absolute = path.resolve(root, decoded);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new Error("Path escapes project root");
  }
  return absolute;
}

function safeResolvePublic(requestedPath) {
  const withoutLeadingSlash = String(requestedPath || "").replace(/^\/+/, "");
  return safeResolve(publicRoot, withoutLeadingSlash || "index.html");
}

function safeImportName(input) {
  const name = path.basename(String(input || ""))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "");
  if (!name || name === "." || name === "..") {
    const error = new Error("Invalid file name");
    error.statusCode = 400;
    throw error;
  }
  if (!isMediaFile(name)) {
    const error = new Error("Unsupported media file");
    error.statusCode = 415;
    throw error;
  }
  return name;
}

async function finalizeImportFile(tempPath, directory, requestedName) {
  const ext = path.extname(requestedName);
  const stem = path.basename(requestedName, ext);
  for (let index = 1; index < 10000; index += 1) {
    const name = index === 1 ? requestedName : `${stem} (${index})${ext}`;
    const filePath = safeResolve(directory, name);
    try {
      await fs.link(tempPath, filePath);
      await fs.unlink(tempPath);
      return { filePath, name };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new Error("Could not allocate a unique file name");
}

async function importMedia(req, projectId, caseId, requestedName) {
  const project = await getProject(projectId);
  const destination = safeResolveProject(project, caseId);
  const stats = await fs.stat(destination);
  if (!stats.isDirectory()) throw new Error("Import destination is not a folder");
  const safeName = safeImportName(requestedName);
  const tempPath = safeResolve(destination, `.asset-import-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.part`);
  const handle = await fs.open(tempPath, "wx");
  try {
    for await (const chunk of req) await handle.write(chunk);
    await handle.close();
    const imported = await finalizeImportFile(tempPath, destination, safeName);
    return {
      name: imported.name,
      path: imported.filePath,
      relPath: path.relative(project.path, imported.filePath),
      caseRelPath: path.relative(destination, imported.filePath)
    };
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function loadConfig() {
  try {
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    const projects = (config.projects || []).map((project) => ({
      id: project.id,
      name: project.name || project.id,
      path: path.resolve(project.path),
      scanRoots: project.scanRoots?.length ? project.scanRoots : ["."]
    })).filter((project) => project.id && project.path);
    for (const project of projects) {
      if (
        project.scanRoots.length === 1
        && project.scanRoots[0] === "02-cases"
        && !await exists(path.join(project.path, "02-cases"))
      ) {
        project.scanRoots = ["."];
      }
    }
    return {
      enabled: config.enabled !== false,
      projects
    };
  } catch {
    return {
      enabled: true,
      projects: []
    };
  }
}

async function saveConfig(config) {
  const normalized = {
    enabled: config.enabled !== false,
    projects: (config.projects || []).map((project) => ({
      id: project.id,
      name: project.name || project.id,
      path: path.resolve(project.path),
      scanRoots: project.scanRoots?.length ? project.scanRoots : ["."]
    }))
  };
  await fs.writeFile(configPath, JSON.stringify(normalized, null, 2) + "\n", "utf8");
  return normalized;
}

function slugify(input) {
  const base = String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return base || `project-${Date.now()}`;
}

async function getProject(projectId) {
  const config = await loadConfig();
  const project = config.projects.find((item) => item.id === projectId) || config.projects[0];
  if (!project) throw new Error("No configured project folders");
  return project;
}

function safeResolveProject(project, requestedPath) {
  return safeResolve(project.path, requestedPath);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

async function readMeta(caseDir) {
  const metaPath = path.join(caseDir, ".asset-review-meta.json");
  try {
    return JSON.parse(await fs.readFile(metaPath, "utf8"));
  } catch {
    return {};
  }
}

async function writeMeta(caseDir, meta) {
  const metaPath = path.join(caseDir, ".asset-review-meta.json");
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf8");
}

function assetKind(filePath, caseDir) {
  const ext = path.extname(filePath).toLowerCase();
  const rel = path.relative(caseDir, filePath);
  const parts = rel.split(path.sep);
  const base = path.basename(filePath).toLowerCase();
  if (videoExts.has(ext)) return "video";
  if (audioExts.has(ext)) return "audio";
  if (imageExts.has(ext) && base.includes("contact_sheet")) return "contact";
  if (imageExts.has(ext) && (parts.includes("frames") || /^frame[_-]/.test(base))) return "frame";
  if (imageExts.has(ext)) return "image";
  return "other";
}

function inferVersion(relPath) {
  const match = relPath.match(/(?:^|[_-])v(\d+)(?:[_\-.]|$)/i);
  if (match) return `v${match[1]}`;
  if (relPath.includes("两段式")) return "v4";
  if (relPath.includes("机制母版")) return "v5";
  if (relPath.includes("无首尾帧")) return "v3";
  if (relPath.includes("全能参考_v2")) return "v2";
  return "";
}

function initialStatus(relPath) {
  if (relPath.includes("机制母版_v5_test")) return "可用";
  if (relPath.includes("两段式_v4")) return "可用但需优化";
  if (relPath.includes("无首尾帧_v3")) return "可用但需优化";
  if (relPath.includes("v2") || relPath.includes("雨夜古风追逐")) return "不通过但有参考价值";
  return "未评估";
}

async function listProjects() {
  const config = await loadConfig();
  const projects = [];
  for (const project of config.projects) {
    const mediaFiles = new Set();
    for (const scanRoot of project.scanRoots) {
      const rootDir = safeResolveProject(project, scanRoot);
      if (!await exists(rootDir)) continue;
      for (const filePath of await walk(rootDir)) {
        if (isMediaFile(filePath)) mediaFiles.add(path.resolve(filePath));
      }
    }
    const files = [...mediaFiles];
    const typeCounts = { image: 0, video: 0, audio: 0 };
    for (const filePath of files) {
      const ext = path.extname(filePath).toLowerCase();
      if (imageExts.has(ext)) typeCounts.image += 1;
      else if (videoExts.has(ext)) typeCounts.video += 1;
      else if (audioExts.has(ext)) typeCounts.audio += 1;
    }
    const previewUrls = files
      .filter((filePath) => imageExts.has(path.extname(filePath).toLowerCase()))
      .slice(0, 4)
      .map((filePath) => {
        const relPath = path.relative(project.path, filePath);
        return `/media?project=${encodeURIComponent(project.id)}&path=${encodeURIComponent(relPath)}`;
      });
    projects.push({
      id: project.id,
      name: project.name,
      path: project.path,
      scanRoots: project.scanRoots,
      exists: await exists(project.path),
      assetCount: files.length,
      typeCounts,
      previewUrls
    });
  }
  return projects;
}

async function scanCaseDirectories(project, directory, scanRoot, depth = 0, parentId = "") {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const relPath = path.relative(project.path, directory) || ".";
  const childTrees = [];
  let directAssetCount = entries.filter((entry) => entry.isFile() && isMediaFile(entry.name)).length;
  let assetCount = directAssetCount;

  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const entry of directories) {
    const childTree = await scanCaseDirectories(project, path.join(directory, entry.name), scanRoot, depth + 1, relPath);
    if (!childTree.assetCount) continue;
    childTrees.push(childTree.nodes);
    assetCount += childTree.assetCount;
  }

  if (!assetCount) return { assetCount: 0, nodes: [] };
  const stats = await fs.stat(directory);
  const node = {
    id: relPath,
    projectId: project.id,
    name: path.basename(directory).replace(/^\d{4}-\d{2}-\d{2}-/, ""),
    relPath,
    scanRoot,
    parentId,
    depth,
    isRoot: depth === 0,
    directAssetCount,
    assetCount,
    mtimeMs: stats.mtimeMs
  };
  return { assetCount, nodes: [node, ...childTrees.flat()] };
}

async function addProject({ name, path: projectPath, scanRoots }) {
  if (!projectPath) throw new Error("Missing project path");
  const config = await loadConfig();
  const absolutePath = path.resolve(projectPath);
  if (!await exists(absolutePath)) throw new Error(`Project folder does not exist: ${absolutePath}`);
  const idBase = slugify(name || path.basename(absolutePath));
  let id = idBase;
  let counter = 2;
  while (config.projects.some((project) => project.id === id)) {
    id = `${idBase}-${counter++}`;
  }
  const project = {
    id,
    name: name || path.basename(absolutePath),
    path: absolutePath,
    scanRoots: scanRoots?.length ? scanRoots : ["."]
  };
  config.projects.push(project);
  await saveConfig(config);
  await ensureWatchers();
  notifyClients("project-change");
  return project;
}

function closeUnusedWatchers(config) {
  const activeRoots = new Set();
  for (const project of config.projects) {
    for (const scanRoot of project.scanRoots) {
      activeRoots.add(safeResolveProject(project, scanRoot));
    }
  }
  for (const [watchRoot, handle] of watcherHandles) {
    if (activeRoots.has(watchRoot)) continue;
    handle.watcher.close();
    watcherHandles.delete(watchRoot);
  }
}

async function removeProject(projectId) {
  if (!projectId) throw new Error("Missing project id");
  const config = await loadConfig();
  const index = config.projects.findIndex((project) => project.id === projectId);
  if (index < 0) throw new Error(`Project not found: ${projectId}`);
  const [project] = config.projects.splice(index, 1);
  await saveConfig(config);
  closeUnusedWatchers(config);
  notifyClients("project-change");
  return project;
}

async function listCases(projectId) {
  const project = await getProject(projectId);
  const cases = [];
  for (const scanRoot of project.scanRoots) {
    const rootDir = safeResolveProject(project, scanRoot);
    if (!await exists(rootDir)) continue;
    const tree = await scanCaseDirectories(project, rootDir, scanRoot);
    cases.push(...tree.nodes);
  }
  return cases;
}

async function listAssets(projectId, caseId) {
  const project = await getProject(projectId);
  const caseDir = safeResolveProject(project, caseId);
  if (!await exists(caseDir)) throw new Error(`Case not found: ${caseId}`);
  const files = await walk(caseDir);
  const meta = await readMeta(caseDir);
  const assets = [];
  for (const filePath of files) {
    const ext = path.extname(filePath).toLowerCase();
    if (!imageExts.has(ext) && !videoExts.has(ext) && !audioExts.has(ext)) continue;
    const stats = await fs.stat(filePath);
    const relToCase = path.relative(caseDir, filePath);
    const relToProject = path.relative(project.path, filePath);
    const kind = assetKind(filePath, caseDir);
    const stored = meta[relToCase] || {};
    assets.push({
      id: relToCase,
      projectId: project.id,
      projectName: project.name,
      caseId,
      kind,
      version: inferVersion(relToCase),
      name: path.basename(filePath),
      relPath: relToProject,
      caseRelPath: relToCase,
      dir: path.dirname(relToProject),
      mediaUrl: `/media?project=${encodeURIComponent(project.id)}&path=${encodeURIComponent(relToProject)}`,
      downloadUrl: `/download?project=${encodeURIComponent(project.id)}&path=${encodeURIComponent(relToProject)}`,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      mtime: new Date(stats.mtimeMs).toISOString(),
      initialStatus: initialStatus(relToCase),
      userStatus: stored.userStatus || "",
      notes: stored.notes || "",
      favorite: Boolean(stored.favorite),
      tags: stored.tags || []
    });
  }
  return assets.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function serveFile(req, res, filePath, asDownload = false) {
  const stats = await fs.stat(filePath);
  const headers = {
    "content-type": contentType(filePath),
    "accept-ranges": "bytes",
    "cache-control": "no-store"
  };
  if (asDownload) {
    headers["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`;
  }

  const range = req.headers.range;
  if (range && !asDownload) {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : stats.size - 1;
      res.writeHead(206, {
        ...headers,
        "content-range": `bytes ${start}-${end}/${stats.size}`,
        "content-length": end - start + 1
      });
      createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
  }

  res.writeHead(200, { ...headers, "content-length": stats.size });
  createReadStream(filePath).pipe(res);
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function openFinder(targetPath, reveal = true) {
  const command = process.platform === "win32" ? "explorer.exe" : "open";
  const args = process.platform === "win32"
    ? (reveal ? ["/select,", targetPath] : [targetPath])
    : (reveal ? ["-R", targetPath] : [targetPath]);
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function notifyClients(event = "asset-change") {
  const payload = JSON.stringify({ event, at: new Date().toISOString() });
  for (const client of sseClients) {
    client.write(`event: ${event}\n`);
    client.write(`data: ${payload}\n\n`);
  }
}

function scheduleNotify() {
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = setTimeout(() => notifyClients(), 600);
}

function isMediaFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return imageExts.has(ext) || videoExts.has(ext) || audioExts.has(ext);
}

function forgetKnownPath(knownMedia, targetPath) {
  for (const filePath of knownMedia) {
    if (filePath === targetPath || filePath.startsWith(targetPath + path.sep)) {
      knownMedia.delete(filePath);
    }
  }
}

async function detectNewMedia(watchRoot, knownMedia, filename) {
  if (!filename) return;
  const targetPath = path.resolve(watchRoot, String(filename));
  if (targetPath !== watchRoot && !targetPath.startsWith(watchRoot + path.sep)) return;

  await new Promise((resolve) => setTimeout(resolve, 200));
  try {
    const stats = await fs.stat(targetPath);
    const candidates = stats.isDirectory() ? await walk(targetPath) : [targetPath];
    let hasNewMedia = false;
    for (const filePath of candidates) {
      const absolutePath = path.resolve(filePath);
      if (!isMediaFile(absolutePath) || knownMedia.has(absolutePath)) continue;
      knownMedia.add(absolutePath);
      hasNewMedia = true;
    }
    if (hasNewMedia) scheduleNotify();
  } catch {
    forgetKnownPath(knownMedia, targetPath);
  }
}

async function ensureWatchers() {
  const config = await loadConfig();
  for (const project of config.projects) {
    for (const scanRoot of project.scanRoots) {
      const watchRoot = safeResolveProject(project, scanRoot);
      if (!await exists(watchRoot)) continue;
      if (watcherHandles.has(watchRoot)) continue;
      try {
        const knownMedia = new Set((await walk(watchRoot)).filter(isMediaFile).map((filePath) => path.resolve(filePath)));
        const watcher = watch(watchRoot, { recursive: true }, (_eventType, filename) => {
          void detectNewMedia(watchRoot, knownMedia, filename).catch((error) => {
            console.warn(`Asset watcher scan failed (${watchRoot}):`, error.message);
          });
        });
        watcher.on("error", (error) => {
          console.warn(`Asset watcher error (${watchRoot}):`, error.message);
        });
        watcherHandles.set(watchRoot, { watcher, knownMedia });
        console.log(`Watching for new assets: ${watchRoot}`);
      } catch (error) {
        console.warn(`Asset watcher unavailable (${watchRoot}):`, error.message);
      }
    }
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (url.pathname === "/api/projects" && req.method === "POST") {
      const body = await readRequestBody(req);
      const project = await addProject(body);
      sendJson(res, { ok: true, project });
      return;
    }

    if (url.pathname === "/api/projects" && req.method === "DELETE") {
      const body = await readRequestBody(req);
      const project = await removeProject(body.projectId);
      sendJson(res, { ok: true, project });
      return;
    }

    if (url.pathname === "/api/projects") {
      sendJson(res, { projects: await listProjects() });
      return;
    }

    if (url.pathname === "/api/config") {
      sendJson(res, await loadConfig());
      return;
    }

    if (url.pathname === "/api/toggle-enabled" && req.method === "POST") {
      const body = await readRequestBody(req);
      const config = await loadConfig();
      config.enabled = Boolean(body.enabled);
      await saveConfig(config);
      notifyClients("config-change");
      sendJson(res, { ok: true, enabled: config.enabled });
      return;
    }

    if (url.pathname === "/api/cases") {
      const projectId = url.searchParams.get("project");
      const project = await getProject(projectId);
      sendJson(res, { projectRoot: project.path, project, cases: await listCases(project.id) });
      return;
    }

    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive"
      });
      res.write(`event: connected\n`);
      res.write(`data: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    if (url.pathname === "/api/assets") {
      const projectId = url.searchParams.get("project");
      const caseId = url.searchParams.get("case");
      if (!caseId) return sendJson(res, { error: "Missing case" }, 400);
      const project = await getProject(projectId);
      sendJson(res, { projectId: project.id, caseId, assets: await listAssets(project.id, caseId) });
      return;
    }

    if (url.pathname === "/api/import" && req.method === "POST") {
      const projectId = url.searchParams.get("project");
      const caseId = url.searchParams.get("case");
      const name = url.searchParams.get("name");
      if (!caseId || !name) return sendJson(res, { error: "Missing import destination or file name" }, 400);
      const imported = await importMedia(req, projectId, caseId, name);
      sendJson(res, { ok: true, imported }, 201);
      return;
    }

    if (url.pathname === "/api/mark" && req.method === "POST") {
      const body = await readRequestBody(req);
      const project = await getProject(body.projectId);
      const caseDir = safeResolveProject(project, body.caseId);
      const assetPath = safeResolve(caseDir, body.assetId);
      const relToCase = path.relative(caseDir, assetPath);
      const meta = await readMeta(caseDir);
      meta[relToCase] = {
        ...(meta[relToCase] || {}),
        userStatus: body.userStatus || "",
        notes: body.notes || "",
        favorite: Boolean(body.favorite),
        tags: Array.isArray(body.tags) ? body.tags : [],
        updatedAt: new Date().toISOString()
      };
      await writeMeta(caseDir, meta);
      sendJson(res, { ok: true, meta: meta[relToCase] });
      return;
    }

    if (url.pathname === "/api/reveal" && req.method === "POST") {
      const body = await readRequestBody(req);
      const project = await getProject(body.projectId);
      const target = safeResolveProject(project, body.path);
      openFinder(target, true);
      sendJson(res, { ok: true });
      return;
    }

    if (url.pathname === "/api/open-folder" && req.method === "POST") {
      const body = await readRequestBody(req);
      const project = await getProject(body.projectId);
      const target = safeResolveProject(project, body.path);
      openFinder(path.dirname(target), false);
      sendJson(res, { ok: true });
      return;
    }

    if (url.pathname === "/media" || url.pathname === "/download") {
      const projectId = url.searchParams.get("project");
      const project = await getProject(projectId);
      const requested = url.searchParams.get("path");
      const filePath = safeResolveProject(project, requested);
      await serveFile(req, res, filePath, url.pathname === "/download");
      return;
    }

    let staticPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = safeResolvePublic(staticPath);
    if (!await exists(filePath)) {
      sendText(res, "Not found", 404);
      return;
    }
    await serveFile(req, res, filePath);
  } catch (error) {
    sendJson(res, { error: error.message || String(error) }, error.statusCode || 500);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Asset browser running at http://127.0.0.1:${port}`);
  console.log(`Config: ${configPath}`);
});

ensureWatchers();

setInterval(() => {
  for (const client of sseClients) {
    client.write(`event: ping\n`);
    client.write(`data: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
  }
}, 30000).unref();
