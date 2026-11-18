// TenantSeal inside the completion gate: a Stop hook for a security-relevant change runs the tenant scan, blocks
// with the real LEAKING dossier while the defect exists, and accepts the completion only after the repaired build
// is verified. Criteria use the test fixture for kane-cli; the tenant scan uses the simulated engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handleHook } from '../server/agentgate/hooks.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const demoDir = path.join(root, 'demo', 'tenant-boundary');
const FIXTURE = path.join(root, 'tests', 'fixtures', 'fake-kane.js');
const VULN = fs.readFileSync(path.join(demoDir, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const FIXED = (() => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-gate-fixed-'));
  fs.mkdirSync(path.join(ws, 'demo', 'tenant-boundary'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'demo', 'tenant-boundary', 'app.js'), VULN);
  execFileSync('git', ['apply', '-p1', path.join(demoDir, 'fix.patch')], { cwd: ws });
  return fs.readFileSync(path.join(ws, 'demo', 'tenant-boundary', 'app.js'), 'utf8');
})();

async function serve(file, port, v) {
  const mod = await import(pathToFileURL(file).href + `?g=${v}-${Date.now()}`);
  const server = mod.createApp();
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return server;
}

test('gate: a security-relevant change is blocked by the tenant leak, then accepted once the repair is verified', { timeout: 300000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-gate-'));
  const stateFile = path.join(dir, 'fake-kane-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ mode: 'run', failWhen: [] }));
  const saved = { bin: process.env.KANE_CLI_BIN, st: process.env.FAKE_KANE_STATE, eng: process.env.SHIPPROOF_TENANT_ENGINE,
    a: process.env.TB_ALICE_PASSWORD, b: process.env.TB_BOB_PASSWORD };
  process.env.KANE_CLI_BIN = FIXTURE;
  process.env.FAKE_KANE_STATE = stateFile;
  process.env.SHIPPROOF_TENANT_ENGINE = 'simulated';
  process.env.TB_ALICE_PASSWORD = 'alice-demo-pass';
  process.env.TB_BOB_PASSWORD = 'bob-demo-pass';
  const w = (rel, body) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
  // Choose a free port; the app is restarted on it after the repair.
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  // The task begins on the vulnerable build.
  w('app.js', VULN);
  w('.shipproof/criteria.json', JSON.stringify({ version: 1, app: { url: `http://127.0.0.1:${port}/`, context: '' }, protected: [],
    criteria: [{ id: 'AC-001', text: 'The sign-in page is reachable and the notes list loads.', paths: ['app.js'] }] }));
  const cfg = JSON.parse(fs.readFileSync(path.join(demoDir, 'tenantseal', 'config.json'), 'utf8'));
  cfg.target.url = `http://127.0.0.1:${port}/`;
  cfg.securityPaths = ['app.js'];
  cfg.app.sourceDir = '.';
  w('.tenantseal/config.json', JSON.stringify(cfg, null, 2));

  let server = await serve(path.join(dir, 'app.js'), port, 'start');
  const sid = 'gate-session-1';
  try {
    // The turn begins: the baseline is the vulnerable build the task was given.
    assert.equal((await handleHook('UserPromptSubmit', { cwd: dir, session_id: sid })).exitCode, 0);

    // The agent claims completion after a change that leaves the authorization defects in place.
    w('app.js', VULN + '\n// agent note\n');
    const first = await handleHook('Stop', { cwd: dir, session_id: sid });
    assert.equal(first.exitCode, 2, first.stderr);
    assert.match(first.stderr, /TENANTSEAL/);
    assert.match(first.stderr, /Tenant isolation/);
    assert.match(first.stderr, /LEAKING/);
    assert.match(first.stderr, /canary visible at \/api\/docs/, 'the dossier names the leaking route');
    assert.match(first.stderr, /\.tenantseal\/scans\//, 'the dossier points at the evidence');
    assert.doesNotMatch(first.stderr, /alice-demo-pass|bob-demo-pass/, 'no credential in feedback');

    // The agent applies the real repair; the same scenario is run again against the repaired build.
    await new Promise((r) => server.close(r));
    w('app.js', FIXED);
    server = await serve(path.join(dir, 'app.js'), port, 'repaired');
    const second = await handleHook('Stop', { cwd: dir, session_id: sid });
    assert.equal(second.exitCode, 0, second.stderr);
    assert.match(second.stderr, /SIMULATED_SEALED/);
    assert.match(second.stderr, /Verified/);
  } finally {
    await new Promise((r) => server.close(r));
    for (const [k, v] of [['KANE_CLI_BIN', saved.bin], ['FAKE_KANE_STATE', saved.st], ['SHIPPROOF_TENANT_ENGINE', saved.eng],
      ['TB_ALICE_PASSWORD', saved.a], ['TB_BOB_PASSWORD', saved.b]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('protection: the scanner, its configuration and the test definitions are protected; run output is not', async () => {
  const { isProtected } = await import('../server/agentgate/spec.js');
  assert.ok(isProtected('server/tenantseal/scan.js'));
  assert.ok(isProtected('server/tenantseal/verdict.js'));
  assert.ok(isProtected('.tenantseal/config.json'));
  assert.ok(isProtected('.shipproof/criteria.json'));
  assert.ok(!isProtected('.tenantseal/scans/2026/scan.json'), 'scan output must not be treated as tampering');
  assert.ok(!isProtected('.tenantseal/runs/2026/session/network.har'));
});

test('demo: npm run demo:tenant reproduces LEAKING → repaired → SIMULATED_SEALED', { timeout: 300000 }, () => {
  const out = execFileSync(process.execPath, [path.join(demoDir, 'run-demo.js')], { encoding: 'utf8', timeout: 280000 });
  assert.match(out, /FIRST SCAN \(vulnerable build\): LEAKING/);
  assert.match(out, /SECOND SCAN \(repaired build, fresh canary\): SIMULATED_SEALED/);
  assert.match(out, /Demo result: OK/);
});
