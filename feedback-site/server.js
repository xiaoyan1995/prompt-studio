const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DEFAULT_DATA_DIR = path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 8788);
const MAX_BODY_BYTES = 35 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENT_COUNT = 5;
const STATUSES = new Set(['new', 'triaged', 'in_progress', 'resolved', 'closed']);
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function ensureStore(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'issues'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
}

function getAdminToken(dataDir, configuredToken) {
  if (configuredToken) return configuredToken;
  const tokenPath = path.join(dataDir, 'admin-token.txt');
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  const token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(tokenPath, token, 'utf8');
  return token;
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}

function sendText(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

function securityHeaders() {
  return {
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY'
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求内容过大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('请求格式不是有效 JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function safeFileName(value) {
  const name = path.basename(cleanText(value, 160)).replace(/[^\w.()\-\u4e00-\u9fff ]/g, '_');
  return name || 'attachment';
}

function parseAttachment(item) {
  if (!item || typeof item !== 'object') throw new Error('附件格式无效');
  const name = safeFileName(item.name);
  const mime = cleanText(item.type, 80).toLowerCase() || 'application/octet-stream';
  const match = typeof item.data === 'string' ? item.data.match(/^data:([^;,]+);base64,(.+)$/s) : null;
  if (!match) throw new Error(`附件 ${name} 内容无效`);
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > MAX_ATTACHMENT_BYTES) throw new Error(`附件 ${name} 超过 8 MB 限制`);
  const allowed = mime.startsWith('image/') || mime.startsWith('video/') || mime === 'text/plain' || mime === 'application/json' || mime === 'application/pdf';
  if (!allowed) throw new Error(`附件 ${name} 类型不支持`);
  return { name, mime, size: buffer.length, buffer };
}

function validateIssue(payload) {
  const issue = {
    type: cleanText(payload.type, 30),
    module: cleanText(payload.module, 60),
    severity: cleanText(payload.severity, 30),
    title: cleanText(payload.title, 120),
    description: cleanText(payload.description, 20000),
    steps: cleanText(payload.steps, 12000),
    expected: cleanText(payload.expected, 6000),
    actual: cleanText(payload.actual, 6000),
    version: cleanText(payload.version, 40),
    os: cleanText(payload.os, 120),
    browser: cleanText(payload.browser, 120),
    contact: cleanText(payload.contact, 160),
    attachments: Array.isArray(payload.attachments) ? payload.attachments : []
  };
  if (!issue.title || issue.title.length < 2) throw new Error('请填写问题标题');
  if (!issue.description || issue.description.length < 8) throw new Error('请描述一下具体情况');
  if (!issue.type || !issue.module || !issue.severity) throw new Error('请完整选择反馈类型、模块和严重度');
  if (issue.attachments.length > MAX_ATTACHMENT_COUNT) throw new Error('最多上传 5 个附件');
  return issue;
}

function issueId() {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `PSD-${date}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

async function listIssues(dataDir) {
  const dir = path.join(dataDir, 'issues');
  const names = (await fsp.readdir(dir)).filter((name) => name.endsWith('.json'));
  const records = await Promise.all(names.map(async (name) => JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'))));
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function publicIssue(record) {
  return {
    ...record,
    attachments: (record.attachments || []).map(({ name, mime, size }) => ({ name, mime, size }))
  };
}

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""').replaceAll('\r', ' ').replaceAll('\n', ' ')}"`;
}

function makeCsv(records) {
  const headers = ['id', 'createdAt', 'status', 'type', 'module', 'severity', 'title', 'description', 'steps', 'expected', 'actual', 'version', 'os', 'browser', 'contact'];
  const lines = [headers.join(',')];
  for (const record of records) lines.push(headers.map((key) => csvCell(record[key])).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function adminAuthorized(req, token) {
  const header = req.headers.authorization || '';
  return header === `Bearer ${token}`;
}

async function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(PUBLIC_DIR, `.${requested}`);
  if (!filePath.startsWith(`${path.resolve(PUBLIC_DIR)}${path.sep}`)) return false;
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return false;
    const headers = { ...securityHeaders(), 'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') res.end();
    else res.end(await fsp.readFile(filePath));
    return true;
  } catch {
    return false;
  }
}

function createServer(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.FEEDBACK_DATA_DIR || DEFAULT_DATA_DIR);
  ensureStore(dataDir);
  const configuredToken = options.adminToken || process.env.FEEDBACK_ADMIN_TOKEN || '';
  const adminToken = getAdminToken(dataDir, configuredToken);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;
      if (pathname === '/api/health' && req.method === 'GET') return sendJson(res, 200, { ok: true, service: 'prompt-studio-feedback' });

      if (pathname === '/api/issues' && req.method === 'POST') {
        const payload = validateIssue(await readJson(req));
        const parsedAttachments = payload.attachments.map(parseAttachment);
        const totalBytes = parsedAttachments.reduce((total, item) => total + item.size, 0);
        if (totalBytes > 24 * 1024 * 1024) throw new Error('附件总大小不能超过 24 MB');
        const id = issueId();
        const uploadDir = path.join(dataDir, 'uploads', id);
        await fsp.mkdir(uploadDir, { recursive: true });
        const attachments = [];
        for (const attachment of parsedAttachments) {
          const storedName = `${crypto.randomBytes(4).toString('hex')}-${attachment.name}`;
          await fsp.writeFile(path.join(uploadDir, storedName), attachment.buffer);
          attachments.push({ name: attachment.name, storedName, mime: attachment.mime, size: attachment.size });
        }
        const record = { id, createdAt: new Date().toISOString(), status: 'new', adminNote: '', ...payload, attachments };
        delete record.attachments;
        record.attachments = attachments;
        await fsp.writeFile(path.join(dataDir, 'issues', `${id}.json`), JSON.stringify(record, null, 2), 'utf8');
        return sendJson(res, 201, { ok: true, id, createdAt: record.createdAt });
      }

      if (pathname.startsWith('/api/admin/')) {
        if (!adminAuthorized(req, adminToken)) return sendJson(res, 401, { ok: false, error: '管理令牌无效' });
        if (pathname === '/api/admin/issues' && req.method === 'GET') {
          let records = await listIssues(dataDir);
          const status = url.searchParams.get('status');
          const query = (url.searchParams.get('q') || '').toLowerCase();
          if (status && STATUSES.has(status)) records = records.filter((record) => record.status === status);
          if (query) records = records.filter((record) => [record.id, record.title, record.description, record.module].some((value) => String(value || '').toLowerCase().includes(query)));
          return sendJson(res, 200, { ok: true, issues: records.map(publicIssue) });
        }
        if (pathname === '/api/admin/export' && req.method === 'GET') {
          const records = await listIssues(dataDir);
          res.writeHead(200, { ...securityHeaders(), 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="prompt-studio-feedback.csv"' });
          return res.end(makeCsv(records));
        }
        const match = pathname.match(/^\/api\/admin\/issues\/([^/]+)(?:\/attachments\/([^/]+))?$/);
        if (match) {
          const id = decodeURIComponent(match[1]);
          const issuePath = path.join(dataDir, 'issues', `${id}.json`);
          const record = JSON.parse(await fsp.readFile(issuePath, 'utf8'));
          if (match[2] && req.method === 'GET') {
            const requestedName = decodeURIComponent(match[2]);
            const attachment = (record.attachments || []).find((item) => item.name === requestedName);
            if (!attachment) return sendJson(res, 404, { ok: false, error: '附件不存在' });
            const filePath = path.join(dataDir, 'uploads', id, attachment.storedName);
            res.writeHead(200, { ...securityHeaders(), 'Content-Type': attachment.mime, 'Content-Disposition': `attachment; filename="${encodeURIComponent(attachment.name)}"` });
            return res.end(await fsp.readFile(filePath));
          }
          if (req.method === 'PATCH') {
            const payload = await readJson(req);
            if (payload.status && !STATUSES.has(payload.status)) return sendJson(res, 400, { ok: false, error: '状态值无效' });
            if (payload.status) record.status = payload.status;
            if (typeof payload.adminNote === 'string') record.adminNote = payload.adminNote.trim().slice(0, 10000);
            record.updatedAt = new Date().toISOString();
            await fsp.writeFile(issuePath, JSON.stringify(record, null, 2), 'utf8');
            return sendJson(res, 200, { ok: true, issue: publicIssue(record) });
          }
          if (req.method === 'GET') return sendJson(res, 200, { ok: true, issue: publicIssue(record) });
        }
        return sendJson(res, 404, { ok: false, error: '管理接口不存在' });
      }

      if (await serveStatic(req, res)) return;
      return sendText(res, 404, 'Not found');
    } catch (error) {
      const status = error.statusCode || (error.code === 'ENOENT' ? 404 : 400);
      if (!res.headersSent) return sendJson(res, status, { ok: false, error: error.message || '请求处理失败' });
      res.end();
    }
  });
  server.feedback = { dataDir, adminToken };
  server.feedback.tokenConfigured = Boolean(configuredToken);
  return server;
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Prompt Studio feedback site: http://127.0.0.1:${PORT}/`);
    console.log(`Admin: http://127.0.0.1:${PORT}/admin.html`);
    if (server.feedback.tokenConfigured) console.log('Admin token loaded from FEEDBACK_ADMIN_TOKEN');
    else console.log(`Admin token: ${server.feedback.adminToken}`);
  });
}

module.exports = { createServer };
