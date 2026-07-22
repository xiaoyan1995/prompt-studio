/**
 * Post-build script for Windows.
 * Creates a portable distribution zip with 3 sibling folders:
 *   desktop/                 <- the Electron app and bundled backend
 *   extension/               <- browser extension
 *   skills/                  <- project-local agent skills
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DESKTOP = path.resolve(__dirname, '..');
const DIST = path.join(DESKTOP, 'dist');
const UNPACKED = path.join(DIST, 'win-unpacked');

const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'));
const version = pkg.version;
const appName = pkg.build?.productName || 'Prompt Studio Desktop';
const zipName = `${appName}-${version}-portable-win.zip`;
const zipOut = path.join(DIST, zipName);

// Stage dir
const STAGE = path.join(DIST, `_stage-${process.pid}`);
if (fs.existsSync(STAGE)) fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

console.log(`Copying app...`);
const desktopStage = path.join(STAGE, 'desktop');
copyDir(UNPACKED, desktopStage);

// electron-builder can leave a previous product-name executable in win-unpacked.
// Keep only the current app executable at the desktop root.
const appExecutable = `${appName}.exe`;
for (const entry of fs.readdirSync(desktopStage, { withFileTypes: true })) {
  if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.exe' && entry.name !== appExecutable) {
    fs.rmSync(path.join(desktopStage, entry.name), { force: true });
  }
}
const rootExecutables = fs.readdirSync(desktopStage, { withFileTypes: true })
  .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.exe')
  .map((entry) => entry.name);
if (rootExecutables.length !== 1 || rootExecutables[0] !== appExecutable) {
  throw new Error(`Desktop root must contain only ${appExecutable}; got ${rootExecutables.join(', ')}`);
}

// Mark the portable data directory as initialized so first launch goes straight
// to the app instead of opening the legacy-data migration dialog.
const portableDataDir = path.join(STAGE, 'desktop', 'studio-data');
fs.mkdirSync(portableDataDir, { recursive: true });
fs.writeFileSync(path.join(portableDataDir, '.prompt-studio-data'), '1', 'utf8');

// 2. Copy extension/
const extSrc = path.join(ROOT, 'extension');
if (fs.existsSync(extSrc)) {
  console.log('Copying extension...');
  copyDir(extSrc, path.join(STAGE, 'extension'));
} else {
  console.warn('extension/ not found, skipping');
}

// 3. Copy skills/
const skillsSrc = path.join(ROOT, 'skills');
if (fs.existsSync(skillsSrc)) {
  console.log('Copying skills...');
  copyDir(skillsSrc, path.join(STAGE, 'skills'));
} else {
  console.warn('skills/ not found, skipping');
}

assertPortableLayout(STAGE);

// 4. Zip the stage dir (replace old zip)
if (fs.existsSync(zipOut)) fs.rmSync(zipOut);
console.log(`Creating ${zipName}...`);
try {
  // Use PowerShell Compress-Archive (Windows)
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Force -Path '${STAGE}\\*' -DestinationPath '${zipOut}'"`,
    { stdio: 'inherit' }
  );
} catch {
  // Fallback: 7z if available
  execSync(`7z a -tzip "${zipOut}" "${STAGE}\\*"`, { stdio: 'inherit', cwd: STAGE });
}

// 5. Cleanup stage
fs.rmSync(STAGE, { recursive: true });

const sizeMB = (fs.statSync(zipOut).size / 1024 / 1024).toFixed(1);
console.log(`\nDone! ${zipName} (${sizeMB} MB)`);
console.log(`Path: ${zipOut}`);

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function assertPortableLayout(stage) {
  const topLevel = fs.readdirSync(stage, { withFileTypes: true });
  const expected = new Set(['desktop', 'extension', 'skills']);
  const actual = new Set(topLevel.map((entry) => entry.name));
  if (topLevel.some((entry) => !entry.isDirectory()) || actual.size !== expected.size) {
    throw new Error(`Portable package top-level must contain only desktop, extension, skills; got ${[...actual].join(', ')}`);
  }
  for (const name of expected) {
    if (!actual.has(name)) throw new Error(`Portable package folder is missing: ${name}`);
  }

  const required = [
    path.join(stage, 'desktop', `${appName}.exe`),
    path.join(stage, 'desktop', 'resources', 'app.asar'),
    path.join(stage, 'desktop', 'resources', 'server', 'prompt-studio-server.exe'),
    path.join(stage, 'extension', 'manifest.json'),
    path.join(stage, 'skills', 'prompt-studio', 'SKILL.md'),
    path.join(stage, 'skills', 'prompt-studio', 'REFERENCE.md')
  ];
  for (const file of required) {
    if (!fs.existsSync(file)) throw new Error(`Portable package file is missing: ${path.relative(stage, file)}`);
  }
}
