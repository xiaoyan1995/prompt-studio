const form = document.querySelector('#feedbackForm');
const fileInput = document.querySelector('#fileInput');
const dropzone = document.querySelector('#dropzone');
const attachmentList = document.querySelector('#attachmentList');
const errorBox = document.querySelector('#formError');
const draftStatus = document.querySelector('#draftStatus');
const submitButton = document.querySelector('#submitButton');
const successPanel = document.querySelector('#successPanel');
const DRAFT_KEY = 'prompt-studio-feedback-draft-v1';
const MAX_FILES = 5;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
let attachments = [];

function detectOS() {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Mac OS X/i.test(ua)) return 'macOS';
  if (/Android/i.test(ua)) return 'Android';
  if (/iPhone|iPad/i.test(ua)) return 'iOS';
  return '其他';
}

function detectBrowser() {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return 'Microsoft Edge';
  if (/Chrome\//.test(ua)) return 'Google Chrome';
  if (/Firefox\//.test(ua)) return 'Mozilla Firefox';
  if (/Safari\//.test(ua)) return 'Safari';
  return '其他浏览器';
}

function applyTheme(value) {
  document.documentElement.dataset.theme = value;
  localStorage.setItem('prompt-studio-feedback-theme', value);
}

function loadTheme() {
  const value = localStorage.getItem('prompt-studio-feedback-theme') || 'system';
  document.querySelector('#themeSelect').value = value;
  applyTheme(value);
}

function showError(message) { errorBox.textContent = message; errorBox.hidden = !message; errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' }); }

function updateCounter() {
  const field = form.elements.description;
  document.querySelector('[data-for="description"]').textContent = `${field.value.length} / 20000`;
}

function renderAttachments() {
  attachmentList.replaceChildren();
  for (const [index, item] of attachments.entries()) {
    const li = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = `${item.name} · ${Math.ceil(item.size / 1024)} KB`;
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'remove-file'; remove.textContent = '移除'; remove.title = `移除 ${item.name}`;
    remove.addEventListener('click', () => { attachments.splice(index, 1); renderAttachments(); });
    li.append(text, remove); attachmentList.append(li);
  }
}

function addFiles(files) {
  const incoming = Array.from(files);
  for (const file of incoming) {
    if (attachments.length >= MAX_FILES) { showError('最多上传 5 个附件'); break; }
    if (file.size > MAX_FILE_BYTES) { showError(`${file.name} 超过 8 MB 限制`); continue; }
    if (!file.type.startsWith('image/') && !file.type.startsWith('video/') && !['text/plain', 'application/json', 'application/pdf'].includes(file.type) && !/\.(log|txt|md)$/i.test(file.name)) { showError(`${file.name} 类型不支持`); continue; }
    attachments.push(file);
  }
  renderAttachments();
}

function fileToData(file) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve({ name: file.name, type: file.type, size: file.size, data: reader.result }); reader.onerror = reject; reader.readAsDataURL(file); });
}

function saveDraft() {
  const data = Object.fromEntries(new FormData(form).entries());
  delete data.consent; localStorage.setItem(DRAFT_KEY, JSON.stringify(data)); draftStatus.textContent = `草稿已保存 ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function restoreDraft() {
  try {
    const data = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}');
    for (const [key, value] of Object.entries(data)) if (form.elements[key]) form.elements[key].value = value;
  } catch { localStorage.removeItem(DRAFT_KEY); }
}

form.addEventListener('input', () => { updateCounter(); saveDraft(); });
document.querySelector('#chooseFiles').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
['dragenter', 'dragover'].forEach((eventName) => dropzone.addEventListener(eventName, (event) => { event.preventDefault(); dropzone.classList.add('is-dragging'); }));
['dragleave', 'drop'].forEach((eventName) => dropzone.addEventListener(eventName, (event) => { event.preventDefault(); dropzone.classList.remove('is-dragging'); }));
dropzone.addEventListener('drop', (event) => addFiles(event.dataTransfer.files));
dropzone.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInput.click(); } });
dropzone.addEventListener('click', (event) => { if (event.target !== fileInput && event.target.id !== 'chooseFiles') fileInput.click(); });
document.querySelector('#themeSelect').addEventListener('change', (event) => applyTheme(event.target.value));

form.addEventListener('submit', async (event) => {
  event.preventDefault(); showError('');
  if (!form.reportValidity()) return;
  const totalBytes = attachments.reduce((total, file) => total + file.size, 0);
  if (totalBytes > 24 * 1024 * 1024) return showError('附件总大小不能超过 24 MB');
  submitButton.disabled = true; submitButton.textContent = '提交中…';
  try {
    const values = Object.fromEntries(new FormData(form).entries());
    const encoded = await Promise.all(attachments.map(fileToData));
    const response = await fetch('/api/issues', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...values, attachments: encoded }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '提交失败');
    document.querySelector('#issueId').textContent = result.id; successPanel.hidden = false; form.hidden = true; document.querySelector('.side-rail').hidden = true; localStorage.removeItem(DRAFT_KEY); successPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { showError(error.message || '提交失败，请稍后重试'); }
  finally { submitButton.disabled = false; submitButton.textContent = '提交反馈'; }
});

document.querySelector('#copyIssueId').addEventListener('click', async () => { await navigator.clipboard.writeText(document.querySelector('#issueId').textContent); document.querySelector('#copyIssueId').textContent = '已复制'; });
document.querySelector('#newFeedback').addEventListener('click', () => { form.reset(); form.elements.version.value = '1.2.2'; form.elements.os.value = detectOS(); form.elements.browser.value = detectBrowser(); attachments = []; renderAttachments(); form.hidden = false; document.querySelector('.side-rail').hidden = false; successPanel.hidden = true; updateCounter(); window.scrollTo({ top: 0, behavior: 'smooth' }); });

loadTheme(); restoreDraft(); document.querySelector('#osField').value ||= detectOS(); document.querySelector('#browserField').value ||= detectBrowser(); updateCounter(); renderAttachments();
