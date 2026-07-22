const DEFAULTS = {
  serverUrl: 'http://127.0.0.1:8768',
  domainBlacklist: '',
  promptInsertWhitelist: ''
};

chrome.storage.sync.get(DEFAULTS, (settings) => {
  document.getElementById('serverUrl').value = settings.serverUrl || DEFAULTS.serverUrl;
  document.getElementById('domainBlacklist').value = settings.domainBlacklist || '';
  document.getElementById('promptInsertWhitelist').value = settings.promptInsertWhitelist || '';
});

document.getElementById('saveBtn').addEventListener('click', () => {
  const settings = {
    serverUrl: document.getElementById('serverUrl').value.trim().replace(/\/$/, '') || DEFAULTS.serverUrl,
    domainBlacklist: document.getElementById('domainBlacklist').value.trim(),
    promptInsertWhitelist: document.getElementById('promptInsertWhitelist').value.trim()
  };
  chrome.storage.sync.set(settings, () => showStatus(dt('saved'), 'ok'));
});

document.getElementById('testBtn').addEventListener('click', async () => {
  const url = document.getElementById('serverUrl').value.trim().replace(/\/$/, '') || DEFAULTS.serverUrl;
  showStatus(dt('connecting'), '');
  try {
    const [projectsRes, settingsRes] = await Promise.all([
      fetch(`${url}/api/projects`, { signal: AbortSignal.timeout(5000) }),
      fetch(`${url}/api/desktop/settings`, { signal: AbortSignal.timeout(5000) })
    ]);
    if (!projectsRes.ok || !settingsRes.ok) throw new Error(dt('api_error'));
    const projects = await projectsRes.json();
    showStatus(dt('connect_ok', projects.length), 'ok');
  } catch (error) {
    showStatus(dt('connect_fail', error.message), 'err');
  }
});

document.getElementById('openDesktopBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'promptstudio-desktop://start' }, (tab) => {
    setTimeout(() => {
      if (tab?.id) chrome.tabs.remove(tab.id).catch(() => {});
    }, 1500);
  });
});

function showStatus(message, cls) {
  const el = document.getElementById('statusMsg');
  el.textContent = message;
  el.className = `status ${cls}`;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.domainBlacklist) {
    document.getElementById('domainBlacklist').value = changes.domainBlacklist.newValue || '';
  }
});
