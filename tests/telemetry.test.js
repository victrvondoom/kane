// Telemetry diagnostics from Kane evidence (HAR network traces and console output). Diagnostic only: the tests also
// prove the result status and the release decision do not change. Engine: TEST-ONLY stand-in tests/fixtures/fake-kane.js.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { hashPassword, hashToken } from '../server/auth.js';
import { parseHar, parseConsole, summarizeEvidence, redactUrl, redactText } from '../server/telemetry.js';

process.env.LOG_LEVEL = 'silent';
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shipproof-tel-'));
const stateFile = path.join(tmp, 'state.json'); process.env.FAKE_KANE_STATE = stateFile;
fs.writeFileSync(stateFile, JSON.stringify({ mode: 'ok', failWhen: [] }));
const config = { bin: path.join(here, 'fixtures', 'fake-kane.js'), timeout: 30, maxSteps: 10, headless: true, username: '', accessKey: '', requireEvidence: true, allowPrivateTargets: true, acceptFixtureEngine: true };

const har = (entries) => JSON.stringify({ log: { version: '1.2', creator: { name: 'kane-fixture', version: '0' }, entries } });
const entry = (method, url, status, time, error) => ({ startedDateTime: '2026-01-01T00:00:00Z', time, request: { method, url }, response: { status }, ...(error ? { _error: error } : {}) });

test('telemetry: HAR is summarised with failures, 5xx, slow requests and redacted URLs', () => {
  const h = parseHar(har([
    entry('GET', 'https://shop.test/', 200, 120),
    entry('POST', 'https://shop.test/api/cart?token=abc123#frag', 500, 300),
    entry('GET', 'https://cdn.test/app.js?v=9', 404, 40),
    entry('GET', 'https://api.test/slow', 200, 2600),
    entry('GET', 'https://api.test/down', 0, 10, 'net::ERR_CONNECTION_REFUSED password=hunter2'),
  ]));
  assert.equal(h.format, 'har'); assert.equal(h.total, 5);
  assert.deepEqual(h.byStatus, { '2xx': 2, '3xx': 0, '4xx': 1, '5xx': 1, failed: 1 });
  assert.equal(h.failed, 3); assert.equal(h.slow, 1);
  const cart = h.failures.find((f) => f.url.includes('/api/cart'));
  assert.equal(cart.url, 'https://shop.test/api/cart', 'query string and fragment (tokens) are removed');
  assert.doesNotMatch(JSON.stringify(h), /abc123|hunter2/, 'no secret leaves the parser');
  assert.equal(h.failures.find((f) => f.status === 0).error.includes('[redacted]'), true);
  assert.equal(parseHar('not json').format, 'invalid'); assert.equal(parseHar('{"log":{}}').format, 'invalid');
});

test('telemetry: console output is classified from NDJSON or plain text, and secrets are redacted', () => {
  const nd = [JSON.stringify({ level: 'error', text: 'Uncaught TypeError: x is undefined' }), JSON.stringify({ level: 'warning', text: 'deprecated api' }),
    JSON.stringify({ level: 'info', text: 'ok' }), JSON.stringify({ level: 'log', text: 'auth token=s3cr3t leaked' })].join('\n');
  const c = parseConsole(nd);
  assert.equal(c.format, 'ndjson'); assert.equal(c.errors, 1); assert.equal(c.warnings, 1);
  assert.equal(c.samples.find((s) => s.level === 'error').text, 'Uncaught TypeError: x is undefined');
  const txt = parseConsole('hello\nERROR: database unreachable\nwarning: slow query\n');
  assert.equal(txt.format, 'text'); assert.equal(txt.errors, 1); assert.equal(txt.warnings, 1);
  assert.equal(parseConsole('password=hunter2 failed').samples[0]?.text, undefined, 'plain info lines are not samples');
  assert.equal(redactText('api_key: AKIA123 and secret=xyz'), 'api_key: [redacted] and secret=[redacted]');
  assert.equal(redactUrl('not a url'), '(unparseable url)');
});

test('telemetry: evidence is read only from inside the evidence root and never changes a verdict', () => {
  const root = fs.mkdtempSync(path.join(tmp, 'ev-'));
  fs.mkdirSync(path.join(root, 'r1'));
  fs.writeFileSync(path.join(root, 'r1', 'net.har'), har([entry('GET', 'https://x.test/', 503, 5)]));
  fs.writeFileSync(path.join(path.dirname(root), 'outside.har'), har([entry('GET', 'https://secret.test/', 200, 1)]));
  const s = summarizeEvidence([
    { name: 'net.har', kind: 'log', rel_path: 'r1/net.har' },
    { name: 'escape.har', kind: 'log', rel_path: '../' + path.basename(root) + '/../outside.har' },
    { name: 'shot.png', kind: 'screenshot', rel_path: 'r1/shot.png' },
  ], root);
  assert.equal(s.network.byStatus['5xx'], 1); assert.equal(s.files.find((f) => f.name === 'escape.har').problem, 'missing');
  assert.equal(s.files.some((f) => f.name === 'shot.png'), false, 'non-telemetry files are not read');
  assert.equal(s.verdictImpact, 'none');
  assert.ok(s.diagnostics.some((d) => /server error/.test(d)));
});

const open = [];
let target = null, targetUrl = '';
after(async () => { for (const S of open) { S.server.close(); S.server.closeAllConnections?.(); await S.shutdown(); } target?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('telemetry: the endpoint reports a real run’s network diagnostics, is owner-scoped, and leaves the verdict unchanged', async () => {
  if (!target) await new Promise((r) => { target = http.createServer((q, s) => s.end('ok')).listen(0, '127.0.0.1', () => { targetUrl = `http://127.0.0.1:${target.address().port}/`; r(); }); });
  const ctx = createApp({ dataDir: path.join(tmp, 'data'), config, watchOptions: { tickMs: 0 } });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`, jar = {};
  for (const [who, email] of [['a', 'a@example.com'], ['b', 'b@example.com']]) {
    const t = crypto.randomBytes(32).toString('base64url');
    const uid = Number(ctx.db.run('INSERT INTO users (email, name, pass_hash, created_at) VALUES (?, ?, ?, ?)', email, who, hashPassword('correct-horse'), 't').lastInsertRowid);
    ctx.db.run('INSERT INTO sessions VALUES (?, ?, ?)', hashToken(t), uid, new Date(Date.now() + 3600e3).toISOString()); jar[who] = `sp_session=${t}`;
  }
  const api = async (method, url, body, who = 'a') => { const res = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: jar[who] }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() }; };
  const S = { ...ctx, server, shutdown: ctx.shutdown };
  open.push(S);
  const pid = (await api('POST', '/api/projects', { name: 'Shop', appUrl: targetUrl })).body.project.id;
  await api('POST', `/api/projects/${pid}/requirements`, { text: 'The catalogue lists the Trail Backpack.' });
  const runId = (await api('POST', `/api/projects/${pid}/runs`, {})).body.run.id;
  await ctx.runner.waitForRun(runId);
  const result = ctx.db.get('SELECT * FROM results WHERE run_id = ? ORDER BY id LIMIT 1', runId);
  const before = (await api('GET', `/api/projects/${pid}/intelligence`)).body.decision;
  // Kane writes a HAR and a console log into the execution's evidence; they are linked to the result.
  const evRoot = path.join(path.dirname(ctx.db.get('PRAGMA database_list').file), 'evidence', 'telemetry-test');
  fs.mkdirSync(evRoot, { recursive: true });
  fs.writeFileSync(path.join(evRoot, 'network.har'), har([entry('GET', 'https://shop.test/', 200, 90), entry('POST', 'https://shop.test/api/checkout?session=zz', 500, 700)]));
  fs.writeFileSync(path.join(evRoot, 'console.log'), 'Uncaught ReferenceError: total is not defined\n');
  const rel = path.join('telemetry-test', 'network.har').replace(/\\/g, '/');
  ctx.db.run(`INSERT INTO evidence (result_id, kind, name, rel_path, mime, size) VALUES (?, 'log', 'network.har', ?, 'application/json', 1)`, result.id, rel);
  ctx.db.run(`INSERT INTO evidence (result_id, kind, name, rel_path, mime, size) VALUES (?, 'log', 'console.log', ?, 'text/plain', 1)`, result.id, 'telemetry-test/console.log');

  const t = await api('GET', `/api/runs/${runId}/results/${result.id}/telemetry`);
  assert.equal(t.status, 200);
  assert.equal(t.body.telemetry.network.byStatus['5xx'], 1);
  assert.equal(t.body.telemetry.console.errors, 1);
  assert.ok(t.body.telemetry.diagnostics.length >= 2);
  assert.equal(t.body.telemetry.verdictImpact, 'none');
  assert.doesNotMatch(JSON.stringify(t.body), /session=zz/, 'query strings are not returned');
  // diagnostics never change the result or the decision
  assert.equal(ctx.db.get('SELECT status FROM results WHERE id = ?', result.id).status, result.status);
  const strip = (d) => ({ ...d, decidedAt: undefined });
  assert.deepEqual(strip((await api('GET', `/api/projects/${pid}/intelligence`)).body.decision), strip(before), 'the decision is recomputed identically');
  // other tenant and unknown results are refused
  assert.equal((await api('GET', `/api/runs/${runId}/results/${result.id}/telemetry`, null, 'b')).status, 404);
  assert.equal((await api('GET', `/api/runs/${runId}/results/999999/telemetry`)).status, 404);
  await S.shutdown.call(null).catch(() => {});
  server.close(); server.closeAllConnections?.();
  open.length = 0;
});
