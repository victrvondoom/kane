// End-to-end API tests: real HTTP server, real SQLite, real child-process spawning.
// The kane-cli binary is replaced by tests/fixtures/fake-kane.js (test-only) so outcomes are deterministic.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shipproof-test-'));
const stateFile = path.join(tmp, 'state.json');
const setState = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));
process.env.FAKE_KANE_STATE = stateFile;
const config = { bin: path.join(here, 'fixtures', 'fake-kane.js'), timeout: 30, maxSteps: 10, headless: true, username: 'ci-user', accessKey: 'SECRETKEY-1234567890' };

let server, base, ctx;
const jar = {};
async function api(method, url, body, who = 'a', headers = {}) {
  const res = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(jar[who] ? { Cookie: jar[who] } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie');
  if (sc) jar[who] = sc.split(';')[0];
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.arrayBuffer(), headers: res.headers };
}
const settle = () => ctx.runner.idle();

before(async () => {
  ctx = createApp({ dataDir: path.join(tmp, 'data'), config });
  await new Promise((r) => { server = ctx.app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); ctx.db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

let pid, criteria;
test('auth: signup, session, validation, isolation', async () => {
  assert.equal((await api('GET', '/api/projects', null, 'anon')).status, 401);
  assert.equal((await api('POST', '/api/auth/signup', { email: 'a@example.com', name: 'A', password: 'short' })).status, 400);
  assert.equal((await api('POST', '/api/auth/signup', { email: 'a@example.com', name: 'Ada', password: 'correct-horse' })).status, 200);
  assert.equal((await api('POST', '/api/auth/signup', { email: 'a@example.com', name: 'Ada', password: 'correct-horse' }, 'x')).status, 409);
  assert.equal((await api('POST', '/api/auth/login', { email: 'a@example.com', password: 'wrong-password' }, 'x')).status, 401);
  assert.equal((await api('GET', '/api/auth/me')).body.user.email, 'a@example.com');
  assert.match(jar.a, /^sp_session=/);
});

test('project + requirement decomposition produce stable criterion ids', async () => {
  assert.equal((await api('POST', '/api/projects', { name: 'Shop', appUrl: 'javascript:alert(1)' })).status, 400);
  const p = await api('POST', '/api/projects', { name: 'Shop', appUrl: 'http://localhost:4100/' });
  assert.equal(p.status, 201);
  pid = p.body.project.id;
  assert.equal(p.body.project.gate.verdict, 'unverified');
  const prev = await api('POST', '/api/decompose', { text: 'A user can register an account, log in again and add items to the cart.' });
  assert.equal(prev.body.criteria.length, 3);
  const r = await api('POST', `/api/projects/${pid}/requirements`, { text: '- Product list shows prices.\n- Applying coupon SAVE10 makes the order total $72.00.\n- The order remains listed after reloading the page.' });
  criteria = r.body.criteria;
  assert.deepEqual(criteria.map((c) => c.key), ['AC-001', 'AC-002', 'AC-003']);
  assert.deepEqual(criteria.map((c) => c.status), ['untested', 'untested', 'untested']);
  assert.equal(criteria[2].category, 'persistence');
});

test('unauthenticated Kane CLI is an execution error, never a pass', async () => {
  setState({ mode: 'unauthenticated' });
  const r = await api('POST', `/api/projects/${pid}/runs`, {});
  assert.equal(r.status, 202);
  await settle();
  const run = (await api('GET', `/api/runs/${r.body.run.id}`)).body;
  assert.equal(run.run.status, 'completed');
  assert.ok(run.results.every((x) => x.status === 'error' && x.errorKind === 'auth' && x.exitCode === 1));
  const proj = (await api('GET', `/api/projects/${pid}`)).body;
  assert.equal(proj.project.gate.verdict, 'unverified');
  assert.equal(proj.project.gate.totals.blocked, 3);
  assert.equal(proj.repairTasks.length, 0, 'environment errors are not application defects');
});

let failedRunId, taskId;
test('genuine failure blocks the release and opens a repair task with evidence', async () => {
  setState({ mode: 'ok', failWhen: ['SAVE10'] });
  const r = await api('POST', `/api/projects/${pid}/runs`, {});
  failedRunId = r.body.run.id;
  await settle();
  const run = (await api('GET', `/api/runs/${failedRunId}`)).body;
  assert.deepEqual(run.results.map((x) => x.status), ['passed', 'failed', 'passed']);
  const failed = run.results[1];
  assert.equal(failed.exitCode, 1);
  assert.deepEqual(failed.failingStep, { step: 2, remark: 'Order total shows $80.00, expected $72.00' });
  assert.ok(failed.evidence.some((e) => e.kind === 'screenshot'), 'screenshot written by the engine is collected');
  const shot = failed.evidence.find((e) => e.kind === 'screenshot');
  const file = await api('GET', `/api/evidence/${shot.id}/file`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
  const full = (await api('GET', `/api/runs/${failedRunId}/results/${failed.id}`)).body.result;
  assert.ok(full.command.includes('--agent') && full.command.includes('--headless') && full.command.includes('«redacted»'));
  assert.ok(!JSON.stringify(full).includes('SECRETKEY-1234567890'), 'access key never reaches the API response');
  const events = (await api('GET', `/api/runs/${failedRunId}/events`)).body.events;
  assert.ok(events.some((e) => e.kind === 'kane' && e.payload.type === 'run_end'));
  assert.ok(!JSON.stringify(events).includes('SECRETKEY-1234567890'), 'access key is redacted from the live event stream');
  const proj = (await api('GET', `/api/projects/${pid}`)).body;
  assert.equal(proj.project.gate.verdict, 'blocked');
  assert.equal(proj.repairTasks.length, 1);
  taskId = proj.repairTasks[0].id;
  assert.equal(proj.repairTasks[0].status, 'open');
  assert.match(proj.repairTasks[0].prompt, /do NOT edit, weaken or delete/);
  assert.match(proj.repairTasks[0].observed, /\$80\.00/);
});

test('a failing criterion cannot be reworded, made optional or deleted', async () => {
  const c = criteria[1];
  assert.equal((await api('PATCH', `/api/projects/${pid}/criteria/${c.id}`, { text: 'Applying coupon SAVE10 shows a message.' })).status, 409);
  assert.equal((await api('PATCH', `/api/projects/${pid}/criteria/${c.id}`, { mandatory: false })).status, 409);
  assert.equal((await api('DELETE', `/api/projects/${pid}/criteria/${c.id}`)).status, 409);
});

test('claiming a fix without fixing keeps the gate blocked', async () => {
  const r = await api('POST', `/api/repair-tasks/${taskId}/fix-applied`, { note: 'should be fixed' });
  assert.equal(r.status, 202);
  await settle();
  const proj = (await api('GET', `/api/projects/${pid}`)).body;
  assert.equal(proj.project.gate.verdict, 'blocked');
  assert.equal(proj.repairTasks[0].status, 'open');
  assert.equal(proj.repairTasks[0].failures, 2);
});

test('after a real fix the re-run passes, the task is verified and both runs are preserved', async () => {
  setState({ mode: 'ok', failWhen: [] });
  const r = await api('POST', `/api/repair-tasks/${taskId}/fix-applied`, { note: 'total = subtotal - discount' });
  await settle();
  const proj = (await api('GET', `/api/projects/${pid}`)).body;
  assert.equal(proj.project.gate.verdict, 'verified');
  assert.deepEqual(proj.project.gate.totals, { total: 3, verified: 3, failed: 0, blocked: 0, untested: 0, mandatory: 3, mandatoryVerified: 3 });
  assert.equal(proj.repairTasks[0].status, 'verified');
  assert.equal(proj.repairTasks[0].verifiedBy.run_id, r.body.run.id);
  const old = (await api('GET', `/api/runs/${failedRunId}`)).body;
  assert.equal(old.results[1].status, 'failed', 'failed run is still in history');
  const hist = (await api('GET', `/api/projects/${pid}/criteria/${criteria[1].id}/history`)).body.history;
  assert.deepEqual(hist.map((h) => h.status), ['passed', 'failed', 'failed', 'error']);
});

test('editing a verified criterion resets it to untested (evidence is bound to the text)', async () => {
  const c = criteria[0];
  const r = await api('PATCH', `/api/projects/${pid}/criteria/${c.id}`, { text: 'Product list shows prices and names.' });
  assert.equal(r.body.criteria[0].status, 'untested');
  assert.equal((await api('GET', `/api/projects/${pid}`)).body.project.gate.verdict, 'unverified');
  await api('PATCH', `/api/projects/${pid}/criteria/${c.id}`, { text: c.text });
  assert.equal((await api('GET', `/api/projects/${pid}`)).body.project.gate.verdict, 'verified');
});

test('exit code and status must agree', async () => {
  setState({ mode: 'ok', failWhen: [], exitOverride: 1 });
  const r = await api('POST', `/api/projects/${pid}/runs`, { criterionIds: [criteria[0].id] });
  await settle();
  const run = (await api('GET', `/api/runs/${r.body.run.id}`)).body;
  assert.equal(run.results[0].status, 'error');
  assert.equal(run.results[0].errorKind, 'inconsistent');
  setState({ mode: 'ok', failWhen: [] });
  await api('POST', `/api/projects/${pid}/runs`, { mode: 'failed' });
  await settle();
  assert.equal((await api('GET', `/api/projects/${pid}`)).body.project.gate.verdict, 'verified');
});

test('cancel kills a hanging engine process and records it as not verified', async () => {
  setState({ mode: 'hang' });
  const r = await api('POST', `/api/projects/${pid}/runs`, { criterionIds: [criteria[0].id, criteria[2].id] });
  await new Promise((res) => setTimeout(res, 600));
  assert.equal((await api('POST', `/api/runs/${r.body.run.id}/cancel`)).status, 200);
  await settle();
  const run = (await api('GET', `/api/runs/${r.body.run.id}`)).body;
  assert.equal(run.run.status, 'cancelled');
  assert.deepEqual(run.results.map((x) => x.status), ['cancelled', 'cancelled']);
  // cancelled checks do not overwrite earlier evidence, and do not create a pass
  assert.equal((await api('GET', `/api/projects/${pid}`)).body.project.gate.verdict, 'verified');
});

test('shareable report: public by token, revocable, no logs or secrets', async () => {
  const s = await api('POST', `/api/projects/${pid}/share`, {});
  const token = s.body.shareToken;
  const pub = await api('GET', `/api/public/report/${token}`, null, 'anon');
  assert.equal(pub.status, 200);
  assert.equal(pub.body.report.gate.verdict, 'verified');
  assert.equal(pub.body.report.repairs[0].status, 'verified');
  assert.ok(pub.body.report.criteria[1].trail.some((t) => t.status === 'failed') && pub.body.report.criteria[1].trail.at(-1).status === 'passed');
  assert.ok(!JSON.stringify(pub.body).includes('stdout'));
  await api('DELETE', `/api/projects/${pid}/share`);
  assert.equal((await api('GET', `/api/public/report/${token}`, null, 'anon')).status, 404);
});

test('coding-agent API: key auth, repair tasks, gate', async () => {
  assert.equal((await api('GET', '/api/agent/gate', null, 'anon')).status, 401);
  const k = (await api('POST', `/api/projects/${pid}/api-key`, {})).body.apiKey;
  const g = await api('GET', '/api/agent/gate', null, 'anon', { Authorization: `Bearer ${k}` });
  assert.equal(g.body.gate.verdict, 'verified');
  assert.deepEqual((await api('GET', '/api/agent/repair-tasks', null, 'anon', { Authorization: `Bearer ${k}` })).body.tasks, []);
});

test('tenants cannot read each other\'s projects, runs, tasks or evidence', async () => {
  await api('POST', '/api/auth/signup', { email: 'b@example.com', name: 'Bo', password: 'another-pass' }, 'b');
  assert.equal((await api('GET', `/api/projects/${pid}`, null, 'b')).status, 404);
  assert.equal((await api('GET', `/api/runs/${failedRunId}`, null, 'b')).status, 404);
  assert.equal((await api('GET', `/api/repair-tasks/${taskId}`, null, 'b')).status, 404);
  assert.equal((await api('GET', `/api/evidence/1/file`, null, 'b')).status, 404);
  assert.equal((await api('POST', `/api/projects/${pid}/runs`, {}, 'b')).status, 404);
  assert.deepEqual((await api('GET', '/api/projects', null, 'b')).body.projects, []);
});

test('secret variables are write-only', async () => {
  await api('PUT', `/api/projects/${pid}/variables/password`, { value: 'Hunter2-secret', secret: true });
  await api('PUT', `/api/projects/${pid}/variables/username`, { value: 'qa@example.com' });
  const v = (await api('GET', `/api/projects/${pid}`)).body.variables;
  assert.deepEqual(v, [{ key: 'password', secret: true, value: null }, { key: 'username', secret: false, value: 'qa@example.com' }]);
});
