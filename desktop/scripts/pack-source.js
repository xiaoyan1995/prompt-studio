/**
 * Build a clean runtime-source archive.
 *
 * The archive contains only the desktop runtime source, browser extension,
 * bundled project skill, launch script, and a short usage guide. It excludes
 * dependencies, build outputs, tests, caches, logs, and user data.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DESKTOP = path.resolve(__dirname, '..');
const DIST = path.join(DESKTOP, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'));
const version = pkg.version;
const appName = pkg.build?.productName || 'Prompt Studio Desktop';
const zipName = `${appName}-${version}-clean-source.zip`;
const zipOut = path.join(DIST, zipName);
const STAGE = path.join(os.tmpdir(), `psd-clean-source-${process.pid}-${Date.now()}`);

const COMMON_SKIP = new Set([
  '.cache', '.context', '.git', '.github', '.idea', '.vscode',
  '__pycache__', 'bin', 'build', 'dist', 'node_modules',
  'playwright-report', 'server-build', 'server-dist', 'studio-data',
  'test-results', 'vendor'
]);
const STUDIO_SKIP = new Set([
  ...COMMON_SKIP,
  'data.json', 'exports', 'snapshots', 'studio-config.json', 'uploads',
  'test_atomic_data_file.py', 'test_media_integrity.py'
]);
const REQUIRED_FILES = [
  'dev-start.bat',
  '源码包说明.txt',
  'desktop/main.js',
  'desktop/preload.js',
  'desktop/package.json',
  'desktop/scripts/start-electron.js',
  'desktop/studio/server.py',
  'desktop/studio/index.html',
  'desktop/asset-browser/server.js',
  'desktop/asset-browser/asset-browser.config.json',
  'desktop/asset-browser/public/index.html',
  'extension/manifest.json',
  'extension/background.js',
  'extension/content.js',
  'skills/prompt-studio/SKILL.md',
  'skills/prompt-studio/REFERENCE.md'
];

fs.mkdirSync(DIST, { recursive: true });
fs.mkdirSync(STAGE, { recursive: true });

try {
  console.log('Copying clean desktop runtime source...');
  copyFile(path.join(DESKTOP, 'main.js'), path.join(STAGE, 'desktop', 'main.js'));
  copyFile(path.join(DESKTOP, 'preload.js'), path.join(STAGE, 'desktop', 'preload.js'));
  writeRuntimePackage(path.join(STAGE, 'desktop', 'package.json'));
  copyFile(
    path.join(DESKTOP, 'scripts', 'start-electron.js'),
    path.join(STAGE, 'desktop', 'scripts', 'start-electron.js')
  );
  copyDir(path.join(DESKTOP, 'studio'), path.join(STAGE, 'desktop', 'studio'), STUDIO_SKIP);
  copyDir(path.join(DESKTOP, 'asset-browser'), path.join(STAGE, 'desktop', 'asset-browser'), COMMON_SKIP);

  // Source mode resolves the native window icon from desktop/, while the web UI
  // serves the same files from desktop/studio/.
  copyFile(
    path.join(DESKTOP, 'studio', 'prompt_studio_icon.ico'),
    path.join(STAGE, 'desktop', 'prompt_studio_icon.ico')
  );
  copyFile(
    path.join(DESKTOP, 'studio', 'prompt_studio_icon.png'),
    path.join(STAGE, 'desktop', 'prompt_studio_icon.png')
  );

  console.log('Copying browser extension...');
  copyDir(path.join(ROOT, 'extension'), path.join(STAGE, 'extension'), COMMON_SKIP);

  console.log('Copying bundled skills...');
  copyDir(path.join(ROOT, 'skills'), path.join(STAGE, 'skills'), COMMON_SKIP);

  copyFile(path.join(ROOT, 'dev-start.bat'), path.join(STAGE, 'dev-start.bat'));
  writeGuide(path.join(STAGE, '源码包说明.txt'));

  const audit = auditStage(STAGE);
  if (fs.existsSync(zipOut)) fs.rmSync(zipOut);

  console.log(`Creating ${zipName}...`);
  createZip(STAGE, zipOut);

  const sizeMB = (fs.statSync(zipOut).size / 1024 / 1024).toFixed(1);
  console.log(`Clean-source audit passed: ${audit.fileCount} files, ${audit.sourceSizeMB} MB before compression.`);
  console.log(`Done: ${zipName} (${sizeMB} MB)`);
  console.log(`Path: ${zipOut}`);
} finally {
  fs.rmSync(STAGE, { recursive: true, force: true });
}

function writeRuntimePackage(destination) {
  const electronVersion = String(pkg.devDependencies?.electron || '').replace(/^[~^]/, '');
  if (!electronVersion) throw new Error('Electron version is missing from desktop/package.json');
  const runtimePackage = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    main: pkg.main,
    private: true,
    scripts: {
      start: 'node scripts/start-electron.js'
    },
    dependencies: {
      electron: electronVersion
    }
  };
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(runtimePackage, null, 2) + '\n', 'utf8');
}

function writeGuide(destination) {
  const guide = `Prompt Studio Desktop ${version} - 纯净源码包

本包包含：
- desktop/：桌面端运行源码
- extension/：Chrome / Edge 浏览器插件
- skills/：本项目配套 Agent Skills

本包不包含：
- node_modules、Electron 可执行文件、Python 环境
- Windows 构建产物和打包工具
- 用户项目、上传素材、监控目录、API Key、缓存和日志

Windows 运行：
1. 安装 Node.js 18+ 与 Python 3.10+。
2. 双击 dev-start.bat。
3. 首次启动会执行 npm install，只安装运行所需的 Electron。

浏览器插件：
打开 chrome://extensions 或 edge://extensions，开启开发者模式，
选择“加载已解压的扩展程序”，然后选择 extension 目录。

Skills：
skills/prompt-studio 是本源码包自己的配套版本，不会修改本机全局 Skills。
`;
  fs.writeFileSync(destination, guide, 'utf8');
}

function copyFile(source, destination) {
  if (!fs.existsSync(source)) throw new Error(`Required source file is missing: ${source}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function copyDir(source, destination, skipNames) {
  if (!fs.existsSync(source)) throw new Error(`Required source directory is missing: ${source}`);
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (skipNames.has(entry.name)) continue;
    if (/\.(?:bak|log|pyc|tmp)$/i.test(entry.name)) continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDir(sourcePath, destinationPath, skipNames);
    else if (entry.isFile()) copyFile(sourcePath, destinationPath);
  }
}

function auditStage(stage) {
  const files = collectFiles(stage);
  const normalizedFiles = new Set(files.map(file => file.replace(/\\/g, '/')));
  for (const required of REQUIRED_FILES) {
    if (!normalizedFiles.has(required)) throw new Error(`Clean-source package is missing: ${required}`);
  }

  const forbiddenSegments = new Set([
    '.git', '__pycache__', 'dist', 'node_modules', 'server-build',
    'server-dist', 'studio-data', 'uploads', 'snapshots', 'exports'
  ]);
  const forbiddenNames = new Set([
    '.env', 'data.json', 'desktop_settings.json', 'studio-config.json'
  ]);
  for (const relativePath of normalizedFiles) {
    const segments = relativePath.split('/');
    if (segments.some(segment => forbiddenSegments.has(segment))) {
      throw new Error(`Forbidden directory leaked into clean source: ${relativePath}`);
    }
    if (segments.some(segment => forbiddenNames.has(segment))) {
      throw new Error(`Runtime data/config leaked into clean source: ${relativePath}`);
    }
    if (segments.some(segment => /\.(?:bak|log|pyc|tmp)$/i.test(segment))) {
      throw new Error(`Temporary file leaked into clean source: ${relativePath}`);
    }
  }

  const configPath = path.join(stage, 'desktop', 'asset-browser', 'asset-browser.config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!Array.isArray(config.projects) || config.projects.length !== 0) {
    throw new Error('Asset Browser default config must not contain monitored directories');
  }

  const sourceBytes = files.reduce((total, relativePath) => {
    return total + fs.statSync(path.join(stage, relativePath)).size;
  }, 0);
  return {
    fileCount: files.length,
    sourceSizeMB: (sourceBytes / 1024 / 1024).toFixed(1)
  };
}

function collectFiles(directory, base = directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(fullPath, base));
    else if (entry.isFile()) files.push(path.relative(base, fullPath));
  }
  return files;
}

function createZip(stage, destination) {
  try {
    execFileSync('tar.exe', ['-a', '-c', '-f', destination, '-C', stage, '.'], { stdio: 'inherit' });
    return;
  } catch (tarError) {
    console.warn(`tar.exe failed, falling back to Compress-Archive: ${tarError.message}`);
  }

  const quote = value => `'${String(value).replace(/'/g, "''")}'`;
  const command = `Compress-Archive -Force -Path ${quote(path.join(stage, '*'))} -DestinationPath ${quote(destination)}`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'inherit' });
}
