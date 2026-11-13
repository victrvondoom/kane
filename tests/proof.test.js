// Layer 3 — proof intelligence: versions, builds, change impact, freshness, stability, policy decisions,
// GitHub webhook, CI lifecycle, dossiers. The engine is the TEST-ONLY stand-in tests/fixtures/fake-kane.js;
// GitHub is represented by locally signed payloads. Nothing here is Kane CLI or GitHub evidence.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { globToRegex, matchPaths, classifyStability, validatePolicy, normalizePaths, validSha, DEFAULT_POLICY } from '../server/proof.js';
import { canonical, verifyDossier } from '../server/keys.js';

process.env.LOG_LEVEL = 'silent';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shipproof-proof-'));
const stateFile = path.join(tmp, 'state.json');
const setState = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));
process.env.FAKE_KANE_STATE = stateFile;
const baseConfig = { bin: path.join(here, 'fixtures', 'fake-kane.js'), timeout: 30, maxSteps: 10, headless: true, username: '', accessKey: '', requireEvidence: true, allowPrivateTargets: true, acceptFixtureEngine: true };
const SHA = (n) => crypto.createHash('sha1').update(String(n)).digest('hex');

function client(base) {
  const jar = {};
  return async (method, url, body, who = 'a', headers = {}) => {
    const res = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(jar[who] ? { Cookie: jar[who] } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) jar[who] = sc.split(';')[0];
    return { status: res.status, body: (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text() };
  };
}
async function boot(name, config = baseConfig) {
  const ctx = createApp({ dataDir: path.join(tmp, name), config });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { ...ctx, server, base, api: client(base), dataDir: path.join(tmp, name), stop: async () => { server.close(); server.closeAllConnections?.(); await ctx.shutdown(); } };
}
/** New account + project with criteria; `specs` = [{ text, paths?, criticality?, mandatory? }] */
async function seed(S, specs) {
  const api = client(S.base);
  await api('POST', '/api/auth/signup', { email: `u${crypto.randomUUID()}@example.com`, name: 'T', password: 'correct-horse' });
  const pid = (await api('POST', '/api/projects', { name: 'P', appUrl: 'http://127.0.0.1:9/' })).body.project.id;
  let criteria;
  for (const s of specs) criteria = (await api('POST', `/api/projects/${pid}/criteria`, s)).body.criteria;
  const run = async (body = {}) => { const r = await api('POST', `/api/projects/${pid}/runs`, body); assert.equal(r.status, 202, JSON.stringify(r.body)); await S.runner.idle(); return r.body.run; };
  const intel = async () => (await api('GET', `/api/projects/${pid}/intelligence`)).body.decision;
  const build = async (n, changedPaths, extra = {}) => (await api('POST', `/api/projects/${pid}/builds`, { commitSha: SHA(n), changedPaths, ...extra })).body.build;
  const states = async () => Object.fromEntries((await intel()).criteria.map((c) => [c.key, c.freshness.state]));
  return { api, pid, criteria, run, intel, build, states };
}

let A;
before(async () => { A = await boot('a'); setState({ mode: 'ok', failWhen: [] }); });
after(async () => { await A.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------- pure logic ----------
test('path patterns: globs match deterministically and metacharacters are literal', () => {
  const m = (p, f) => globToRegex(p).test(f);
  assert.ok(m('src/cart/**', 'src/cart/a/b.js')); assert.ok(m('src/cart/**', 'src/cart/x.js')); assert.ok(!m('src/cart/**', 'src/cartoon/x.js'));
  assert.ok(m('**/*.css', 'a/b/c.css')); assert.ok(m('**/*.css', 'c.css')); assert.ok(!m('*.css', 'a/c.css'));
  assert.ok(m('src/?.js', 'src/a.js')); assert.ok(!m('src/?.js', 'src/ab.js'));
  assert.ok(m('a.b(c)+[d]', 'a.b(c)+[d]')); assert.ok(!m('a.b', 'axb'), 'dot is not a wildcard'); assert.ok(m('src/**', 'src')); assert.ok(m('src/**/test/*.js', 'src/a/b/test/x.js')); assert.ok(m('*a*b*c', 'xxaxxbxxc'));
  assert.ok(!m('(a+)+$', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!'));
  const t0 = Date.now(); m('**/**/**/**/x', 'a/'.repeat(400) + 'y'); m('*a*a*a*a*a*a*a*b', 'a'.repeat(900)); assert.ok(Date.now() - t0 < 500, 'no catastrophic backtracking');
  assert.deepEqual(matchPaths(['src/auth/**', 'README.md'], ['src/auth/login.js', 'src/cart/x.js', 'README.md']), ['src/auth/login.js', 'README.md']);
});
test('stability classification needs a minimum sample and uses application outcomes only', () => {
  const c = (list, min = 5) => classifyStability(list.split('').map((x) => (x === 'P' ? 'passed' : 'failed')), min);
  assert.equal(c('PPPP').classification, 'insufficient_data');
  assert.equal(c('PPPPP').classification, 'stable_pass'); assert.equal(c('FFFFF').classification, 'stable_fail');
  const i = c('PFPPF'); assert.equal(i.classification, 'intermittent'); assert.equal(i.failures, 2); assert.equal(i.failureRate, 0.4); assert.equal(i.flips, 3);
  assert.equal(c('PFP', 3).classification, 'intermittent');
});
test('policy, path and commit validation', () => {
  assert.deepEqual(validatePolicy({}), DEFAULT_POLICY);
  assert.throws(() => validatePolicy({ nope: true }), /Unknown policy rule/); assert.throws(() => validatePolicy({ requireBuild: 'yes' }), /true or false/);
  assert.throws(() => validatePolicy({ minStabilitySample: 1 }), /between 3 and 50/);
  assert.deepEqual(normalizePaths(['./b.js', 'a.js', 'a.js']), { paths: ['a.js', 'b.js'], known: true });
  assert.equal(normalizePaths(undefined).known, false); assert.equal(normalizePaths(Array(5001).fill('x')).known, false);
  assert.ok(validSha('abc1234')); assert.ok(!validSha('abc123')); assert.ok(!validSha('zzzzzzz')); assert.ok(!validSha("abc1234'; DROP"));
  assert.equal(canonical({ b: 1, a: [{ d: 1, c: 2 }] }), '{"a":[{"c":2,"d":1}],"b":1}');
});

// ---------- versions & proof graph ----------
test('criterion edits append immutable versions; executions stay linked to the version they ran', async () => {
  const s = await seed(A, [{ text: 'The cart total is correct.', paths: ['src/cart/**'], criticality: 'high', areas: ['checkout'] }]);
  const cid = s.criteria[0].id;
  assert.equal((await s.api('POST', `/api/projects/${s.pid}/criteria`, { text: 'Bad pattern.', paths: ['../etc/passwd'] })).status, 400);
  assert.equal((await s.api('PATCH', `/api/projects/${s.pid}/criteria/${cid}`, { criticality: 'extreme' })).status, 400);
  const run1 = await s.run();
  await s.api('PATCH', `/api/projects/${s.pid}/criteria/${cid}`, { areas: ['checkout', 'pricing'] });   // metadata only → v2, evidence kept
  assert.deepEqual(await s.states(), { 'AC-001': 'CURRENT' });
  await s.api('PATCH', `/api/projects/${s.pid}/criteria/${cid}`, { text: 'The cart total is correct to the cent.' }); // text → v3, evidence no longer applies
  const st = (await s.intel()).criteria[0];
  assert.equal(st.freshness.state, 'UNVERIFIED'); assert.equal(st.freshness.reasons[0].code, 'criterion_changed');
  const run2 = await s.run();
  const t = (await s.api('GET', `/api/projects/${s.pid}/proof/criteria/${cid}`)).body.trace;
  assert.deepEqual(t.versions.map((v) => [v.number, v.current, v.executions]), [[3, true, 1], [2, false, 0], [1, false, 1]]);
  assert.equal(new Set(t.versions.map((v) => v.contentHash)).size, 3);
  assert.equal(t.versions[2].text, 'The cart total is correct.', 'history is not rewritten');
  assert.deepEqual(t.executions.map((e) => [e.runId, e.versionId, e.appliesToCurrentText]), [[run2.id, t.versions[0].id, true], [run1.id, t.versions[2].id, false]]);
  assert.ok(t.executions[0].evidence.every((e) => /^[0-9a-f]{64}$/.test(e.sha256) || e.kind === 'test_manager'));
  assert.ok(t.executions[0].eventCount > 0); assert.equal(t.executions[0].engineKind, 'test-fixture');
  assert.equal(t.criterion.freshness.state, 'CURRENT');
  // search by evidence hash and by key; another account sees nothing
  const hash = t.executions[0].evidence.find((e) => e.sha256).sha256;
  const found = (await s.api('GET', `/api/projects/${s.pid}/proof?q=${hash.slice(0, 16)}`)).body;
  assert.equal(found.evidence[0].criterion_id, cid);
  assert.equal((await s.api('GET', `/api/projects/${s.pid}/proof?q=pricing`)).body.criteria.length, 1);
  assert.equal((await s.api('GET', `/api/projects/${s.pid}/proof?q=nomatch`)).body.criteria.length, 0);
  const other = client(A.base); await other('POST', '/api/auth/signup', { email: `o${crypto.randomUUID()}@example.com`, name: 'O', password: 'correct-horse' });
  for (const u of [`/proof`, `/proof/criteria/${cid}`, `/builds`, `/intelligence`, `/policy`, `/dossiers`, `/integration`]) assert.equal((await other('GET', `/api/projects/${s.pid}${u}`)).status, 404, u);
});

// ---------- builds, impact, freshness ----------
test('a new build produces an impact analysis; stale evidence blocks; history is preserved', async () => {
  const s = await seed(A, [{ text: 'Cart totals are right.', paths: ['src/cart/**'] }, { text: 'Login works.', paths: ['src/auth/**'] }, { text: 'Unmapped behaviour holds.' }]);
  assert.equal((await s.api('POST', `/api/projects/${s.pid}/builds`, { commitSha: 'not-a-sha' })).status, 400);
  assert.equal((await s.api('POST', `/api/projects/${s.pid}/builds`, { commitSha: SHA(0), appUrl: 'http://169.254.169.254/' })).status, 400, 'build URLs obey the SSRF policy');
  const b1 = await s.build(1, ['README.md']);
  assert.equal((await s.api('POST', `/api/projects/${s.pid}/builds`, { commitSha: SHA(1), changedPaths: ['other'] })).body.created, false, 'registration is idempotent');
  assert.deepEqual((await s.api('GET', `/api/projects/${s.pid}/builds`)).body.builds[0].changedPaths, ['README.md'], 'a known change set is never replaced');
  const run1 = await s.run();
  assert.equal(run1.build.id, b1.id);
  assert.equal((await s.intel()).verdict, 'verified');

  const b2 = await s.build(2, ['src/cart/total.js', 'docs/notes.md']);
  assert.deepEqual(await s.states(), { 'AC-001': 'STALE', 'AC-002': 'CURRENT', 'AC-003': 'STALE' });
  let d = await s.intel();
  assert.equal(d.verdict, 'unverified'); assert.equal(d.releaseAllowed, false);
  assert.deepEqual(d.blocking.map((b) => [b.code, b.criterionKey]), [['STALE_EVIDENCE', 'AC-001'], ['STALE_EVIDENCE', 'AC-003']]);
  assert.deepEqual(d.criteria.map((c) => c.freshness.reasons[0].code), ['affected_by_change', 'carried_forward', 'unmapped']);
  assert.equal(d.strictGate.verdict, 'verified', 'the strict gate alone would have allowed it — freshness is what blocks');
  assert.equal((await s.api('GET', `/api/projects/${s.pid}`)).body.project.gate.verdict, 'unverified', 'project status uses the same decision');
  const plan = (await s.api('GET', `/api/projects/${s.pid}/builds/${b2.id}/impact`)).body;
  assert.deepEqual(plan.summary, { affected: 1, unaffected: 1, unknown: 1, toVerify: 2, total: 3 });
  assert.deepEqual(plan.items.map((i) => [i.key, i.impact, i.include]), [['AC-001', 'affected', true], ['AC-002', 'unaffected', false], ['AC-003', 'unknown', true]]);
  assert.match(plan.items[0].why, /src\/cart\/total\.js/); assert.match(plan.items[1].why, /^Excluded/); assert.deepEqual(plan.items[0].matched, ['src/cart/total.js']);

  const run2 = await s.run({ mode: 'plan' });
  assert.equal(run2.total, 2, 'only the planned criteria are executed'); assert.equal(run2.build.id, b2.id);
  assert.equal((await s.intel()).verdict, 'verified');
  assert.equal((await s.api('POST', `/api/projects/${s.pid}/runs`, { mode: 'plan' })).status, 400, 'nothing left to verify');
  assert.deepEqual(A.db.all('SELECT build_id, status FROM results WHERE run_id = ?', run1.id).map((r) => [r.build_id, r.status]), [[b1.id, 'passed'], [b1.id, 'passed'], [b1.id, 'passed']], 'older executions are untouched');

  // a build whose change set is unknown invalidates everything by default…
  await s.build(3, undefined);
  assert.deepEqual(Object.values(await s.states()), ['STALE', 'STALE', 'STALE']);
  assert.equal((await s.intel()).criteria[1].freshness.reasons[0].code, 'unknown_change_set');
  // …unless the project policy explicitly accepts unknown impact (new policy version, recorded)
  const pol = (await s.api('PUT', `/api/projects/${s.pid}/policy`, { rules: { ...DEFAULT_POLICY, unknownImpactInvalidates: false } })).body.policy;
  assert.equal(pol.version, 2);
  assert.equal((await s.intel()).verdict, 'verified'); assert.equal((await s.intel()).policy.version, 2);
  assert.equal((await s.api('PUT', `/api/projects/${s.pid}/policy`, { rules: { bogus: 1 } })).status, 400);
  await s.api('PUT', `/api/projects/${s.pid}/policy`, { rules: DEFAULT_POLICY });
  await s.run();

  // re-mapping a criterion after the fact cannot rescue its evidence
  await s.build(4, ['src/auth/login.js']);
  assert.equal((await s.states())['AC-002'], 'STALE');
  await s.api('PATCH', `/api/projects/${s.pid}/criteria/${s.criteria[1].id}`, { paths: ['somewhere/else/**'] });
  d = await s.intel();
  assert.equal(d.criteria[1].freshness.state, 'STALE'); assert.equal(d.criteria[1].freshness.reasons[0].code, 'mapping_changed');
  await s.run({ mode: 'plan' });
  assert.equal((await s.intel()).verdict, 'verified');

  // evidence from another environment does not verify a build in this one
  await s.build(5, ['docs/x.md'], { environment: 'staging' });
  d = await s.intel();
  assert.equal(d.build.environment, 'staging'); assert.ok(d.criteria.every((c) => c.freshness.state === 'STALE'));
  assert.ok(d.criteria[0].freshness.reasons.some((r) => r.code === 'different_environment'));
  const list = (await s.api('GET', `/api/projects/${s.pid}/builds?environment=staging`)).body;
  assert.equal(list.total, 1); assert.deepEqual(list.environments, ['default', 'staging']);
  assert.equal((await s.api('GET', `/api/projects/${s.pid}/builds?q=${SHA(2).slice(0, 10)}`)).body.builds[0].commitSha, SHA(2));
});

test('a failed newer run overrides an older pass; a fixture pass does not count unless explicitly accepted', async () => {
  const s = await seed(A, [{ text: 'Thing ALPHA works.' }]);
  await s.run(); assert.equal((await s.intel()).verdict, 'verified');
  setState({ mode: 'ok', failWhen: ['ALPHA'] }); await s.run();
  const d = await s.intel();
  assert.equal(d.verdict, 'blocked'); assert.equal(d.blocking[0].code, 'FAILED'); assert.ok(d.blocking[0].runId && d.blocking[0].action);
  setState({ mode: 'ok', failWhen: [] });
  const B = await boot('strict', { ...baseConfig, acceptFixtureEngine: false });
  const t = await seed(B, [{ text: 'Thing works.' }]);
  await t.run();
  const e = await t.intel();
  assert.equal(e.strictGate.verdict, 'verified'); assert.equal(e.verdict, 'unverified');
  assert.equal(e.criteria[0].freshness.state, 'BLOCKED'); assert.equal(e.criteria[0].freshness.reasons[0].code, 'fixture_engine');
  assert.equal((await t.api('GET', `/api/projects/${t.pid}`)).body.project.gate.verdict, 'unverified');
  await B.stop();
});

// ---------- stability & risk ----------
test('stability comes from real application outcomes; infrastructure failures are excluded; risk never changes a verdict', async () => {
  const s = await seed(A, [{ text: 'Checkout BETA completes.', criticality: 'critical' }, { text: 'Footer shows.', criticality: 'low', paths: ['src/footer/**'] }]);
  const one = { criterionIds: [s.criteria[0].id] };
  for (const fail of [false, true, false, false]) { setState({ mode: 'ok', failWhen: fail ? ['BETA'] : [] }); await s.run(); }
  let c = (await s.intel()).criteria[0];
  assert.equal(c.stability.classification, 'insufficient_data'); assert.equal(c.stability.sample, 4);
  for (const mode of ['unauthenticated', 'network']) { setState({ mode }); await s.run(one); }   // infrastructure, not application behaviour
  c = (await s.intel()).criteria[0];
  assert.equal(c.stability.sample, 4, 'auth and network errors are not samples'); assert.deepEqual(c.stability.excluded.byKind, { auth: 1, network: 1 });
  assert.equal(c.freshness.state, 'BLOCKED');
  setState({ mode: 'ok', failWhen: [] }); await s.run(one); await s.run({ criterionIds: [s.criteria[1].id] });
  let d = await s.intel(); c = d.criteria[0];
  assert.deepEqual([c.stability.classification, c.stability.sample, c.stability.failures, c.stability.failureRate], ['intermittent', 5, 1, 0.2]);
  assert.deepEqual(c.stability.recent.map((r) => r.status), ['passed', 'failed', 'passed', 'passed', 'passed']);
  assert.equal(c.freshness.state, 'CURRENT', 'its latest execution passed');
  assert.equal(d.verdict, 'blocked'); assert.deepEqual(d.blocking.map((b) => b.code), ['CRITICAL_UNSTABLE']);
  assert.equal(d.criteria[1].stability.classification, 'stable_pass');
  assert.ok(c.risk.factors.some((f) => f.factor === 'stability') && c.risk.factors.some((f) => f.factor === 'criticality' && f.points === 3));
  assert.equal(c.risk.score, c.risk.factors.reduce((a, f) => a + f.points, 0)); assert.equal(d.criteria[1].risk.level, 'low');
  // policy can stop treating instability as blocking — but can never turn a failure into a pass
  await s.api('PUT', `/api/projects/${s.pid}/policy`, { rules: { ...DEFAULT_POLICY, blockCriticalUnstable: false } });
  assert.equal((await s.intel()).verdict, 'verified');
  setState({ mode: 'ok', failWhen: ['BETA'] }); await s.run(one);
  await s.api('PUT', `/api/projects/${s.pid}/policy`, { rules: Object.fromEntries(Object.entries(DEFAULT_POLICY).map(([k, v]) => [k, typeof v === 'boolean' ? false : v])) });
  d = await s.intel();
  assert.equal(d.verdict, 'blocked', 'with every configurable rule off, a failed mandatory criterion still blocks'); assert.equal(d.blocking[0].code, 'FAILED');
  setState({ mode: 'ok', failWhen: [] });
});

// ---------- GitHub webhook ----------
test('GitHub webhook: HMAC verified over raw bytes, deliveries are idempotent, change sets recorded', async () => {
  const s = await seed(A, [{ text: 'Cart works.', paths: ['src/cart/**'] }]);
  await s.run();
  const url = `${A.base}/api/webhooks/github/${s.pid}`;
  const post = (body, secret, headers = {}) => { const raw = JSON.stringify(body);
    return fetch(url, { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'push', 'X-GitHub-Delivery': crypto.randomUUID(),
      'X-Hub-Signature-256': 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex'), ...headers } }); };
  const push = (n, files, extra = {}) => ({ ref: 'refs/heads/main', before: SHA(n - 1), after: SHA(n), forced: false, head_commit: { message: `change ${n}\n\nbody` },
    commits: [{ id: SHA(n), added: [], modified: files, removed: [] }], ...extra });
  assert.equal((await post(push(10, ['a']), 'whatever')).status, 401, 'no secret configured');
  const secret = (await s.api('POST', `/api/projects/${s.pid}/webhook`, { environment: 'default' })).body.secret;
  assert.ok(!JSON.stringify(A.db.get('SELECT * FROM projects WHERE id = ?', s.pid)).includes(secret), 'secret is encrypted at rest');
  assert.equal((await post(push(10, ['a']), 'wrong-secret')).status, 401);
  const raw = JSON.stringify(push(10, ['src/cart/x.js']));
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const hdr = { 'Content-Type': 'application/json', 'X-GitHub-Event': 'push', 'X-GitHub-Delivery': 'delivery-0001', 'X-Hub-Signature-256': sig };
  assert.equal((await fetch(url, { method: 'POST', body: raw.replace('x.js', 'y.js'), headers: hdr })).status, 401, 'tampered body');
  assert.equal(A.db.get('SELECT COUNT(*) n FROM builds WHERE project_id = ?', s.pid).n, 0);
  const first = await fetch(url, { method: 'POST', body: raw, headers: hdr });
  assert.equal(first.status, 202);
  const b = (await first.json()).build;
  assert.deepEqual([b.commitSha, b.branch, b.source, b.pathsKnown, b.message], [SHA(10), 'main', 'github_webhook', true, 'change 10']); assert.deepEqual(b.changedPaths, ['src/cart/x.js']);
  const replay = await fetch(url, { method: 'POST', body: raw, headers: hdr });
  assert.equal(replay.status, 200); assert.equal((await replay.json()).duplicate, true);
  assert.equal(A.db.get('SELECT COUNT(*) n FROM builds WHERE project_id = ?', s.pid).n, 1, 'replayed delivery is not processed twice');
  assert.equal((await s.states())['AC-001'], 'STALE', 'the pushed change invalidated mapped evidence');
  assert.equal((await post(push(11, ['z']), secret, { 'X-GitHub-Delivery': '' })).status, 400);
  const forced = await (await post(push(12, ['z'], { forced: true }), secret)).json();
  assert.equal(forced.build.pathsKnown, false, 'a force push cannot be trusted as a complete change set');
  assert.equal((await (await post({ zen: 'x' }, secret, { 'X-GitHub-Event': 'ping' })).json()).event, 'ping');
  assert.equal((await (await post(push(13, [], { deleted: true, after: '0'.repeat(40) }), secret)).json()).ignored, true);
  assert.equal((await (await post({ action: 'opened' }, secret, { 'X-GitHub-Event': 'issues' })).json()).ignored, true);
  const integ = (await s.api('GET', `/api/projects/${s.pid}/integration`)).body;
  assert.equal(integ.webhook.configured, true); assert.deepEqual(integ.deliveries.map((d) => d.outcome).sort(), ['build_registered', 'build_registered', 'ignored', 'ignored', 'ok']);
  assert.ok(!JSON.stringify(integ).includes(secret));
  await s.api('DELETE', `/api/projects/${s.pid}/webhook`);
  assert.equal((await post(push(14, ['a']), secret)).status, 401, 'removed secret stops working');
  const acts = (await s.api('GET', `/api/projects/${s.pid}/audit`)).body.events.map((e) => e.action);
  for (const a of ['webhook.created', 'build.registered', 'webhook.removed']) assert.ok(acts.includes(a), a);
});

// ---------- CI lifecycle through the shipped client ----------
test('CI: the shipped client registers the commit, runs the plan, waits, and exits on the real decision', async () => {
  const s = await seed(A, [{ text: 'Pricing GAMMA is right.', paths: ['src/pricing/**'] }, { text: 'Docs page loads.', paths: ['docs/**'] }]);
  const key = (await s.api('POST', `/api/projects/${s.pid}/api-key`, {})).body.apiKey;
  const ci = (env) => new Promise((resolve) => {
    const changed = path.join(tmp, `changed-${crypto.randomUUID()}.txt`); fs.writeFileSync(changed, (env.files || []).join('\n'));
    const summary = path.join(tmp, `summary-${crypto.randomUUID()}.md`);
    const c = spawn(process.execPath, [path.join(root, 'public', 'ci', 'shipproof-ci.mjs')], { env: { PATH: process.env.PATH, SHIPPROOF_URL: A.base, SHIPPROOF_API_KEY: key, POLL_MS: '100', GITHUB_STEP_SUMMARY: summary,
      ...(env.files ? { CHANGED_PATHS_FILE: changed } : {}), ...env.vars } });
    let out = ''; c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d));
    c.on('close', (code) => resolve({ code, out, summary: fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '' }));
  });
  setState({ mode: 'ok', failWhen: ['GAMMA'] });
  const r1 = await ci({ vars: { COMMIT_SHA: SHA(20), BRANCH: 'main', BUILD_ID: 'run-1' }, files: ['src/pricing/coupon.js'] });
  assert.equal(r1.code, 1, r1.out); assert.match(r1.out, /BLOCKED/); assert.match(r1.out, /\[FAILED\] AC-001/); assert.match(r1.summary, /SHIPPROOF: BLOCKED/);
  const build = A.db.get('SELECT * FROM builds WHERE project_id = ? AND commit_sha = ?', s.pid, SHA(20));
  assert.deepEqual([build.source, build.branch, build.build_identifier], ['ci', 'main', 'run-1']);
  const dec = A.db.get('SELECT * FROM release_decisions WHERE project_id = ? ORDER BY id DESC', s.pid);
  assert.deepEqual([dec.verdict, dec.build_id, dec.requested_by], ['blocked', build.id, 'ci'], 'the decision is persisted against the commit');
  // the fix lands as a new commit touching only pricing: only AC-001 is re-run, AC-002 evidence carries forward
  setState({ mode: 'ok', failWhen: [] });
  const r2 = await ci({ vars: { COMMIT_SHA: SHA(21) }, files: ['src/pricing/coupon.js'] });
  assert.equal(r2.code, 0, r2.out); assert.match(r2.out, /1 affected, 0 unknown, 1 unaffected, 1 to verify/); assert.match(r2.out, /VERIFIED/);
  const lastRun = A.db.get('SELECT * FROM runs WHERE project_id = ? ORDER BY id DESC', s.pid);
  assert.equal(lastRun.trigger, 'impact_plan'); assert.equal(A.db.get('SELECT COUNT(*) n FROM results WHERE run_id = ?', lastRun.id).n, 1);
  const r3 = await ci({ vars: { COMMIT_SHA: SHA(21) }, files: ['src/pricing/coupon.js'] });   // re-running the job is safe
  assert.equal(r3.code, 0); assert.match(r3.out, /nothing to verify/);
  const r4 = await ci({ vars: { COMMIT_SHA: SHA(22) } });                                       // no file list → unknown impact → everything re-verified
  assert.equal(r4.code, 0); assert.match(r4.out, /0 affected, 2 unknown, 0 unaffected, 2 to verify/);
  // authorization
  assert.equal((await ci({ vars: { COMMIT_SHA: SHA(23), SHIPPROOF_API_KEY: 'spk_' + 'x'.repeat(30) } })).code, 2);
  assert.equal((await ci({ vars: { COMMIT_SHA: 'nonsense' } })).code, 2);
  assert.equal((await s.api('GET', `/api/agent/decision?commitSha=${SHA(99)}`, null, 'anon', { Authorization: `Bearer ${key}` })).status, 404);
  const other = await seed(A, [{ text: 'x holds true.' }]);
  const otherKey = (await other.api('POST', `/api/projects/${other.pid}/api-key`, {})).body.apiKey;
  assert.equal((await s.api('GET', `/api/agent/decision?commitSha=${SHA(21)}`, null, 'anon', { Authorization: `Bearer ${otherKey}` })).status, 404, 'a key only reaches its own project\'s builds');
  assert.equal((await s.api('GET', `/api/agent/runs/${lastRun.id}`, null, 'anon', { Authorization: `Bearer ${otherKey}` })).status, 404);
  assert.equal((await fetch(`${A.base}/ci/shipproof-verify.yml`)).status, 200);
});

// ---------- dossier ----------
test('proof dossier: canonical, signed, independently verifiable, and honest about what it contains', async () => {
  const s = await seed(A, [{ text: 'Order DELTA is confirmed.', paths: ['src/orders/**'], criticality: 'high' }, { text: 'Never executed criterion.', mandatory: false }]);
  setState({ mode: 'ok', failWhen: ['DELTA'] }); await s.build(30, ['src/orders/a.js']); const fail = await s.run({ criterionIds: [s.criteria[0].id] });
  const task = (await s.api('GET', `/api/projects/${s.pid}`)).body.repairTasks[0];
  setState({ mode: 'ok', failWhen: [] });
  const fix = (await s.api('POST', `/api/repair-tasks/${task.id}/fix-applied`, { note: 'fixed' })).body.run; await A.runner.idle();
  const { id, document } = (await s.api('POST', `/api/projects/${s.pid}/dossiers`, {})).body;
  const p = document.payload;
  assert.equal(p.schema, 'shipproof.dossier/v1'); assert.equal(p.build.commitSha, SHA(30)); assert.equal(p.decision.verdict, 'verified'); assert.equal(p.policy.version, 1);
  const c = p.criteria[0];
  assert.equal(c.version.number, 1); assert.match(c.version.contentHash, /^[0-9a-f]{64}$/); assert.equal(c.freshness.state, 'CURRENT');
  assert.deepEqual([c.supportingExecution.runId, c.supportingExecution.commitSha, c.supportingExecution.engineKind, c.supportingExecution.engine], [fix.id, SHA(30), 'test-fixture', 'kane-cli fixture']);
  assert.deepEqual(c.executions.map((e) => [e.runId, e.status]), [[fail.id, 'failed'], [fix.id, 'passed']]);
  assert.equal(p.criteria[1].supportingExecution, null); assert.equal(p.criteria[1].freshness.state, 'UNVERIFIED');
  assert.deepEqual(p.executionSummary, { kaneCli: 0, testFixture: 1, unverified: 1, missingEvidence: 0, evidenceMismatch: 0 }, 'fixture results are never reported as Kane CLI');
  assert.deepEqual([p.repairs[0].originRunId, p.repairs[0].verifyRunId, p.repairs[0].status], [fail.id, fix.id, 'verified']);
  // evidence hashes are the real file hashes
  const ev = c.supportingExecution.evidence.find((e) => e.sha256);
  const row = A.db.get('SELECT rel_path FROM evidence WHERE uid = ?', ev.id), file = path.join(A.dataDir, 'evidence', row.rel_path);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), ev.sha256); assert.equal(ev.integrity, 'ok');
  // independent verification from the document alone
  assert.deepEqual(verifyDossier(document), { valid: true, problems: [] });
  assert.ok(crypto.verify(null, Buffer.from(document.manifest.payloadSha256), crypto.createPublicKey(document.manifest.publicKey), Buffer.from(document.manifest.signature, 'base64')));
  assert.equal(crypto.createHash('sha256').update(canonical(p)).digest('hex'), document.manifest.payloadSha256);
  const forged = structuredClone(document); forged.payload.decision.verdict = 'verified'; forged.payload.criteria[1].freshness.state = 'CURRENT';
  assert.equal(verifyDossier(forged).valid, false); assert.ok(verifyDossier(forged).problems.some((x) => /criteria/.test(x)));
  const resigned = structuredClone(forged); resigned.manifest.payloadSha256 = crypto.createHash('sha256').update(canonical(resigned.payload)).digest('hex');
  assert.equal(verifyDossier(resigned).valid, false, 'recomputing the hash without the private key does not help');
  // server endpoints: stored copy, download, public verify, key
  const stored = (await s.api('GET', `/api/dossiers/${id}`)).body;
  assert.equal(stored.verification.valid, true); assert.equal(stored.signedByThisServer, true); assert.equal(stored.payloadSha256, document.manifest.payloadSha256);
  assert.equal(JSON.parse((await s.api('GET', `/api/dossiers/${id}/download`)).body === undefined ? '{}' : JSON.stringify((await s.api('GET', `/api/dossiers/${id}/download`)).body)).manifest.signature, document.manifest.signature);
  const anon = client(A.base);
  assert.equal((await anon('POST', '/api/dossiers/verify', { document })).body.valid, true);
  assert.equal((await anon('POST', '/api/dossiers/verify', { document: forged })).body.valid, false);
  assert.equal((await anon('GET', '/api/dossier-key')).body.keyId, document.manifest.keyId);
  assert.equal((await anon('GET', `/api/dossiers/${id}`)).status, 401);
  const other = await seed(A, [{ text: 'y holds true.' }]);
  assert.equal((await other.api('GET', `/api/dossiers/${id}`)).status, 404); assert.equal((await other.api('GET', `/api/dossiers/${id}/download`)).status, 404);
  const text = JSON.stringify(document);
  for (const secret of ['correct-horse', 'stdout', 'spk_', 'whsec_', 'pass_hash', 'PRIVATE KEY']) assert.ok(!text.includes(secret), secret);
  // offline CLI verifier
  const f = path.join(tmp, 'dossier.json'); fs.writeFileSync(f, text);
  const cli = (args) => new Promise((r) => { const ch = spawn(process.execPath, [path.join(root, 'scripts', 'verify-dossier.mjs'), ...args]); let o = ''; ch.stdout.on('data', (d) => (o += d)); ch.on('close', (code) => r({ code, o })); });
  const okRun = await cli([f, '--trust-key', document.manifest.keyId]); assert.equal(okRun.code, 0, okRun.o); assert.match(okRun.o, /VALID/); assert.match(okRun.o, /1 test fixture/);
  assert.equal((await cli([f, '--trust-key', 'deadbeefdeadbeef'])).code, 1);
  fs.writeFileSync(f, JSON.stringify(forged)); assert.equal((await cli([f])).code, 1);
  // tampering with an evidence file on disk is detected in the next dossier
  fs.appendFileSync(file, 'tampered');
  const d2 = (await s.api('POST', `/api/projects/${s.pid}/dossiers`, {})).body.document;
  assert.equal(d2.payload.criteria[0].supportingExecution.evidence.find((e) => e.id === ev.id).integrity, 'mismatch'); assert.equal(d2.payload.executionSummary.evidenceMismatch, 1);
  assert.equal((await s.api('GET', `/api/projects/${s.pid}/dossiers`)).body.dossiers.length, 2);
});
