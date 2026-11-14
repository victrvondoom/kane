// Quality-layer-2 tests: migrations, target policy, adapter contract, streaming, restart safety,
// history pagination, audit trail, and the real fail -> code fix -> pass loop on the demo store.
// Engines used here are TEST-ONLY stand-ins (tests/fixtures/*); none of this is Kane CLI evidence.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { checkTarget, addressClass } from '../server/netpolicy.js';
import { textHash } from '../server/requirements.js';
import { classify, versionAtLeast, runKane, MIN_KANE_VERSION } from '../server/kane.js';

process.env.LOG_LEVEL = 'silent';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shipproof-hard-'));
const stateFile = path.join(tmp, 'state.json');
const setState = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));
process.env.FAKE_KANE_STATE = stateFile;
const fake = path.join(here, 'fixtures', 'fake-kane.js');
const baseConfig = { bin: fake, timeout: 30, maxSteps: 10, headless: true, username: '', accessKey: '', requireEvidence: true, allowPrivateTargets: true, acceptFixtureEngine: true };

function client(base) {
  const jar = {};
  return async (method, url, body, who = 'a', headers = {}) => {
    const res = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(jar[who] ? { Cookie: jar[who] } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) jar[who] = sc.split(';')[0];
    return { status: res.status, body: (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text(), headers: res.headers, cookie: () => jar[who] };
  };
}
async function boot(dataDir, config = baseConfig) {
  const ctx = createApp({ dataDir, config });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { ...ctx, server, base, api: client(base), stop: async () => { server.close(); server.closeAllConnections?.(); await ctx.shutdown(); } };
}
async function seed(api, n = 2) {
  await api('POST', '/api/auth/signup', { email: `u${Math.random().toString(36).slice(2)}@example.com`, name: 'T', password: 'correct-horse' });
  const p = (await api('POST', '/api/projects', { name: 'P', appUrl: 'http://127.0.0.1:9/' })).body.project;
  const c = (await api('POST', `/api/projects/${p.id}/requirements`, { text: Array.from({ length: n }, (_, i) => `Criterion number ${i + 1} holds.`).join('\n') })).body.criteria;
  return { pid: p.id, criteria: c };
}
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });

let A;
before(async () => { A = await boot(path.join(tmp, 'a')); });
after(async () => { await A.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------- database & migrations ----------
test('migrations upgrade a v1 database in place and keep existing data', () => {
  const dir = path.join(tmp, 'mig'); fs.mkdirSync(dir);
  const raw = new DatabaseSync(path.join(dir, 'shipproof.db'));
  raw.exec('CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  raw.exec(fs.readFileSync(path.join(root, 'migrations', '001_init.sql'), 'utf8'));
  raw.prepare('INSERT INTO _migrations VALUES (?, ?)').run('001_init.sql', '2026-01-01T00:00:00.000Z');
  raw.exec(`INSERT INTO users VALUES (1,'old@example.com','Old','x','2026-01-01T00:00:00.000Z');
    INSERT INTO projects (id,user_id,name,app_url,share_token,created_at) VALUES (1,1,'Legacy','https://example.com/','legacy-plain-token-123456','2026-01-01T00:00:00.000Z');
    INSERT INTO criteria (id,project_id,key,text,created_at,updated_at) VALUES (1,1,'AC-001','Old criterion.','t','t');
    INSERT INTO runs (id,project_id,trigger,status,created_at) VALUES (1,1,'full','completed','t');
    INSERT INTO results (id,run_id,criterion_id,criterion_key,criterion_text,text_hash,status) VALUES (1,1,1,'AC-001','Old criterion.','${textHash('Old criterion.')}','failed');
    INSERT INTO evidence (id,result_id,kind,name,rel_path) VALUES (1,1,'screenshot','a.png','result-1/a.png');
    INSERT INTO repair_tasks (id,project_id,criterion_id,source_result_id,status,expected,observed,diagnosis,created_at,updated_at) VALUES (1,1,1,1,'open','e','o','d','t','t');`);
  raw.close();
  const db = openDb(dir);
  assert.deepEqual(db.all('SELECT name FROM _migrations ORDER BY name').map((r) => r.name), ['001_init.sql', '002_hardening.sql', '003_proof_intelligence.sql', '004_autonomous_loop.sql', '005_loop_truth.sql', '006_watch.sql']);
  const ver = db.get('SELECT * FROM criterion_versions WHERE criterion_id = 1');
  assert.equal(ver.text, 'Old criterion.'); assert.equal(db.get('SELECT version_id FROM criteria WHERE id = 1').version_id, ver.id);
  assert.equal(db.get('SELECT criterion_version_id FROM results WHERE id = 1').criterion_version_id, ver.id, 'old executions are linked to the version they verified');
  assert.equal(db.get('SELECT version FROM policy_versions WHERE project_id = 1').version, 1);
  const p = db.get('SELECT * FROM projects WHERE id = 1');
  assert.equal(p.name, 'Legacy'); assert.equal(p.share_token, null); assert.match(p.share_token_hash, /^[0-9a-f]{64}$/);
  assert.match(db.get('SELECT uid FROM evidence WHERE id = 1').uid, /^[\w-]{16}$/);
  assert.equal(db.get('SELECT origin_run_id FROM repair_tasks WHERE id = 1').origin_run_id, 1);
  assert.equal(db.get('PRAGMA foreign_keys').foreign_keys, 1);
  assert.throws(() => db.run(`INSERT INTO results (run_id,criterion_id,criterion_key,criterion_text,text_hash,status) VALUES (999,1,'k','t','h','queued')`), /FOREIGN KEY/);
  const backup = db.backup(path.join(dir, 'backup.db'));
  db.close(); openDb(dir).close(); // re-opening is idempotent
  const b = new DatabaseSync(backup); assert.equal(b.prepare('SELECT name FROM projects').get().name, 'Legacy'); b.close();
});

// ---------- target policy (SSRF) ----------
test('address classes', () => {
  assert.equal(addressClass('169.254.169.254'), 'link-local'); assert.equal(addressClass('127.0.0.1'), 'loopback');
  assert.equal(addressClass('10.1.2.3'), 'private'); assert.equal(addressClass('172.20.0.1'), 'private'); assert.equal(addressClass('192.168.1.1'), 'private');
  assert.equal(addressClass('::1'), 'loopback'); assert.equal(addressClass('::ffff:10.0.0.1'), 'private'); assert.equal(addressClass('fd00::1'), 'private');
  assert.equal(addressClass('93.184.216.34'), 'public');
});
test('target policy refuses dangerous URLs', async () => {
  const pub = async () => [{ address: '93.184.216.34' }];
  assert.equal((await checkTarget('https://example.com/x', { lookup: pub })).ok, true);
  for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://example.com', 'not a url', 'https://user:pw@example.com/'])
    assert.equal((await checkTarget(u, { lookup: pub })).ok, false, u);
  assert.equal((await checkTarget('http://localhost:3000/')).ok, false);
  assert.equal((await checkTarget('http://127.0.0.1/', { allowPrivate: true })).ok, true);
  assert.equal((await checkTarget('http://169.254.169.254/latest/meta-data', { allowPrivate: true })).ok, false, 'metadata is never allowed');
  assert.equal((await checkTarget('http://[::1]/')).ok, false);
  assert.equal((await checkTarget('https://rebind.example/', { lookup: async () => [{ address: '93.184.216.34' }, { address: '10.0.0.5' }] })).ok, false, 'any private A record is refused');
  assert.equal((await checkTarget('https://nx.example/', { lookup: async () => { throw new Error('ENOTFOUND'); } })).ok, false);
});
test('API enforces the target policy at create, update and run time', async () => {
  const B = await boot(path.join(tmp, 'ssrf'), { ...baseConfig, allowPrivateTargets: false });
  await B.api('POST', '/api/auth/signup', { email: 's@example.com', name: 'S', password: 'correct-horse' });
  assert.equal((await B.api('POST', '/api/projects', { name: 'x', appUrl: 'http://127.0.0.1:4100/' })).status, 400);
  assert.equal((await B.api('POST', '/api/projects', { name: 'x', appUrl: 'http://169.254.169.254/' })).status, 400);
  // a project saved while private targets were allowed is still refused at execution time
  B.db.run(`INSERT INTO projects (id,user_id,name,app_url,created_at) VALUES (50,1,'old','http://127.0.0.1:4100/','t')`);
  await B.api('POST', '/api/projects/50/requirements', { text: 'Something holds true.' });
  setState({ mode: 'ok', failWhen: [] });
  const r = await B.api('POST', '/api/projects/50/runs', {});
  await B.runner.idle();
  const run = (await B.api('GET', `/api/runs/${r.body.run.id}`)).body;
  assert.equal(run.results[0].status, 'error'); assert.equal(run.results[0].errorKind, 'target_blocked');
  assert.equal(run.results[0].exitCode, null, 'engine was never started');
  await B.stop();
});

// ---------- adapter contract ----------
test('contract: real kane-cli 0.10.4 unauthenticated capture is classified as auth, not as a test failure', () => {
  const stdout = fs.readFileSync(path.join(here, 'fixtures', 'real-kane-0.10.4-unauthenticated.stdout.ndjson'), 'utf8');
  const stderr = fs.readFileSync(path.join(here, 'fixtures', 'real-kane-0.10.4-unauthenticated.stderr.txt'), 'utf8');
  const events = stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events[0].type, 'stream_start'); assert.equal(events[0].cli_version, '0.10.4');
  const v = classify({ exitCode: 1, runEnd: events.find((e) => e.type === 'run_end') ?? null, stderr });
  assert.deepEqual([v.status, v.errorKind], ['error', 'auth']);
});
test('contract: the installed kane-cli still exposes every flag the adapter uses', { skip: spawnSync('kane-cli', ['--version']).status !== 0 && 'kane-cli not installed' }, () => {
  const version = execFileSync('kane-cli', ['--version']).toString().trim();
  assert.ok(versionAtLeast(version, MIN_KANE_VERSION), `installed ${version}`);
  const help = execFileSync('kane-cli', ['run', '--help']).toString();
  for (const flag of ['--agent', '--headless', '--url', '--timeout', '--max-steps', '--variables-file', '--username', '--access-key'])
    assert.ok(help.includes(flag), `kane-cli run no longer documents ${flag}`);
});
test('version gate', () => {
  assert.equal(versionAtLeast('0.10.4', '0.8.17'), true); assert.equal(versionAtLeast('0.8.17', '0.8.17'), true);
  assert.equal(versionAtLeast('0.8.16', '0.8.17'), false); assert.equal(versionAtLeast('1.0.0', '0.8.17'), true); assert.equal(versionAtLeast('garbage', '0.8.17'), false);
});
test('adapter: malformed NDJSON is preserved as raw events and never invents a verdict', async () => {
  setState({ mode: 'garbage', failWhen: [] });
  const o = await runKane({ objective: 'x', url: 'http://127.0.0.1:9/', workDir: path.join(tmp, 'w1'), config: baseConfig });
  assert.ok(o.events.filter((e) => e.type === 'raw').length >= 2);
  assert.equal(o.runEnd.status, 'passed'); assert.equal(o.exitCode, 0); assert.equal(o.engine, 'kane-cli fixture');
});
test('adapter: a process killed mid-run has no run_end and is an execution error', async () => {
  setState({ mode: 'crash' });
  const o = await runKane({ objective: 'x', url: 'http://127.0.0.1:9/', workDir: path.join(tmp, 'w2'), config: baseConfig });
  assert.equal(o.runEnd, null);
  if (process.platform !== 'win32') assert.equal(o.signal, 'SIGKILL');
  assert.deepEqual([classify(o).status, classify(o).errorKind], ['error', 'did_not_start']);
});
test('adapter: shell metacharacters in criteria are passed as one argument, never interpreted', async () => {
  setState({ mode: 'ok', failWhen: [] });
  const marker = path.join(tmp, 'pwned');
  const o = await runKane({ objective: `x"; touch ${marker}; $(touch ${marker}) \`touch ${marker}\``, url: 'http://127.0.0.1:9/', workDir: path.join(tmp, 'w3'), config: baseConfig });
  assert.equal(o.exitCode, 0); assert.equal(fs.existsSync(marker), false);
});
test('missing binary, network failure and evidence-less pass are all "no verdict"', async () => {
  const { pid } = await seed(A.api, 1);
  const kinds = [];
  for (const mode of ['network', 'pass_no_evidence', 'crash']) {
    setState({ mode });
    const r = await A.api('POST', `/api/projects/${pid}/runs`, {});
    await A.runner.idle();
    const res = (await A.api('GET', `/api/runs/${r.body.run.id}`)).body.results[0];
    kinds.push([res.status, res.errorKind]);
  }
  assert.deepEqual(kinds, [['error', 'network'], ['error', 'no_evidence'], ['error', 'did_not_start']]);
  const proj = (await A.api('GET', `/api/projects/${pid}`)).body;
  assert.equal(proj.project.gate.verdict, 'unverified'); assert.equal(proj.repairTasks.length, 0);
  const M = await boot(path.join(tmp, 'missing'), { ...baseConfig, bin: '/nonexistent/kane-cli' });
  const s = await seed(M.api, 1);
  const r = await M.api('POST', `/api/projects/${s.pid}/runs`, {});
  await M.runner.idle();
  assert.equal((await M.api('GET', `/api/runs/${r.body.run.id}`)).body.results[0].errorKind, 'kane_not_installed');
  assert.equal((await M.api('GET', `/api/projects/${s.pid}`)).body.project.gate.verdict, 'unverified');
  const sys = (await M.api('GET', '/api/system?fresh=1')).body.kane;
  assert.equal(sys.state, 'unavailable'); assert.equal(sys.ready, false);
  await M.stop();
});

// ---------- queue, streaming, history ----------
test('duplicate run requests are refused while one is active; states go queued -> starting -> running', async () => {
  const { pid } = await seed(A.api, 1);
  setState({ mode: 'hang' });
  const r = await A.api('POST', `/api/projects/${pid}/runs`, {});
  const dup = await A.api('POST', `/api/projects/${pid}/runs`, {});
  assert.equal(dup.status, 409); assert.equal(dup.body.activeRunId, r.body.run.id);
  await new Promise((x) => setTimeout(x, 700));
  assert.equal((await A.api('GET', `/api/runs/${r.body.run.id}`)).body.results[0].status, 'running');
  await A.api('POST', `/api/runs/${r.body.run.id}/cancel`); await A.runner.idle();
  const phases = (await A.api('GET', `/api/runs/${r.body.run.id}/events`)).body.events.filter((e) => e.kind === 'system' && e.payload.phase).map((e) => e.payload.phase);
  assert.deepEqual(phases, ['starting', 'running', 'end']);
});
test('SSE stream carries event ids and resumes from Last-Event-ID without loss or duplicates', async () => {
  const { pid } = await seed(A.api, 2);
  setState({ mode: 'ok', failWhen: [] });
  const r = await A.api('POST', `/api/projects/${pid}/runs`, {}); await A.runner.idle();
  const all = (await A.api('GET', `/api/runs/${r.body.run.id}/events`)).body.events;
  const read = async (headers) => {
    const res = await fetch(`${A.base}/api/runs/${r.body.run.id}/stream`, { headers: { Cookie: (await A.api('GET', '/api/auth/me')).cookie(), ...headers } });
    let text = ''; const dec = new TextDecoder();
    for await (const chunk of res.body) { text += dec.decode(chunk); if (text.includes('event: end')) break; }
    return [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  };
  assert.deepEqual(await read({}), all.map((e) => e.id));
  const cut = all[Math.floor(all.length / 2)].id;
  const resumed = await read({ 'Last-Event-ID': String(cut) });
  assert.deepEqual(resumed, all.filter((e) => e.id > cut).map((e) => e.id));
  assert.equal(new Set(resumed).size, resumed.length);
});
test('run history is paginated, filterable and scoped to the owner', async () => {
  const { pid } = await seed(A.api, 1);
  setState({ mode: 'ok', failWhen: [] });
  for (let i = 0; i < 5; i++) { await A.api('POST', `/api/projects/${pid}/runs`, {}); await A.runner.idle(); }
  const p1 = (await A.api('GET', `/api/projects/${pid}/runs?limit=2`)).body;
  assert.equal(p1.runs.length, 2); assert.equal(p1.total, 5); assert.ok(p1.nextBefore);
  const p2 = (await A.api('GET', `/api/projects/${pid}/runs?limit=2&before=${p1.nextBefore}`)).body;
  assert.ok(p2.runs[0].id < p1.runs[1].id);
  assert.equal((await A.api('GET', `/api/projects/${pid}/runs?status=cancelled`)).body.total, 0);
  assert.equal((await A.api('GET', `/api/projects/${pid}/runs?status=bogus`)).status, 400);
  assert.ok(p1.runs.every((r) => r.durationMs >= 0 && r.startedAt));
  await A.api('POST', '/api/auth/signup', { email: 'other@example.com', name: 'O', password: 'correct-horse' }, 'b');
  assert.equal((await A.api('GET', `/api/projects/${pid}/runs`, null, 'b')).status, 404);
  assert.equal((await A.api('GET', `/api/runs?project=${pid}`, null, 'b')).status, 404);
  assert.deepEqual((await A.api('GET', '/api/runs', null, 'b')).body.runs, []);
});
test('dashboard metrics are computed from execution rows and change when they change', async () => {
  const api = client(A.base);
  const { pid } = await seed(api, 2);
  let m = (await api('GET', '/api/projects')).body.metrics;
  assert.deepEqual([m.projects, m.runs, m.passRate], [1, 0, null]);
  setState({ mode: 'ok', failWhen: ['number 2'] });
  await api('POST', `/api/projects/${pid}/runs`, {}); await A.runner.idle();
  m = (await api('GET', '/api/projects')).body.metrics;
  assert.deepEqual([m.completedRuns, m.executions.passed, m.executions.failed, m.passRate, m.releaseReady], [1, 1, 1, 0.5, 0]);
  setState({ mode: 'ok', failWhen: [] });
  await api('POST', `/api/projects/${pid}/runs`, { mode: 'failed' }); await A.runner.idle();
  m = (await api('GET', '/api/projects')).body.metrics;
  assert.deepEqual([m.completedRuns, m.executions.passed, m.releaseReady], [2, 2, 1]);
});

// ---------- restart safety ----------
test('server restart: history persists, in-flight work becomes "interrupted", sessions survive', async () => {
  const dir = path.join(tmp, 'restart');
  let S = await boot(dir);
  const { pid } = await seed(S.api, 2);
  setState({ mode: 'ok', failWhen: [] });
  const done = await S.api('POST', `/api/projects/${pid}/runs`, {}); await S.runner.idle();
  setState({ mode: 'hang' });
  const hung = await S.api('POST', `/api/projects/${pid}/runs`, {});
  await new Promise((x) => setTimeout(x, 500));
  const cookie = S.api.length ? (await S.api('GET', '/api/auth/me')).cookie() : null;
  await S.stop();
  S = await boot(dir);
  const get = async (u) => (await fetch(S.base + u, { headers: { Cookie: cookie } })).json();
  assert.equal((await get('/api/auth/me')).user.name, 'T', 'session survives restart');
  assert.equal((await get(`/api/runs/${done.body.run.id}`)).results.every((r) => r.status === 'passed'), true);
  const h = await get(`/api/runs/${hung.body.run.id}`);
  assert.equal(h.run.status, 'interrupted');
  assert.ok(h.results.every((r) => r.status === 'error' && r.errorKind === 'interrupted'));
  assert.ok((await get(`/api/runs/${hung.body.run.id}/events`)).events.length > 0, 'events persisted');
  assert.equal((await get(`/api/projects/${pid}`)).project.gate.verdict, 'unverified', 'an interrupted re-run invalidates the earlier pass');
  await S.stop();
});

// ---------- ops ----------
test('health, readiness, request ids, generic 500s, audit trail', async () => {
  assert.deepEqual(await (await fetch(A.base + '/healthz')).json(), { status: 'ok' });
  const ready = await fetch(A.base + '/readyz');
  assert.equal(ready.status, 200); assert.deepEqual((await ready.json()).checks, { database: true, storage: true, accepting: true });
  const r = await A.api('GET', '/api/nope'); assert.equal(r.status, 404); assert.match(r.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
  assert.equal(r.headers.get('access-control-allow-origin'), null, 'no cross-origin access is granted');
  assert.equal((await fetch(A.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad json' })).status, 400);
  const api = client(A.base);
  const { pid } = await seed(api, 1);
  const key = (await api('POST', `/api/projects/${pid}/api-key`, {})).body.apiKey;
  await api('POST', `/api/projects/${pid}/share`, { expiresInDays: 7 });
  await api('DELETE', `/api/projects/${pid}/api-key`);
  assert.equal((await api('GET', '/api/agent/gate', null, 'anon', { Authorization: `Bearer ${key}` })).status, 401, 'revoked key stops working immediately');
  const ev = (await api('GET', `/api/projects/${pid}/audit`)).body.events.map((e) => e.action);
  for (const a of ['project.created', 'api_key.created', 'share.created', 'api_key.revoked']) assert.ok(ev.includes(a), a);
  assert.ok(!JSON.stringify(ev).includes(key));
  assert.equal((await api('POST', `/api/projects/${pid}/share`, { expiresInDays: 9999 })).status, 400);
});

// ---------- the closed loop on real application logic ----------
test('demo store: real bug fails, real code fix passes, repair task records the causal chain', async () => {
  // Private copy of the demo store so the working tree is never modified.
  const store = path.join(tmp, 'store'); fs.mkdirSync(path.join(store, 'demo'), { recursive: true }); fs.cpSync(path.join(root, 'demo-app'), path.join(store, 'demo-app'), { recursive: true });
  fs.copyFileSync(path.join(root, 'demo', 'fix-coupon.patch'), path.join(store, 'demo', 'fix-coupon.patch'));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(store, 'node_modules'));
  const port = await freePort();
  const start = async () => {
    const child = spawn(process.execPath, ['demo-app/server.js'], { cwd: store, env: { ...process.env, DEMO_PORT: String(port) }, stdio: 'ignore' });
    for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return child; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    throw new Error('demo store did not start');
  };
  let child = await start();
  const D = await boot(path.join(tmp, 'demo'), { ...baseConfig, bin: path.join(here, 'fixtures', 'store-check-kane.js') });
  try {
    await D.api('POST', '/api/auth/signup', { email: 'd@example.com', name: 'D', password: 'correct-horse' });
    const pid = (await D.api('POST', '/api/projects', { name: 'Store', appUrl: `http://127.0.0.1:${port}/` })).body.project.id;
    await D.api('POST', `/api/projects/${pid}/requirements`, { text: 'The product catalogue lists the Trail Backpack.\nAfter applying coupon code SAVE10 to a cart containing one Trail Backpack ($80.00), the order total shows $72.00.' });
    const run1 = (await D.api('POST', `/api/projects/${pid}/runs`, {})).body.run.id; await D.runner.idle();
    let proj = (await D.api('GET', `/api/projects/${pid}`)).body;
    assert.deepEqual(proj.criteria.map((c) => c.status), ['verified', 'failed']);
    assert.equal(proj.project.gate.verdict, 'blocked');
    const task = proj.repairTasks[0];
    assert.equal(task.originRunId, run1); assert.match(task.observed, /\$80\.00, expected \$72\.00/);
    const failed = (await D.api('GET', `/api/runs/${run1}`)).body.results[1];
    assert.equal(failed.isFixture, true, 'stand-in output is labelled as fixture'); assert.equal(failed.engine, 'kane-cli fixture-store-check');
    assert.ok(failed.evidence.length > 0);
    // 1. Declaring a fix without changing code does not close the task.
    const v1 = (await D.api('POST', `/api/repair-tasks/${task.id}/fix-applied`, { note: 'trust me' })).body.run.id; await D.runner.idle();
    assert.equal((await D.api('GET', `/api/repair-tasks/${task.id}`)).body.task.status, 'open');
    // 2. Apply the real one-line fix to the store's code and restart it.
    child.kill(); execFileSync('git', ['apply', 'demo/fix-coupon.patch'], { cwd: store }); child = await start();
    const v2 = (await D.api('POST', `/api/repair-tasks/${task.id}/fix-applied`, { note: 'total = subtotal - discount' })).body.run.id; await D.runner.idle();
    const closed = (await D.api('GET', `/api/repair-tasks/${task.id}`)).body.task;
    assert.equal(closed.status, 'verified'); assert.equal(closed.originRunId, run1); assert.equal(closed.verifyRunId, v2); assert.equal(closed.verifiedBy.run_id, v2);
    assert.equal(closed.fixDeclaredBy, 'user'); assert.ok(closed.closedAt);
    assert.deepEqual(closed.timeline.map((e) => e.action), ['repair_task.opened', 'repair_task.fix_declared', 'repair_task.failed_again', 'repair_task.fix_declared', 'repair_task.verified']);
    proj = (await D.api('GET', `/api/projects/${pid}`)).body;
    assert.equal(proj.project.gate.verdict, 'verified');
    assert.deepEqual([run1, v1, v2].map((id) => D.db.get('SELECT status FROM results WHERE run_id = ? AND criterion_key = ?', id, 'AC-002').status), ['failed', 'failed', 'passed']);
    assert.equal((await D.api('POST', `/api/repair-tasks/${task.id}/fix-applied`, {})).status, 409, 'a closed task cannot be re-declared');
  } finally { child.kill(); await D.stop(); }
});

test('engine status distinguishes a test stand-in from Kane CLI', async () => {
  const sys = (await A.api('GET', '/api/system?fresh=1')).body.kane;
  assert.equal(sys.state, 'test_fixture'); assert.equal(sys.isFixture, true); assert.equal(sys.ready, false);
  assert.ok(!JSON.stringify(sys).match(/access|secret|LT_/i) || !JSON.stringify(sys).includes(process.env.LT_ACCESS_KEY || '\u0000'));
});
