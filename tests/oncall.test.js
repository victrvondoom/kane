// On-call engineering agent: end-to-end tests over real HTTP, real SQLite, real git repositories (with a real bare
// remote), real child-process test runs and real WebSocket/HTTP traffic to the voice adapter.
// The only stand-ins are in tests/fixtures/oncall-doubles.js and are test-only: a scripted reasoning provider
// (instead of an LLM), a local GitHub REST double, and a local server speaking the GPT-Live wire protocol.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { oncallConfig, roleOf, argv } from '../server/oncall/config.js';
import { createRedactor, scrubbedEnv } from '../server/oncall/redact.js';
import { validate } from '../server/oncall/tools/registry.js';
import { safePath, isDenied, parseGithubRepo } from '../server/oncall/git.js';
import { runCheck, testCounts } from '../server/oncall/checks.js';
import { canonical } from '../server/keys.js';
import { scriptedReasoning, fakeGithub, fakeLiveProvider, makeRepo, call, say } from './fixtures/oncall-doubles.js';

process.env.LOG_LEVEL = 'silent';
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shipproof-oncall-'));
const stateFile = path.join(tmp, 'kane-state.json');
process.env.FAKE_KANE_STATE = stateFile;
fs.writeFileSync(stateFile, JSON.stringify({ failWhen: ['SAVE10'] }));
const kane = { bin: path.join(here, 'fixtures', 'fake-kane.js'), timeout: 30, maxSteps: 10, headless: true, username: 'ci-user', accessKey: 'SECRETKEY-1234567890', requireEvidence: true, allowPrivateTargets: true, acceptFixtureEngine: true };

let ctx, server, base, repo, gh, live, reasoning, oc;
const jar = {};
async function api(method, url, body, who = 'eng') {
  const res = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(jar[who] ? { Cookie: jar[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) jar[who] = sc.split(';')[0];
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
}
const users = {};
const row = (uid) => ctx.db.get('SELECT * FROM oncall_sessions WHERE uid = ?', uid);
const exec = (uid, who, name, input) => oc.registry.execute({ session: row(uid), user: users[who], signal: undefined, redactor: oc.redactor, db: ctx.db }, name, input);
/** One caller turn in a typed session: install the script, send the message, wait for the engineer to go idle. */
async function turn(uid, text, steps, who = 'eng') {
  reasoning.steps.length = 0; reasoning.steps.push(...steps);
  const r = await api('POST', `/api/oncall/sessions/${uid}/message`, { text }, who);
  assert.equal(r.status, 202);
  await oc.engineer.idle(row(uid).id);
}
const events = (uid, kind) => ctx.db.all('SELECT kind, payload FROM oncall_events WHERE session_id = ? ORDER BY id', row(uid).id).filter((e) => !kind || e.kind === kind).map((e) => ({ kind: e.kind, ...JSON.parse(e.payload) }));
const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } throw new Error('condition not reached in time'); };

before(async () => {
  repo = makeRepo(tmp); gh = await fakeGithub(); live = await fakeLiveProvider();
  reasoning = scriptedReasoning([]);
  const config = oncallConfig({ ONCALL_READERS: 'reader@example.com', ONCALL_ENGINEERS: 'eng@example.com', ONCALL_APPROVERS: 'boss@example.com', ONCALL_REPO_DIR: repo.work,
    ONCALL_GITHUB_TOKEN: 'test-github-token', ONCALL_GITHUB_API: gh.api, ONCALL_GITHUB_REPO: 'acme/fixture', OPENAI_API_KEY: live.apiKey, ONCALL_VOICE_BASE_URL: live.baseUrl, ONCALL_CHECK_TIMEOUT_SECONDS: '60' }, { workspaceDir: repo.work });
  ctx = createApp({ dataDir: path.join(tmp, 'data'), config: kane, oncallOptions: { config, overrides: { reasoning } } });
  oc = ctx.oncall;
  await new Promise((r) => { server = ctx.app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const who of ['eng', 'reader', 'boss', 'outsider']) {
    assert.equal((await api('POST', '/api/auth/signup', { email: `${who}@example.com`, name: who[0].toUpperCase() + who.slice(1), password: 'correct-horse' }, who)).status, 200);
    users[who] = ctx.db.get('SELECT id, email, name FROM users WHERE email = ?', `${who}@example.com`);
  }
});
after(async () => { server.close(); server.closeAllConnections?.(); await ctx.shutdown(); await gh.close(); await live.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ------------------------------------------------------------------ units
test('units: redaction, input validation, path confinement, roles, argv', () => {
  const r = createRedactor(['hunter2-very-secret']);
  assert.equal(r.text('pw=hunter2-very-secret ok'), 'pw=«redacted» ok');
  assert.match(r.text('token ghp_abcdefghijklmnopqrstuvwxyz0123456789'), /«redacted/);
  assert.match(r.text('Authorization: Bearer abcdefghijklmnopqrstuvwxyz'), /Bearer «redacted»/);
  assert.match(r.text('https://user:p4ssw0rd@host/x'), /user:«redacted»@host/);
  assert.match(r.text('API_KEY="sk-proj-abcdefghijklmnopqrstuvwx"'), /«redacted/);
  assert.deepEqual(r.deep({ a: ['password: supersecretvalue'] }), { a: ['password: «redacted»'] });
  assert.equal(scrubbedEnv({ PATH: '/bin', OPENAI_API_KEY: 'x', LT_ACCESS_KEY: 'y', GIT_CONFIG_KEY_0: 'z' }).OPENAI_API_KEY, undefined);
  assert.deepEqual(Object.keys(scrubbedEnv({ PATH: '/bin', OPENAI_API_KEY: 'x', LT_USERNAME: 'y', GIT_CONFIG_KEY_0: 'z' })), ['PATH']);

  const schema = { type: 'object', required: ['path'], properties: { path: { type: 'string', maxLength: 10 }, n: { type: 'integer', minimum: 1 }, tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } } } };
  assert.deepEqual(validate(schema, { path: 'x', n: 2, tags: ['a'] }), { path: 'x', n: 2, tags: ['a'] });
  for (const bad of [{}, { path: 1 }, { path: 'x', extra: 1 }, { path: 'x', n: 0 }, { path: 'x', n: 1.5 }, { path: 'x', tags: ['c'] }, { path: 'xxxxxxxxxxxxxxx' }, { path: 'a\0b' }]) assert.throws(() => validate(schema, bad), /input/);

  assert.throws(() => safePath(repo.work, '../outside'), /escapes/);
  assert.throws(() => safePath(repo.work, '/etc/passwd'), /escapes/);
  fs.symlinkSync('/etc', path.join(repo.work, 'sneaky'));
  assert.throws(() => safePath(repo.work, 'sneaky/passwd'), /escapes/);
  fs.rmSync(path.join(repo.work, 'sneaky'));
  assert.ok(safePath(repo.work, 'src/pricing.js').endsWith('pricing.js'));
  for (const p of ['.env', 'config/.env.production', '.git/config', 'node_modules/x/index.js', 'data/shipproof.db', 'deploy/id_rsa', 'certs/server.pem']) assert.equal(isDenied(p), true, p);
  for (const p of ['.env.example', 'src/environment.js', 'server/database.js']) assert.equal(isDenied(p), false, p);
  assert.equal(parseGithubRepo('http://proxy@127.0.0.1:9/git/victrvondoom/kane'), 'victrvondoom/kane');
  assert.equal(parseGithubRepo('git@github.com:acme/app.git'), 'acme/app');

  const cfg = oncallConfig({ ONCALL_READERS: 'r@x.io', ONCALL_ENGINEERS: 'E@x.io', ONCALL_APPROVERS: 'a@x.io' });
  assert.equal(roleOf(cfg, { email: 'nobody@x.io' }), null);
  assert.equal(roleOf(cfg, { email: 'r@x.io' }), 'read_only');
  assert.equal(roleOf(cfg, { email: 'e@x.io' }), 'engineering');
  assert.equal(roleOf(cfg, { email: 'a@x.io' }), 'production');
  assert.equal(roleOf(oncallConfig({}), { email: 'anyone@x.io' }), null, 'no role list → nobody has access');
  assert.deepEqual(argv('npm run "test all" --x'), ['npm', 'run', 'test all', '--x']);
  assert.deepEqual(testCounts('ℹ tests 4\nℹ pass 3\nℹ fail 1\n'), { tests: 4, pass: 3, fail: 1, skipped: null });
});

test('a running check is killed when the turn is aborted', async () => {
  const ac = new AbortController();
  const p = runCheck({ argv: [process.execPath, '-e', 'setTimeout(()=>{}, 60000)'], cwd: tmp, timeoutMs: 60000, signal: ac.signal });
  setTimeout(() => ac.abort(), 150);
  const r = await p;
  assert.equal(r.status, 'cancelled');
  assert.ok(r.durationMs < 5000);
  assert.equal((await runCheck({ argv: [process.execPath, '-e', 'setTimeout(()=>{}, 60000)'], cwd: tmp, timeoutMs: 200 })).status, 'timeout');
  assert.equal((await runCheck({ argv: [process.execPath, '-e', 'console.log(process.env.OPENAI_API_KEY ?? "no-key"); process.exit(3)'], cwd: tmp, timeoutMs: 5000 })).exitCode, 3);
});

// ------------------------------------------------------------------ access control
test('access: feature is off for unlisted accounts; tiers follow roles; sessions are isolated per account', async () => {
  assert.equal((await api('GET', '/api/oncall/status', null, 'anon')).status, 401);
  const out = await api('GET', '/api/oncall/status', null, 'outsider');
  assert.equal(out.body.enabled, false);
  assert.equal((await api('POST', '/api/oncall/sessions', { mode: 'text' }, 'outsider')).status, 403);
  const st = (await api('GET', '/api/oncall/status', null, 'eng')).body;
  assert.equal(st.enabled, true); assert.equal(st.role, 'engineering'); assert.deepEqual(st.levels, ['read_only', 'engineering']); assert.equal(st.canApprove, false);
  assert.equal(st.voice.configured, true); assert.equal(st.repository.defaultBranch, 'trunk'); assert.equal(st.telephony.available, false);
  assert.ok(!JSON.stringify(st).includes(live.apiKey) && !JSON.stringify(st).includes('test-github-token'), 'status never exposes credentials');

  assert.equal((await api('POST', '/api/oncall/sessions', { mode: 'text', permissionLevel: 'engineering' }, 'reader')).status, 403);
  const rs = await api('POST', '/api/oncall/sessions', { mode: 'text', permissionLevel: 'read_only' }, 'reader');
  assert.equal(rs.status, 201);
  const sid = rs.body.session.id;
  assert.equal((await api('GET', `/api/oncall/sessions/${sid}`, null, 'eng')).status, 404, 'another account cannot read the session');
  assert.equal((await api('POST', `/api/oncall/sessions/${sid}/message`, { text: 'hi' }, 'eng')).status, 404);
  assert.equal((await api('POST', `/api/oncall/sessions/${sid}/permission`, { level: 'engineering' }, 'reader')).status, 403, 'a reader cannot raise their own level');

  // The model is only offered tools its session may use, and a forged call is refused by the registry anyway.
  await turn(sid, 'fix the coupon bug and push it', [
    ({ tools }) => { assert.ok(tools.includes('repo_read_file') && tools.includes('runtime_health')); assert.ok(!tools.some((t) => t.startsWith('eng_') || t.startsWith('prod_')), 'no engineering tools in a read-only session'); return [call('eng_start_branch', { slug: 'x' })]; },
    ({ results }) => { assert.equal(results[0].error, true); assert.match(results[0].text, /permission_denied/); return [say('This session is read-only, so I can investigate but not change code.')]; },
  ], 'reader');
  assert.ok(!repo.git(repo.work, 'branch', '--list', 'oncall/*'), 'no branch was created');
  const t = (await api('GET', `/api/oncall/sessions/${sid}`, null, 'reader')).body.transcript;
  assert.match(t.at(-1).text, /read-only/);
  assert.equal((await api('POST', `/api/oncall/sessions/${sid}/end`, {}, 'reader')).body.session.status, 'ended');
  assert.equal((await api('POST', `/api/oncall/sessions/${sid}/message`, { text: 'still there?' }, 'reader')).status, 409);
});

// ------------------------------------------------------------------ the full incident
let incidentId, sessionId;
test('incident end to end: investigate → diagnose → fix on a branch → red/green proof → tests → commit → push → pull request → signed report', async () => {
  const s = await api('POST', '/api/oncall/sessions', { mode: 'text', permissionLevel: 'engineering' });
  assert.equal(s.status, 201); sessionId = s.body.session.id;
  const trunkBefore = repo.trunkSha(), headBefore = repo.git(repo.work, 'rev-parse', 'HEAD'), statusBefore = repo.git(repo.work, 'status', '--porcelain');
  const regression = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { total } from '../src/pricing.js';\n\ntest('SAVE10 takes ten percent off', () => { assert.equal(total(80, 'SAVE10'), 72); });\n`;

  await turn(sessionId, 'Coupon SAVE10 on an 80 dollar order gives 70 instead of 72 in production. Investigate and fix it.', [
    () => [say('Opening an incident and checking the service first.'), call('incident_open', { title: 'SAVE10 coupon produces the wrong order total', description: 'Applying SAVE10 to an $80 order yields $70.00; the expected total is $72.00.', environment: 'production', symptoms: 'Order total $70.00 instead of $72.00', expected_outcome: 'SAVE10 takes 10 percent off' })],
    () => [call('runtime_health'), call('repo_overview'), call('repo_search', { query: 'SAVE10' }), call('repo_read_file', { path: 'src/pricing.js' }), call('repo_log', { path: 'src/pricing.js' }), call('repo_dependencies', { path: 'src/pricing.js' })],
    ({ results }) => { assert.ok(results.every((r) => !r.error), JSON.stringify(results.filter((r) => r.error)));
      assert.match(results[3].text, /subtotal - pct/); assert.match(results[5].text, /tests\/pricing\.test\.js/);
      return [call('incident_finding', { kind: 'fact', statement: 'total() subtracts the coupon value from the subtotal as dollars: (subtotal - pct).', evidence: [results[3].ref] }),
        call('incident_finding', { kind: 'hypothesis', statement: 'The coupon table stores percentages but the arithmetic treats them as amounts.' }),
        call('incident_timeline_add', { at: new Date().toISOString(), description: 'pricing.js last changed by "Add currency formatter"', evidence: [results[4].ref] }),
        call('incident_diagnose', { primary_failure: 'Order total is $70.00 for an $80 order with SAVE10', root_cause: 'src/pricing.js total() subtracts the coupon percentage as a flat dollar amount.', affected_components: ['src/pricing.js'], confidence: 'high', evidence: [results[3].ref] }),
        call('incident_plan', { steps: ['Apply the coupon as a percentage in total()', 'Add a regression test for SAVE10 on $80'], regression_risks: ['Orders without a coupon must be unchanged'], verification: ['Regression test fails before and passes after', 'Full test suite passes'] }),
        call('eng_start_branch', { slug: 'save10-percent' })]; },
    ({ results }) => { assert.ok(results.every((r) => !r.error), JSON.stringify(results.filter((r) => r.error)));
      return [say('The total subtracts the coupon as dollars rather than a percentage. I am fixing it on a separate branch.'),
        call('eng_edit_file', { path: 'src/pricing.js', old_text: '(subtotal - pct)', new_text: '(subtotal * (1 - pct / 100))' }), call('eng_write_file', { path: 'tests/coupon.test.js', content: regression }),
        call('eng_prove_fix', { test_files: ['tests/coupon.test.js'] }), call('eng_run_check', { kind: 'test' }), call('eng_run_check', { kind: 'syntax', target: 'src/pricing.js' }), call('eng_run_check', { kind: 'build' })]; },
    ({ results }) => { assert.match(results[2].text, /"proven": true/); assert.match(results[3].text, /"status": "passed"/); assert.match(results[3].text, /"pass": 2/);
      assert.equal(results[5].error, true, 'a check the repository does not have is reported unavailable, not passed'); assert.match(results[5].text, /no build step/);
      return [call('eng_commit', { message: 'Apply SAVE10 as a percentage discount\n\ntotal() subtracted the coupon value as dollars; it now takes the percentage off the subtotal.' }), call('eng_push'), call('eng_open_pull_request', { title: 'Apply SAVE10 as a percentage discount', summary: 'total() now applies coupons as a percentage. Adds a regression test for SAVE10 on an $80 order.' })]; },
    ({ results }) => { assert.ok(results.every((r) => !r.error), JSON.stringify(results.filter((r) => r.error)));
      return [call('incident_close', { outcome: 'resolved', summary: 'SAVE10 was applied as a flat ten dollars. Fixed in src/pricing.js on a repair branch, proven with a regression test, full suite passing, pull request open.', follow_ups: ['Review and merge the pull request', 'Deploy to production after merge'] })]; },
    ({ results }) => { assert.ok(!results[0].error, results[0].text); return [say('The regression tests passed. I pushed the repair branch and opened a pull request; the link is on your screen.')]; },
  ]);

  const snap = (await api('GET', `/api/oncall/sessions/${sessionId}`)).body, inc = snap.incident;
  incidentId = inc.id;
  assert.equal(inc.stage, 'closed'); assert.equal(inc.status, 'resolved');
  assert.match(inc.branch, /^oncall\/inc-\d+-save10-percent$/); assert.equal(inc.baseBranch, 'trunk');
  assert.equal(inc.verification.level, 'verified'); assert.equal(inc.verification.rootCauseReproduced, true); assert.equal(inc.verification.testsPassedOnHead, true);
  assert.equal(inc.findings.filter((f) => f.kind === 'fact').length, 1); assert.equal(inc.findings.filter((f) => f.kind === 'hypothesis').length, 1);
  assert.deepEqual(inc.checks.map((c) => [c.phase, c.status]), [['proof_red', 'failed'], ['proof_green', 'passed'], ['verify', 'passed'], ['verify', 'passed']]);
  assert.ok(inc.checks.every((c) => /^E-\d+$/.test(c.evidence)), 'every check is linked to its evidence record');
  assert.deepEqual(events(sessionId, 'incident.stage').map((e) => e.stage), ['investigate', 'diagnose', 'repair', 'verify', 'deliver']);

  // What actually happened in git: the branch is on the remote with the fix; trunk and the running checkout are untouched.
  assert.ok(repo.remoteBranches().includes(inc.branch));
  assert.equal(repo.trunkSha(), trunkBefore, 'the default branch was not pushed');
  assert.equal(repo.git(repo.work, 'rev-parse', 'HEAD'), headBefore); assert.equal(repo.git(repo.work, 'status', '--porcelain'), statusBefore, 'the main checkout is untouched');
  assert.equal(repo.git(repo.origin, 'rev-parse', `refs/heads/${inc.branch}`), inc.headSha);
  assert.match(repo.git(repo.origin, 'show', `${inc.branch}:src/pricing.js`), /1 - pct \/ 100/);
  assert.match(repo.git(repo.origin, 'log', '-1', '--format=%an|%B', inc.branch), /^SHIPPROOF On-Call Agent\|Apply SAVE10 as a percentage discount[\s\S]*Requested-by: Eng/);
  assert.equal(repo.git(repo.origin, 'rev-list', '--count', `trunk..${inc.branch}`), '1');
  assert.ok(!fs.existsSync(path.join(tmp, 'data', 'oncall', 'worktrees', inc.branch.replace(/\//g, '_'))), 'the worktree is removed once the incident closes');

  // The pull request: draft, against the real default branch, with a server-assembled body.
  const pr = gh.requests.find((r) => r.method === 'POST');
  assert.equal(pr.body.base, 'trunk'); assert.equal(pr.body.head, inc.branch); assert.equal(pr.body.draft, true);
  assert.match(pr.body.body, /verified by reproduction/); assert.match(pr.body.body, /before fix fails, after fix passes/);
  assert.equal(inc.prUrl, 'https://github.test/acme/fixture/pull/41');

  // The report: computed verification, evidence ledger, valid Ed25519 signature.
  const full = (await api('GET', `/api/oncall/incidents/${incidentId}`)).body;
  assert.match(full.reportMarkdown, /\*\*Verification:\*\* Verified — failure reproduced before the fix/);
  assert.match(full.reportMarkdown, /Deploy to production after merge/);
  const doc = (await api('GET', `/api/oncall/incidents/${incidentId}/report`)).body;
  const { signature, ...payload } = doc;
  assert.equal(signature.algorithm, 'ed25519');
  assert.equal(crypto.verify(null, Buffer.from(canonical(payload)), crypto.createPublicKey(signature.publicKey), Buffer.from(signature.value, 'base64')), true, 'report signature verifies offline');
  assert.equal(doc.diagnosis.rootCauseStatus, 'verified_by_reproduction'); assert.equal(doc.delivery.pushed, true);
  assert.ok(doc.evidence.length >= 20);
  const ev = (await api('GET', `/api/oncall/incidents/${incidentId}/evidence/${inc.checks[0].evidence}`)).body.evidence;
  assert.equal(ev.tool, 'eng_prove_fix'); assert.match(ev.output, /72 !== 70|70 !== 72/, 'the red run output is preserved as evidence');

  // Audit trail and transcript.
  const actions = ctx.db.all(`SELECT action FROM audit_events WHERE action LIKE 'oncall.%' AND user_id = ?`, users.eng.id).map((a) => a.action);
  for (const a of ['oncall.session.started', 'oncall.eng_start_branch', 'oncall.eng_edit_file', 'oncall.eng_commit', 'oncall.eng_push', 'oncall.eng_open_pull_request']) assert.ok(actions.includes(a), a);
  assert.ok(!actions.includes('oncall.repo_read_file'), 'read-only calls stay out of the audit trail (they are in the evidence ledger)');
  assert.match(snap.transcript.at(-1).text, /pushed the repair branch/);
  assert.equal((await api('GET', '/api/oncall/incidents')).body.incidents[0].id, incidentId);
  assert.equal((await api('GET', `/api/oncall/incidents/${incidentId}`, null, 'reader')).status, 404, 'incidents are private to their account');
});

// ------------------------------------------------------------------ guardrails
test('guardrails: order of work, evidence citation, protected paths, weakened tests, unverified delivery', async () => {
  const sid = sessionId; // same engineering session, new incident
  const x = (name, input) => exec(sid, 'eng', name, input);
  assert.equal((await x('incident_finding', { kind: 'fact', statement: 'something is wrong' })).code, 'no_incident');
  assert.equal((await x('eng_write_file', { path: 'a.js', content: 'x' })).code, 'no_incident');
  assert.equal((await x('no_such_tool', {})).code, 'unknown_tool');
  assert.equal((await x('repo_read_file', { path: 'src/pricing.js', command: 'rm -rf /' })).code, 'invalid_input');
  assert.equal((await x('repo_read_file', { path: '../../etc/passwd' })).ok, false);
  assert.equal((await x('repo_read_file', { path: '.git/config' })).code, 'protected_path');
  assert.equal((await x('repo_log', { since: '1 day ago; rm -rf /' })).code, 'invalid_input');
  assert.equal((await x('repo_show_commit', { sha: '--output=/tmp/x' })).code, 'invalid_input');

  assert.ok((await x('incident_open', { title: 'Totals look wrong again', description: 'Second look at pricing after the first fix.' })).ok);
  assert.equal((await x('incident_open', { title: 'Another one entirely', description: 'Should not open while one is open.' })).code, 'incident_open');
  assert.equal((await x('incident_finding', { kind: 'fact', statement: 'A fact with nothing behind it' })).code, 'evidence_required');
  assert.equal((await x('incident_finding', { kind: 'fact', statement: 'A fact citing a made-up ref', evidence: ['E-9999'] })).code, 'unknown_evidence');
  assert.equal((await x('incident_plan', { steps: ['do it'], verification: ['test'] })).code, 'workflow', 'no plan before a diagnosis');
  assert.equal((await x('eng_start_branch', {})).code, 'workflow', 'no branch before diagnosis and plan');
  const read = await x('repo_read_file', { path: 'src/pricing.js' });
  assert.ok((await x('incident_diagnose', { primary_failure: 'Totals differ from expectations', root_cause: 'Unknown rounding behaviour in total()', confidence: 'low', evidence: [read.ref] })).ok);
  assert.equal((await x('incident_close', { outcome: 'resolved', summary: 'Claiming this is resolved without having done anything at all.' })).code, 'not_supported_by_records');
  assert.ok((await x('incident_plan', { steps: ['Investigate rounding'], verification: ['Run the suite'] })).ok);
  assert.equal((await x('eng_write_file', { path: 'src/x.js', content: 'x' })).code, 'workflow', 'no edits before the branch exists');
  const br = await x('eng_start_branch', { slug: 'guard checks' });
  assert.ok(br.ok, br.summary);

  assert.equal((await x('eng_write_file', { path: '.env', content: 'SECRET=1' })).code, 'protected_path');
  assert.equal((await x('eng_write_file', { path: '../escape.js', content: 'x' })).ok, false);
  assert.equal((await x('eng_edit_file', { path: 'src/pricing.js', old_text: 'not present anywhere', new_text: 'x' })).code, 'no_match');
  assert.equal((await x('eng_run_check', { kind: 'test_file', target: 'src/pricing.js' })).code, 'check_unavailable', 'only test files run as tests');
  assert.equal((await x('eng_push', {})).code, 'nothing_to_deliver');

  // A "fix" that makes the suite green by skipping the test is refused at commit time.
  assert.ok((await x('eng_edit_file', { path: 'tests/pricing.test.js', old_text: "test('no coupon", new_text: "test.skip('no coupon" })).ok);
  const skip = await x('eng_commit', { message: 'Make the tests pass by skipping them' });
  assert.equal(skip.code, 'integrity_violation'); assert.match(skip.summary, /skip\/only marker/);
  assert.ok((await x('eng_edit_file', { path: 'tests/pricing.test.js', old_text: "test.skip('no coupon", new_text: "test('no coupon" })).ok);

  // A change that breaks the suite can be committed locally but cannot be pushed or closed as resolved.
  assert.ok((await x('eng_edit_file', { path: 'src/pricing.js', old_text: 'const pct = COUPONS[coupon] || 0;', new_text: 'const pct = COUPONS[coupon] || 5;' })).ok);
  assert.equal((await x('eng_push', {})).code, 'uncommitted_changes');
  assert.ok((await x('eng_commit', { message: 'Change the default discount (deliberately wrong, for the guard test)' })).ok);
  const unrun = await x('eng_push', {});
  assert.equal(unrun.code, 'not_verified'); assert.match(unrun.summary, /no test run on the committed tree/);
  const failing = await x('eng_run_check', { kind: 'test' });
  assert.ok(failing.ok); assert.match(failing.content, /"status": "failed"/);
  const blocked = await x('eng_push', {});
  assert.equal(blocked.code, 'not_verified'); assert.match(blocked.summary, /failed/);
  assert.equal((await x('eng_open_pull_request', { title: 'Unverified change', summary: 'This should not be possible to open before a push.' })).code, 'not_pushed');
  assert.equal((await x('incident_close', { outcome: 'resolved', summary: 'Trying to close as resolved while the tests are failing on the branch.' })).code, 'not_supported_by_records');
  assert.equal(repo.remoteBranches().filter((b) => b.startsWith('oncall/')).length, 1, 'nothing unverified reached the remote');
  // A passing run on an older tree does not count for a newer commit.
  assert.ok((await x('eng_edit_file', { path: 'src/pricing.js', old_text: '|| 5;', new_text: '|| 0;' })).ok);
  assert.ok((await x('eng_commit', { message: 'Restore the default discount of zero' })).ok);
  assert.match((await x('eng_run_check', { kind: 'test' })).content, /"status": "passed"/);
  assert.ok((await x('eng_write_file', { path: 'NOTES.md', content: 'later change\n' })).ok);
  assert.ok((await x('eng_commit', { message: 'Add notes after the test run' })).ok);
  assert.match((await x('eng_push', {})).summary, /different tree|no test run on the committed tree|NOT verified/);

  // Honest closing is always possible, and it says what was not verified.
  const closed = await x('incident_close', { outcome: 'unresolved', summary: 'No defect was confirmed; an experimental change is committed locally but not verified or pushed.' });
  assert.ok(closed.ok); assert.match(closed.summary, /NOT verified/);
  const view = (await api('GET', '/api/oncall/incidents')).body.incidents[0];
  assert.equal(view.status, 'unresolved'); assert.equal(view.pushedSha, null);
});

test('production actions: refused without approval; approval is on-screen, by an approver, single-use', async () => {
  // boss (approver) runs a session and takes a fix to a pull request
  const s = (await api('POST', '/api/oncall/sessions', { mode: 'text', permissionLevel: 'engineering' }, 'boss')).body.session.id;
  const x = (name, input) => exec(s, 'boss', name, input);
  await x('incident_open', { title: 'Currency formatter lacks a test', description: 'Add coverage for the currency formatter.' });
  const read = await x('repo_read_file', { path: 'src/pricing.js' });
  await x('incident_diagnose', { primary_failure: 'currency() is untested', root_cause: 'No test covers currency()', confidence: 'high', evidence: [read.ref] });
  await x('incident_plan', { steps: ['Add a test'], verification: ['Suite passes'] });
  await x('eng_start_branch', { slug: 'currency-test' });
  await x('eng_write_file', { path: 'tests/currency.test.js', content: `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { currency } from '../src/pricing.js';\ntest('formats', () => assert.equal(currency(72), '$72.00'));\n` });
  await x('eng_run_check', { kind: 'test' }); await x('eng_commit', { message: 'Cover the currency formatter with a test' });
  assert.ok((await x('eng_push', {})).ok);
  assert.ok((await x('eng_open_pull_request', { title: 'Cover the currency formatter', summary: 'Adds a unit test for currency(); no behaviour change.' })).ok);

  assert.equal((await x('prod_merge_pull_request', {})).code, 'authorization_required');
  assert.equal(gh.state.merged.length, 0);
  const req = await x('request_production_action', { action: 'merge_pull_request', reason: 'Low-risk test-only change, suite passing.' });
  assert.ok(req.ok);
  const pending = (await api('GET', `/api/oncall/sessions/${s}`, null, 'boss')).body.authorizations.at(-1);
  assert.equal(pending.status, 'pending');
  assert.equal((await x('prod_merge_pull_request', {})).code, 'authorization_required', 'a pending request authorizes nothing');
  assert.equal((await api('POST', `/api/oncall/sessions/${s}/authorizations/${pending.id}`, { approve: true }, 'eng')).status, 404, 'another account cannot approve');

  reasoning.steps.length = 0; reasoning.steps.push(({ messages }) => { assert.match(JSON.stringify(messages.at(-1)), /approved the production action/); return [call('prod_merge_pull_request', {})]; }, ({ results }) => { assert.ok(!results[0].error, results[0].text); return [say('Merged.')]; });
  assert.equal((await api('POST', `/api/oncall/sessions/${s}/authorizations/${pending.id}`, { approve: true }, 'boss')).status, 200);
  await oc.engineer.idle(row(s).id);
  assert.equal(gh.state.merged.length, 1); assert.equal(gh.state.merged[0].number, 42);
  assert.equal((await x('prod_merge_pull_request', {})).code, 'authorization_required', 'the approval was consumed by one execution');
  assert.equal((await api('POST', `/api/oncall/sessions/${s}/authorizations/${pending.id}`, { approve: true }, 'boss')).status, 409);
  const audited = ctx.db.all(`SELECT action FROM audit_events WHERE user_id = ? AND action LIKE 'oncall.%'`, users.boss.id).map((a) => a.action);
  assert.ok(audited.includes('oncall.authorization.approved') && audited.includes('oncall.prod_merge_pull_request'));

  // An engineer who is not an approver cannot approve their own request, even in their own session.
  const e = (await api('POST', '/api/oncall/sessions', { mode: 'text', permissionLevel: 'engineering' }, 'eng')).body.session.id;
  const fake = oc.store.authorizations.request({ sessionId: row(e).id, incidentId: null, action: 'prod_merge_pull_request', params: { pullRequest: 1, sha: 'x' }, reason: 'self-approval attempt', ttlMs: 60000 });
  assert.equal((await api('POST', `/api/oncall/sessions/${e}/authorizations/${fake.id}`, { approve: true }, 'eng')).status, 403);
  assert.equal((await exec(e, 'eng', 'prod_merge_pull_request', {})).code, 'permission_denied', 'production tools are not available to the engineering role at all');
  await api('POST', `/api/oncall/sessions/${s}/end`, {}, 'boss');
});

// ------------------------------------------------------------------ SHIPPROOF + runtime intelligence
test('SHIPPROOF and runtime tools report real state, scoped to the caller’s projects, and secrets never leave the tool layer', async () => {
  const p = (await api('POST', '/api/projects', { name: 'Shop', appUrl: 'http://127.0.0.1:9/' })).body.project;
  await api('POST', `/api/projects/${p.id}/requirements`, { text: '- Product list shows prices.\n- Applying coupon SAVE10 makes the order total $72.00.' });
  const other = (await api('POST', '/api/projects', { name: 'Private', appUrl: 'http://127.0.0.1:9/' }, 'boss')).body.project;
  const run = (await api('POST', `/api/projects/${p.id}/runs`, {})).body.run;
  await ctx.runner.idle();
  const s = (await api('POST', '/api/oncall/sessions', { mode: 'text', permissionLevel: 'engineering', projectId: p.id })).body.session.id;
  assert.equal((await api('POST', '/api/oncall/sessions', { mode: 'text', projectId: other.id })).status, 404, 'cannot link a project you do not own');
  const s2 = (await api('GET', '/api/oncall/status')).body.activeSession.id;
  const x = (name, input) => exec(s2, 'eng', name, input);
  assert.equal(s2, s);

  const proj = await x('shipproof_project', {});
  assert.match(proj.summary, /gate BLOCKED/); assert.match(proj.content, /"status": "failed"/); assert.match(proj.content, /"status": "verified"/);
  const data = JSON.parse(proj.content.slice(proj.content.indexOf('\n') + 1));
  const failed = data.criteria.find((c) => c.status === 'failed');
  const res = await x('shipproof_result', { result_id: failed.latestResultId });
  assert.match(res.content, /Order total shows \$80\.00, expected \$72\.00/); assert.match(res.content, /"exitCode": 1/); assert.match(res.content, /step-1\.png/);
  assert.ok(!res.content.includes('SECRETKEY-1234567890'), 'the engine access key is redacted from tool output');
  assert.match((await x('shipproof_run', { run_id: run.id })).summary, /1 failed, 1 passed|1 passed, 1 failed/);
  assert.equal((await x('shipproof_project', { project_id: other.id })).code, 'not_found');
  assert.equal((await x('shipproof_result', { result_id: 999999 })).code, 'not_found');
  assert.match((await x('shipproof_projects', {})).content, /"name": "Shop"/);
  assert.ok(!(await x('shipproof_projects', {})).content.includes('Private'));
  assert.match((await x('runtime_background_tasks', {})).summary, /active run/);

  const health = await x('runtime_health', {});
  assert.match(health.summary, /application unreachable/); assert.match(health.content, /"reachable": false/); assert.match(health.content, /"database": true/);
  assert.match((await x('runtime_database', {})).summary, /Database healthy \(7 migrations applied/);
  assert.match((await x('runtime_process', {})).content, /"eventLoopDelayMs"/);
  await api('GET', '/api/projects/424242');
  const fails = await x('runtime_api_failures', {});
  assert.match(fails.content, /GET \/api\/projects\/:id → 404/);
  assert.match((await x('runtime_logs', { min_status: 400, limit: 5 })).content, /"status": 404/);
  assert.match((await x('repo_regression_candidates', { paths: ['src/pricing.js'] })).content, /firstFailureAfterLastPass|lastPass/);

  // Starting a real verification run is an engineering action tied to an incident; the gate, not the agent, decides.
  assert.equal((await x('shipproof_start_verification', { mode: 'failed' })).code, 'no_incident');
  await x('incident_open', { title: 'SAVE10 criterion failing', description: 'Verification of the SAVE10 criterion fails in the browser stage.' });
  fs.writeFileSync(stateFile, JSON.stringify({}));
  const started = await x('shipproof_start_verification', { mode: 'failed' });
  assert.ok(started.ok, started.summary);
  await ctx.runner.idle();
  assert.match((await x('shipproof_project', {})).summary, /gate VERIFIED/);
  assert.ok(!oc.registry.names().some((n) => /gate|decision|verdict|evidence_delete/.test(n)), 'no tool can write a verdict or delete evidence');

  // Secrets in files the agent reads are redacted before they reach the model, the ledger or the stream.
  fs.writeFileSync(path.join(repo.work, 'notes.txt'), 'deploy token ghp_abcdefghijklmnopqrstuvwxyz0123456789 and password: tr0ub4dor&3xyz\n');
  const leak = await x('repo_read_file', { path: 'notes.txt' });
  assert.ok(!leak.content.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789') && !leak.content.includes('tr0ub4dor'));
  assert.ok(!oc.store.evidence.get(row(s).id, leak.ref).output.includes('ghp_abcdefghijklmnopqrstuvwxyz'));
  fs.rmSync(path.join(repo.work, 'notes.txt'));
  await api('POST', `/api/oncall/sessions/${s}/message`, { text: 'my password: hunter2hunter2 is in the env' });
  await oc.engineer.idle(row(s).id);
  assert.ok(!(await api('GET', `/api/oncall/sessions/${s}`)).body.transcript.some((t) => t.text.includes('hunter2hunter2')), 'transcripts are redacted before storage');
  const ended = (await api('POST', `/api/oncall/sessions/${s}/end`, {})).body.session;
  assert.equal(ended.status, 'ended');
  const inc = (await api('GET', '/api/oncall/incidents')).body.incidents[0];
  assert.equal(inc.status, 'interrupted', 'an incident still open at hang-up is closed as interrupted, never as resolved'); assert.equal(inc.hasReport, true);
});

// ------------------------------------------------------------------ interruption, stream
test('the caller can interrupt a turn and redirect it; the activity stream replays from any point', async () => {
  const s = (await api('POST', '/api/oncall/sessions', { mode: 'text', permissionLevel: 'read_only' })).body.session.id;
  reasoning.steps.length = 0;
  reasoning.steps.push(() => [say('Checking the process.'), call('runtime_process')],
    ({ signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
    ({ messages }) => { assert.match(JSON.stringify(messages), /pressed stop/); assert.match(JSON.stringify(messages.at(-1)), /look at the database instead/); return [call('runtime_database')]; },
    () => [say('The database is healthy.')]);
  await api('POST', `/api/oncall/sessions/${s}/message`, { text: 'check the service' });
  await until(() => events(s, 'tool').length === 1 && oc.engineer.status(row(s).id).running);
  await api('POST', `/api/oncall/sessions/${s}/message`, { text: 'actually look at the database instead' }); // steering while it works
  assert.equal((await api('POST', `/api/oncall/sessions/${s}/interrupt`, {})).body.stopped, true);
  await oc.engineer.idle(row(s).id);
  const said = events(s, 'agent.say').map((e) => e.text);
  assert.deepEqual(said, ['Checking the process.', 'Stopped. Tell me how you want to proceed.', 'The database is healthy.']);
  assert.equal(events(s, 'agent.interrupted').length, 1);
  assert.equal((await api('POST', `/api/oncall/sessions/${s}/interrupt`, {})).body.stopped, false);

  const ac = new AbortController();
  const res = await fetch(`${base}/api/oncall/sessions/${s}/stream?after=0`, { headers: { Cookie: jar.eng }, signal: ac.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader(); let text = '';
  while (!/"The database is healthy\."/.test(text)) text += new TextDecoder().decode((await reader.read()).value);
  const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  assert.ok(ids.length >= 5 && ids.every((v, i) => !i || v > ids[i - 1]), 'events replay in order');
  const mid = ids[2]; ac.abort();
  const ac2 = new AbortController();
  const res2 = await fetch(`${base}/api/oncall/sessions/${s}/stream`, { headers: { Cookie: jar.eng, 'Last-Event-ID': String(mid) }, signal: ac2.signal });
  const r2 = res2.body.getReader(); let t2 = '';
  while (!/"The database is healthy\."/.test(t2)) t2 += new TextDecoder().decode((await r2.read()).value);
  assert.ok([...t2.matchAll(/^id: (\d+)$/gm)].every((m) => Number(m[1]) > mid), 'resume skips what the client already has');
  ac2.abort();
  assert.equal((await fetch(`${base}/api/oncall/sessions/${s}/stream`, { headers: { Cookie: jar.reader } })).status, 404);
  await api('POST', `/api/oncall/sessions/${s}/end`, {});
});

// ------------------------------------------------------------------ voice
test('voice: SDP exchange with server-held key, sideband transcripts, delegation → engineer → spoken result, barge-in stop, mute, reconnect, clean close', async () => {
  const sdp = 'v=0\r\no=- 46117317 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
  const s = (await api('POST', '/api/oncall/sessions', { permissionLevel: 'read_only', consentProviderStore: true })).body;
  const sid = s.session.id;
  assert.equal(s.session.mode, 'voice'); assert.equal(s.session.providerStore, false, 'provider-side storage stays off without operator opt-in, even with user consent');
  assert.equal((await api('POST', `/api/oncall/sessions/${sid}/voice/connect`, { sdp: 'not sdp' })).status, 400);
  assert.equal((await api('POST', `/api/oncall/sessions/${sid}/voice/connect`, { sdp }, 'reader')).status, 404);
  const c = await api('POST', `/api/oncall/sessions/${sid}/voice/connect`, { sdp });
  assert.equal(c.status, 200); assert.match(c.body.sdp, /^v=0/); assert.equal(c.body.dataChannelLabel, 'oai-events');
  assert.ok(!JSON.stringify(c.body).includes(live.apiKey), 'the provider key never reaches the browser');

  const made = live.created[0];
  assert.equal(made.session.model, 'gpt-live-1'); assert.deepEqual(made.session.delegation, { type: 'client' }); assert.equal(made.session.store, false);
  assert.equal(made.transport.type, 'webrtc'); assert.equal(made.transport.sdp, sdp); assert.match(made.session.instructions, /on-call software engineer/);
  assert.match(made.safetyId, /^[0-9a-f]{32}$/); assert.ok(!made.safetyId.includes('eng@'), 'the safety identifier is a hash, not the user identity');
  const greet = await live.until((e) => e.type === 'session.commentary.append');
  assert.equal(greet.delegation_id, null); assert.match(greet.content, /Greet the caller/);
  assert.deepEqual(live.attaches, [made.id]);
  assert.equal((await api('GET', `/api/oncall/sessions/${sid}`)).body.session.voiceState, 'live');

  // The caller speaks; the live model delegates; the engineer investigates with tools and its answer is spoken.
  reasoning.steps.length = 0;
  reasoning.steps.push(({ messages }) => { assert.match(JSON.stringify(messages.at(-1)), /Is the database healthy right now/); return [call('runtime_database')]; }, () => [say('The database is healthy: integrity check is clean and all migrations are applied.')]);
  const del = live.callerSays('Is the database healthy right now');
  const spoken = await live.until((e) => e.type === 'session.commentary.append' && e.delegation_id === del);
  assert.match(spoken.content, /integrity check is clean/);
  live.emit({ type: 'session.output_transcript.delta', delta: 'Database is healthy,', start_ms: 9000, end_ms: 9400 });
  live.emit({ type: 'session.output_transcript.delta', delta: ' integrity is clean.', start_ms: 9400, end_ms: 9900 });
  live.raw({ type: 'session.output_transcript.delta', event_id: 'dup_1', delta: ' (dup)', start_ms: 9900, end_ms: 9950 });
  live.raw({ type: 'session.output_transcript.delta', event_id: 'dup_1', delta: ' (dup)', start_ms: 9900, end_ms: 9950 }); // replayed event after a re-attach: applied once
  live.emit({ type: 'session.usage.updated', usage: { seconds: 12 } });
  await until(() => row(sid).voice_seconds === 12);

  // Barge-in: "stop" while the engineer is working interrupts it instead of queueing another request.
  reasoning.steps.length = 0;
  reasoning.steps.push(({ signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))));
  live.callerSays('Go through all the logs from today');
  await until(() => oc.engineer.status(row(sid).id).running);
  live.callerSays('stop');
  await until(() => events(sid, 'agent.interrupted').some((e) => e.by === 'voice'));
  await oc.engineer.idle(row(sid).id);
  await live.until((e) => e.type === 'session.commentary.append' && /Stopped/.test(e.content));

  await api('POST', `/api/oncall/sessions/${sid}/mute`, { muted: true });
  await live.until((e) => e.type === 'session.input_audio.mute');

  // Control-channel loss is recovered without ending the call.
  live.dropControl();
  await until(() => live.attaches.length === 2, 6000);
  // Typed input during a call reaches the engineer and is mirrored to the voice model as quiet context.
  reasoning.steps.length = 0; reasoning.steps.push(() => [say('Run 4 0 4 2 is not one I can find.')]);
  await api('POST', `/api/oncall/sessions/${sid}/message`, { text: 'run id is A0042' });
  await live.until((e) => e.type === 'session.thinking.append' && /A0042/.test(e.content));
  await oc.engineer.idle(row(sid).id);

  // Media failure → the browser reconnects; the new provider session is seeded with the conversation so far.
  await api('POST', `/api/oncall/sessions/${sid}/voice/failed`, { detail: 'ice failed' });
  assert.equal(row(sid).voice_state, 'failed');
  const c2 = await api('POST', `/api/oncall/sessions/${sid}/voice/connect`, { sdp });
  assert.equal(c2.status, 200);
  const seeded = live.created[1].session.input;
  assert.ok(seeded.some((m) => m.role === 'user' && /Is the database healthy right now/.test(m.content[0].text) && m.content[0].type === 'input_text'));
  assert.ok(seeded.some((m) => m.role === 'assistant' && m.content[0].type === 'output_text'));
  assert.match(seeded.at(-1).content[0].text, /back on the line/); assert.equal(seeded.at(-1).role, 'developer');
  await until(() => live.attaches.length === 3);

  const t = (await api('GET', `/api/oncall/sessions/${sid}`)).body.transcript;
  assert.ok(t.some((x) => x.speaker === 'user' && x.source === 'voice' && x.text === 'Is the database healthy right now'));
  assert.ok(t.some((x) => x.speaker === 'agent' && x.source === 'voice' && x.text === 'Database is healthy, integrity is clean. (dup)'));
  assert.ok(t.some((x) => x.speaker === 'user' && x.source === 'text' && x.text === 'run id is A0042'));

  // Hang-up: the provider session is closed gracefully and its final usage is recorded.
  const ended = (await api('POST', `/api/oncall/sessions/${sid}/end`, {})).body.session;
  assert.equal(ended.status, 'ended'); assert.equal(ended.voiceState, 'closed'); assert.equal(ended.voiceSeconds, 37);
  assert.ok(live.received.some((e) => e.type === 'session.close'));
  assert.equal((await api('POST', `/api/oncall/sessions/${sid}/voice/connect`, { sdp })).status, 409);
  assert.equal(ctx.db.get(`SELECT COUNT(*) n FROM oncall_sessions WHERE status = 'active' AND user_id = ?`, users.eng.id).n, 0);
});

test('provider outage: a refused or unreachable voice provider fails clearly and the session falls back to typing', async () => {
  const dead = oncallConfig({ ONCALL_ENGINEERS: 'eng@example.com', ONCALL_REPO_DIR: repo.work, OPENAI_API_KEY: 'sk-wrong-key-00000000000000000000', ONCALL_VOICE_BASE_URL: live.baseUrl }, { workspaceDir: repo.work });
  const r2 = scriptedReasoning([() => [say('Typed fallback works.')]]);
  const app2 = createApp({ dataDir: path.join(tmp, 'data2'), config: kane, oncallOptions: { config: dead, overrides: { reasoning: r2 } } });
  const srv = await new Promise((r) => { const x = app2.app.listen(0, () => r(x)); }); const b2 = `http://127.0.0.1:${srv.address().port}`;
  let cookie = '';
  const call2 = async (m, u, body) => { const r = await fetch(b2 + u, { method: m, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: cookie }, body: body ? JSON.stringify(body) : undefined }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; return { status: r.status, body: await r.json() }; };
  await call2('POST', '/api/auth/signup', { email: 'eng@example.com', name: 'Eng', password: 'correct-horse' });
  const s = (await call2('POST', '/api/oncall/sessions', {})).body.session.id;
  const c = await call2('POST', `/api/oncall/sessions/${s}/voice/connect`, { sdp: 'v=0\r\n' });
  assert.equal(c.status, 503); assert.match(c.body.error, /voice provider refused the session \(401/); assert.equal(c.body.code, 'voice_refused');
  assert.ok(!JSON.stringify(c.body).includes('sk-wrong-key'));
  assert.equal(app2.db.get('SELECT voice_state FROM oncall_sessions WHERE uid = ?', s).voice_state, 'failed');
  assert.equal((await call2('POST', `/api/oncall/sessions/${s}/message`, { text: 'are you there' })).status, 202);
  await app2.oncall.engineer.idle(app2.db.get('SELECT id FROM oncall_sessions WHERE uid = ?', s).id);
  assert.equal((await call2('GET', `/api/oncall/sessions/${s}`)).body.transcript.at(-1).text, 'Typed fallback works.');
  // Restart recovery: sessions and incidents left open by a stopped server are closed out, not resumed silently.
  srv.close(); srv.closeAllConnections?.();
  app2.db.run(`UPDATE oncall_sessions SET status = 'active', ended_at = NULL WHERE uid = ?`, s);
  await app2.shutdown();
  const app3 = createApp({ dataDir: path.join(tmp, 'data2'), config: kane, oncallOptions: { config: dead, overrides: { reasoning: r2 } } });
  assert.equal(app3.db.get('SELECT status FROM oncall_sessions WHERE uid = ?', s).status, 'ended');
  await app3.shutdown();
});
