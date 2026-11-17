// Failure investigations and fix verification. Two layers:
//  - pure rules (diagnosis, comparison) on SYNTHETIC telemetry, to pin each deterministic rule and its false positives;
//  - the real server (routes, persistence, ownership, runner) with the TEST-ONLY stand-in engine tests/fixtures/fake-kane.js.
// Synthetic HAR/console files are test fixtures only. They are not Kane output formats.
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
import { buildSide, diagnose, compareExecutions, failureFacts } from '../server/investigations.js';

process.env.LOG_LEVEL = 'silent';
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shipproof-inv-'));
const stateFile = path.join(tmp, 'state.json'); process.env.FAKE_KANE_STATE = stateFile;
const setState = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));
setState({ mode: 'ok', failWhen: [] });
const config = { bin: path.join(here, 'fixtures', 'fake-kane.js'), timeout: 30, maxSteps: 10, headless: true, username: '', accessKey: '', requireEvidence: true, allowPrivateTargets: true, acceptFixtureEngine: true };

// ---------- synthetic fixtures (pure rules) ----------
const net = (method, url, status, extra = {}) => ({ method, url, status, ms: 100, index: 0, evidenceUid: 'ev1', evidenceName: 'network.har', ...extra });
const con = (text) => ({ level: 'error', text, evidenceUid: 'ev2', evidenceName: 'console.log' });
const result = (o = {}) => ({ id: o.id ?? 1, criterion_key: 'AC-005', status: o.status ?? 'failed', reason: o.reason ?? 'Order total did not reduce after coupon SAVE10', failing_step: o.step ? JSON.stringify({ description: o.step }) : null,
  error_kind: o.errorKind ?? null, criterion_version_id: o.version ?? 7, started_at: '2026-01-01T00:00:00Z', build_id: null, one_liner: null, summary: null, duration_ms: 1000, ...o.extra });
const side = (r, t, rows = [{ kind: 'screenshot', name: 'step.png', uid: 's1', available: true }, { kind: 'log', name: 'run.log', uid: 'l1', available: true }]) =>
  buildSide({ result: r, rows: rows.map((x) => ({ ...x, available: x.available !== false })), t });
const tel = ({ failures = [], samples = [], network = true, console: hasConsole = true } = {}) => ({
  network: network ? { format: 'har', failures, byStatus: { '2xx': 1, '3xx': 0, '4xx': 0, '5xx': failures.filter((f) => f.status >= 500).length, failed: 0 }, failed: failures.length, slow: 0, slowest: [], total: 3, analysed: 3 } : null,
  console: hasConsole ? { format: 'ndjson', errors: samples.length, warnings: 0, samples } : null,
});

test('rules: a 5xx that is linked to the failed step and corroborated by a console error is a strong correlation', () => {
  const s = side(result({ reason: 'Checkout total did not reduce after coupon SAVE10', step: '{"description":"Submit checkout with coupon"}' }),
    tel({ failures: [net('POST', 'https://shop.test/api/checkout', 500)], samples: [con('checkout request failed: total undefined')] }));
  const d = diagnose(s);
  const f = d.findings.find((x) => x.category === 'server_error');
  assert.equal(f.linkedToStep, true); assert.equal(f.confidence, 'STRONG_CORRELATION');
  assert.match(d.mostLikelyCause.text, /server error: POST https:\/\/shop\.test\/api\/checkout returned HTTP 500/);
  assert.equal(d.mostLikelyCause.findingIds[0], f.id, 'the cause cites the finding that supports it');
  assert.deepEqual(f.evidence[0], { kind: 'network', evidenceUid: 'ev1', name: 'network.har', index: 0 }, 'evidence reference points at the exact request');
  assert.ok(d.confirmedObservations.some((x) => /reported the failing step/.test(x)));
  assert.equal(d.hypotheses.length, 1); assert.match(d.hypotheses[0], /a hypothesis, not a proven fact/);
});

test('false positive: an unrelated analytics 5xx is recorded but is never named as the root cause', () => {
  const s = side(result({ reason: 'Order total did not reduce after coupon SAVE10', step: 'Apply coupon and check the total' }),
    tel({ failures: [net('POST', 'https://shop.test/collect/analytics-beacon', 503)], samples: [] }));
  const d = diagnose(s);
  const f = d.findings.find((x) => x.category === 'server_error');
  assert.equal(f.linkedToStep, false); assert.equal(f.confidence, 'INSUFFICIENT_EVIDENCE');
  assert.equal(d.mostLikelyCause.findingIds.length, 0, 'no finding is promoted to a cause');
  assert.match(d.mostLikelyCause.text, /does not identify a cause/);
  assert.equal(d.mostLikelyCause.confidence, 'INSUFFICIENT_EVIDENCE');
  assert.ok(d.unknowns.some((u) => /not linked to the failed step/.test(u)), 'the unlinked failure is listed as unknown, not hidden');
});

test('rules: a harness error is never diagnosed as an application defect', () => {
  const s = side(result({ status: 'error', errorKind: 'auth', reason: null }), tel({ network: false, console: false }), []);
  const d = diagnose(s);
  assert.equal(d.category, 'execution_error');
  assert.match(d.mostLikelyCause.text, /Kane did not reach a verdict/);
  assert.equal(d.findings[0].id, 'F-EXEC');
});

test('rules: missing screenshot and missing telemetry are reported as limitations, not guessed', () => {
  const d = diagnose(side(result(), tel({ network: false, console: false }), []));
  assert.ok(d.findings.some((f) => f.id === 'F-NOSHOT' && f.confidence === 'INSUFFICIENT_EVIDENCE'));
  assert.ok(d.unknowns.some((u) => /No network \(HAR\) evidence/.test(u)));
  assert.equal(d.evidenceCompleteness.screenshots, 0);
});

test('comparison: a passing comparable flow with no new failures is VERIFIED_FIXED; the original signature is absent', () => {
  const orig = side(result({ version: 7 }), tel({ failures: [net('POST', 'https://shop.test/api/checkout', 500)] }));
  const ver = side(result({ id: 2, status: 'passed', reason: null, version: 7 }), tel({ failures: [] }));
  const c = compareExecutions(orig, ver, { origRunId: 1, verRunId: 2 });
  assert.equal(c.outcome, 'VERIFIED_FIXED'); assert.equal(c.originalFailureStatus, 'ABSENT'); assert.equal(c.flowComparable, true);
  assert.deepEqual(c.resolvedFindings.map((x) => x.observation), ['POST https://shop.test/api/checkout']);
  assert.equal(c.label, 'FIX VERIFIED');
});

test('comparison: a pass with a new server error is REGRESSION_INTRODUCED, never a fix', () => {
  const orig = side(result({ version: 7 }), tel({ failures: [net('POST', 'https://shop.test/api/checkout', 500)] }));
  const ver = side(result({ id: 2, status: 'passed', reason: null, version: 7 }), tel({ failures: [net('GET', 'https://shop.test/api/cart', 502)] }));
  const c = compareExecutions(orig, ver, { origRunId: 1, verRunId: 2 });
  assert.equal(c.outcome, 'REGRESSION_INTRODUCED'); assert.equal(c.newFailures[0].observation, 'GET https://shop.test/api/cart');
});

test('comparison: the same failure signature is STILL_FAILING; a different failing step with a new endpoint is a regression', () => {
  const failing = (reason, url) => side(result({ id: 2, reason, version: 7 }), tel({ failures: [net('POST', url, 500)] }));
  const orig = side(result({ reason: 'Order total did not reduce after SAVE10', version: 7 }), tel({ failures: [net('POST', 'https://shop.test/api/checkout', 500)] }));
  assert.equal(compareExecutions(orig, failing('Order total did not reduce after SAVE10', 'https://shop.test/api/checkout'), { verRunId: 2 }).outcome, 'STILL_FAILING');
  // numbers are normalised: the same failure with another amount is still the same signature
  const amounts = side(result({ reason: 'Order total 80.00 did not reduce after SAVE10', version: 7 }), tel({ failures: [net('POST', 'https://shop.test/api/checkout', 500)] }));
  assert.equal(compareExecutions(amounts, failing('Order total 72.00 did not reduce after SAVE10', 'https://shop.test/api/checkout'), { verRunId: 2 }).outcome, 'STILL_FAILING');
  const other = compareExecutions(orig, side(result({ id: 2, reason: 'Login button missing', step: 'Log in', version: 7 }), tel({ failures: [net('POST', 'https://shop.test/api/login', 500)] })), { verRunId: 2 });
  assert.equal(other.outcome, 'REGRESSION_INTRODUCED');
});

test('comparison: same step with fewer failing endpoints is PARTIALLY_RESOLVED', () => {
  const orig = side(result({ step: 'Submit checkout', reason: 'Total wrong', version: 7 }), tel({ failures: [net('POST', 'https://shop.test/api/checkout', 500), net('GET', 'https://shop.test/api/tax', 500)] }));
  const ver = side(result({ id: 2, step: 'Submit checkout', reason: 'Total still wrong', version: 7 }), tel({ failures: [net('POST', 'https://shop.test/api/checkout', 500)] }));
  const c = compareExecutions(orig, ver, { verRunId: 2 });
  assert.equal(c.outcome, 'PARTIALLY_RESOLVED'); assert.equal(c.originalFailureStatus, 'CHANGED');
  assert.equal(c.persistentFindings[0].observation, 'POST https://shop.test/api/checkout');
});

test('comparison: incompatible flows, infrastructure failures, missing evidence and unfinished runs are never promoted to a fix', () => {
  const orig = side(result({ version: 7 }), tel({ failures: [net('POST', 'https://shop.test/api/checkout', 500)] }));
  const passed = side(result({ id: 2, status: 'passed', reason: null, version: 7 }), tel({ failures: [] }));
  assert.equal(compareExecutions(orig, side(result({ id: 2, status: 'passed', reason: null, version: 8 }), tel({})), { verRunId: 2 }).outcome, 'INCOMPARABLE', 'flow text changed');
  assert.equal(compareExecutions(orig, side(result({ id: 2, status: 'error', errorKind: 'auth', version: 7 }), tel({ network: false, console: false }), []), { verRunId: 2 }).outcome, 'INCONCLUSIVE', 'infrastructure error');
  assert.equal(compareExecutions(orig, passed, { runStatus: 'running' }).outcome, 'INCONCLUSIVE', 'run not finished');
  assert.equal(compareExecutions(orig, null, { runStatus: 'completed' }).outcome, 'INCONCLUSIVE', 'no result');
  // the pass has no network evidence although the original had some: new 5xx cannot be ruled out
  const noNet = side(result({ id: 2, status: 'passed', reason: null, version: 7 }), tel({ network: false }));
  const c = compareExecutions(orig, noNet, { verRunId: 2 });
  assert.equal(c.outcome, 'INCONCLUSIVE'); assert.match(c.reason, /Insufficient evidence/);
  const noEv = side(result({ id: 2, status: 'passed', reason: null, version: 7 }), tel({ failures: [] }), []);
  assert.equal(compareExecutions(orig, noEv, { verRunId: 2 }).outcome, 'INCONCLUSIVE', 'no evidence files at all');
  assert.equal(compareExecutions(side(result({ status: 'error', errorKind: 'auth', version: 7 }), tel({ network: false, console: false }), []), passed, { verRunId: 2 }).outcome, 'INCONCLUSIVE', 'original was an execution error');
});

test('security: query strings, cookies and tokens never appear in diagnosis output', () => {
  const s = side(result({ reason: 'checkout failed for token=abc123 session cookie', step: 'checkout' }),
    tel({ failures: [net('POST', 'https://shop.test/api/checkout', 500)], samples: [con('password=hunter2 in checkout response')] }));
  const text = JSON.stringify(diagnose(s));
  assert.doesNotMatch(text, /abc123|hunter2|\?session|authorization/i);
  assert.equal(failureFacts(result({ reason: 'x'.repeat(900) })).message.length <= 400, true, 'long messages are bounded');
});

// ---------- real server: lifecycle, ownership, verification ----------
const open = [];
let target = null, targetUrl = '';
const startTarget = () => (target ? Promise.resolve() : new Promise((r) => { target = http.createServer((q, s) => s.end('ok')).listen(0, '127.0.0.1', () => { targetUrl = `http://127.0.0.1:${target.address().port}/`; r(); }); }));
after(async () => { for (const S of open) { S.server.close(); S.server.closeAllConnections?.(); await S.shutdown(); } target?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

let n = 0;
async function boot(dataDir = path.join(tmp, `d${++n}`)) {
  const ctx = createApp({ dataDir, config, watchOptions: { tickMs: 0 }, eventOptions: { autoKick: false, tickMs: 0 } });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`, jar = {};
  const user = (who, email) => { const t = crypto.randomBytes(32).toString('base64url');
    ctx.db.run('INSERT OR IGNORE INTO users (email, name, pass_hash, created_at) VALUES (?, ?, ?, ?)', email, who, hashPassword('correct-horse'), 't');
    const uid = ctx.db.get('SELECT id FROM users WHERE email = ?', email).id;
    ctx.db.run('INSERT INTO sessions VALUES (?, ?, ?)', hashToken(t), uid, new Date(Date.now() + 3600e3).toISOString()); jar[who] = `sp_session=${t}`; };
  user('a', 'a@example.com'); user('b', 'b@example.com');
  const api = async (method, url, body, who = 'a') => { const res = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: jar[who] }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({})) }; };
  const evRoot = path.join(dataDir, 'evidence');
  const S = { ...ctx, base, api, server, dataDir, evRoot, jar, shutdown: ctx.shutdown };
  open.push(S); return S;
}
const har = (entries) => JSON.stringify({ log: { version: '1.2', entries } });
const hent = (method, url, status) => ({ startedDateTime: '2026-01-01T00:00:00Z', time: 50, request: { method, url }, response: { status } });
/** Attach a HAR/console fixture to a result (test data, written like Kane's evidence would be stored). */
function attach(S, resultId, name, text, kind = 'log') {
  const dir = path.join(S.evRoot, `fixture-${resultId}`); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), text);
  S.db.run('INSERT INTO evidence (result_id, kind, name, rel_path, mime, size) VALUES (?, ?, ?, ?, ?, ?)', resultId, kind, name, `fixture-${resultId}/${name}`, name.endsWith('.har') ? 'application/json' : 'text/plain', text.length);
}
/** A project with the SAVE10 flow, a failing run and a failing result whose reason we set (test fixture). */
/** Test fixture: the verification run reports the same failing step and message as the original (same defect). */
const sameFailureAs = (S, runId, original) => S.db.run('UPDATE results SET reason = ?, failing_step = ? WHERE run_id = ?', original.reason, original.step, runId);
async function failingProject(S, { who = 'a', failWhen = ['SAVE10'], reason = 'Order total did not reduce after coupon SAVE10', step = 'Submit checkout with coupon', tgtFirst = true } = {}) {
  if (tgtFirst) await startTarget();
  const pid = (await S.api('POST', '/api/projects', { name: `Shop ${++n}`, appUrl: targetUrl }, who)).body.project.id;
  await S.api('POST', `/api/projects/${pid}/requirements`, { text: 'Coupon SAVE10 reduces the total.' }, who);
  setState({ mode: 'ok', failWhen });
  const runId = (await S.api('POST', `/api/projects/${pid}/runs`, {}, who)).body.run.id;
  await S.runner.waitForRun(runId);
  const result = S.db.get('SELECT * FROM results WHERE run_id = ?', runId);
  S.db.run('UPDATE results SET reason = ?, failing_step = ? WHERE id = ?', reason, JSON.stringify({ description: step }), result.id);
  return { pid, runId, resultId: result.id, criterionId: result.criterion_id };
}
const verifyAndWait = async (S, invId, who = 'a') => {
  const v = await S.api('POST', `/api/investigations/${invId}/verifications`, {}, who);
  assert.equal(v.status, 202, JSON.stringify(v.body));
  await S.runner.idle();
  return v.body.verification;
};

test('investigation: a failed result creates one persisted investigation; a repeat returns it; a passed result is refused', async () => {
  const S = await boot();
  const f = await failingProject(S);
  const first = await S.api('POST', `/api/runs/${f.runId}/results/${f.resultId}/investigations`, {});
  assert.equal(first.status, 201); assert.equal(first.body.created, true);
  const invId = first.body.investigation.id;
  assert.equal(first.body.investigation.status, 'OPEN'); assert.equal(first.body.investigation.originalVerdict, 'failed');
  const again = await S.api('POST', `/api/runs/${f.runId}/results/${f.resultId}/investigations`, {});
  assert.equal(again.status, 200); assert.equal(again.body.investigation.id, invId, 'double click cannot create a second investigation');
  assert.equal(S.db.get('SELECT COUNT(*) n FROM investigations WHERE result_id = ?', f.resultId).n, 1);
  // the original Kane result is untouched
  assert.equal(S.db.get('SELECT status FROM results WHERE id = ?', f.resultId).status, 'failed');
  // passed results have nothing to investigate
  setState({ mode: 'ok', failWhen: [] });
  const pid2 = (await S.api('POST', '/api/projects', { name: 'Clean', appUrl: targetUrl })).body.project.id;
  await S.api('POST', `/api/projects/${pid2}/requirements`, { text: 'Coupon SAVE10 reduces the total.' });
  const rid = (await S.api('POST', `/api/projects/${pid2}/runs`, {})).body.run.id; await S.runner.waitForRun(rid);
  const passed = S.db.get('SELECT id FROM results WHERE run_id = ?', rid).id;
  const refused = await S.api('POST', `/api/runs/${rid}/results/${passed}/investigations`, {});
  assert.equal(refused.status, 409); assert.match(refused.body.error, /nothing to investigate/);
  // the detail shows real facts: original verdict, failing step, evidence, diagnosis and the creation event
  const d = (await S.api('GET', `/api/investigations/${invId}`)).body;
  assert.equal(d.original.verdict, 'failed'); assert.equal(d.original.failingStep, 'Submit checkout with coupon');
  assert.ok(d.evidence.completeness.total >= 1); assert.ok(d.diagnosis.engine === 'deterministic-v1');
  assert.ok(d.events.some((e) => e.type === 'created' && e.actor === 'a'));
});

test('investigation: lifecycle transitions are validated on the server and every change is in the history', async () => {
  const S = await boot();
  const f = await failingProject(S);
  const invId = (await S.api('POST', `/api/runs/${f.runId}/results/${f.resultId}/investigations`, {})).body.investigation.id;
  const bad = await S.api('POST', `/api/investigations/${invId}/status`, { status: 'VERIFIED_FIXED' });
  assert.equal(bad.status, 409, 'a fix cannot be declared by hand'); assert.deepEqual(bad.body.allowed, ['INVESTIGATING']);
  assert.equal((await S.api('POST', `/api/investigations/${invId}/status`, { status: 'NOPE' })).status, 400);
  assert.equal((await S.api('POST', `/api/investigations/${invId}/status`, { status: 'INVESTIGATING' })).body.investigation.status, 'INVESTIGATING');
  assert.equal((await S.api('POST', `/api/investigations/${invId}/status`, { status: 'READY_FOR_VERIFICATION' })).status, 200);
  const hist = (await S.api('GET', `/api/investigations/${invId}`)).body.events.filter((e) => e.type === 'status_changed').map((e) => [e.detail.from, e.detail.to]);
  assert.deepEqual(hist, [['OPEN', 'INVESTIGATING'], ['INVESTIGATING', 'READY_FOR_VERIFICATION']]);
  assert.equal(S.db.get('SELECT COUNT(*) n FROM investigation_events WHERE investigation_id = (SELECT id FROM investigations WHERE uid = ?) AND type = ?', invId, 'status_changed').n, 2, 'history rows are appended, never rewritten');
});

test('investigation: notes are authenticated, validated, stored verbatim as text and survive a restart', async () => {
  const dataDir = path.join(tmp, 'restart-data');
  const S = await boot(dataDir);
  const f = await failingProject(S);
  const invId = (await S.api('POST', `/api/runs/${f.runId}/results/${f.resultId}/investigations`, {})).body.investigation.id;
  assert.equal((await S.api('POST', `/api/investigations/${invId}/notes`, { body: '   ' })).status, 400);
  assert.equal((await S.api('POST', `/api/investigations/${invId}/notes`, { body: 'x'.repeat(4001) })).status, 400);
  const xss = '<img src=x onerror=alert(1)> checked the API logs';
  const note = await S.api('POST', `/api/investigations/${invId}/notes`, { body: xss });
  assert.equal(note.status, 201); assert.equal(note.body.investigation.body, xss, 'stored and returned as plain text');
  assert.equal((await S.api('POST', `/api/investigations/${invId}/notes`, { body: 'anon' }, 'b')).status, 404, 'another tenant cannot write a note');
  // restart: a new server on the same data directory still has the investigation, its note and its history
  S.server.close(); S.server.closeAllConnections?.(); await S.shutdown();
  open.pop();
  const S2 = await boot(dataDir);
  const d = (await S2.api('GET', `/api/investigations/${invId}`)).body;
  assert.equal(d.investigation.id, invId); assert.equal(d.notes.length, 1); assert.equal(d.notes[0].body, xss);
  assert.ok(d.events.some((e) => e.type === 'note_added'));
});

test('authorization: other tenants cannot read, change, verify or download an investigation, its evidence or its report', async () => {
  const S = await boot();
  const f = await failingProject(S);
  const invId = (await S.api('POST', `/api/runs/${f.runId}/results/${f.resultId}/investigations`, {})).body.investigation.id;
  const b = 'b';
  assert.equal((await S.api('GET', `/api/investigations/${invId}`, null, b)).status, 404);
  assert.equal((await S.api('POST', `/api/investigations/${invId}/status`, { status: 'INVESTIGATING' }, b)).status, 404);
  assert.equal((await S.api('POST', `/api/investigations/${invId}/verifications`, {}, b)).status, 404);
  assert.equal((await S.api('POST', `/api/runs/${f.runId}/results/${f.resultId}/investigations`, {}, b)).status, 404, 'cannot investigate another tenant’s result');
  assert.equal((await S.api('GET', `/api/projects/${f.pid}/investigations`, null, b)).status, 404);
  assert.equal((await S.api('GET', `/api/investigations/${invId}/verifications/nonexistent-uid`, null, b)).status, 404);
  // guessing a numeric id or a malformed id does not bypass authorization
  assert.equal((await S.api('GET', `/api/investigations/1`, null, b)).status, 404);
  assert.equal((await S.api('GET', `/api/investigations/..%2F..%2Fetc`, null, b)).status, 404);
  // evidence of the original result is served only to its owner
  const ev = S.db.get('SELECT uid FROM evidence WHERE result_id = ? LIMIT 1', f.resultId);
  assert.equal((await fetch(`${S.base}/api/evidence/${ev.uid}/file`)).status, 401, 'anonymous request refused');
  assert.equal((await fetch(`${S.base}/api/evidence/${ev.uid}/file`, { headers: { Cookie: S.jar.b } })).status, 404, 'another tenant cannot open the evidence');
  assert.equal((await fetch(`${S.base}/api/evidence/${ev.uid}/file`, { headers: { Cookie: S.jar.a } })).status, 200, 'the owner can open it');
});

test('evidence safety: traversal, malformed HAR and missing files are reported as unavailable and never crash the investigation', async () => {
  const S = await boot();
  const f = await failingProject(S);
  attach(S, f.resultId, 'broken.har', '{not json');
  S.db.run('INSERT INTO evidence (result_id, kind, name, rel_path, mime, size) VALUES (?, ?, ?, ?, ?, ?)', f.resultId, 'log', 'escape.log', '../../../../etc/passwd', 'text/plain', 10);
  S.db.run('INSERT INTO evidence (result_id, kind, name, rel_path, mime, size) VALUES (?, ?, ?, ?, ?, ?)', f.resultId, 'screenshot', 'gone.png', 'fixture-missing/gone.png', 'image/png', 10);
  const created = await S.api('POST', `/api/runs/${f.runId}/results/${f.resultId}/investigations`, {});
  assert.equal(created.status, 201, 'malformed evidence does not stop the investigation');
  const d = (await S.api('GET', `/api/investigations/${created.body.investigation.id}`)).body;
  const esc = d.evidence.items.find((x) => x.name === 'escape.log');
  const gone = d.evidence.items.find((x) => x.name === 'gone.png');
  assert.equal(esc.available, false, 'a path outside the evidence root is never treated as available');
  assert.equal(gone.available, false);
  assert.ok(d.evidence.completeness.missing.includes('gone.png'));
  const leak = JSON.stringify(d).match(/.{0,30}(etc\/passwd|fixture-missing|evidence\/).{0,30}/);
  assert.equal(leak, null, 'no filesystem path is exposed: ' + (leak && leak[0]));
});

test('verification: a fixed flow is VERIFIED_FIXED only with evidence and no new failure; the original execution is untouched', async () => {
  const S = await boot();
  const f = await failingProject(S);
  attach(S, f.resultId, 'network.har', har([hent('POST', 'https://shop.test/api/checkout', 500)]));
  const invId = (await S.api('POST', `/api/runs/${f.runId}/results/${f.resultId}/investigations`, {})).body.investigation.id;
  setState({ mode: 'ok', failWhen: [] }); // the defect is fixed in the application under test
  const v = await verifyAndWait(S, invId);
  assert.equal(v.status, 'QUEUED');
  // the passing verification run has its own HAR (clean), so the comparison has evidence on both sides
  const verResult = S.db.get('SELECT id FROM results WHERE run_id = ?', v.runId);
  attach(S, verResult.id, 'network.har', har([hent('POST', 'https://shop.test/api/checkout', 200)]));
  const done = (await S.api('GET', `/api/investigations/${invId}/verifications/${v.id}`)).body.verification;
  assert.equal(done.status, 'COMPLETED'); assert.equal(done.outcome, 'VERIFIED_FIXED'); assert.equal(done.outcomeLabel, 'FIX VERIFIED');
  assert.equal((await S.api('GET', `/api/investigations/${invId}`)).body.investigation.status, 'VERIFIED_FIXED');
  // the original execution and its evidence are exactly as before
  assert.equal(S.db.get('SELECT status FROM results WHERE id = ?', f.resultId).status, 'failed');
  assert.equal(S.db.get('SELECT COUNT(*) n FROM evidence WHERE result_id = ?', f.resultId).n >= 3, true);
  // a later reload returns the same persisted outcome (no recomputation drift)
  assert.equal((await S.api('GET', `/api/investigations/${invId}/verifications/${v.id}`)).body.verification.outcome, 'VERIFIED_FIXED');
});

test('verification: a reproduced failure is STILL_FAILING and a newly introduced failure is REGRESSION_INTRODUCED', async () => {
  const S = await boot();
  const still = await failingProject(S);
  attach(S, still.resultId, 'network.har', har([hent('POST', 'https://shop.test/api/checkout', 500)]));
  const invA = (await S.api('POST', `/api/runs/${still.runId}/results/${still.resultId}/investigations`, {})).body.investigation.id;
  setState({ mode: 'ok', failWhen: ['SAVE10'] });
  const vA = await verifyAndWait(S, invA);
  attach(S, S.db.get('SELECT id FROM results WHERE run_id = ?', vA.runId).id, 'network.har', har([hent('POST', 'https://shop.test/api/checkout', 500)]));
  sameFailureAs(S, vA.runId, { reason: 'Order total did not reduce after coupon SAVE10', step: JSON.stringify({ description: 'Submit checkout with coupon' }) });
  const a = (await S.api('GET', `/api/investigations/${invA}/verifications/${vA.id}`)).body.verification;
  assert.equal(a.outcome, 'STILL_FAILING', a.comparison?.reason);
  assert.equal(a.comparison.originalFailureStatus, 'PRESENT');

  const reg = await failingProject(S, { reason: 'Order total did not reduce after coupon SAVE10' });
  attach(S, reg.resultId, 'network.har', har([hent('POST', 'https://shop.test/api/checkout', 500)]));
  const invB = (await S.api('POST', `/api/runs/${reg.runId}/results/${reg.resultId}/investigations`, {})).body.investigation.id;
  setState({ mode: 'ok', failWhen: [] });
  const vB = await verifyAndWait(S, invB);
  attach(S, S.db.get('SELECT id FROM results WHERE run_id = ?', vB.runId).id, 'network.har', har([hent('GET', 'https://shop.test/api/cart', 502)]));
  const b = (await S.api('GET', `/api/investigations/${invB}/verifications/${vB.id}`)).body.verification;
  assert.equal(b.outcome, 'REGRESSION_INTRODUCED', b.comparison?.reason);
  assert.equal(b.comparison.newFailures[0].observation, 'GET https://shop.test/api/cart');
});

test('verification: missing evidence and infrastructure failures are INCONCLUSIVE, never a fix; attempts are retained', async () => {
  const S = await boot();
  const f = await failingProject(S);
  attach(S, f.resultId, 'network.har', har([hent('POST', 'https://shop.test/api/checkout', 500)]));
  const invId = (await S.api('POST', `/api/runs/${f.runId}/results/${f.resultId}/investigations`, {})).body.investigation.id;
  // attempt 1: the harness cannot authenticate, so Kane gives no verdict
  setState({ mode: 'unauthenticated', failWhen: [] });
  const v1 = await verifyAndWait(S, invId);
  const r1 = (await S.api('GET', `/api/investigations/${invId}/verifications/${v1.id}`)).body.verification;
  assert.equal(r1.outcome, 'INCONCLUSIVE'); assert.match(r1.comparison.reason, /never evidence that the defect was fixed/);
  assert.equal((await S.api('GET', `/api/investigations/${invId}`)).body.investigation.status, 'INCONCLUSIVE');
  // attempt 2: the application passes but records no network evidence → cannot prove the 5xx is gone
  setState({ mode: 'ok', failWhen: [] });
  const v2 = await verifyAndWait(S, invId);
  const r2 = (await S.api('GET', `/api/investigations/${invId}/verifications/${v2.id}`)).body.verification;
  assert.equal(r2.outcome, 'INCONCLUSIVE'); assert.match(r2.comparison.reason, /Insufficient evidence/);
  // both attempts are retained and listed in order
  const list = (await S.api('GET', `/api/investigations/${invId}`)).body.verifications;
  assert.deepEqual(list.map((x) => x.attempt), [2, 1]);
  assert.deepEqual(list.map((x) => x.outcome), ['INCONCLUSIVE', 'INCONCLUSIVE']);
});

test('verification: a second request while one is running is refused, and archived flows cannot be verified', async () => {
  const S = await boot();
  const f = await failingProject(S);
  attach(S, f.resultId, 'network.har', har([hent('POST', 'https://shop.test/api/checkout', 500)]));
  const invId = (await S.api('POST', `/api/runs/${f.runId}/results/${f.resultId}/investigations`, {})).body.investigation.id;
  setState({ mode: 'ok', failWhen: [] });
  const first = await S.api('POST', `/api/investigations/${invId}/verifications`, {});
  assert.equal(first.status, 202);
  const second = await S.api('POST', `/api/investigations/${invId}/verifications`, {});
  assert.equal(second.status, 409); assert.equal(second.body.verificationId, first.body.verification.id);
  await S.runner.idle();
  S.db.run('UPDATE criteria SET archived = 1 WHERE id = ?', f.criterionId);
  const archived = await S.api('POST', `/api/investigations/${invId}/verifications`, {});
  assert.equal(archived.status, 409); assert.match(archived.body.error, /archived or removed/);
});

test('report: an exportable JSON with evidence references, and no paths, credentials or raw output; tenant-scoped', async () => {
  const S = await boot();
  const f = await failingProject(S);
  attach(S, f.resultId, 'network.har', har([hent('POST', 'https://shop.test/api/checkout?session=sekret', 500)]));
  const invId = (await S.api('POST', `/api/runs/${f.runId}/results/${f.resultId}/investigations`, {})).body.investigation.id;
  setState({ mode: 'ok', failWhen: ['SAVE10'] });
  const v = await verifyAndWait(S, invId);
  // the verification run reports the same failure, with the same evidence kinds as the original
  sameFailureAs(S, v.runId, { reason: 'Order total did not reduce after coupon SAVE10', step: JSON.stringify({ description: 'Submit checkout with coupon' }) });
  attach(S, S.db.get('SELECT id FROM results WHERE run_id = ?', v.runId).id, 'network.har', har([hent('POST', 'https://shop.test/api/checkout', 500)]));
  const url = `${S.base}/api/investigations/${invId}/verifications/${v.id}/report`;
  assert.equal((await fetch(url)).status, 401, 'anonymous download refused');
  assert.equal((await fetch(url, { headers: { Cookie: S.jar.b } })).status, 404, 'another tenant cannot download it');
  const ok = await fetch(url, { headers: { Cookie: S.jar.a } });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-disposition'), /attachment; filename="shipproof-fix-verification-/);
  const text = await ok.text();
  const body = JSON.parse(text);
  assert.equal(body.schema, 'shipproof.fix-verification.v1');
  assert.equal(body.verification.outcome, 'STILL_FAILING');
  assert.ok(body.verification.comparison.evidenceRefs.original.length >= 1, 'references the original evidence by id');
  assert.doesNotMatch(text, /sekret|stdout|stderr|sp_session|pass_hash/, 'no query secrets, raw output or credentials');
  assert.equal(text.includes(S.dataDir), false, 'no filesystem path');
});
