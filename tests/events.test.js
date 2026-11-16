// Event-triggered continuous monitoring: GitHub workflow_run and deployment_status deliveries → durable ledger →
// serial worker → the existing Continuous Watch assessment. Engine: TEST-ONLY stand-in tests/fixtures/fake-kane.js.
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
import { normalize, redact, MAX_ATTEMPTS } from '../server/events.js';

process.env.LOG_LEVEL = 'silent';
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shipproof-events-'));
const stateFile = path.join(tmp, 'state.json'); process.env.FAKE_KANE_STATE = stateFile;
const setState = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));
setState({ mode: 'ok', failWhen: [] });
const config = { bin: path.join(here, 'fixtures', 'fake-kane.js'), timeout: 30, maxSteps: 10, headless: true, username: '', accessKey: '', requireEvidence: true, allowPrivateTargets: true, acceptFixtureEngine: true };
const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const SHA1 = sha('release-1'), SHA2 = sha('release-2'), SHA3 = sha('unknown');
let n = 0; const open = [];

async function boot() {
  const ctx = createApp({ dataDir: path.join(tmp, `d${++n}`), config, watchOptions: { tickMs: 0 }, eventOptions: { autoKick: false, tickMs: 0 } });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`, jar = {};
  const mk = (who, email) => { const t = crypto.randomBytes(32).toString('base64url');
    const uid = Number(ctx.db.run('INSERT INTO users (email, name, pass_hash, created_at) VALUES (?, ?, ?, ?)', email, who, hashPassword('correct-horse'), 't').lastInsertRowid);
    ctx.db.run('INSERT INTO sessions VALUES (?, ?, ?)', hashToken(t), uid, new Date(Date.now() + 3600e3).toISOString()); jar[who] = `sp_session=${t}`; };
  mk('a', 'a@example.com'); mk('b', 'b@example.com');
  const api = async (method, url, body, who = 'a') => { const res = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: jar[who] }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() }; };
  const S = { ...ctx, base, api, stop: async () => { server.close(); server.closeAllConnections?.(); await ctx.shutdown(); } };
  open.push(S); return S;
}
let target = null, targetUrl = '';
const startTarget = () => (target ? Promise.resolve() : new Promise((r) => { target = http.createServer((q, s) => s.end('ok')).listen(0, '127.0.0.1', () => { targetUrl = `http://127.0.0.1:${target.address().port}/`; r(); }); }));
after(async () => { for (const S of open) await S.stop(); target?.closeAllConnections?.(); await new Promise((r) => (target ? target.close(r) : r())); fs.rmSync(tmp, { recursive: true, force: true }); });

async function project(S, text = 'The catalogue lists the Trail Backpack.\nCoupon SAVE10 reduces the total.') {
  await startTarget();
  const pid = (await S.api('POST', '/api/projects', { name: `P${++n}`, appUrl: targetUrl })).body.project.id;
  await S.api('POST', `/api/projects/${pid}/requirements`, { text });
  const secret = (await S.api('POST', `/api/projects/${pid}/webhook`, {})).body.secret;
  return { pid, secret };
}
const enable = (S, pid, events = { enabled: true, workflowRun: true, deployment: true }) => S.api('PUT', `/api/projects/${pid}/watch`, { events });
const sign = (raw, secret) => 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
async function wh(S, pid, secret, event, body, opts = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const delivery = opts.delivery ?? `del-${crypto.randomUUID()}`;
  const res = await fetch(`${S.base}/api/webhooks/github/${pid}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': event, 'X-GitHub-Delivery': delivery,
    'X-Hub-Signature-256': opts.sig ?? sign(raw, secret) }, body: raw });
  return { status: res.status, body: await res.json().catch(() => ({})), delivery };
}
const wrun = (o = {}) => ({ action: o.action ?? 'completed', repository: { full_name: o.repo ?? 'acme/shop' },
  workflow_run: { id: o.id ?? 1001, name: o.name ?? 'CI', head_sha: o.sha ?? SHA1, head_branch: 'main', conclusion: (o.action ?? 'completed') === 'completed' ? (o.conclusion ?? 'success') : null,
    status: (o.action ?? 'completed') === 'completed' ? 'completed' : 'in_progress', html_url: 'https://github.com/acme/shop/actions/runs/1001', updated_at: new Date().toISOString() } });
const dep = (o = {}) => ({ action: 'created', repository: { full_name: 'acme/shop' }, deployment: { id: o.id ?? 2001, sha: o.sha ?? SHA1, environment: o.env ?? 'production', ref: 'main', description: 'deploy' },
  deployment_status: { state: o.state ?? 'success', environment_url: o.url ?? 'https://shop.example.com/', description: 'Deployed', updated_at: new Date().toISOString() } });
const build = (S, pid, commitSha, environment = 'production') => S.api('POST', `/api/projects/${pid}/builds`, { commitSha, environment });
const checks = (S, pid) => S.db.all('SELECT id, trigger, event_id FROM watch_checks WHERE project_id = ? ORDER BY id', pid);
const ev = (S, id) => S.db.get('SELECT * FROM watch_events WHERE id = ?', id);

test('events: scheduled and event-triggered monitoring are configured independently and both default to off', async () => {
  const S = await boot(); const { pid } = await project(S);
  let cfg = (await S.api('GET', `/api/projects/${pid}/watch`)).body.config;
  assert.deepEqual(cfg.events, { enabled: false, workflowRun: false, deployment: false });
  // scheduled monitoring does not silently enable events
  cfg = (await S.api('PUT', `/api/projects/${pid}/watch`, { enabled: true, intervalMinutes: 30 })).body.config;
  assert.equal(cfg.enabled, true); assert.equal(cfg.events.enabled, false);
  // events do not change the schedule or automatic verification
  cfg = (await S.api('PUT', `/api/projects/${pid}/watch`, { events: { workflowRun: true } })).body.config;
  assert.equal(cfg.enabled, true); assert.equal(cfg.intervalMinutes, 30); assert.equal(cfg.autoRun, false);
  assert.deepEqual(cfg.events, { enabled: false, workflowRun: true, deployment: false }, 'a subscription without the master switch stays inactive');
  for (const bad of [{ events: 'yes' }, { events: { enabled: 'true' } }, { events: { onPush: true } }]) assert.equal((await S.api('PUT', `/api/projects/${pid}/watch`, bad)).status, 400, JSON.stringify(bad));
  await S.stop();
});

test('events: a completed workflow run is persisted, acknowledged, assessed exactly once and linked to its check', async () => {
  await startTarget();
  const S = await boot(); const { pid, secret } = await project(S);
  await enable(S, pid); await build(S, pid, SHA1);
  const runsBefore = S.db.get('SELECT COUNT(*) n FROM runs').n, resultsBefore = S.db.get('SELECT COUNT(*) n FROM results').n;
  const r = await wh(S, pid, secret, 'workflow_run', wrun({ id: 1001 }));
  assert.equal(r.status, 202); assert.equal(r.body.eventStatus, 'queued');
  const row = ev(S, r.body.eventId);
  assert.equal(row.state, 'QUEUED'); assert.equal(row.source, 'github_workflow_run'); assert.equal(row.external_id, 1001); assert.equal(row.commit_sha, SHA1);
  assert.ok(row.build_id, 'correlated with the registered build');
  assert.equal(checks(S, pid).length, 0, 'acknowledged before any assessment');
  await S.events.drain();
  const done = ev(S, r.body.eventId);
  assert.equal(done.state, 'COMPLETED'); assert.ok(done.check_id); assert.equal(done.attempts, 1); assert.equal(done.error, null);
  const [c] = checks(S, pid); assert.equal(c.trigger, 'event'); assert.equal(c.event_id, r.body.eventId); assert.equal(c.id, done.check_id);
  const view = (await S.api('GET', `/api/projects/${pid}/watch/checks`)).body.checks[0];
  assert.equal(view.trigger, 'event'); assert.deepEqual([view.event.id, view.event.source, view.event.externalId, view.event.commitSha], [r.body.eventId, 'github_workflow_run', 1001, SHA1]);
  // a success is not proof: no results, no runs, no verdict change
  assert.equal(S.db.get('SELECT COUNT(*) n FROM runs').n, runsBefore); assert.equal(S.db.get('SELECT COUNT(*) n FROM results').n, resultsBefore);
  await S.stop();
});

test('events: duplicate deliveries are recognised before any effect and never create a second check', async () => {
  const S = await boot(); const { pid, secret } = await project(S);
  await enable(S, pid);
  const body = wrun({ id: 1002 });
  const first = await wh(S, pid, secret, 'workflow_run', body, { delivery: 'delivery-fixed-0001' });
  const again = await wh(S, pid, secret, 'workflow_run', body, { delivery: 'delivery-fixed-0001' });
  assert.equal(first.status, 202); assert.equal(again.status, 200); assert.equal(again.body.duplicate, true);
  assert.equal(S.db.get('SELECT COUNT(*) n FROM watch_events WHERE project_id = ?', pid).n, 1);
  assert.equal(ev(S, first.body.eventId).duplicates, 1);
  await S.events.drain(); await S.events.drain();
  assert.equal(checks(S, pid).length, 1, 'exactly one assessment');
  assert.equal(ev(S, first.body.eventId).state, 'COMPLETED');
  await S.stop();
});

test('events: invalid signatures, cross-project secrets, unsupported and intermediate events are refused or ignored', async () => {
  const S = await boot(); const A = await project(S), B = await project(S);
  await enable(S, A.pid);
  const body = wrun({ id: 1003 });
  assert.equal((await wh(S, A.pid, A.secret, 'workflow_run', body, { sig: 'sha256=' + '0'.repeat(64) })).status, 401);
  assert.equal((await wh(S, A.pid, A.secret, 'workflow_run', body, { sig: 'nonsense' })).status, 401);
  assert.equal((await wh(S, A.pid, B.secret, 'workflow_run', body)).status, 401, "project B's secret cannot authenticate for project A");
  assert.equal(S.db.get('SELECT COUNT(*) n FROM watch_events').n, 0, 'nothing persisted for rejected signatures');
  // malformed payloads are rejected and recorded as rejected deliveries (not queued)
  const noSha = wrun({ id: 1004 }); noSha.workflow_run.head_sha = 'not-a-sha';
  const bad = await wh(S, A.pid, A.secret, 'workflow_run', noSha);
  assert.equal(bad.status, 400); assert.match(bad.body.error, /head_sha/);
  assert.equal(S.db.get(`SELECT outcome FROM webhook_deliveries WHERE delivery_id = ?`, bad.delivery).outcome, 'rejected');
  assert.equal((await wh(S, A.pid, A.secret, 'deployment_status', { action: 'created' })).status, 400);
  assert.equal((await wh(S, A.pid, A.secret, 'workflow_run', 'not json at all')).status, 400);
  // intermediate and non-health conclusions are ignored with a reason
  const started = await wh(S, A.pid, A.secret, 'workflow_run', wrun({ action: 'requested', id: 1005 }));
  assert.equal(started.status, 202); assert.equal(started.body.eventStatus, 'ignored'); assert.match(started.body.reason, /intermediate/);
  const cancelled = await wh(S, A.pid, A.secret, 'workflow_run', wrun({ id: 1006, conclusion: 'cancelled' }));
  assert.equal(cancelled.body.eventStatus, 'ignored'); assert.match(cancelled.body.reason, /does not change project health/);
  // unsupported event types keep their existing treatment
  const issues = await wh(S, A.pid, A.secret, 'issues', { action: 'opened', repository: { full_name: 'acme/shop' } });
  assert.equal(issues.status, 202); assert.equal(issues.body.ignored, true);
  // a subscription that is off records the event as ignored, not queued
  await S.api('PUT', `/api/projects/${A.pid}/watch`, { events: { workflowRun: false } });
  const off = await wh(S, A.pid, A.secret, 'workflow_run', wrun({ id: 1007 }));
  assert.equal(off.body.eventStatus, 'ignored'); assert.match(off.body.reason, /subscription to GitHub Actions workflow_run is off/);
  await S.events.drain();
  assert.equal(checks(S, A.pid).length, 0, 'ignored events never start an assessment');
  assert.equal(S.db.get('SELECT COUNT(*) n FROM watch_events WHERE project_id = ? AND state = ?', A.pid, 'QUEUED').n, 0);
  // the other project's watch history is untouched
  assert.equal(S.db.get('SELECT COUNT(*) n FROM watch_events WHERE project_id = ?', B.pid).n, 0);
  await S.stop();
});

test('events: deployment states are distinguished and correlated to builds without inventing one', async () => {
  const S = await boot(); const { pid, secret } = await project(S);
  await enable(S, pid); await build(S, pid, SHA1, 'production');
  const ok = await wh(S, pid, secret, 'deployment_status', dep({ state: 'success', sha: SHA1, id: 2001 }));
  assert.equal(ok.body.eventStatus, 'queued'); assert.ok(ok.body.buildId, 'matched the registered production build');
  const failed = await wh(S, pid, secret, 'deployment_status', dep({ state: 'failure', sha: SHA2, id: 2002, env: 'staging' }));
  assert.equal(failed.body.eventStatus, 'queued'); assert.equal(failed.body.buildId, null, 'no registered build for this commit: none is invented');
  assert.equal(S.db.get('SELECT COUNT(*) n FROM builds WHERE commit_sha = ?', SHA2).n, 0, 'correlation never registers a build');
  for (const st of ['inactive', 'pending', 'in_progress', 'queued', 'waiting']) {
    const r = await wh(S, pid, secret, 'deployment_status', dep({ state: st, id: 2100 + st.length }));
    assert.equal(r.body.eventStatus, 'ignored', st);
  }
  assert.match((await wh(S, pid, secret, 'deployment_status', dep({ state: 'inactive', id: 2200 }))).body.reason, /superseded/);
  // invalid environment is rejected; a javascript: target URL is dropped, never stored or fetched
  const badEnv = dep({ id: 2300 }); badEnv.deployment.environment = 'prod uction; drop';
  assert.equal((await wh(S, pid, secret, 'deployment_status', badEnv)).status, 400);
  const jsUrl = await wh(S, pid, secret, 'deployment_status', dep({ id: 2301, url: 'javascript:alert(1)' }));
  assert.equal(jsUrl.body.eventStatus, 'queued');
  assert.equal(ev(S, jsUrl.body.eventId).target_url, null);
  await S.events.drain();
  assert.equal(S.db.get(`SELECT state FROM watch_events WHERE id = ?`, ok.body.eventId).state, 'COMPLETED');
  assert.equal(S.db.get(`SELECT state FROM watch_events WHERE id = ?`, failed.body.eventId).state, 'COMPLETED');
  // unit-level validation of the pure normaliser
  assert.equal(normalize('deployment_status', dep({ state: 'success' })).qualifies, true);
  assert.equal(normalize('workflow_run', wrun({ sha: 'zz' })).error, 'workflow_run.head_sha (commit) is missing or invalid');
  assert.equal(normalize('workflow_run', { ...wrun(), repository: undefined }).error, 'repository.full_name is missing or invalid');
  await S.stop();
});

test('events: release integrity — a green workflow or a successful deployment never changes criteria, results or the gate', async () => {
  await startTarget();
  const S = await boot(); const { pid, secret } = await project(S);
  await enable(S, pid); await build(S, pid, SHA1);
  await S.api('POST', `/api/projects/${pid}/runs`, {}); await S.runner.idle();
  const before = {
    results: S.db.get('SELECT COUNT(*) n FROM results').n,
    passed: S.db.get(`SELECT COUNT(*) n FROM results WHERE status = 'passed'`).n,
    runs: S.db.get('SELECT COUNT(*) n FROM runs').n,
    verdict: (await S.api('GET', `/api/projects/${pid}/intelligence`)).body.decision.verdict,
    evidence: S.db.get('SELECT COUNT(*) n FROM evidence').n,
  };
  await wh(S, pid, secret, 'workflow_run', wrun({ id: 3001 }));
  await wh(S, pid, secret, 'deployment_status', dep({ id: 3002, state: 'success' }));
  await S.events.drain();
  const after = {
    results: S.db.get('SELECT COUNT(*) n FROM results').n, passed: S.db.get(`SELECT COUNT(*) n FROM results WHERE status = 'passed'`).n,
    runs: S.db.get('SELECT COUNT(*) n FROM runs').n, verdict: (await S.api('GET', `/api/projects/${pid}/intelligence`)).body.decision.verdict,
    evidence: S.db.get('SELECT COUNT(*) n FROM evidence').n,
  };
  assert.deepEqual(after, before, 'no event added results, runs or evidence, and the verdict is what the strict gate says');
  assert.equal(checks(S, pid).length, 2, 'both events were assessed by the Watch');
  await S.stop();
});

test('events: automatic verification runs only when opted in, exactly as for scheduled checks', async () => {
  await startTarget();
  const S = await boot(); const { pid, secret } = await project(S);
  await enable(S, pid);
  // not opted in: the event assessment produces the verify step but starts no Kane run
  const r1 = await wh(S, pid, secret, 'workflow_run', wrun({ id: 4001 }));
  await S.events.drain();
  const c1 = S.db.get('SELECT * FROM watch_checks WHERE event_id = ?', r1.body.eventId);
  const plan1 = JSON.parse(c1.plan_json);
  assert.equal(plan1.steps.find((s) => s.type === 'verify').automatic, true, 'the plan is eligible');
  assert.equal(S.db.get('SELECT COUNT(*) n FROM runs').n, 0, 'but nothing ran without autoRun');
  // opted in: the event-triggered check starts the verification its plan asks for
  await S.api('PUT', `/api/projects/${pid}/watch`, { autoRun: true });
  const r2 = await wh(S, pid, secret, 'workflow_run', wrun({ id: 4002 }));
  await S.events.drain();
  const run = S.db.get(`SELECT * FROM runs WHERE project_id = ? ORDER BY id DESC LIMIT 1`, pid);
  assert.ok(run, 'a run was started'); assert.equal(run.trigger, 'watch_auto');
  await S.runner.waitForRun(run.id);
  assert.equal(S.db.get('SELECT started_run_id r FROM watch_checks WHERE event_id = ?', r2.body.eventId).r, run.id);
  await S.stop();
});

test('events: a worker that is interrupted is recovered without processing twice; failures are bounded and recoverable', async () => {
  const S = await boot(); const { pid, secret } = await project(S);
  await enable(S, pid);
  // (a) interrupted before its check was persisted → requeued on recovery, then processed once
  const r = await wh(S, pid, secret, 'workflow_run', wrun({ id: 5001 }));
  S.db.run(`UPDATE watch_events SET state = 'PROCESSING', attempts = 1, processing_started_at = ? WHERE id = ?`, new Date().toISOString(), r.body.eventId);
  assert.equal(S.events.recover(), 1);
  assert.equal(ev(S, r.body.eventId).state, 'QUEUED');
  await S.events.drain();
  assert.equal(ev(S, r.body.eventId).state, 'COMPLETED'); assert.equal(checks(S, pid).length, 1);
  // (b) interrupted after its check was persisted → recovery never assesses it again
  const r2 = await wh(S, pid, secret, 'workflow_run', wrun({ id: 5002 }));
  const checkId = S.db.run(`INSERT INTO watch_checks (project_id, trigger, health, variables_json, plan_json, counts_json, started_at, finished_at, event_id) VALUES (?, 'event', 'healthy', '{}', '{"blocked":false,"steps":[]}', '{}', ?, ?, ?)`,
    pid, new Date().toISOString(), new Date().toISOString(), r2.body.eventId).lastInsertRowid;
  S.db.run(`UPDATE watch_events SET state = 'PROCESSING', attempts = 1 WHERE id = ?`, r2.body.eventId);
  S.events.recover(); await S.events.drain();
  assert.equal(ev(S, r2.body.eventId).state, 'COMPLETED'); assert.equal(Number(ev(S, r2.body.eventId).check_id), Number(checkId));
  assert.equal(checks(S, pid).length, 2, 'no duplicate check');
  // (c) repeated interruptions give up with a recorded reason
  const r3 = await wh(S, pid, secret, 'workflow_run', wrun({ id: 5003 }));
  S.db.run(`UPDATE watch_events SET state = 'PROCESSING', attempts = ? WHERE id = ?`, MAX_ATTEMPTS, r3.body.eventId);
  S.events.recover();
  assert.equal(ev(S, r3.body.eventId).state, 'FAILED'); assert.match(ev(S, r3.body.eventId).reason, /interrupted repeatedly/);
  // (d) an assessment that throws is retried with backoff, then fails permanently
  const r4 = await wh(S, pid, secret, 'workflow_run', wrun({ id: 5004 }));
  const orig = S.watch.runCheck;
  S.watch.runCheck = async () => { throw new Error(`boom with whsec_${'x'.repeat(20)} inside`); };
  try {
    await S.events.drain();
    let row = ev(S, r4.body.eventId);
    assert.equal(row.state, 'QUEUED'); assert.equal(row.attempts, 1); assert.ok(Date.parse(row.not_before) > Date.now() + 10_000, 'backoff applied');
    assert.doesNotMatch(row.error, /whsec_x/, 'secrets are redacted from stored errors');
    await S.events.drain(); assert.equal(ev(S, r4.body.eventId).attempts, 1, 'not yet due: nothing is retried early');
    for (let i = 0; i < 5; i++) { S.db.run(`UPDATE watch_events SET not_before = NULL WHERE id = ?`, r4.body.eventId); await S.events.drain(); }
    row = ev(S, r4.body.eventId);
    assert.equal(row.state, 'FAILED'); assert.equal(row.attempts, MAX_ATTEMPTS); assert.match(row.reason, /failed 3 times/);
  } finally { S.watch.runCheck = orig; }
  // (e) a busy project defers the event without spending an attempt, and it is still processed later
  const r5 = await wh(S, pid, secret, 'workflow_run', wrun({ id: 5005 }));
  S.watch.runCheck = async () => { throw Object.assign(new Error('A watch check is already running for this project'), { status: 409 }); };
  try { await S.events.drain(); } finally { S.watch.runCheck = orig; }
  let row = ev(S, r5.body.eventId);
  assert.equal(row.state, 'QUEUED'); assert.equal(row.attempts, 0, 'busy is not a failure'); assert.ok(row.not_before);
  S.db.run(`UPDATE watch_events SET not_before = NULL WHERE id = ?`, r5.body.eventId);
  await S.events.drain();
  assert.equal(ev(S, r5.body.eventId).state, 'COMPLETED');
  await S.stop();
});

test('events: concurrent events for one project are assessed one at a time and each keeps its own check', async () => {
  const S = await boot(); const { pid, secret } = await project(S);
  await enable(S, pid);
  const ids = [];
  for (const id of [6001, 6002, 6003]) ids.push((await wh(S, pid, secret, 'deployment_status', dep({ id, state: 'success' }))).body.eventId);
  let inFlight = 0, peak = 0; const orig = S.watch.runCheck;
  S.watch.runCheck = async (...a) => { inFlight++; peak = Math.max(peak, inFlight); try { return await orig(...a); } finally { inFlight--; } };
  try { await Promise.all([S.events.drain(), S.events.drain(), S.events.drain()]); } finally { S.watch.runCheck = orig; }
  assert.equal(peak, 1, 'never more than one assessment in flight');
  assert.deepEqual(ids.map((id) => ev(S, id).state), ['COMPLETED', 'COMPLETED', 'COMPLETED']);
  assert.deepEqual(checks(S, pid).map((c) => c.event_id), ids, 'one check per event, in arrival order');
  await S.stop();
});

test('events: history lists accepted, ignored, duplicate and push deliveries, never secrets, and is owner-scoped', async () => {
  const S = await boot(); const { pid, secret } = await project(S);
  await enable(S, pid);
  const r = await wh(S, pid, secret, 'workflow_run', wrun({ id: 7001 }));
  await wh(S, pid, secret, 'workflow_run', wrun({ id: 7001 }), { delivery: r.delivery });
  await wh(S, pid, secret, 'workflow_run', wrun({ action: 'in_progress', id: 7002 }));
  await wh(S, pid, secret, 'push', { ref: 'refs/heads/main', after: SHA2, before: '0'.repeat(40), commits: [{ id: SHA2, added: ['a.js'], modified: [], removed: [] }], repository: { full_name: 'acme/shop' } });
  await S.events.drain();
  const h = (await S.api('GET', `/api/projects/${pid}/watch/events`)).body;
  const states = h.events.map((e) => `${e.event}:${e.state}`);
  assert.ok(states.includes('workflow_run:COMPLETED'), states.join(', '));
  assert.ok(states.includes('workflow_run:IGNORED'));
  assert.ok(h.events.some((e) => e.kind === 'delivery' && e.event === 'push'), 'push deliveries are part of the history');
  assert.equal(h.events.find((e) => e.id === r.body.eventId).duplicates, 1);
  assert.equal((await S.api('GET', `/api/projects/${pid}/watch/events?state=COMPLETED`)).body.events.every((e) => e.state === 'COMPLETED'), true);
  assert.equal((await S.api('GET', `/api/projects/${pid}/watch/events?state=NOPE`)).status, 400);
  const json = JSON.stringify(h);
  assert.doesNotMatch(json, /whsec_|sha256=|X-Hub-Signature|pass_hash/, 'no secrets or signatures in the history');
  assert.equal((await S.api('GET', `/api/projects/${pid}/watch/events`, null, 'b')).status, 404, 'another tenant cannot read it');
  await S.stop();
});

test('events: pure normaliser and redaction', () => {
  assert.equal(normalize('workflow_run', wrun({ conclusion: 'failure' })).outcome, 'failure');
  assert.equal(normalize('workflow_run', wrun({ conclusion: 'timed_out' })).qualifies, true);
  assert.equal(normalize('workflow_run', { ...wrun(), workflow_run: { ...wrun().workflow_run, id: -1 } }).error, 'workflow_run.id is missing or invalid');
  assert.equal(normalize('workflow_run', 'x').error, 'payload must be a JSON object');
  assert.equal(redact('token whsec_abcdef and sha256=' + 'f'.repeat(64)), 'token [redacted] and [redacted]');
});

test('events: webhook deliveries are rate limited per source', async () => {
  const S = await boot(); const { pid, secret } = await project(S);
  let limited = 0;
  for (let i = 0; i < 125; i++) { const r = await wh(S, pid, secret, 'ping', { zen: 'x' }); if (r.status === 429) limited++; }
  assert.ok(limited >= 1, 'requests beyond the per-source limit are refused');
  await S.stop();
});
