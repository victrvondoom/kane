// Continuous watch: variables → scenario → cause findings, tracked over time, with a derived workflow.
// OFFLINE: the engine is the labelled fake-kane stand-in.
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
import { buildPlan, cleanThresholds } from '../server/watch.js';

process.env.LOG_LEVEL = 'silent';
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shipproof-watch-'));
const stateFile = path.join(tmp, 'state.json'); process.env.FAKE_KANE_STATE = stateFile;
const setState = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));
const config = { bin: path.join(here, 'fixtures', 'fake-kane.js'), timeout: 30, maxSteps: 10, headless: true, username: '', accessKey: '', requireEvidence: true, allowPrivateTargets: true, acceptFixtureEngine: true };
let n = 0; const open = [];
async function boot(extra = {}) {
  const ctx = createApp({ dataDir: path.join(tmp, `d${++n}`), config: { ...config, ...extra.config }, watchOptions: { tickMs: 0, ...extra.watchOptions } });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`, jar = {};
  const mk = (who, email) => { const t = crypto.randomBytes(32).toString('base64url');
    const uid = Number(ctx.db.run('INSERT INTO users (email, name, pass_hash, created_at) VALUES (?, ?, ?, ?)', email, who, hashPassword('correct-horse'), 't').lastInsertRowid);
    ctx.db.run('INSERT INTO sessions VALUES (?, ?, ?)', hashToken(t), uid, new Date(Date.now() + 3600e3).toISOString()); jar[who] = `sp_session=${t}`; };
  mk('a', 'a@example.com'); mk('b', 'b@example.com');
  const api = async (method, url, body, who = 'a') => { const res = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: jar[who] }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() }; };
  const S = { ...ctx, api, stop: async () => { server.close(); server.closeAllConnections?.(); await ctx.shutdown(); } };
  open.push(S); return S;
}
// a real target the watch can reach (and that can go down)
let target = null, targetUrl = '';
const startTarget = () => new Promise((r) => { target = http.createServer((q, s) => s.end('ok')).listen(targetUrl ? Number(new URL(targetUrl).port) : 0, '127.0.0.1', () => { targetUrl = `http://127.0.0.1:${target.address().port}/`; r(); }); });
const stopTarget = () => new Promise((r) => { target.closeAllConnections?.(); target.close(r); });
after(async () => { for (const S of open) await S.stop(); await stopTarget().catch(() => {}); fs.rmSync(tmp, { recursive: true, force: true }); });

async function project(S, text = 'The catalogue lists the Trail Backpack.\nCoupon SAVE10 reduces the total.') {
  const pid = (await S.api('POST', '/api/projects', { name: `P${++n}`, appUrl: targetUrl })).body.project.id;
  await S.api('POST', `/api/projects/${pid}/requirements`, { text }); return pid;
}
const check = async (S, pid) => { const r = await S.api('POST', `/api/projects/${pid}/watch/check`, {}); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.check; };
const run = async (S, pid) => { const id = (await S.api('POST', `/api/projects/${pid}/runs`, {})).body.run.id; await S.runner.waitForRun(id); return id; };
const vars = (c) => c.findings.filter((f) => f.severity !== 'info').map((f) => f.variable);

test('watch: findings follow live state across checks (new → persisting → resolved) and the plan is derived from them', async () => {
  await startTarget();
  const S = await boot();
  const pid = await project(S);
  // 1. nothing verified yet → evidence findings, an automatic verify step for exactly those criteria
  const c1 = await check(S, pid);
  assert.equal(c1.health, 'degraded');
  const ev1 = c1.findings.filter((f) => f.severity !== 'info'); // the stand-in engine is itself reported, as info
  assert.equal(ev1.length, 2); assert.equal(c1.findings.find((f) => f.severity === 'info').variable, 'engine.state');
  assert.ok(ev1.every((f) => f.variable && f.scenario && f.cause && f.origin === 'evidence' && f.value === 'UNVERIFIED' && f.trend === 'new'));
  assert.equal(c1.variables['target.reachable'], true); assert.equal(c1.variables['engine.state'], 'test_fixture');
  const step = c1.plan.steps.find((s) => s.type === 'verify');
  assert.equal(step.automatic, true); assert.equal(step.criterionIds.length, 2);
  // 2. execute the plan: a real run is queued for those criteria; a second execution is refused
  setState({ mode: 'ok', failWhen: ['SAVE10'] });
  const ex = await S.api('POST', `/api/projects/${pid}/watch/checks/${c1.id}/execute`, {});
  assert.equal(ex.body.started, true); assert.deepEqual(ex.body.criterionIds.sort(), step.criterionIds.sort());
  assert.equal((await S.api('POST', `/api/projects/${pid}/watch/checks/${c1.id}/execute`, {})).status, 409);
  await S.runner.waitForRun(ex.body.runId);
  assert.equal(S.db.get('SELECT trigger FROM runs WHERE id = ?', ex.body.runId).trigger, 'watch_manual');
  // 3. one passes, one fails → evidence findings resolve, an application finding appears
  const c2 = await check(S, pid);
  assert.equal(c2.counts.resolved, 1); assert.deepEqual(vars(c2), ['criterion.AC-002.state']);
  assert.equal(c2.findings[0].value, 'FAILED'); assert.equal(c2.findings[0].trend, 'persisting', 'same variable, new value and cause');
  assert.equal(c2.findings[0].origin, 'application'); assert.equal(c2.findings[0].action.type, 'replay');
  // 4. fails again → recurring failure with a streak and a repair step; same finding key keeps its history
  await run(S, pid);
  const c3 = await check(S, pid);
  const streak = c3.findings.find((f) => f.variable === 'criterion.AC-002.failureStreak');
  assert.equal(streak.value, 2); assert.match(streak.cause, /\$80\.00/); assert.equal(streak.severity, 'high');
  assert.ok(c3.plan.steps.some((s) => s.type === 'repair' && s.criterionId === streak.criterionId && s.automatic === false));
  await run(S, pid);
  const c4 = await check(S, pid);
  const again = c4.findings.find((f) => f.variable === 'criterion.AC-002.failureStreak');
  assert.equal(again.value, 3); assert.equal(again.trend, 'persisting'); assert.equal(again.occurrences, 2); assert.equal(again.firstSeen, c3.startedAt);
  // 5. the application is fixed → everything resolves, healthy, empty plan
  setState({ mode: 'ok', failWhen: [] }); await run(S, pid);
  const c5 = await check(S, pid);
  assert.equal(c5.health, 'healthy'); assert.deepEqual(c5.plan, { blocked: false, steps: [] }); assert.ok(c5.counts.resolved >= 1);
  // 6. it breaks again → the same finding is reopened, not duplicated
  setState({ mode: 'ok', failWhen: ['SAVE10'] }); await run(S, pid); await run(S, pid);
  const c6 = await check(S, pid);
  assert.equal(c6.findings.find((f) => f.variable === 'criterion.AC-002.failureStreak').trend, 'reopened');
  const all = (await S.api('GET', `/api/projects/${pid}/watch/findings`)).body.findings;
  assert.equal(new Set(all.map((f) => f.fingerprint)).size, all.length);
  assert.equal((await S.api('GET', `/api/projects/${pid}/watch/findings?status=resolved`)).body.findings.every((f) => f.status === 'resolved'), true);
  const tr = (await S.api('GET', `/api/projects/${pid}/watch/trend`)).body;
  assert.deepEqual(tr.checks.map((c) => c.health), ['degraded', 'degraded', 'degraded', 'degraded', 'healthy', 'degraded']);
  assert.equal(tr.series['executions.sample'].length, 6);
  await S.stop();
});

test('watch: harness and environment problems are found, attributed to their cause, and gate the workflow', async () => {
  const S = await boot();
  const pid = await project(S, 'The catalogue lists the Trail Backpack.');
  // engine cannot authenticate: three executions without a verdict
  setState({ mode: 'unauthenticated' }); for (let i = 0; i < 3; i++) await run(S, pid);
  const c1 = await check(S, pid);
  const h = c1.findings.find((f) => f.variable === 'executions.noVerdictRate');
  assert.equal(h.origin, 'harness'); assert.equal(h.value, 1); assert.match(h.cause, /authentication \(3\)/);
  assert.equal(c1.health, 'blocked'); assert.equal(c1.plan.steps[0].type, 'fix_harness');
  assert.equal(c1.plan.steps.find((s) => s.type === 'verify').automatic, false);
  assert.equal((await S.api('POST', `/api/projects/${pid}/watch/checks/${c1.id}/execute`, {})).body.started, false, 'a blocked plan never starts runs');
  assert.equal(c1.findings.some((f) => f.origin === 'application'), false, 'no application defect is inferred from harness errors');
  // thresholds are per-project: raising the bar removes the finding, lowering the sample keeps it
  await S.api('PUT', `/api/projects/${pid}/watch`, { thresholds: { minSample: 10 } });
  assert.equal(vars(await check(S, pid)).includes('executions.noVerdictRate'), false);
  await S.api('PUT', `/api/projects/${pid}/watch`, { thresholds: {} });
  // target goes down
  await stopTarget();
  const c3 = await check(S, pid);
  const t = c3.findings.find((f) => f.variable === 'target.reachable');
  assert.equal(t.origin, 'environment'); assert.equal(t.severity, 'blocking'); assert.match(t.cause, /ECONNREFUSED/);
  await startTarget();
  assert.equal(vars(await check(S, pid)).includes('target.reachable'), false);
  // engine unavailable (injected status) and a probe that throws are both reported, never swallowed
  const U = await boot({ watchOptions: { engineStatus: async () => ({ state: 'not_authenticated', version: '0.10.4', auth: 'not_authenticated', detail: 'Not logged in.' }), reach: async () => { throw new Error('boom'); } } });
  const up = await project(U);
  const cu = await check(U, up);
  assert.equal(cu.findings.find((f) => f.variable === 'engine.state').severity, 'blocking');
  assert.equal(cu.findings.find((f) => f.variable === 'probe.target').cause, 'boom');
  assert.equal(cu.health, 'blocked');
  await S.stop(); await U.stop();
});

test('watch: evidence tampering, missing files, stale repair tasks and interrupted workflows are detected', async () => {
  const S = await boot();
  const pid = await project(S, 'Coupon SAVE10 reduces the total.');
  setState({ mode: 'ok', failWhen: ['SAVE10'] }); await run(S, pid);
  const ev = S.db.all(`SELECT e.rel_path FROM evidence e WHERE e.rel_path IS NOT NULL ORDER BY e.id`);
  const root = path.join(S.db.get('PRAGMA database_list').file.replace(/[^/\\]+$/, ''), 'evidence');
  fs.appendFileSync(path.join(root, ev[0].rel_path), 'tampered'); fs.rmSync(path.join(root, ev[1].rel_path));
  S.db.run(`UPDATE repair_tasks SET created_at = '2020-01-01T00:00:00.000Z' WHERE project_id = ?`, pid);
  S.db.run(`INSERT INTO agent_executions (project_id, task_description, status, current_stage, reason, created_at, updated_at) VALUES (?, 't', 'INTERRUPTED', 'INTERRUPTED_DURING_VERIFYING', 'Server restarted.', 't', 't')`, pid);
  S.db.run(`INSERT INTO runs (project_id, trigger, status, created_at) VALUES (?, 'full', 'cancelled', 't')`, pid);
  const c = await check(S, pid);
  const by = Object.fromEntries(c.findings.map((f) => [f.variable, f]));
  assert.equal(by['evidence.tampered'].value, 1); assert.equal(by['evidence.tampered'].severity, 'blocking'); assert.equal(by['evidence.tampered'].files[0].problem, 'hash_mismatch');
  assert.equal(by['evidence.missing'].value, 1);
  assert.match(by['repairTasks.stale'].scenario, /RT-\d+ for AC-001/);
  assert.equal(by['workflow.last'].value, 'INTERRUPTED'); assert.equal(by['workflow.last'].cause, 'Server restarted.');
  assert.equal(c.health, 'blocked');
  await S.stop();
});

test('watch: schedule is persisted, runs only when due, auto-run is opt-in, and access is owner-scoped', async () => {
  const S = await boot();
  const pid = await project(S, 'The catalogue lists the Trail Backpack.');
  setState({ mode: 'ok', failWhen: [] });
  assert.deepEqual(await S.watch.tick(), [], 'disabled by default');
  for (const bad of [{ intervalMinutes: 0 }, { intervalMinutes: 1.5 }, { thresholds: { nope: 1 } }, { thresholds: { infraErrorRate: 2 } }]) assert.equal((await S.api('PUT', `/api/projects/${pid}/watch`, bad)).status, 400);
  const cfg = (await S.api('PUT', `/api/projects/${pid}/watch`, { enabled: true, intervalMinutes: 5 })).body.config;
  assert.equal(cfg.autoRun, false); assert.ok(Date.parse(cfg.nextDueAt) > Date.now());
  assert.deepEqual(await S.watch.tick(), [], 'not due yet');
  S.db.run(`UPDATE watch_config SET next_due_at = '2020-01-01T00:00:00.000Z' WHERE project_id = ?`, pid);
  const [c1] = await S.watch.tick();
  assert.equal(c1.trigger, 'schedule'); assert.equal(c1.execution, null, 'no credits spent without autoRun');
  assert.equal(S.db.get('SELECT COUNT(*) n FROM runs WHERE project_id = ?', pid).n, 0);
  assert.ok(Date.parse(S.db.get('SELECT next_due_at d FROM watch_config WHERE project_id = ?', pid).d) > Date.now(), 'rescheduled');
  assert.deepEqual(await S.watch.tick(), []);
  // opt in: the due check starts the verification its own plan asks for
  await S.api('PUT', `/api/projects/${pid}/watch`, { autoRun: true });
  S.db.run(`UPDATE watch_config SET next_due_at = '2020-01-01T00:00:00.000Z' WHERE project_id = ?`, pid);
  const [c2] = await S.watch.tick();
  assert.equal(c2.execution.started, true); await S.runner.waitForRun(c2.execution.runId);
  assert.equal(S.db.get('SELECT trigger FROM runs WHERE id = ?', c2.execution.runId).trigger, 'watch_auto');
  S.db.run(`UPDATE watch_config SET next_due_at = '2020-01-01T00:00:00.000Z' WHERE project_id = ?`, pid);
  const [c3] = await S.watch.tick();
  assert.equal(c3.health, 'healthy'); assert.equal(c3.execution.started, false);
  // other tenant
  for (const [m, u] of [['GET', 'watch'], ['PUT', 'watch'], ['POST', 'watch/check'], ['GET', 'watch/checks'], ['GET', 'watch/findings'], ['GET', 'watch/trend'], ['POST', `watch/checks/${c1.id}/execute`]])
    assert.equal((await S.api(m, `/api/projects/${pid}/${u}`, m === 'GET' ? null : {}, 'b')).status, 404, u);
  assert.equal((await S.api('POST', `/api/projects/${pid}/watch/checks/${c1.id}/execute`, {})).status, 409, 'a superseded check cannot be executed');
  await S.stop();
});

test('watch: plan and thresholds are pure functions of their input', () => {
  assert.deepEqual(buildPlan([]), { blocked: false, steps: [] });
  const p = buildPlan([{ variable: 'x', severity: 'medium', origin: 'evidence', criterionId: 7, action: { type: 'verify', criterionId: 7 } },
    { variable: 'engine.state', severity: 'blocking', origin: 'harness', scenario: 'down', cause: 'c', fingerprint: 'fp', action: { type: 'fix_harness', hint: 'h' } }]);
  assert.equal(p.blocked, true); assert.deepEqual(p.steps.map((s) => [s.order, s.type, s.automatic]), [[1, 'fix_harness', false], [2, 'verify', false]]);
  assert.deepEqual(p.steps[1].blockedBy, ['fp']);
  assert.deepEqual(cleanThresholds({ window: '5' }), { window: 5 });
  assert.throws(() => cleanThresholds({ window: 0 }), /between/);
});
