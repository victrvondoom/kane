// Adversarial tests for the autonomous loop's truth invariants.
// OFFLINE ONLY: every engine here is a labelled test stand-in (fake-kane.js / store-check-kane.js), never Kane CLI.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { hashPassword, hashToken } from '../server/auth.js';
import { WORKFLOW_STATES as W } from '../server/orchestrator.js';
import { executeRepair } from '../server/coding-agent.js';
import { setDefectState, measureGroundTruth } from '../server/demo-defects.js';
import { runRegressionTrial } from '../server/regression.js';
import { classifyFailure } from '../server/gate.js';

process.env.LOG_LEVEL = 'silent';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shipproof-truth-'));
const stateFile = path.join(tmp, 'state.json');
const setState = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));
process.env.FAKE_KANE_STATE = stateFile;
const FAKE = path.join(here, 'fixtures', 'fake-kane.js'), STORE_CHECK = path.join(here, 'fixtures', 'store-check-kane.js');
const baseConfig = { bin: FAKE, timeout: 30, maxSteps: 10, headless: true, username: '', accessKey: '', requireEvidence: true, allowPrivateTargets: true,
  acceptFixtureEngine: true, demoMutations: true, demoMutationUsers: ['owner@example.com'] };
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COUPON = 'After applying coupon code SAVE10 to a cart containing one Trail Backpack ($80.00), the order total shows $72.00.';

let n = 0;
function workspace() { // private copy of the demo store: the working tree is never modified
  const ws = path.join(tmp, `ws-${++n}`); fs.mkdirSync(ws);
  fs.cpSync(path.join(root, 'demo-app'), path.join(ws, 'demo-app'), { recursive: true });
  for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(root, f), path.join(ws, f));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(ws, 'node_modules'));
  return ws;
}
function client(base, jar = {}) {
  return async (method, url, body, who = 'a') => {
    const res = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(jar[who] ? { Cookie: jar[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) jar[who] = sc.split(';')[0];
    return { status: res.status, body: (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text() };
  };
}
const open = [];
async function boot({ config = {}, dataDir = path.join(tmp, `data-${++n}`), ws = workspace(), repairFn = null } = {}) {
  const ctx = createApp({ dataDir, config: { ...baseConfig, ...config }, workspaceDir: ws, repairFn });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  // Owner session is created directly (the signup endpoint is rate-limited per IP across this whole test process).
  const jar = {}, token = crypto.randomBytes(32).toString('base64url');
  const uid = ctx.db.get('SELECT id FROM users WHERE email = ?', 'owner@example.com')?.id
    ?? Number(ctx.db.run('INSERT INTO users (email, name, pass_hash, created_at) VALUES (?, ?, ?, ?)', 'owner@example.com', 'Owner', hashPassword('correct-horse'), new Date().toISOString()).lastInsertRowid);
  ctx.db.run('INSERT INTO sessions VALUES (?, ?, ?)', hashToken(token), uid, new Date(Date.now() + 3600e3).toISOString());
  jar.a = `sp_session=${token}`;
  const S = { ...ctx, ws, dataDir, base, api: client(base, jar), stopped: false,
    stop: async () => { if (S.stopped) return; S.stopped = true; server.close(); server.closeAllConnections?.(); await ctx.shutdown(); } };
  open.push(S);
  return S;
}
after(async () => { for (const S of open) await S.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

async function project(S, { text = COUPON, appUrl = 'http://127.0.0.1:4100/' } = {}) {
  const pid = (await S.api('POST', '/api/projects', { name: `P${++n}`, appUrl })).body.project.id;
  const r = await S.api('POST', `/api/projects/${pid}/requirements`, { text });
  assert.ok(r.status < 300, JSON.stringify(r.body));
  return pid;
}
async function loop(S, pid, body = {}) {
  const r = await S.api('POST', `/api/projects/${pid}/loop/start`, { taskDescription: 'Verify the acceptance criterion.', autoRepair: true, ...body });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  await S.orchestrator.waitFor(r.body.executionId);
  return (await S.api('GET', `/api/projects/${pid}/loop/${r.body.executionId}`)).body.execution;
}
const stages = (ex) => ex.events.map((e) => e.status);
const gate = async (S, pid) => (await S.api('GET', `/api/projects/${pid}`)).body.project.gate;

// ---------------------------------------------------------------------------------------------------------
test('full chain on a real app: failure → replay → repair → reverify → decision → regression detected (fixture engine doing real HTTP)', async () => {
  const ws = workspace();
  const pricing = path.join(ws, 'demo-app', 'pricing.js');
  setDefectState(ws, 'coupon_ignored', true);
  assert.equal(measureGroundTruth(ws, 'coupon_ignored').defectPresent, true, 'known defective starting state');
  const port = await freePort();
  let child = null;
  const startStore = async () => {
    child = spawn(process.execPath, ['demo-app/server.js'], { cwd: ws, env: { ...process.env, DEMO_PORT: String(port) }, stdio: 'ignore' });
    for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return; } catch {} await sleep(100); }
    throw new Error('store did not start');
  };
  const stopStore = () => new Promise((r) => { if (!child) return r(); child.once('exit', r); child.kill('SIGKILL'); });
  await startStore();
  // The "coding agent" of this test: a real source edit followed by a redeploy of the store.
  const repairFn = async ({ workspaceDir }) => {
    const r = setDefectState(workspaceDir, 'coupon_ignored', false);
    await stopStore(); await startStore();
    return { patchSummary: 'total = subtotal - discount', changedFiles: r.changed ? [r.file] : [] };
  };
  const S = await boot({ config: { bin: STORE_CHECK }, ws, repairFn });
  try {
    const pid = await project(S, { appUrl: `http://127.0.0.1:${port}/` });
    const before = sha(pricing);
    const ex = await loop(S, pid);
    assert.equal(ex.status, W.RELEASE_READY, JSON.stringify(ex.events.at(-1)));
    assert.deepEqual(stages(ex), [W.SPECIFICATION_READY, W.SECURITY_CHECK, W.VERIFYING, W.ANALYSING_FAILURE, W.REPAIRING, W.REVERIFYING, W.VERIFIED, W.REGRESSION_CHECK, W.RELEASE_READY]);

    // REAL FAILURE: persisted failed result with evidence, from the labelled fixture engine
    const runs = S.db.all('SELECT id, trigger, status FROM runs WHERE project_id = ? ORDER BY id', pid);
    assert.deepEqual(runs.map((r) => r.trigger), ['agent_loop', 'playtest_replay', 'repair_verify']);
    const res = runs.map((r) => S.db.get('SELECT * FROM results WHERE run_id = ?', r.id));
    assert.deepEqual(res.map((r) => r.status), ['failed', 'failed', 'passed']);
    assert.match(res[0].summary, /\$80\.00, expected \$72\.00/);
    for (const r of res) { assert.match(r.engine, /fixture-store-check/); assert.ok(S.db.get('SELECT COUNT(*) n FROM evidence WHERE result_id = ?', r.id).n > 0); }

    // INDEPENDENT REPLAY → VERIFIED DIAGNOSIS
    const inv = (await S.api('GET', `/api/projects/${pid}/investigations/${ex.investigationId}`)).body.investigation;
    assert.equal(inv.defectStatus, 'CONFIRMED_DEFECT'); assert.equal(inv.reproduced, true);
    assert.equal(inv.resultId, res[0].id); assert.equal(inv.replay.resultId, res[1].id); assert.ok(inv.replay.evidence.length > 0);

    // ACTUAL REPAIR → REAL REVERIFICATION
    assert.equal(ex.repairs.length, 1);
    assert.equal(ex.repairs[0].status, 'applied'); assert.equal(ex.repairs[0].outcome, 'verified');
    assert.equal(ex.repairs[0].sourceResultId, res[1].id); assert.equal(ex.repairs[0].verifyRunId, runs[2].id);
    assert.notEqual(sha(pricing), before, 'source file was really modified');
    assert.equal(ex.repairs[0].fileHashes[0].afterSha256, sha(pricing));
    assert.equal(measureGroundTruth(ws, 'coupon_ignored').defectPresent, false);

    // RELEASE DECISION from the decision engine, persisted
    const dec = S.db.get('SELECT * FROM release_decisions WHERE id = ?', ex.decisionId);
    assert.equal(dec.verdict, 'verified'); assert.equal(dec.requested_by, 'autonomous_orchestrator');
    assert.equal(ex.release.allowed, true);

    // ACTUAL REGRESSION TEST: isolated copies, ground truth measured independently, evidence on disk
    const t = ex.regression;
    assert.equal(t.outcome, 'detected'); assert.equal(t.engineKind, 'test-fixture', 'offline trial is labelled as fixture, not Kane');
    const [ctl, def] = t.runs;
    assert.deepEqual([ctl.variant, ctl.defectPresent, ctl.status], ['control', false, 'passed']);
    assert.deepEqual([def.variant, def.defectPresent, def.status], ['defect', true, 'failed']);
    assert.deepEqual([ctl.groundTruth.measured.total, def.groundTruth.measured.total], [7200, 8000]);
    assert.match(def.summary, /\$80\.00, expected \$72\.00/);
    assert.notEqual(ctl.targetUrl, def.targetUrl); assert.ok(!ctl.targetUrl.includes(`:${port}/`), 'trials ran against isolated instances, not the project app');
    for (const r of t.runs) for (const f of r.evidence) assert.equal(sha(path.join(S.dataDir, 'evidence', f.relPath)), f.sha256);
    assert.ok(def.evidence.length > 0);
    // the trial left neither the workspace nor the release evidence changed
    assert.equal(sha(pricing), ex.repairs[0].fileHashes[0].afterSha256);
    assert.equal(S.db.get('SELECT COUNT(*) n FROM results r JOIN runs x ON x.id = r.run_id WHERE x.project_id = ?', pid).n, 3);
    assert.equal((await gate(S, pid)).verdict, 'verified');
  } finally { await stopStore(); }
});

test('attack: release approval after a failed run', async () => {
  const S = await boot();
  const pid = await project(S);
  setState({ mode: 'ok', failWhen: ['SAVE10'] });
  const ex = await loop(S, pid, { autoRepair: false });
  assert.equal(ex.status, W.FAILED); assert.equal(ex.currentStage, 'UNREPAIRED_FAILURE');
  assert.ok(!stages(ex).includes(W.RELEASE_READY) && !stages(ex).includes(W.VERIFIED));
  // forging the label does not make it true: reads are re-checked against the decision engine
  S.db.run(`UPDATE agent_executions SET status = 'RELEASE_READY' WHERE id = ?`, ex.id);
  const forged = (await S.api('GET', `/api/projects/${pid}/loop/${ex.id}`)).body.execution;
  assert.equal(forged.status, W.NOT_RELEASE_READY); assert.equal(forged.release.allowed, false);
  assert.ok(forged.release.blocking.includes('FAILED') && forged.release.blocking.includes('NO_RECORDED_DECISION'));
  assert.equal((await S.api('GET', `/api/projects/${pid}/loop/executions`)).body.executions[0].status, W.NOT_RELEASE_READY);
  assert.equal((await gate(S, pid)).verdict, 'blocked');
  // repair keeps failing: bounded attempts, never released
  const ex2 = await loop(S, pid);
  assert.equal(ex2.status, W.NEEDS_HUMAN_APPROVAL);
  assert.ok(ex2.repairs.length >= 1 && ex2.repairs.length <= 3);
  await S.stop();
});

test('attack: a pass from a non-Kane engine cannot produce RELEASE_READY when fixtures are not accepted', async () => {
  const S = await boot({ config: { acceptFixtureEngine: false } });
  const pid = await project(S);
  setState({ mode: 'ok', failWhen: [] });
  const ex = await loop(S, pid);
  assert.equal(ex.status, W.NOT_RELEASE_READY); assert.equal(ex.currentStage, 'RELEASE_DECISION_BLOCKED');
  assert.equal(ex.events.at(-1).data.blocking[0].code, 'BLOCKED');
  await S.stop();
});

test('attack: timeouts and infrastructure errors never release and never trigger repair', async () => {
  const S = await boot();
  const pricing = path.join(S.ws, 'demo-app', 'pricing.js'), before = sha(pricing);
  const cases = [[{ mode: 'ok', failWhen: [], exitOverride: 3 }, 'timeout'], [{ mode: 'unauthenticated' }, 'authentication'], [{ mode: 'network' }, 'network'],
    [{ mode: 'crash' }, 'engine_error'], [{ mode: 'pass_no_evidence' }, 'missing_evidence'], [{ mode: 'ok', failWhen: [], exitOverride: 1 }, 'engine_error']];
  for (const [state, cls] of cases) {
    const pid = await project(S);
    setState(state);
    const ex = await loop(S, pid);
    assert.equal(ex.status, W.INCONCLUSIVE, `${cls}: ${JSON.stringify(ex.events.at(-1))}`);
    assert.equal(ex.currentStage, 'VERIFICATION_NO_VERDICT'); assert.equal(ex.failureClass, cls);
    assert.deepEqual(stages(ex), [W.SPECIFICATION_READY, W.SECURITY_CHECK, W.VERIFYING, W.INCONCLUSIVE]);
    assert.equal(ex.repairs.length, 0); assert.equal(ex.investigationId, null); assert.equal(ex.retryCount, 0);
    assert.equal(S.db.get('SELECT COUNT(*) n FROM repair_tasks WHERE project_id = ?', pid).n, 0);
    assert.notEqual((await gate(S, pid)).verdict, 'verified');
  }
  assert.equal(sha(pricing), before, 'application source untouched');
  // infrastructure failure on RE-verification after a real repair is also not a pass and not a second repair
  const pid = await project(S);
  setState({ mode: 'ok', failTimes: 2 });
  S.orchestrator.repairFn = async ({ workspaceDir }) => { const r = setDefectState(workspaceDir, 'coupon_ignored', false); setState({ mode: 'network' }); return { changedFiles: [r.file] }; };
  const ex = await loop(S, pid);
  S.orchestrator.repairFn = null;
  assert.equal(ex.status, W.INCONCLUSIVE); assert.equal(ex.currentStage, 'REVERIFICATION_NO_VERDICT');
  assert.equal(ex.repairs.length, 1); assert.equal(ex.repairs[0].outcome, 'no_verdict'); assert.equal(ex.regression, null);
  await S.stop();
});

test('classifyFailure: only a clean engine "failed" verdict is an application defect', () => {
  assert.deepEqual([classifyFailure({ status: 'failed', error_kind: null }).failureClass, classifyFailure({ status: 'failed' }).repairable], ['application_defect', true]);
  for (const r of [{ status: 'error', error_kind: 'auth' }, { status: 'error', error_kind: 'network' }, { status: 'timeout', error_kind: 'timeout' }, { status: 'error', error_kind: 'interrupted' },
    { status: 'error', error_kind: 'no_evidence' }, { status: 'error', error_kind: 'something_new' }, { status: 'cancelled' }, { status: 'running' }, { status: 'queued' }, { status: 'passed' }, null, { status: 'failed', error_kind: 'runner' }]) {
    const c = classifyFailure(r);
    assert.equal(c.applicationDefect, false, JSON.stringify(r)); assert.equal(c.repairable, false);
  }
});

test('attack: reproduction without an actual replay', async () => {
  const S = await boot();
  const pid = await project(S);
  setState({ mode: 'ok', failTimes: 1 }); // fails once; the real replay then passes
  const run = (await S.api('POST', `/api/projects/${pid}/runs`, {})).body.run.id; await S.runner.waitForRun(run);
  const failed = S.db.get('SELECT id FROM results WHERE run_id = ?', run);
  const rep = await S.api('POST', `/api/projects/${pid}/investigations/reproduce`, { resultId: failed.id });
  assert.equal(rep.status, 201);
  const inv = rep.body.investigation;
  assert.equal(inv.reproduced, false); assert.equal(inv.defectStatus, 'UNCONFIRMED_TRANSIENT');
  assert.ok(inv.replay.runId > run, 'a new run was really executed');
  assert.equal(S.db.get('SELECT trigger FROM runs WHERE id = ?', inv.replay.runId).trigger, 'playtest_replay');
  assert.equal(S.db.get('SELECT status FROM results WHERE id = ?', inv.replay.resultId).status, 'passed');
  // replay that cannot reach a verdict → INCONCLUSIVE
  setState({ mode: 'ok', failTimes: 1 });
  const run2 = (await S.api('POST', `/api/projects/${pid}/runs`, {})).body.run.id; await S.runner.waitForRun(run2);
  setState({ mode: 'network' });
  const inv2 = (await S.api('POST', `/api/projects/${pid}/investigations/reproduce`, { resultId: S.db.get('SELECT id FROM results WHERE run_id = ?', run2).id })).body.investigation;
  assert.equal(inv2.reproduced, false); assert.equal(inv2.defectStatus, 'INCONCLUSIVE');
  // in the loop: unreproduced failure → no repair
  const pid2 = await project(S);
  setState({ mode: 'ok', failTimes: 1 });
  const ex = await loop(S, pid2);
  assert.equal(ex.repairs.length, 0);
  assert.ok(!stages(ex).includes(W.REPAIRING));
  // another tenant's result cannot be replayed
  await S.api('POST', '/api/auth/signup', { email: 'mallory@example.com', name: 'M', password: 'another-pass' }, 'b');
  const mp = (await S.api('POST', '/api/projects', { name: 'M', appUrl: 'http://127.0.0.1:4100/' }, 'b')).body.project.id;
  assert.equal((await S.api('POST', `/api/projects/${mp}/investigations/reproduce`, { resultId: failed.id }, 'b')).status, 404);
  await S.stop();
});

test('attack: regression success without an execution', async () => {
  const S = await boot({ config: { allowPrivateTargets: false } }); // trial targets (loopback) are refused → nothing can execute
  const pid = Number(S.db.run(`INSERT INTO projects (user_id, name, app_url, created_at) VALUES (1, 'pub', 'https://example.com/', 't')`).lastInsertRowid);
  const p = S.db.get('SELECT * FROM projects WHERE id = ?', pid);
  S.db.run(`INSERT INTO criteria (project_id, key, text, created_at, updated_at) VALUES (?, 'AC-001', ?, 't', 't')`, pid, COUPON);
  const crit = S.db.get('SELECT * FROM criteria WHERE project_id = ?', pid);
  const t1 = await runRegressionTrial({ db: S.db, runner: S.runner, workspaceDir: S.ws, dataDir: S.dataDir, project: p, criterion: crit });
  assert.equal(t1.outcome, 'inconclusive'); assert.equal(t1.runs.length, 1); assert.equal(t1.runs[0].errorKind, 'target_blocked');
  // no applicable known defect → not_run (never "detected")
  const t2 = await runRegressionTrial({ db: S.db, runner: S.runner, workspaceDir: S.ws, dataDir: S.dataDir, project: p, criterion: { ...crit, text: 'The catalogue lists the Trail Backpack.' } });
  assert.equal(t2.outcome, 'not_run'); assert.equal(t2.runs.length, 0);
  // engine cannot authenticate during the trial → inconclusive
  const S2 = await boot();
  const pid2 = await project(S2);
  setState({ mode: 'unauthenticated' });
  const t3 = await runRegressionTrial({ db: S2.db, runner: S2.runner, workspaceDir: S2.ws, dataDir: S2.dataDir, project: S2.db.get('SELECT * FROM projects WHERE id = ?', pid2), criterion: S2.db.get('SELECT * FROM criteria WHERE project_id = ?', pid2) });
  assert.equal(t3.outcome, 'inconclusive'); assert.equal(t3.runs[0].errorKind, 'auth');
  // engine that passes everything → the reintroduced defect is MISSED, and that is what gets recorded
  setState({ mode: 'ok', failWhen: [] });
  const t4 = await runRegressionTrial({ db: S2.db, runner: S2.runner, workspaceDir: S2.ws, dataDir: S2.dataDir, project: S2.db.get('SELECT * FROM projects WHERE id = ?', pid2), criterion: S2.db.get('SELECT * FROM criteria WHERE project_id = ?', pid2) });
  assert.equal(t4.outcome, 'missed'); assert.equal(t4.runs[1].defectPresent, true);
  assert.equal(S2.db.get(`SELECT COUNT(*) n FROM regression_trials WHERE outcome = 'detected'`).n, 0);
  assert.equal(S2.db.get('SELECT COUNT(*) n FROM results').n, 0, 'trials never write release evidence');
  // a loop that passes first time ran no regression and says so
  const ex = await loop(S2, pid2);
  assert.equal(ex.status, W.RELEASE_READY); assert.deepEqual(ex.regression, { outcome: 'not_run' }); assert.ok(!stages(ex).includes(W.REGRESSION_CHECK));
  await S.stop(); await S2.stop();
});

test('attack: duplicate repair submissions and concurrent workflows', async () => {
  const S = await boot();
  const pid = await project(S);
  const pricing = path.join(S.ws, 'demo-app', 'pricing.js');
  const execId = Number(S.db.run(`INSERT INTO agent_executions (project_id, task_description, status, current_stage, created_at, updated_at) VALUES (?, 't', 'FAILED', 'x', 't', 't')`, pid).lastInsertRowid);
  const args = { db: S.db, executionId: execId, attemptNumber: 1, workspaceDir: S.ws, dossier: { criterionKey: 'AC-001', criterionText: COUPON }, mutationAuthorized: true };
  const a = await executeRepair(args);
  assert.equal(a.status, 'applied'); assert.equal(a.duplicate, false);
  const afterFirst = sha(pricing);
  setDefectState(S.ws, 'coupon_ignored', true); // if the duplicate re-ran the repair, the file would change again
  const broken = sha(pricing);
  const b = await executeRepair(args);
  assert.equal(b.duplicate, true); assert.equal(b.attemptId, a.attemptId);
  assert.equal(sha(pricing), broken); assert.notEqual(broken, afterFirst);
  assert.equal(S.db.get('SELECT COUNT(*) n FROM agent_repair_attempts WHERE execution_id = ?', execId).n, 1);
  assert.throws(() => S.db.run(`INSERT INTO agent_repair_attempts (execution_id, attempt_number, patch_summary, status, created_at) VALUES (?, 1, 'dup', 'applied', 't')`, execId), /UNIQUE/);
  // unauthorized workspace mutation / an agent that only CLAIMS a change → nothing applied
  const c = await executeRepair({ ...args, attemptNumber: 2, mutationAuthorized: false });
  assert.equal(c.status, 'proposed'); assert.equal(sha(pricing), broken);
  const d = await executeRepair({ ...args, attemptNumber: 3, repairFn: async () => ({ patchSummary: 'fixed, trust me', changedFiles: ['does/not/exist.js', '../../etc/passwd'] }) });
  assert.equal(d.status, 'proposed'); assert.deepEqual(d.changedFiles, []);
  // second workflow while one is active is refused
  setState({ mode: 'hang' });
  const first = await S.api('POST', `/api/projects/${pid}/loop/start`, { taskDescription: 'one' });
  assert.equal(first.status, 202);
  assert.equal((await S.api('POST', `/api/projects/${pid}/loop/start`, { taskDescription: 'two' })).status, 409);
  for (let i = 0; i < 100 && !S.db.get('SELECT active_run_id r FROM agent_executions WHERE id = ?', first.body.executionId).r; i++) await sleep(50);
  assert.equal((await S.api('POST', `/api/projects/${pid}/loop/${first.body.executionId}/cancel`)).body.cancelled, true);
  const ex = await S.orchestrator.waitFor(first.body.executionId);
  assert.equal(ex.status, W.CANCELLED); assert.ok(!stages(ex).includes(W.RELEASE_READY));
  assert.equal(S.db.get('SELECT COUNT(*) n FROM agent_executions WHERE project_id = ? AND task_description = ?', pid, 'two').n, 0);
  await S.stop();
});

test("attack: another user's demo mutation and cross-tenant workflow access", async () => {
  const S = await boot();
  const pricing = path.join(S.ws, 'demo-app', 'pricing.js'), before = sha(pricing);
  await S.api('POST', '/api/auth/signup', { email: 'mallory@example.com', name: 'M', password: 'another-pass' }, 'b');
  for (const ep of ['break-app', 'fix-app']) {
    assert.equal((await S.api('POST', `/api/demo/${ep}`, {}, 'b')).status, 403);
    assert.equal((await S.api('POST', `/api/demo/${ep}`, {}, 'anon')).status, 401);
  }
  assert.equal(sha(pricing), before);
  // an unauthorized user's loop cannot repair server source either
  const mp = await (async () => { const pid = (await S.api('POST', '/api/projects', { name: 'M', appUrl: 'http://127.0.0.1:4100/' }, 'b')).body.project.id; await S.api('POST', `/api/projects/${pid}/requirements`, { text: COUPON }, 'b'); return pid; })();
  setState({ mode: 'ok', failTimes: 2 });
  const r = await S.api('POST', `/api/projects/${mp}/loop/start`, { taskDescription: 'x' }, 'b');
  const mex = await S.orchestrator.waitFor(r.body.executionId);
  assert.equal(mex.status, W.NEEDS_HUMAN_APPROVAL); assert.equal(mex.currentStage, 'NO_REPAIR_APPLIED'); assert.equal(mex.repairs[0].status, 'proposed');
  assert.equal(sha(pricing), before);
  // the owner cannot read or cancel it through their own project, nor can mallory reach the owner's
  const op = await project(S);
  for (const [who, pid] of [['a', op]]) {
    assert.equal((await S.api('GET', `/api/projects/${pid}/loop/${mex.id}`, null, who)).status, 404);
    assert.equal((await S.api('POST', `/api/projects/${pid}/loop/${mex.id}/cancel`, {}, who)).status, 404);
    assert.equal((await S.api('GET', `/api/projects/${pid}/loop/${mex.id}/stream`, null, who)).status, 404);
  }
  assert.equal((await S.api('GET', `/api/projects/${op}/loop/executions`, null, 'b')).status, 404);
  // the authorized account: works, is idempotent, and is refused while a verification is running
  const fix = await S.api('POST', '/api/demo/fix-app', {});
  assert.equal(fix.status, 200); assert.equal(fix.body.changed, true); assert.notEqual(sha(pricing), before);
  assert.equal((await S.api('POST', '/api/demo/fix-app', {})).body.changed, false);
  setState({ mode: 'hang' });
  const run = (await S.api('POST', `/api/projects/${op}/runs`, {})).body.run.id;
  assert.equal((await S.api('POST', '/api/demo/break-app', {})).status, 409);
  await S.api('POST', `/api/runs/${run}/cancel`, {}); await S.runner.waitForRun(run);
  assert.equal((await S.api('POST', '/api/demo/break-app', {})).body.changed, true);
  assert.equal(sha(pricing), before);
  // unrecognised file contents are refused rather than overwritten
  fs.writeFileSync(pricing, fs.readFileSync(pricing, 'utf8').replace('const total = subtotal;', 'const total = subtotal * 2;'));
  assert.equal((await S.api('POST', '/api/demo/fix-app', {})).status, 409);
  await S.stop();
  // disabled environment: even the listed account is refused
  const off = await boot({ config: { demoMutations: false } });
  const offBefore = sha(path.join(off.ws, 'demo-app', 'pricing.js'));
  assert.equal((await off.api('POST', '/api/demo/fix-app', {})).status, 403);
  assert.equal(sha(path.join(off.ws, 'demo-app', 'pricing.js')), offBefore);
  await off.stop();
});

test('attack: an unrelated run is not mistaken for the current run', async () => {
  const S = await boot();
  const other = await project(S, { text: 'UNRELATED-FAIL check that always fails.' });
  const mine = await project(S, { text: 'The catalogue lists the Trail Backpack.' });
  setState({ mode: 'ok', failWhen: ['UNRELATED-FAIL'] });
  // waitForRun resolves for its own id only
  const a = (await S.api('POST', `/api/projects/${mine}/runs`, {})).body.run.id, b = (await S.api('POST', `/api/projects/${other}/runs`, {})).body.run.id;
  const ra = await S.runner.waitForRun(a);
  assert.equal(ra.id, a); assert.equal(ra.status, 'completed');
  assert.notEqual(S.db.get('SELECT status FROM runs WHERE id = ?', b).status, 'completed', 'the later run was still pending when ours resolved');
  assert.equal((await S.runner.waitForRun(b)).id, b);
  assert.equal(await S.runner.waitForRun(999999), null);
  // an unrelated failing run queued AHEAD of the workflow's run does not make the workflow fail…
  const u1 = (await S.api('POST', `/api/projects/${other}/runs`, {})).body.run.id;
  const ex = await loop(S, mine);
  assert.equal(ex.status, W.RELEASE_READY); assert.equal(ex.investigationId, null);
  assert.equal(S.db.get('SELECT project_id FROM runs WHERE id = ?', ex.activeRunId).project_id, mine);
  assert.equal(S.db.get('SELECT status FROM results WHERE run_id = ?', u1).status, 'failed');
  // …and an unrelated PASSING run does not make a failing workflow pass
  setState({ mode: 'ok', failWhen: ['UNRELATED-FAIL'] });
  const u2 = (await S.api('POST', `/api/projects/${mine}/runs`, {})).body.run.id;
  const ex2 = await loop(S, other, { autoRepair: false });
  assert.equal(ex2.status, W.FAILED);
  assert.equal(S.db.get('SELECT status FROM results WHERE run_id = ?', u2).status, 'passed');
  await S.stop();
});

test('attack: restart during an active orchestration stage', async () => {
  const dataDir = path.join(tmp, 'restart'), ws = workspace();
  const S = await boot({ dataDir, ws });
  const pid = await project(S);
  setState({ mode: 'hang' });
  const r = await S.api('POST', `/api/projects/${pid}/loop/start`, { taskDescription: 'x' });
  const id = r.body.executionId;
  for (let i = 0; i < 100 && S.db.get('SELECT r.status s FROM results r JOIN runs n ON n.id = r.run_id WHERE n.project_id = ?', pid)?.s !== 'running'; i++) await sleep(50);
  assert.equal(S.db.get('SELECT status FROM agent_executions WHERE id = ?', id).status, W.VERIFYING);
  await S.stop();
  // simulate a hard crash as well: a row left mid-repair with no process to finish it
  setState({ mode: 'ok', failWhen: [] });
  const T = await boot({ dataDir, ws });
  const crashed = Number(T.db.run(`INSERT INTO agent_executions (project_id, task_description, status, current_stage, created_at, updated_at) VALUES (?, 'crashed', 'REPAIRING', 'CODING_AGENT_REPAIR', 't', 't')`, pid).lastInsertRowid);
  await T.stop();
  const U = await boot({ dataDir, ws });
  for (const [eid, prev] of [[id, 'VERIFYING'], [crashed, 'REPAIRING']]) {
    const ex = (await U.api('GET', `/api/projects/${pid}/loop/${eid}`)).body.execution;
    assert.equal(ex.status, W.INTERRUPTED); assert.equal(ex.currentStage, `INTERRUPTED_DURING_${prev}`);
    assert.equal(ex.events.at(-1).status, W.INTERRUPTED);
    assert.ok(!stages(ex).some((s) => [W.VERIFIED, W.RELEASE_READY, W.REGRESSION_CHECK].includes(s)));
    assert.equal(ex.repairs.length, 0);
  }
  assert.deepEqual(U.db.all('SELECT r.status, r.error_kind FROM results r JOIN runs n ON n.id = r.run_id WHERE n.project_id = ?', pid).map((x) => [x.status, x.error_kind]), [['error', 'interrupted']]);
  assert.notEqual((await gate(U, pid)).verdict, 'verified');
  // the project is not stuck: a fresh workflow can start and is judged on its own execution
  const again = await loop(U, pid);
  assert.equal(again.status, W.RELEASE_READY);
  await U.stop();
});
