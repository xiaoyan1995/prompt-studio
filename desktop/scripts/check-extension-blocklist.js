const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');
const extensionDir = path.join(root, 'extension');
const backgroundSource = fs.readFileSync(path.join(extensionDir, 'background.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(extensionDir, 'content.js'), 'utf8');

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    },
  };
}

function createHarness(tabs) {
  const storageGets = [];
  const removedLocalKeys = [];
  const openedWindows = [];
  const events = {
    storageChanged: createEvent(),
    responseStarted: createEvent(),
    sendHeaders: createEvent(),
    runtimeMessage: createEvent(),
  };
  const passiveEvent = () => createEvent();

  const chrome = {
    action: {
      setBadgeText(_details, callback) {
        if (callback) callback();
      },
    },
    commands: { onCommand: passiveEvent() },
    contextMenus: {
      create() {},
      removeAll(callback) {
        if (callback) callback();
      },
      onClicked: passiveEvent(),
    },
    declarativeNetRequest: {
      updateSessionRules() {
        return Promise.resolve();
      },
    },
    downloads: { download() {} },
    notifications: { create() {} },
    runtime: {
      lastError: null,
      getURL(value) {
        return `chrome-extension://test/${value}`;
      },
      onInstalled: passiveEvent(),
      onMessage: events.runtimeMessage,
    },
    storage: {
      sync: {
        get(_defaults, callback) {
          storageGets.push(callback);
        },
      },
      local: {
        get(defaults, callback) {
          callback(defaults);
        },
        set(_values, callback) {
          if (callback) callback();
        },
        remove(key, callback) {
          removedLocalKeys.push(key);
          if (callback) callback();
        },
      },
      onChanged: events.storageChanged,
    },
    tabs: {
      query(_query, callback) {
        callback(tabs);
      },
      sendMessage() {},
      onRemoved: passiveEvent(),
    },
    webNavigation: {
      onCommitted: passiveEvent(),
      onHistoryStateUpdated: passiveEvent(),
    },
    webRequest: {
      onResponseStarted: events.responseStarted,
      onSendHeaders: events.sendHeaders,
    },
    windows: {
      create(details, callback) {
        openedWindows.push(details);
        if (callback) callback();
      },
    },
  };

  let timerId = 0;
  const context = vm.createContext({
    AbortController,
    AbortSignal,
    DataView,
    Map,
    TextDecoder,
    Uint8Array,
    URL,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    chrome,
    clearTimeout() {},
    console,
    fetch: global.fetch,
    setTimeout() {
      timerId += 1;
      return timerId;
    },
  });
  new vm.Script(backgroundSource, { filename: 'extension/background.js' }).runInContext(context);

  function evaluate(expression) {
    return vm.runInContext(expression, context);
  }

  function capture(details) {
    assert.strictEqual(events.responseStarted.listeners.length, 1);
    events.responseStarted.listeners[0](details);
  }

  return {
    captureImage(tabId, requestId) {
      capture({
        tabId,
        requestId,
        url: `https://cdn.example.test/${requestId}.jpg`,
        initiator: 'https://blocked.example',
        responseHeaders: [
          { name: 'content-type', value: 'image/jpeg' },
          { name: 'content-length', value: '4096' },
        ],
      });
    },
    captureMedia(tabId, requestId) {
      capture({
        tabId,
        requestId,
        url: `https://cdn.example.test/${requestId}.mp4`,
        initiator: 'https://blocked.example',
        responseHeaders: [
          { name: 'content-type', value: 'video/mp4' },
          { name: 'content-length', value: '8192' },
        ],
      });
    },
    captureRequestHeaders(tabId, requestId) {
      assert.strictEqual(events.sendHeaders.listeners.length, 1);
      events.sendHeaders.listeners[0]({
        tabId,
        requestId,
        initiator: 'https://blocked.example',
        requestHeaders: [
          { name: 'referer', value: 'https://blocked.example/page' },
          { name: 'cookie', value: 'session=test-secret' },
        ],
      });
    },
    changeBlocklist(value) {
      assert.strictEqual(events.storageChanged.listeners.length, 1);
      events.storageChanged.listeners[0]({
        domainBlacklist: { newValue: value },
      }, 'sync');
    },
    sendRuntimeMessage(message, sender = {}) {
      assert.strictEqual(events.runtimeMessage.listeners.length, 1);
      let response;
      events.runtimeMessage.listeners[0](message, sender, value => { response = value; });
      return response;
    },
    resolveInitialBlocklist(value) {
      assert.ok(storageGets.length > 0, 'background must request the persisted blocklist');
      storageGets.shift()({ domainBlacklist: value });
    },
    imageCount(tabId) {
      return evaluate(`(imagesByTab.get(${tabId}) || []).length`);
    },
    mediaCount(tabId) {
      return evaluate(`(mediaByTab.get(${tabId}) || []).length`);
    },
    requestInfoCount() {
      return evaluate('refererByRequest.size');
    },
    isReady() {
      return evaluate('blockedRulesReady');
    },
    removedLocalKeys,
    openedWindows,
  };
}

const startupAction = createHarness([{ id: 6, url: 'https://allowed.example/page' }]);
startupAction.sendRuntimeMessage({
  type: 'open-dialog',
  mediaUrl: 'https://allowed.example/image.jpg',
  mediaType: 'image',
  mode: 'save',
  pageUrl: 'https://allowed.example/page',
}, { tab: { id: 6, url: 'https://allowed.example/page', title: 'Allowed page' } });
assert.strictEqual(startupAction.openedWindows.length, 1, 'an allowed save action must not be dropped while the background blocklist is loading');

const restarted = createHarness([{ id: 7, url: 'https://blocked.example/page' }]);
restarted.captureRequestHeaders(7, 'headers-before-load');
restarted.captureImage(7, 'image-before-load');
restarted.captureMedia(7, 'media-before-load');
assert.strictEqual(restarted.imageCount(7), 0, 'images must not be captured before persisted rules load');
assert.strictEqual(restarted.mediaCount(7), 0, 'media must not be captured before persisted rules load');
assert.strictEqual(restarted.requestInfoCount(), 0, 'request credentials must not be cached before persisted rules load');
restarted.resolveInitialBlocklist('blocked.example');
assert.strictEqual(restarted.isReady(), true, 'persisted rules must mark blocklist initialization complete');
restarted.captureImage(7, 'image-after-restart');
restarted.captureMedia(7, 'media-after-restart');
assert.strictEqual(restarted.imageCount(7), 0, 'persisted blocked tab must stay ignored after browser restart');
assert.strictEqual(restarted.mediaCount(7), 0, 'persisted blocked tab media must stay ignored after browser restart');

const changed = createHarness([{ id: 8, url: 'https://blocked.example/page' }]);
changed.resolveInitialBlocklist('');
changed.captureImage(8, 'image-before-change');
changed.captureMedia(8, 'media-before-change');
changed.captureRequestHeaders(8, 'headers-before-change');
assert.strictEqual(changed.imageCount(8), 1, 'unblocked tab should capture images normally');
assert.strictEqual(changed.mediaCount(8), 1, 'unblocked tab should capture media normally');
assert.strictEqual(changed.requestInfoCount(), 1, 'unblocked request metadata should be available for media resolution');
changed.changeBlocklist('blocked.example');
assert.strictEqual(changed.imageCount(8), 0, 'blocking a tab must purge captured images');
assert.strictEqual(changed.mediaCount(8), 0, 'blocking a tab must purge captured media');
assert.strictEqual(changed.requestInfoCount(), 0, 'blocking a tab must purge pending request metadata');
assert.ok(changed.removedLocalKeys.includes('psc_media_8'), 'blocking a tab must purge persisted media cache');
changed.captureImage(8, 'image-after-change');
changed.captureMedia(8, 'media-after-change');
assert.strictEqual(changed.imageCount(8), 0, 'new images must remain blocked after the setting changes');
assert.strictEqual(changed.mediaCount(8), 0, 'new media must remain blocked after the setting changes');

const changedDuringLoad = createHarness([{ id: 9, url: 'https://blocked.example/page' }]);
changedDuringLoad.changeBlocklist('blocked.example');
changedDuringLoad.resolveInitialBlocklist('');
changedDuringLoad.captureImage(9, 'image-after-stale-load');
assert.strictEqual(changedDuringLoad.imageCount(9), 0, 'a stale initial read must not overwrite a newer blocklist change');

assert.match(contentSource, /let blockedDomainsReady = false;/, 'content script must start with recognition disabled');
assert.match(contentSource, /return blockedDomainsReady && !isHostBlocked\(\);/, 'content script must wait for blocklist initialization');
assert.match(contentSource, /sendResponse\(\{ images: isRecognitionEnabled\(\) \? scanPageImages\(\) : \[\] \}\)/, 'page scans must return no images while blocked or uninitialized');

const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
assert.strictEqual(manifest.name, 'Prompt Studio Desktop Companion');
assert.strictEqual(manifest.action.default_title, 'Prompt Studio Desktop');

console.log('Extension blocklist restart, cache purge, and product-name checks passed.');
