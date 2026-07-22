const tokenKey = 'prompt-studio-feedback-admin-token';
const loginPanel = document.querySelector('#loginPanel');
const adminPanel = document.querySelector('#adminPanel');
const loginError = document.querySelector('#loginError');
const list = document.querySelector('#issueList');
const detail = document.querySelector('#issueDetail');
let token = localStorage.getItem(tokenKey) || '';
let issues = [];
let selectedId = '';

const labels = { new: '新反馈', triaged: '已分诊', in_progress: '处理中', resolved: '已解决', closed: '已关闭' };
const typeLabels = { bug: '问题 / Bug', suggestion: '功能建议', question: '使用咨询', other: '其他' };
const severityLabels = { low: '一般', medium: '影响使用', high: '严重阻塞', critical: '无法启动 / 数据风险' };

function applyTheme(value) { document.documentElement.dataset.theme = value; localStorage.setItem('prompt-studio-feedback-theme', value); }
function loadTheme() { const value = localStorage.getItem('prompt-studio-feedback-theme') || 'system'; document.querySelector('#themeSelect').value = value; applyTheme(value); }
function setLoginError(message) { loginError.textContent = message; loginError.hidden = !message; }
async function api(url, options = {}) { const response = await fetch(url, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` } }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`); return data; }
function formatDate(value) { return new Date(value).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }); }
function escapeText(value) { return String(value ?? ''); }
function escapeHtml(value) { return escapeText(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }

function renderStats() {
  const values = [issues.length, issues.filter((item) => item.status === 'new').length, issues.filter((item) => item.status === 'in_progress' || item.status === 'triaged').length, issues.filter((item) => item.status === 'resolved' || item.status === 'closed').length];
  document.querySelectorAll('#stats strong').forEach((node, index) => { node.textContent = values[index]; });
}

function renderList() {
  list.replaceChildren();
  if (!issues.length) { list.innerHTML = '<div class="empty-state"><strong>暂无匹配反馈</strong><span>调整筛选条件或等待新的提交。</span></div>'; return; }
  for (const issue of issues) {
    const button = document.createElement('button'); button.type = 'button'; button.className = `issue-list-item${issue.id === selectedId ? ' is-selected' : ''}`;
    button.innerHTML = `<span class="issue-item-top"><b>${escapeHtml(issue.title)}</b><em class="status status-${escapeHtml(issue.status)}">${escapeHtml(labels[issue.status] || issue.status)}</em></span><span class="issue-item-meta">${escapeHtml(issue.id)} · ${escapeHtml(issue.module)} · ${escapeHtml(formatDate(issue.createdAt))}</span>`;
    button.addEventListener('click', () => { selectedId = issue.id; renderList(); renderDetail(issue); }); list.append(button);
  }
}

function fieldValue(label, value) { const wrapper = document.createElement('div'); wrapper.className = 'detail-field'; const name = document.createElement('span'); name.textContent = label; const content = document.createElement('p'); content.textContent = value || '未填写'; wrapper.append(name, content); return wrapper; }

function renderDetail(issue) {
  if (!issue) { detail.innerHTML = '<div class="empty-state"><strong>选择一条反馈</strong><span>右侧会显示完整内容和处理记录。</span></div>'; return; }
  detail.replaceChildren();
  const head = document.createElement('div'); head.className = 'detail-heading'; head.innerHTML = `<div><p class="eyebrow">${escapeHtml(issue.id)}</p><h2>${escapeHtml(issue.title)}</h2><span class="issue-date">${escapeHtml(formatDate(issue.createdAt))}</span></div><span class="status status-${escapeHtml(issue.status)}">${escapeHtml(labels[issue.status] || issue.status)}</span>`; detail.append(head);
  const grid = document.createElement('div'); grid.className = 'detail-grid'; [['类型', typeLabels[issue.type] || issue.type], ['模块', issue.module], ['严重度', severityLabels[issue.severity] || issue.severity], ['版本', issue.version], ['系统', issue.os], ['浏览器', issue.browser], ['联系方式', issue.contact]].forEach(([label, value]) => grid.append(fieldValue(label, value))); detail.append(grid);
  [['具体描述', issue.description], ['复现步骤', issue.steps], ['期望结果', issue.expected], ['实际结果', issue.actual]].forEach(([label, value]) => detail.append(fieldValue(label, value)));
  if (issue.attachments?.length) { const attachmentSection = document.createElement('div'); attachmentSection.className = 'detail-field'; attachmentSection.innerHTML = '<span>附件</span>'; const ul = document.createElement('ul'); ul.className = 'admin-attachments'; issue.attachments.forEach((attachment) => { const li = document.createElement('li'); const link = document.createElement('button'); link.type = 'button'; link.className = 'text-link'; link.textContent = `${attachment.name} (${Math.ceil(attachment.size / 1024)} KB)`; link.addEventListener('click', () => downloadAttachment(issue.id, attachment.name)); li.append(link); ul.append(li); }); attachmentSection.append(ul); detail.append(attachmentSection); }
  const controls = document.createElement('div'); controls.className = 'admin-controls'; controls.innerHTML = '<label class="field"><span>处理状态</span><select id="detailStatus"><option value="new">新反馈</option><option value="triaged">已分诊</option><option value="in_progress">处理中</option><option value="resolved">已解决</option><option value="closed">已关闭</option></select></label><label class="field"><span>内部备注</span><textarea id="adminNote" rows="4" placeholder="仅管理端可见"></textarea></label><button class="button button-primary" id="saveDetail" type="button">保存处理记录</button>'; detail.append(controls); document.querySelector('#detailStatus').value = issue.status; document.querySelector('#adminNote').value = issue.adminNote || ''; document.querySelector('#saveDetail').addEventListener('click', () => saveDetail(issue.id));
}

async function downloadAttachment(id, name) { const response = await fetch(`/api/admin/issues/${encodeURIComponent(id)}/attachments/${encodeURIComponent(name)}`, { headers: { Authorization: `Bearer ${token}` } }); if (!response.ok) return alert('附件下载失败'); const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url); }
async function saveDetail(id) { const button = document.querySelector('#saveDetail'); button.disabled = true; try { await api(`/api/admin/issues/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: document.querySelector('#detailStatus').value, adminNote: document.querySelector('#adminNote').value }) }); await loadIssues(); } catch (error) { alert(error.message); } finally { button.disabled = false; } }
async function loadIssues() { const params = new URLSearchParams({ status: document.querySelector('#statusFilter').value, q: document.querySelector('#queryInput').value }); const result = await api(`/api/admin/issues?${params}`); issues = result.issues; renderStats(); renderList(); const selected = issues.find((item) => item.id === selectedId) || issues[0]; if (selected) { selectedId = selected.id; renderList(); renderDetail(selected); } else renderDetail(null); }

document.querySelector('#loginForm').addEventListener('submit', async (event) => { event.preventDefault(); token = document.querySelector('#tokenInput').value.trim(); try { await api('/api/admin/issues'); localStorage.setItem(tokenKey, token); loginPanel.hidden = true; adminPanel.hidden = false; await loadIssues(); } catch (error) { setLoginError(error.message); localStorage.removeItem(tokenKey); } });
document.querySelector('#refreshButton').addEventListener('click', () => loadIssues().catch((error) => alert(error.message)));
document.querySelector('#statusFilter').addEventListener('change', () => loadIssues().catch((error) => alert(error.message)));
document.querySelector('#queryInput').addEventListener('input', (() => { let timer; return () => { clearTimeout(timer); timer = setTimeout(() => loadIssues().catch((error) => alert(error.message)), 250); }; })());
document.querySelector('#exportButton').addEventListener('click', async () => { const response = await fetch('/api/admin/export', { headers: { Authorization: `Bearer ${token}` } }); const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'prompt-studio-feedback.csv'; link.click(); URL.revokeObjectURL(url); });
document.querySelector('#logoutButton').addEventListener('click', () => { localStorage.removeItem(tokenKey); location.reload(); });
document.querySelector('#themeSelect').addEventListener('change', (event) => applyTheme(event.target.value));
loadTheme();
if (token) { document.querySelector('#tokenInput').value = token; document.querySelector('#loginForm').requestSubmit(); }
