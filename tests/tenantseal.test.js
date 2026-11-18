// TenantSeal: configuration, evidence parsing, route discovery, verdict rules, reporting, and full scans against
// the NoteVault demo. Browser actions run through the existing Kane adapter with the TEST FIXTURE engine, so every
// scan here is SIMULATED. Nothing in this file produces a SEALED verdict.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateConfig, resolveCredentials, TenantConfigError } from '../server/tenantseal/config.js';
import { readHarFiles, discoverRoutes, sameOriginPath, templateOf, concretePath } from '../server/tenantseal/har.js';
import { classifyRead, classifyTamper, classifyOwner, aggregateScan, CHECK, SCAN } from '../server/tenantseal/verdict.js';
import { newCanary, runTenantScan, prepareEngine, objectiveFor, observedIdentity, idFromTemplate } from '../server/tenantseal/scan.js';
import { writeReport } from '../server/tenantseal/report.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const demoDir = path.join(root, 'demo', 'tenant-boundary');
const TEMPLATE = JSON.parse(fs.readFileSync(path.join(demoDir, 'tenantseal', 'config.json'), 'utf8'));
const CREDS = { owner: 'alice-demo-pass', second: 'bob-demo-pass' };
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ---------- configuration ----------

test('config: the demo template is valid and normalised', () => {
  const c = validateConfig(TEMPLATE);
  assert.equal(c.personas.owner.identity, 'alice');
  assert.equal(c.personas.second.passwordEnv, 'TB_BOB_PASSWORD');
  assert.equal(c.target.origin, 'http://127.0.0.1:4300');
});

test('config: rejects plaintext passwords, bad env names, identical personas and mismatched origins', () => {
  const clone = () => JSON.parse(JSON.stringify(TEMPLATE));
  const cases = [
    [(c) => { c.personas.second.password = 'x'; }, /must not contain a password/],
    [(c) => { c.personas.second.passwordEnv = 'lower-case'; }, /environment variable name/],
    [(c) => { c.personas.second.identity = 'alice'; }, /different identities/],
    [(c) => { c.target.allowedOrigin = 'http://evil.example'; }, /allowedOrigin/],
    [(c) => { c.workflows.readPathTemplate = '/docs'; }, /must contain :id/],
    [(c) => { c.limits.maxRuns = 0; }, /maxRuns/],
    [(c) => { c.policy.permittedPaths = ['docs/:id']; }, /permittedPaths/],
  ];
  for (const [mutate, re] of cases) {
    const c = clone(); mutate(c);
    assert.throws(() => validateConfig(c), (e) => e instanceof TenantConfigError && re.test(e.message), String(re));
  }
});

test('config: missing credentials are named by variable, never by value', () => {
  const c = validateConfig(TEMPLATE);
  assert.throws(() => resolveCredentials(c, { TB_ALICE_PASSWORD: 'secret-value-123' }), (e) => /TB_BOB_PASSWORD/.test(e.message) && !/secret-value-123/.test(e.message));
  assert.deepEqual(resolveCredentials(c, { TB_ALICE_PASSWORD: 'a', TB_BOB_PASSWORD: 'b' }), { owner: 'a', second: 'b' });
});

// ---------- canaries ----------

test('canary: prefixed, high entropy and unique per call', () => {
  const a = newCanary(), b = newCanary();
  assert.match(a, /^TENANTSEAL-[0-9a-f]{24}$/);
  assert.notEqual(a, b);
});

// ---------- network evidence ----------

const har = (entries) => JSON.stringify({ log: { version: '1.2', entries } });
const entry = (method, url, status, body = '', kind = 'navigation', headers = []) => ({
  comment: `kind=${kind}`, request: { method, url, headers: [{ name: 'Cookie', value: 'tb_session=SECRET' }] },
  response: { status, headers, content: { text: body } },
});

test('har: malformed and wrongly shaped evidence is counted, never trusted', () => {
  const d = tmp('ts-har-');
  fs.mkdirSync(path.join(d, 'session'));
  fs.writeFileSync(path.join(d, 'session', 'bad.har'), '{ not json');
  fs.writeFileSync(path.join(d, 'session', 'shape.har'), JSON.stringify({ hello: 1 }));
  fs.writeFileSync(path.join(d, 'session', 'ok.har'), har([entry('GET', 'http://x/a', 200, 'hi')]));
  const r = readHarFiles(d);
  assert.equal(r.malformed, 2);
  assert.equal(r.entries.length, 1);
  assert.equal(readHarFiles(path.join(d, 'missing')).files, 0, 'a missing evidence directory yields no entries');
});

test('har: discovery keeps same-origin routes only, dedupes by template and never keeps request headers', () => {
  const origin = 'http://127.0.0.1:4300';
  const raw = [
    entry('GET', `${origin}/docs/doc-1`, 200, 'Note CANARY-1', 'navigation'),
    entry('GET', `${origin}/docs/doc-2`, 200, 'other', 'background'),
    entry('GET', `${origin}/api/docs/doc-1/activity`, 200, 'preview CANARY-1', 'background'),
    entry('GET', 'https://evil.example/docs/doc-1', 200, 'CANARY-1'),
    entry('POST', `${origin}/docs/doc-1/edit`, 302),
    entry('POST', `${origin}/docs/new`, 302),
    entry('GET', `${origin}/unrelated`, 200, 'nothing'),
  ];
  const entries = raw.map((e) => ({ file: 'a.har', method: e.request.method, url: e.request.url, status: e.response.status, kind: 'navigation', location: null, body: e.response.content.text }));
  const d = discoverRoutes({ entries, origin, resourceId: 'doc-1', canary: 'CANARY-1' });
  const keys = d.routes.map((r) => `${r.method} ${r.template}`).sort();
  assert.deepEqual(keys, ['GET /api/docs/:id/activity', 'GET /docs/:id', 'POST /docs/:id/edit']);
  assert.equal(d.foreignEntries, 1, 'foreign origin excluded and counted');
  assert.ok(!JSON.stringify(d).includes('SECRET'), 'no cookie values in discovery output');
  assert.equal(templateOf('/docs/doc-1/edit', 'doc-1'), '/docs/:id/edit');
  assert.equal(concretePath('/docs/:id', 'doc-9'), '/docs/doc-9');
  assert.equal(sameOriginPath('https://evil.example/x', origin), null);
  assert.equal(idFromTemplate('/docs/:id', '/docs/doc-7'), 'doc-7');
  assert.equal(idFromTemplate('/docs/:id', '/other/doc-7'), null);
});

// ---------- verdict rules ----------

const origin = 'http://127.0.0.1:4300';
const probeOf = (over) => ({ runStatus: 'passed', errorKind: null, reason: null, identity: null, identityFailed: false, entries: [], ...over });
const H = (method, pathname, status, body = '') => ({ method, url: origin + pathname, status, body, kind: 'navigation', file: 'x.har', location: null });

test('verdict: a canary visible to the second tenant is a LEAK, whatever the status code says', () => {
  const v = classifyRead({ probe: probeOf({ identity: { observed: 'bob' }, entries: [H('GET', '/api/docs/d1', 200, 'C-1')] }), origin, pathname: '/api/docs/d1', canary: 'C-1', expectedIdentity: 'bob' });
  assert.equal(v.verdict, CHECK.LEAK);
});

test('verdict: denied probes are BLOCKED only when the route was observed without the canary', () => {
  const denied = classifyRead({ probe: probeOf({ identity: { observed: 'bob' }, entries: [H('GET', '/docs/d1', 404, 'nope')] }), origin, pathname: '/docs/d1', canary: 'C-1', expectedIdentity: 'bob' });
  assert.equal(denied.verdict, CHECK.BLOCKED);
  const unobserved = classifyRead({ probe: probeOf({ identity: { observed: 'bob' }, entries: [] }), origin, pathname: '/docs/d1', canary: 'C-1', expectedIdentity: 'bob' });
  assert.equal(unobserved.verdict, CHECK.INCONCLUSIVE, 'a route that was never requested is not proven denied');
});

test('verdict: a failed sign-in never proves a route is secure', () => {
  const v = classifyRead({ probe: probeOf({ runStatus: 'failed', identityFailed: true, identity: { observed: null }, entries: [H('GET', '/docs/d1', 404)] }), origin, pathname: '/docs/d1', canary: 'C-1', expectedIdentity: 'bob' });
  assert.equal(v.verdict, CHECK.INCONCLUSIVE);
  assert.match(v.reason, /identity not established/);
});

test('verdict: a timeout or network failure is an error, never BLOCKED', () => {
  for (const runStatus of ['timeout', 'error', 'cancelled']) {
    const v = classifyRead({ probe: probeOf({ runStatus, errorKind: runStatus === 'error' ? 'network' : null, entries: [H('GET', '/docs/d1', 404)] }), origin, pathname: '/docs/d1', canary: 'C-1', expectedIdentity: null });
    assert.equal(v.verdict, CHECK.ERROR, runStatus);
  }
});

test('verdict: anonymous probes need no identity and must not expose the canary', () => {
  const v = classifyRead({ probe: probeOf({ entries: [H('GET', '/api/docs/d1', 401, '{"error":"unauthorized"}')] }), origin, pathname: '/api/docs/d1', canary: 'C-1', expectedIdentity: null });
  assert.equal(v.verdict, CHECK.BLOCKED);
});

test('verdict: a write counts only when the owner sees the tamper token, not because the write returned 200', () => {
  const base = { origin, writePath: '/docs/d1/edit', method: 'POST', readPath: '/docs/d1', canary: 'C-1', tamperToken: 'T-1', secondIdentity: 'bob', ownerIdentity: 'alice' };
  const attempt = probeOf({ identity: { observed: 'bob' }, entries: [H('POST', '/docs/d1/edit', 302)] });
  const tampered = classifyTamper({ ...base, attempt, owner: probeOf({ identity: { observed: 'alice' }, entries: [H('GET', '/docs/d1', 200, 'T-1')] }) });
  assert.equal(tampered.verdict, CHECK.TAMPERED);
  const unchanged = classifyTamper({ ...base, attempt, owner: probeOf({ identity: { observed: 'alice' }, entries: [H('GET', '/docs/d1', 200, 'C-1')] }) });
  assert.equal(unchanged.verdict, CHECK.BLOCKED, 'a 200 from the write with an unchanged record is not a tamper');
  const notSent = classifyTamper({ ...base, attempt: probeOf({ identity: { observed: 'bob' }, entries: [] }), owner: probeOf({ identity: { observed: 'alice' }, entries: [H('GET', '/docs/d1', 200, 'C-1')] }) });
  assert.equal(notSent.verdict, CHECK.INCONCLUSIVE, 'an attempt that was never made proves nothing');
});

test('verdict: owner control separates access from integrity', () => {
  const ok = classifyOwner({ probe: probeOf({ identity: { observed: 'alice' }, entries: [H('GET', '/docs/d1', 200, 'T-1')] }), origin, pathname: '/docs/d1', markers: ['C-1', 'T-1'], ownerIdentity: 'alice' });
  assert.equal(ok.verdict, CHECK.OWNER_OK, 'a tampered record is still accessible to the owner');
  const locked = classifyOwner({ probe: probeOf({ identity: { observed: 'alice' }, entries: [H('GET', '/docs/d1', 404)] }), origin, pathname: '/docs/d1', markers: ['C-1'], ownerIdentity: 'alice' });
  assert.equal(locked.verdict, CHECK.OWNER_LOCKED_OUT);
  const noSession = classifyOwner({ probe: probeOf({ runStatus: 'failed', identityFailed: true, identity: { observed: null }, entries: [] }), origin, pathname: '/docs/d1', markers: ['C-1'], ownerIdentity: 'alice' });
  assert.equal(noSession.verdict, CHECK.INCONCLUSIVE, 'a failed owner sign-in never proves a successful repair');
});

test('aggregate: only a complete, owner-verified, leak-free result can be SEALED', () => {
  const plant = { id: 'PLANT', kind: 'plant', verdict: CHECK.OWNER_OK, reason: 'ok' };
  const owner = { id: 'OWNER /docs/:id', kind: 'owner', verdict: CHECK.OWNER_OK, reason: 'ok' };
  const read = { id: 'READ second GET /docs/:id', kind: 'read', route: '/docs/:id', verdict: CHECK.BLOCKED, reason: 'denied' };
  const sealed = aggregateScan({ checks: [plant, owner, read], routes: ['/docs/:id'], engine: 'simulated' });
  assert.equal(sealed.verdict, SCAN.SIMULATED_SEALED);
  assert.equal(aggregateScan({ checks: [plant, owner, read], routes: ['/docs/:id'], engine: 'kane' }).verdict, SCAN.SEALED);
  assert.equal(aggregateScan({ checks: [plant, owner, read], routes: [], engine: 'kane' }).verdict, SCAN.INCONCLUSIVE, 'no discovered routes is not safety');
  assert.equal(aggregateScan({ checks: [plant, owner, read], routes: ['/docs/:id', '/api/x'], engine: 'kane' }).verdict, SCAN.INCONCLUSIVE, 'uncovered route');
  const leak = { id: 'READ second GET /api/x', kind: 'read', route: '/api/x', verdict: CHECK.LEAK, reason: 'leak' };
  assert.equal(aggregateScan({ checks: [plant, owner, read, leak], routes: ['/docs/:id', '/api/x'], engine: 'kane' }).verdict, SCAN.LEAKING);
  const lock = { id: 'OWNER /docs/:id', kind: 'owner', verdict: CHECK.OWNER_LOCKED_OUT, reason: 'denied' };
  const locked = aggregateScan({ checks: [plant, lock, read], routes: ['/docs/:id'], engine: 'kane' });
  assert.notEqual(locked.verdict, SCAN.SEALED);
  assert.equal(locked.releaseBlocking, true);
  const err = { id: 'READ anonymous GET /docs/:id', kind: 'read', route: '/docs/:id', verdict: CHECK.ERROR, reason: 'timeout' };
  assert.equal(aggregateScan({ checks: [plant, owner, read, err], routes: ['/docs/:id'], engine: 'kane' }).verdict, SCAN.ERROR);
  assert.equal(aggregateScan({ checks: [], routes: [], engine: 'kane', configValid: false, configReason: 'tampered' }).verdict, SCAN.BLOCKED_CONFIGURATION);
  assert.equal(aggregateScan({ checks: [{ ...plant, verdict: CHECK.INCONCLUSIVE }], routes: [], engine: 'kane' }).verdict, SCAN.INCONCLUSIVE);
});

// ---------- engine selection and plans ----------

test('engine: a real Kane that is not ready is an error; nothing falls back to the fixture', async () => {
  const saved = process.env.KANE_CLI_BIN;
  process.env.KANE_CLI_BIN = path.join(tmp('ts-nobin-'), 'kane-cli-missing.js');
  try {
    const e = await prepareEngine('kane');
    assert.equal(e.ok, false);
    assert.match(e.reason, /not ready|not installed|did not report|not found/i);
  } finally {
    if (saved === undefined) delete process.env.KANE_CLI_BIN; else process.env.KANE_CLI_BIN = saved;
  }
});

test('objective: names the target, the plan, and never a credential value', () => {
  const o = objectiveFor({ identity: 'bob', credentialKey: 'second_password', steps: [{ do: 'get', path: '/docs/d1' }] }, 'http://127.0.0.1:4300/');
  assert.match(o, /Sign in as bob/);
  assert.match(o, /TENANTSEAL_PLAN:/);
  assert.doesNotMatch(o, /bob-demo-pass/);
  assert.equal(observedIdentity([H('GET', '/docs', 200, 'Signed in as bob')], origin, '/docs'), 'bob');
});

test('report: the record carries a digest and never a credential', () => {
  const d = tmp('ts-report-');
  const scan = { scanId: 's1', verdict: 'LEAKING', releaseBlocking: true, reasons: ['x'], target: origin, engineKind: 'simulated', checks: [{ id: 'C', verdict: 'LEAK', reason: 'r' }], runs: [], trusted: { before: { configSha: 'a', scannerSha: 'b' }, after: { configSha: 'a', scannerSha: 'b' } } };
  const r = writeReport(d, scan);
  assert.match(r.digest, /^[0-9a-f]{64}$/);
  const all = fs.readdirSync(d).map((f) => fs.readFileSync(path.join(d, f), 'utf8')).join('\n');
  assert.match(all, /SIMULATED \(test fixture, not Kane evidence\)/);
  assert.doesNotMatch(all, /demo-pass/);
});

// ---------- full scans against the NoteVault demo (SIMULATED engine) ----------

async function withApp(source, fn) {
  const dir = tmp('ts-scan-');
  const appFile = path.join(dir, 'app.js');
  fs.writeFileSync(appFile, source);
  const mod = await import(pathToFileURL(appFile).href + `?t=${Date.now()}${Math.random()}`);
  const server = mod.createApp();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    fs.mkdirSync(path.join(dir, '.tenantseal'), { recursive: true });
    const cfg = JSON.parse(JSON.stringify(TEMPLATE));
    cfg.target.url = `http://127.0.0.1:${port}/`;
    fs.writeFileSync(path.join(dir, '.tenantseal', 'config.json'), JSON.stringify(cfg, null, 2));
    return await fn(dir, validateConfig(cfg));
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// Normalised to LF: a Windows checkout with autocrlf may write CRLF, and the variants below match exact text.
const VULN = fs.readFileSync(path.join(demoDir, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const FIXED = (() => {
  const ws = tmp('ts-fixed-');
  fs.mkdirSync(path.join(ws, 'demo', 'tenant-boundary'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'demo', 'tenant-boundary', 'app.js'), VULN);
  execFileSync('git', ['apply', '-p1', path.join(demoDir, 'fix.patch')], { cwd: ws });
  return fs.readFileSync(path.join(ws, 'demo', 'tenant-boundary', 'app.js'), 'utf8');
})();

test('scan: the vulnerable NoteVault is LEAKING with the real defects, and the owner keeps access', { timeout: 180000 }, async () => {
  await withApp(VULN, async (dir, cfg) => {
    const s = await runTenantScan({ cwd: dir, config: cfg, engineKind: 'simulated', credentials: CREDS });
    assert.equal(s.verdict, SCAN.LEAKING, JSON.stringify(s.reasons));
    assert.equal(s.releaseBlocking, true);
    const v = (id) => s.checks.find((c) => c.id === id)?.verdict;
    assert.equal(v('READ second GET /api/docs/:id'), CHECK.LEAK, 'A: API read');
    assert.equal(v('READ second GET /docs/:id/edit'), CHECK.LEAK, 'B: UI edit page read');
    assert.equal(v('READ second GET /api/docs/:id/activity'), CHECK.LEAK, 'C: background activity route');
    assert.equal(v('READ second GET /docs/:id'), CHECK.BLOCKED, 'the visible owner page is protected');
    assert.equal(v('TAMPER second POST /docs/:id/edit'), CHECK.TAMPERED, 'B: cross-tenant write');
    assert.equal(v('OWNER /docs/:id'), CHECK.OWNER_OK);
    assert.equal(v('OWNER /docs/:id/edit'), CHECK.OWNER_OK);
    assert.ok(s.checks.filter((c) => c.actor === 'anonymous').every((c) => c.verdict === CHECK.BLOCKED), 'anonymous is denied everywhere');
    assert.ok(s.discovery.routes.some((r) => r.kind === 'background' && r.template === '/api/docs/:id/activity'), 'the hidden route was found from evidence');
    assert.ok(fs.existsSync(path.join(dir, '.tenantseal', 'scans', s.scanId, 'scan.json')));
  });
});

test('scan: the repaired NoteVault is SIMULATED_SEALED with a fresh canary and intact owner access', { timeout: 180000 }, async () => {
  const first = await withApp(VULN, (dir, cfg) => runTenantScan({ cwd: dir, config: cfg, engineKind: 'simulated', credentials: CREDS }));
  const fixed = await withApp(FIXED, (dir, cfg) => runTenantScan({ cwd: dir, config: cfg, engineKind: 'simulated', credentials: CREDS }));
  assert.equal(fixed.verdict, SCAN.SIMULATED_SEALED, JSON.stringify(fixed.reasons));
  assert.equal(fixed.releaseBlocking, false);
  assert.ok(fixed.checks.filter((c) => c.kind === 'read' || c.kind === 'tamper').every((c) => c.verdict === CHECK.BLOCKED), 'every negative probe is blocked');
  assert.ok(fixed.checks.filter((c) => c.kind === 'owner').every((c) => c.verdict === CHECK.OWNER_OK));
  assert.notEqual(fixed.canary, first.canary, 'a fresh canary is planted for the repaired build');
});

test('scan: an owner-locking "fix" never receives a SEALED verdict', { timeout: 180000 }, async () => {
  const lock = VULN.replace(
    "          if (doc.owner !== user) return send(res, 404, 'text/html; charset=utf-8', page('Not found', '<p>Not found</p>'));\n          return send(res, 200",
    "          return send(res, 404, 'text/html; charset=utf-8', page('Not found', '<p>Not found</p>'));\n          return send(res, 200");
  assert.notEqual(lock, VULN, 'the variant must change the visible route');
  await withApp(lock, async (dir, cfg) => {
    const s = await runTenantScan({ cwd: dir, config: cfg, engineKind: 'simulated', credentials: CREDS });
    assert.notEqual(s.verdict, SCAN.SIMULATED_SEALED);
    assert.notEqual(s.verdict, SCAN.SEALED);
    assert.equal(s.releaseBlocking, true);
  });
});

test('scan: a wrong owner password leaves the scan unverified, not sealed and not leaking', { timeout: 180000 }, async () => {
  await withApp(VULN, async (dir, cfg) => {
    const s = await runTenantScan({ cwd: dir, config: cfg, engineKind: 'simulated', credentials: { owner: 'wrong-pass', second: CREDS.second } });
    assert.equal(s.verdict, SCAN.INCONCLUSIVE, JSON.stringify(s.reasons));
    assert.equal(s.releaseBlocking, true);
  });
});

test('scan: missing credential variables block the scan before any browser run', async () => {
  const saved = { a: process.env.TB_ALICE_PASSWORD, b: process.env.TB_BOB_PASSWORD };
  delete process.env.TB_ALICE_PASSWORD; delete process.env.TB_BOB_PASSWORD;
  try {
    await withApp(VULN, async (dir, cfg) => {
      const s = await runTenantScan({ cwd: dir, config: cfg, engineKind: 'simulated' });
      assert.equal(s.verdict, SCAN.BLOCKED_CONFIGURATION);
      assert.equal(s.runs.length, 0);
      assert.match(s.reasons[0], /TB_ALICE_PASSWORD/);
    });
  } finally {
    if (saved.a !== undefined) process.env.TB_ALICE_PASSWORD = saved.a;
    if (saved.b !== undefined) process.env.TB_BOB_PASSWORD = saved.b;
  }
});
