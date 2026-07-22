const { app, BrowserWindow, Menu, dialog, shell, ipcMain, clipboard, nativeImage } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

app.setName('Prompt Studio Desktop');

const PORT = Number(process.env.PROMPT_STUDIO_PORT || 8768);
const SERVER_URL = `http://127.0.0.1:${PORT}`;
const ASSET_BROWSER_PORT = Number(process.env.ASSET_BROWSER_PORT || 5177);
const ASSET_BROWSER_URL = `http://127.0.0.1:${ASSET_BROWSER_PORT}`;
const PROTOCOL = 'promptstudio-desktop';

let mainWindow = null;
let serverProcess = null;
let assetBrowserProcess = null;

function logLine(message) {
  try {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(path.join(app.getPath('temp'), 'prompt-studio-desktop.log'), line);
  } catch {}
}

function resourcePath(...parts) {
  return app.isPackaged
    ? path.join(process.resourcesPath, ...parts)
    : path.join(__dirname, ...parts);
}

function packagedAppRoot() {
  if (!app.isPackaged) return path.resolve(__dirname, '..');
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  if (process.platform === 'darwin') {
    return path.resolve(path.dirname(process.execPath), '..', '..', '..');
  }
  return path.dirname(process.execPath);
}

function extensionPath() {
  if (!app.isPackaged) return path.resolve(__dirname, '..', 'extension');
  // Packaged: prefer extension/ next to the app bundle or portable app folder.
  const sibling = path.join(packagedAppRoot(), 'extension');
  if (fs.existsSync(sibling)) return sibling;
  // Fallback: legacy inside resources/
  return path.join(process.resourcesPath, 'extension');
}

function appWritableRoot() {
  if (!app.isPackaged) return path.resolve(__dirname, '..');
  return packagedAppRoot();
}

let activeDataDir = null;

function defaultDataPath() {
  return path.join(appWritableRoot(), 'studio-data');
}

function dataPath() {
  return activeDataDir || defaultDataPath();
}

function dataLocationConfigPath() {
  return path.join(app.getPath('userData'), 'data-location.json');
}

function readConfiguredDataDir() {
  try {
    const cfg = JSON.parse(fs.readFileSync(dataLocationConfigPath(), 'utf8'));
    const dir = cfg && typeof cfg.data_dir === 'string' ? cfg.data_dir : '';
    return dir && fs.existsSync(dir) ? dir : '';
  } catch {
    return '';
  }
}

function writeConfiguredDataDir(dir) {
  try {
    const cfgPath = dataLocationConfigPath();
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify({ data_dir: dir }, null, 2), 'utf8');
  } catch (err) {
    logLine(`write data location failed ${err.message}`);
  }
}

function looksLikeDataDir(dir) {
  try {
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;
    return [
      '.prompt-studio-data',
      'data.json',
      'desktop_settings.json',
      'uploads',
      'snapshots',
    ].some((name) => fs.existsSync(path.join(dir, name)));
  } catch {
    return false;
  }
}

function resolvePickedDataDir(folder) {
  if (looksLikeDataDir(folder)) return folder;
  const nested = path.join(folder, 'studio-data');
  return looksLikeDataDir(nested) ? nested : '';
}

function copyDataDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.cpSync(s, d, { recursive: true, force: true });
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function chooseExistingDataDir(defaultDir) {
  if (!app.isPackaged || looksLikeDataDir(defaultDir)) return '';
  const choice = dialog.showMessageBoxSync({
    type: 'question',
    title: '选择旧版数据',
    message: '是否已有旧版 studio-data 数据文件夹？',
    detail: '如果你是从旧版 zip/绿色版升级，可以选择旧版程序旁边的 studio-data 文件夹。新版会先尝试复制这份数据到当前版本的数据目录；如果没有旧数据，直接创建新数据即可。',
    buttons: ['选择旧数据文件夹', '创建新数据'],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice !== 0) return '';

  while (true) {
    const picked = dialog.showOpenDialogSync({
      title: '选择旧版 studio-data 文件夹',
      properties: ['openDirectory'],
    });
    if (!picked || !picked[0]) return '';

    const sourceDir = resolvePickedDataDir(picked[0]);
    if (!sourceDir) {
      const retry = dialog.showMessageBoxSync({
        type: 'warning',
        title: '未识别到数据',
        message: '选择的目录不像 Prompt Studio 数据文件夹。',
        detail: '请确认目录中包含 data.json、uploads 或 desktop_settings.json。你也可以选择旧程序文件夹，软件会自动寻找其中的 studio-data。',
        buttons: ['重新选择', '创建新数据'],
        defaultId: 0,
        cancelId: 1,
      });
      if (retry === 0) continue;
      return '';
    }

    try {
      copyDataDir(sourceDir, defaultDir);
      logLine(`copied existing data dir ${sourceDir} -> ${defaultDir}`);
      return defaultDir;
    } catch (err) {
      logLine(`copy existing data dir failed ${err.message}`);
      const useOriginal = dialog.showMessageBoxSync({
        type: 'warning',
        title: '复制数据失败',
        message: '旧数据复制到新版目录失败，是否直接使用旧数据文件夹？',
        detail: `旧数据：${sourceDir}\n失败原因：${err.message}`,
        buttons: ['直接使用旧数据', '创建新数据'],
        defaultId: 0,
        cancelId: 1,
      });
      return useOriginal === 0 ? sourceDir : '';
    }
  }
}

function prepareDataDir() {
  const configured = readConfiguredDataDir();
  const fallback = defaultDataPath();
  const target = configured || chooseExistingDataDir(fallback) || fallback;
  activeDataDir = target;
  fs.mkdirSync(target, { recursive: true });
  try {
    fs.writeFileSync(path.join(target, '.prompt-studio-data'), '1', 'utf8');
  } catch (err) {
    logLine(`write data marker failed ${err.message}`);
  }
  if (path.resolve(target) !== path.resolve(fallback)) {
    writeConfiguredDataDir(target);
  }
  return target;
}

function requestOk(url, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await requestOk(`${SERVER_URL}/api/health`, 1200)) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanupStaleWindowsServers() {
  if (process.platform !== 'win32') return;
  const { execSync } = require('child_process');
  logLine('cleanup stale server processes start');

  let netstat = '';
  try {
    netstat = execSync(`netstat -ano -p tcp | findstr :${PORT}`, { timeout: 3000, encoding: 'utf8' });
  } catch {
    return;
  }

  const pids = new Set();
  for (const line of netstat.split(/\r?\n/)) {
    if (!/\bLISTENING\b/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    const pid = parts[parts.length - 1];
    if (/^\d+$/.test(pid)) pids.add(pid);
  }

  for (const pid of pids) {
    let commandLine = '';
    try {
      commandLine = execSync(
        `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine"`,
        { timeout: 3000, encoding: 'utf8' }
      ).trim().toLowerCase();
    } catch (err) {
      logLine(`cleanup inspect pid ${pid} failed ${err.message}`);
      continue;
    }

    const looksLikeDevServer = commandLine.includes('server.py') && commandLine.includes('prompt_studio');
    const looksLikeBundledServer = commandLine.includes('prompt-studio-server');
    if (!looksLikeDevServer && !looksLikeBundledServer) {
      logLine(`cleanup keep pid ${pid} command=${commandLine}`);
      continue;
    }

    try {
      execSync(`taskkill /PID ${pid} /T /F`, { timeout: 4000, stdio: 'ignore' });
      logLine(`cleanup killed stale server pid ${pid}`);
    } catch (err) {
      logLine(`cleanup kill pid ${pid} failed ${err.message}`);
    }
  }
}

function bundledServerCommand() {
  // In dev mode always use python server.py so code changes take effect immediately
  if (!app.isPackaged) return null;
  const exeName = process.platform === 'win32' ? 'prompt-studio-server.exe' : 'prompt-studio-server';
  const candidates = [
    resourcePath('server', exeName),
    path.join(__dirname, 'server-dist', exeName),
  ];
  const command = candidates.find((candidate) => fs.existsSync(candidate));
  return command ? { command, args: [String(PORT)] } : null;
}

function findPython() {
  const { execSync } = require('child_process');
  // Try Windows py launcher first, then where python
  const candidates = process.platform === 'win32'
    ? ['py', 'python', 'python3']
    : ['python3', 'python'];
  for (const cmd of candidates) {
    try {
      const full = execSync(
        process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`,
        { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }
      ).toString().trim().split(/\r?\n/)[0];
      if (full && fs.existsSync(full)) return full;
    } catch {}
  }
  // Last resort: common install paths
  const fallbacks = process.platform === 'win32'
    ? [
        'C:\\Python312\\python.exe', 'C:\\Python311\\python.exe',
        'C:\\Python310\\python.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'python.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python310', 'python.exe'),
      ]
    : ['/usr/bin/python3', '/usr/local/bin/python3'];
  for (const p of fallbacks) { if (fs.existsSync(p)) return p; }
  return process.platform === 'win32' ? 'python' : 'python3';
}

function pythonServerCommand() {
  const serverPy = resourcePath('studio', 'server.py');
  const python = findPython();
  logLine(`python executable: ${python}`);
  return { command: python, args: [serverPy, String(PORT)] };
}

async function ensureServer() {
  logLine(`ensureServer start ${SERVER_URL}`);
  if (await requestOk(`${SERVER_URL}/api/health`, 500)) return true;
  cleanupStaleWindowsServers();
  await sleep(700);
  if (await requestOk(`${SERVER_URL}/api/health`, 500)) return true;

  const cmd = bundledServerCommand() || pythonServerCommand();
  logLine(`server command ${cmd.command} ${cmd.args.join(' ')}`);
  const localDataPath = prepareDataDir();
  logLine(`data path ${localDataPath}`);
  serverProcess = spawn(cmd.command, cmd.args, {
    cwd: resourcePath('studio'),
    env: {
      ...process.env,
      PROMPT_STUDIO_DATA_DIR: localDataPath,
      PROMPT_STUDIO_STATIC_DIR: resourcePath('studio'),
      PYTHONUNBUFFERED: '1',
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', (chunk) => {
    const text = `[studio] ${chunk}`.trim();
    console.log(text);
    logLine(text);
  });
  serverProcess.stderr.on('data', (chunk) => {
    const text = `[studio] ${chunk}`.trim();
    console.error(text);
    logLine(text);
  });
  serverProcess.on('error', (err) => {
    logLine(`server spawn error ${err.message}`);
  });
  serverProcess.on('exit', () => {
    logLine('server process exited');
    serverProcess = null;
  });

  const ok = await waitForServer();
  logLine(`server ready ${ok}`);
  return ok;
}

async function ensureAssetBrowser() {
  logLine(`ensureAssetBrowser start ${ASSET_BROWSER_URL}`);
  if (await requestOk(`${ASSET_BROWSER_URL}/api/config`, 500)) return true;

  const serverPath = resourcePath('asset-browser', 'server.js');
  if (!fs.existsSync(serverPath)) {
    logLine(`asset browser server missing ${serverPath}`);
    return false;
  }
  const assetBrowserDataDir = path.join(app.getPath('userData'), 'asset-browser');
  const assetBrowserConfigPath = path.join(assetBrowserDataDir, 'asset-browser.config.json');
  fs.mkdirSync(assetBrowserDataDir, { recursive: true });
  if (!fs.existsSync(assetBrowserConfigPath)) {
    fs.copyFileSync(resourcePath('asset-browser', 'asset-browser.config.json'), assetBrowserConfigPath);
  }

  assetBrowserProcess = spawn(process.execPath, [serverPath], {
    cwd: path.dirname(serverPath),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(ASSET_BROWSER_PORT),
      ASSET_BROWSER_CONFIG_PATH: assetBrowserConfigPath,
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  assetBrowserProcess.stdout.on('data', (chunk) => logLine(`[asset-browser] ${String(chunk).trim()}`));
  assetBrowserProcess.stderr.on('data', (chunk) => logLine(`[asset-browser] ${String(chunk).trim()}`));
  assetBrowserProcess.on('error', (err) => logLine(`asset browser spawn error ${err.message}`));
  assetBrowserProcess.on('exit', () => {
    logLine('asset browser process exited');
    assetBrowserProcess = null;
  });

  const started = Date.now();
  while (Date.now() - started < 8000) {
    if (await requestOk(`${ASSET_BROWSER_URL}/api/config`, 800)) return true;
    await sleep(250);
  }
  return false;
}

function registerProtocol() {
  try {
    if (process.defaultApp) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL);
    }
    logLine('protocol registered');
  } catch (err) {
    logLine(`protocol registration failed ${err.message}`);
  }
}

function buildMenu() {
  const template = [
    {
      label: 'Prompt Studio',
      submenu: [
        {
          label: '设置',
          accelerator: 'CmdOrCtrl+,',
          click: () => mainWindow?.webContents.executeJavaScript('window.openDesktopSettings && window.openDesktopSettings()'),
        },
        {
          label: '打开插件目录',
          click: () => shell.openPath(extensionPath()),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: process.platform === 'darwin' ? 'close' : 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerDialogHandlers() {
  ipcMain.handle('dialog:pick-folder', async (event, options = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const requestedTitle = typeof options?.title === 'string' ? options.title.trim() : '';
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      title: requestedTitle.slice(0, 80) || '选择数据存储目录',
    });
    return result.canceled ? null : result.filePaths[0];
  });
}

function registerWindowControls() {
  ipcMain.handle('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle('window:toggle-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.handle('window:set-always-on-top', (event, flag) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.setAlwaysOnTop(flag, 'floating');
    return flag;
  });
  ipcMain.handle('shell:open-external', (_event, url) => {
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      shell.openExternal(url);
    }
  });
}

// ── Upload path resolver ───────────────────────────────────────────────────
function resolveUploadPath(uploadPath) {
  if (!uploadPath || !uploadPath.startsWith('/uploads/')) return null;
  const rel = decodeURIComponent(uploadPath.slice('/uploads/'.length)).replace(/\\/g, '/');
  if (rel.includes('../') || rel.includes('/..')) return null;
  const parts = rel.split('/').filter(Boolean);
  const absPath = path.join(dataPath(), 'uploads', ...parts);
  return fs.existsSync(absPath) ? absPath : null;
}

// ── Clipboard IPC handlers (TODO3) ────────────────────────────────────────
function registerClipboardHandlers() {
  // Copy image to clipboard: write bitmap (for image editors/apps) + CF_HDROP (for Explorer paste)
  ipcMain.handle('clipboard:copy-image', (_event, uploadPath) => {
    try {
      const localPath = resolveUploadPath(uploadPath);
      if (!localPath) return false;
      const img = nativeImage.createFromPath(localPath);
      if (img.isEmpty()) return false;
      // Primary: bitmap for image editors / chat apps
      clipboard.writeImage(img);
      // Also write CF_HDROP so Ctrl+V works in Windows Explorer / Desktop
      if (process.platform === 'win32') {
        const p = localPath;
        const filesBuf = Buffer.concat([
          (() => { const b = Buffer.alloc((p.length + 1) * 2); b.write(p, 0, 'utf16le'); return b; })(),
          Buffer.alloc(2), // double-null terminator
        ]);
        const header = Buffer.alloc(20);
        header.writeUInt32LE(20, 0); header.writeUInt32LE(1, 16);
        clipboard.writeBuffer('CF_HDROP', Buffer.concat([header, filesBuf]));
      }
      return true;
    } catch { return false; }
  });

  // Copy plain text to clipboard
  ipcMain.handle('clipboard:copy-text', (_event, text) => {
    try { clipboard.writeText(String(text || '')); return true; }
    catch { return false; }
  });

  // Copy file(s) to clipboard — writes CF_HDROP on Windows so Ctrl+V works in Explorer
  ipcMain.handle('clipboard:copy-files', (_event, uploadPaths) => {
    try {
      const paths = (uploadPaths || []).map(resolveUploadPath).filter(Boolean);
      if (!paths.length) return false;
      if (process.platform === 'win32') {
        // Build CF_HDROP buffer for Windows native file clipboard
        const filesBuf = Buffer.concat(
          paths.map(p => {
            const b = Buffer.alloc((p.length + 1) * 2);
            b.write(p, 0, 'utf16le');
            return b;
          }).concat([Buffer.alloc(2)])  // double-null terminator
        );
        const header = Buffer.alloc(20);
        header.writeUInt32LE(20, 0);  // pFiles offset
        header.writeUInt32LE(1,  16); // fWide = true
        clipboard.writeBuffer('CF_HDROP', Buffer.concat([header, filesBuf]));
      }
      // Always write text fallback (full path, one per line)
      clipboard.writeText(paths.join('\n'));
      return true;
    } catch { return false; }
  });
}

// ── Native file drag-out IPC (TODO2) ─────────────────────────────────────
let _dragIcon = null;
function getDragIcon() {
  if (_dragIcon) return _dragIcon;
  const size = 48;
  const buf  = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i*4]=59; buf[i*4+1]=130; buf[i*4+2]=246; buf[i*4+3]=220;
  }
  _dragIcon = nativeImage.createFromBuffer(buf, { width: size, height: size });
  return _dragIcon;
}
function registerDragHandlers() {
  ipcMain.on('drag:start', (event, uploadPathOrPaths) => {
    try {
      const paths = Array.isArray(uploadPathOrPaths) ? uploadPathOrPaths : [uploadPathOrPaths];
      const localPaths = paths.map(resolveUploadPath).filter(Boolean);
      if (localPaths.length === 1) {
        event.sender.startDrag({ file: localPaths[0], icon: getDragIcon() });
      } else if (localPaths.length > 1) {
        event.sender.startDrag({ files: localPaths, icon: getDragIcon() });
      }
    } catch (e) { logLine('drag:start error ' + e.message); }
    event.returnValue = null;
  });
  // Drag local (non-uploads) file to OS/editing software
  ipcMain.on('drag:start-local', (event, absPathOrPaths) => {
    try {
      const paths = Array.isArray(absPathOrPaths) ? absPathOrPaths : [absPathOrPaths];
      const valid = paths.filter(p => { try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; } });
      if (valid.length === 1) {
        event.sender.startDrag({ file: valid[0], icon: getDragIcon() });
      } else if (valid.length > 1) {
        event.sender.startDrag({ files: valid, icon: getDragIcon() });
      }
    } catch (e) { logLine('drag:start-local error ' + e.message); }
  });
}

function registerAudioHandlers() {
  const AUDIO_EXTS = new Set(['.mp3','.wav','.ogg','.flac','.aac','.m4a','.opus','.weba','.m4r','.aiff','.au']);
  ipcMain.handle('folder:scan-audio', async (_event, folderPath) => {
    function scanDir(dirPath, subPath, depth) {
      if (depth > 8) return [];
      const results = [];
      let entries;
      try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch { return []; }
      entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh');
      });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const absPath = path.join(dirPath, entry.name);
        const relPath = subPath ? subPath + '/' + entry.name : entry.name;
        if (entry.isDirectory()) {
          results.push({ type: 'folder', name: entry.name, relPath, absPath, subPath: subPath || '' });
          results.push(...scanDir(absPath, relPath, depth + 1));
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (AUDIO_EXTS.has(ext)) {
            let size = 0;
            try { size = fs.statSync(absPath).size; } catch {}
            results.push({ type: 'file', name: entry.name,
              nameNoExt: path.basename(entry.name, ext),
              ext: ext.slice(1), relPath, absPath, size, subPath: subPath || '' });
          }
        }
      }
      return results;
    }
    try { return { ok: true, items: scanDir(folderPath, '', 0) }; }
    catch (e) { return { ok: false, error: e.message, items: [] }; }
  });
}

async function createWindow() {
  logLine(`createWindow resources=${process.resourcesPath || ''}`);
  const serverReady = await ensureServer();
  if (!serverReady) {
    logLine('server failed to become ready');
    dialog.showErrorBox('Prompt Studio', '本地服务启动失败。请确认已安装 Python 3，或使用带 sidecar 的正式安装包。');
    return;
  }
  const assetBrowserReady = await ensureAssetBrowser();
  logLine(`asset browser ready ${assetBrowserReady}`);

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1040,
    minHeight: 720,
    title: 'Prompt Studio Desktop',
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#10151c',
    icon: process.platform === 'win32'
      ? resourcePath('prompt_studio_icon.ico')
      : resourcePath('prompt_studio_icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      sandbox: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);

  // Prevent drag-drop from navigating the main window away from the application
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== SERVER_URL && !url.startsWith(`${SERVER_URL}/`)) {
      event.preventDefault();
    }
  });

  // Clear HTTP cache so a freshly installed version always loads new files
  await mainWindow.webContents.session.clearCache();
  await mainWindow.loadURL(SERVER_URL, { extraHeaders: 'pragma: no-cache\n' });
  logLine('main window loaded');
  if (process.argv.some((arg) => arg.startsWith(`${PROTOCOL}://`))) {
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.executeJavaScript('window.openDesktopSettings && window.openDesktopSettings()');
    });
  }
  return true;
}

function stopServer() {
  stopProcessTree(serverProcess, 'studio');
  serverProcess = null;
  stopProcessTree(assetBrowserProcess, 'asset-browser');
  assetBrowserProcess = null;
}

function stopProcessTree(proc, label) {
  if (!proc) return;
  try {
    if (process.platform === 'win32') {
      // Kill the entire process tree (covers py.exe → python.exe chains)
      const { execSync } = require('child_process');
      try { execSync(`taskkill /pid ${proc.pid} /T /F`, { timeout: 4000, stdio: 'ignore' }); } catch {}
    } else {
      // Unix: SIGTERM first, then SIGKILL
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 1500);
    }
  } catch {}
  // Fallback: always try direct kill too
  try { proc.kill(); } catch {}
  logLine(`stop ${label} called, pid=${proc.pid}`);
}

const gotLock = app.requestSingleInstanceLock();
logLine(`gotLock ${gotLock}`);
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      logLine('second instance received before main window became available');
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (argv.some((arg) => arg.startsWith(`${PROTOCOL}://`))) {
      mainWindow.webContents.executeJavaScript('window.openDesktopSettings && window.openDesktopSettings()');
    }
  });

  app.whenReady().then(async () => {
    logLine('app ready');
    registerProtocol();
    registerWindowControls();
    registerDialogHandlers();
    registerClipboardHandlers();
    registerDragHandlers();
    registerAudioHandlers();
    buildMenu();
    if (!await createWindow()) {
      app.quit();
      return;
    }
  }).catch((err) => {
    logLine(`app ready error ${err.stack || err.message}`);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', stopServer);
  app.on('will-quit', stopServer);

  // Final safety net: if Node process itself exits for any reason
  process.on('exit', () => {
    for (const proc of [serverProcess, assetBrowserProcess]) {
      if (!proc) continue;
      try {
        if (process.platform === 'win32') {
          require('child_process').execSync(
            `taskkill /pid ${proc.pid} /T /F`,
            { timeout: 2000, stdio: 'ignore' }
          );
        } else {
          proc.kill('SIGKILL');
        }
      } catch {}
    }
  });
}
