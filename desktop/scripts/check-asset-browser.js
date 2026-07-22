const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-browser-check-'));
const configPath = path.join(tempDir, 'config.json');
const port = 5197;
const samplePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

const studioHtml = fs.readFileSync(path.join(__dirname, '..', 'studio', 'index.html'), 'utf8');
const assetApp = fs.readFileSync(path.join(__dirname, '..', 'asset-browser', 'public', 'app.js'), 'utf8');
const assetServer = fs.readFileSync(path.join(__dirname, '..', 'asset-browser', 'server.js'), 'utf8');
const desktopMain = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const desktopPreload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
assert.match(
  studioHtml,
  /querySelectorAll\('\.nav-folder-item\[data-folder-id\]\[data-folder-view\]'\)/,
  'regular folder handlers must not bind to asset-browser directory nodes'
);
assert.match(studioHtml, /data-asset-folder-toggle/, 'asset-browser parent directories must provide independent collapse controls');
assert.match(studioHtml, /assetBrowserExpandedCases/, 'asset-browser directory expansion state must survive sidebar rerenders');
assert.match(studioHtml, /id="assetBrowserHost"/, 'asset browser must have a persistent iframe host');
assert.match(studioHtml, /function ensureAssetBrowserFrame\(\)/, 'asset browser iframe must be created once and reused');
assert.doesNotMatch(
  studioHtml,
  /mainGrid['"]?\)\.innerHTML\s*=\s*`<iframe[^>]+asset-browser-frame/,
  'asset browser navigation must not rebuild the iframe through mainGrid.innerHTML'
);
assert.match(assetApp, /selectedAssetIds:\s*new Set\(\)/, 'asset cards must keep a dedicated multi-selection state');
assert.match(assetApp, /function wireMarqueeSelection\(\)/, 'asset cards must support mouse marquee selection');
assert.match(assetApp, /function importDroppedFiles\(/, 'asset grid must accept dropped local files');
assert.match(assetServer, /url\.pathname === "\/api\/import"/, 'asset server must expose a streaming import route');
assert.match(desktopMain, /nodeIntegrationInSubFrames:\s*true/, 'trusted asset iframe must load the restricted preload bridge');
assert.match(desktopPreload, /assetBrowserDesktop/, 'asset iframe must expose the native local-file drag bridge');

fs.writeFileSync(path.join(tempDir, 'sample.png'), samplePng);
fs.mkdirSync(path.join(tempDir, 'Characters', 'Hero'), { recursive: true });
fs.writeFileSync(path.join(tempDir, 'Characters', 'character.png'), samplePng);
fs.writeFileSync(path.join(tempDir, 'Characters', 'Hero', 'hero.png'), samplePng);
fs.writeFileSync(configPath, JSON.stringify({
  enabled: true,
  projects: [{
    id: 'root-folder',
    name: 'Root Folder',
    path: tempDir,
    scanRoots: ['02-cases']
  }]
}));

const server = spawn(process.execPath, ['asset-browser/server.js'], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, PORT: String(port), ASSET_BROWSER_CONFIG_PATH: configPath },
  stdio: 'ignore'
});
let browser;

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/projects`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Asset browser test server did not start');
}

function openEventStream() {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let assetEvents = 0;
    let connected = false;
    const request = http.get(`http://127.0.0.1:${port}/api/events`, (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        buffer += chunk;
        const messages = buffer.split('\n\n');
        buffer = messages.pop() || '';
        for (const message of messages) {
          if (message.includes('event: asset-change')) assetEvents += 1;
          if (!connected && message.includes('event: connected')) {
            connected = true;
            resolve({ request, count: () => assetEvents });
          }
        }
      });
    });
    request.on('error', reject);
  });
}

async function waitForEvent(stream) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (stream.count() > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('New media file did not trigger an asset-change event');
}

(async () => {
  try {
    await waitForServer();
    const projectList = await fetch(`http://127.0.0.1:${port}/api/projects`).then((response) => response.json());
    assert.equal(projectList.projects[0]?.assetCount, 3, 'project overview must include the monitored asset count');
    assert.equal(projectList.projects[0]?.typeCounts?.image, 3, 'project overview must include media type counts');
    assert.equal(projectList.projects[0]?.previewUrls?.length, 3, 'project overview must include real image previews');
    const cases = await fetch(`http://127.0.0.1:${port}/api/cases?project=root-folder`).then((response) => response.json());
    assert.equal(cases.cases[0]?.id, '.', 'selected folder root must be a valid case');
    assert.deepEqual(
      cases.cases.map((item) => ({ id: item.id, parentId: item.parentId, depth: item.depth, assetCount: item.assetCount })),
      [
        { id: '.', parentId: '', depth: 0, assetCount: 3 },
        { id: 'Characters', parentId: '.', depth: 1, assetCount: 2 },
        { id: path.join('Characters', 'Hero'), parentId: 'Characters', depth: 2, assetCount: 1 }
      ],
      'nested media folders must be returned as a recursive tree'
    );
    const assets = await fetch(`http://127.0.0.1:${port}/api/assets?project=root-folder&case=.`).then((response) => response.json());
    assert.equal(assets.assets.length, 3, 'project root must include media from nested folders');
    const nestedAssets = await fetch(`http://127.0.0.1:${port}/api/assets?project=root-folder&case=${encodeURIComponent('Characters')}`).then((response) => response.json());
    assert.equal(nestedAssets.assets.length, 2, 'parent folder must include media from its descendants');
    const heroAssets = await fetch(`http://127.0.0.1:${port}/api/assets?project=root-folder&case=${encodeURIComponent(path.join('Characters', 'Hero'))}`).then((response) => response.json());
    assert.equal(heroAssets.assets.length, 1, 'leaf folder must only include its own media');

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.addInitScript(() => {
      window.assetBrowserDesktop = {
        startLocalFileDrag(paths) {
          window.__nativeDragPaths = paths;
        }
      };
    });
    await page.goto(`http://127.0.0.1:${port}/?embedded=1`);
    await page.waitForSelector('.project-cover-grid img', { state: 'attached' });
    assert.equal(await page.locator('.project-cover-grid img').count(), 3, 'project cards must render the available image previews');
    assert.equal(await page.locator('.project-cover-count').textContent(), '3 个资源', 'project cards must render the asset count');
    await page.locator('.project-card').click();
    await page.waitForSelector('#caseSelect option', { state: 'attached' });
    await page.waitForFunction(() => document.querySelector('#typeSelect')?.value === 'image');
    assert.equal(await page.locator('#typeSelect').inputValue(), 'image', 'opening a project must select its first populated asset type');
    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/assets') && response.url().includes('case=Characters')),
      page.evaluate(() => {
        const button = [...document.querySelectorAll('#caseList button')]
          .find((item) => item.querySelector('span')?.textContent === 'Characters');
        button?.click();
      })
    ]);
    await page.waitForFunction(() => document.querySelectorAll('.asset-card').length === 2);
    assert.equal(await page.locator('#caseSelect').inputValue(), 'Characters', 'clicking a directory must select that directory');
    assert.equal(await page.locator('#typeSelect').inputValue(), '', 'clicking a directory must show all resources in that directory');
    assert.equal(await page.locator('.asset-card').count(), 2, 'clicking a directory must render resources from that directory and its descendants');

    await page.locator('.asset-card').nth(0).click();
    await page.locator('.asset-card').nth(1).click({ modifiers: ['Control'] });
    assert.equal(await page.locator('.asset-card.selected').count(), 2, 'Ctrl+click must add a second card to the selection');
    assert.equal(await page.locator('#detailName').textContent(), '已选择 2 项', 'multi-selection count must be visible in the inspector');
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await page.locator('.asset-card').nth(0).dispatchEvent('dragstart', { dataTransfer });
    const nativeDragPaths = await page.evaluate(() => window.__nativeDragPaths);
    assert.equal(nativeDragPaths.length, 2, 'dragging a selected card must start one native drag with all selected files');
    assert.ok(nativeDragPaths.every((item) => path.isAbsolute(item)), 'native drag payload must contain absolute local paths');

    await page.locator('#closeDetail').click();
    await page.locator('.asset-card').nth(0).click();
    await page.locator('.asset-card').nth(1).click({ modifiers: ['Shift'] });
    assert.equal(await page.locator('.asset-card.selected').count(), 2, 'Shift+click must select a contiguous card range');

    await page.locator('#closeDetail').click();
    const gridBox = await page.locator('#assetGrid').boundingBox();
    const firstCardBox = await page.locator('.asset-card').first().boundingBox();
    await page.mouse.move(gridBox.x + gridBox.width - 4, gridBox.y + gridBox.height - 4);
    await page.mouse.down();
    await page.mouse.move(firstCardBox.x + 3, firstCardBox.y + 3, { steps: 10 });
    await page.mouse.up();
    assert.equal(await page.locator('.asset-card.selected').count(), 2, 'dragging a marquee across cards must select both cards');

    await page.evaluate(() => {
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), (char) => char.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'ui-dropped.png', { type: 'image/png' }));
      const grid = document.querySelector('#assetGrid');
      grid.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: transfer }));
      grid.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
    });
    await page.waitForFunction(() => [...document.querySelectorAll('.card-title')].some((item) => item.textContent === 'ui-dropped.png'));
    assert.equal(fs.existsSync(path.join(tempDir, 'Characters', 'ui-dropped.png')), true, 'dropping through the grid UI must write the file to the selected directory');
    assert.equal(await page.locator('.asset-card.selected .card-title').textContent(), 'ui-dropped.png', 'newly dropped files must become the active selection');
    await browser.close();
    browser = null;

    const importUrl = `http://127.0.0.1:${port}/api/import?project=root-folder&case=${encodeURIComponent('Characters')}&name=${encodeURIComponent('dropped.png')}`;
    const firstImport = await fetch(importUrl, { method: 'POST', body: samplePng }).then(async (response) => ({ status: response.status, body: await response.json() }));
    assert.equal(firstImport.status, 201, 'dropping a supported media file must create it in the selected directory');
    assert.equal(firstImport.body.imported.caseRelPath, 'dropped.png', 'import response must identify the new case-relative file');
    assert.deepEqual(await fs.promises.readFile(path.join(tempDir, 'Characters', 'dropped.png')), samplePng, 'imported file bytes must be preserved');
    const duplicateImport = await fetch(importUrl, { method: 'POST', body: samplePng }).then((response) => response.json());
    assert.equal(duplicateImport.imported.caseRelPath, 'dropped (2).png', 'duplicate imports must not overwrite the existing file');
    assert.equal(fs.existsSync(path.join(tempDir, 'Characters', 'dropped (2).png')), true, 'duplicate import must be written with a numbered name');
    const rejectedImport = await fetch(`http://127.0.0.1:${port}/api/import?project=root-folder&case=Characters&name=notes.txt`, { method: 'POST', body: 'not-media' });
    assert.equal(rejectedImport.status, 415, 'non-media drops must be rejected');
    assert.equal(fs.existsSync(path.join(tempDir, 'Characters', 'notes.txt')), false, 'rejected drops must not create files');

    await new Promise((resolve) => setTimeout(resolve, 1500));
    const events = await openEventStream();
    fs.appendFileSync(path.join(tempDir, 'sample.png'), '-modified');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(events.count(), 0, 'modifying an existing media file must not trigger a refresh');
    fs.mkdirSync(path.join(tempDir, 'NewGroup', 'Sub'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'NewGroup', 'Sub', 'new.png'), 'new-asset');
    await waitForEvent(events);
    assert.equal(events.count(), 1, 'a new media file must trigger one refresh event');
    const updatedCases = await fetch(`http://127.0.0.1:${port}/api/cases?project=root-folder`).then((response) => response.json());
    assert.ok(updatedCases.cases.some((item) => item.id === path.join('NewGroup', 'Sub')), 'a newly populated nested folder must appear in the directory tree');
    events.request.destroy();
    const removed = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'root-folder' })
    }).then((response) => response.json());
    assert.equal(removed.ok, true, 'cancel monitoring must succeed');
    const remainingProjects = await fetch(`http://127.0.0.1:${port}/api/projects`).then((response) => response.json());
    assert.equal(remainingProjects.projects.length, 0, 'cancelled project must be removed from configuration');
    assert.equal(fs.existsSync(path.join(tempDir, 'sample.png')), true, 'cancel monitoring must keep root media files');
    assert.equal(fs.existsSync(path.join(tempDir, 'Characters', 'Hero', 'hero.png')), true, 'cancel monitoring must keep nested media files');
    assert.equal(fs.existsSync(path.join(tempDir, 'NewGroup', 'Sub', 'new.png')), true, 'cancel monitoring must keep newly detected files');
    console.log('Asset browser selection, drag-in/out, scan, new-file event, and cancel-monitoring checks passed.');
  } finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
