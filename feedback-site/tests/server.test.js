const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../server');

function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-studio-feedback-'));
  const server = createServer({ dataDir, adminToken: 'test-token' });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, dataDir, base: `http://127.0.0.1:${server.address().port}` })));
}

test('feedback submission and admin lifecycle', async () => {
  const { server, dataDir, base } = await startServer();
  try {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, service: 'prompt-studio-feedback' });

    const invalid = await fetch(`${base}/api/issues`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    assert.equal(invalid.status, 400);

    const created = await fetch(`${base}/api/issues`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'bug', module: '资产浏览器', severity: 'medium', title: '目录没有显示', description: '添加目录后列表没有显示。', version: '1.2.2', attachments: [{ name: 'log.txt', type: 'text/plain', data: `data:text/plain;base64,${Buffer.from('hello').toString('base64')}` }] }) });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.match(createdBody.id, /^PSD-\d{8}-[A-F0-9]{6}$/);

    const unauthorized = await fetch(`${base}/api/admin/issues`);
    assert.equal(unauthorized.status, 401);
    const list = await fetch(`${base}/api/admin/issues`, { headers: { Authorization: 'Bearer test-token' } });
    const listBody = await list.json();
    assert.equal(list.status, 200);
    assert.equal(listBody.issues.length, 1);
    assert.equal(listBody.issues[0].attachments[0].name, 'log.txt');

    const updated = await fetch(`${base}/api/admin/issues/${createdBody.id}`, { method: 'PATCH', headers: { Authorization: 'Bearer test-token', 'content-type': 'application/json' }, body: JSON.stringify({ status: 'resolved', adminNote: '已确认并修复' }) });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).issue.status, 'resolved');

    const attachment = await fetch(`${base}/api/admin/issues/${createdBody.id}/attachments/log.txt`, { headers: { Authorization: 'Bearer test-token' } });
    assert.equal(await attachment.text(), 'hello');
    const csv = await fetch(`${base}/api/admin/export`, { headers: { Authorization: 'Bearer test-token' } });
    assert.equal(csv.status, 200);
    assert.match(await csv.text(), /目录没有显示/);
    assert.ok(fs.existsSync(path.join(dataDir, 'issues', `${createdBody.id}.json`)));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
