// Autonomous Development Loop End-to-End Tests
// Tests the full unified cycle:
// Specification (Steps Writer) -> Security (Gatekeeper) -> Verification (Kane CLI) -> Failure Analysis (Playtest) -> Repair (Coding Agent) -> Reverification -> Release Gate
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { WORKFLOW_STATES } from '../server/orchestrator.js';

process.env.LOG_LEVEL = 'silent';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shipproof-autoloop-'));
const stateFile = path.join(tmp, 'state.json');
const setState = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));
process.env.FAKE_KANE_STATE = stateFile;
const fake = path.join(here, 'fixtures', 'fake-kane.js');
const baseConfig = {
  bin: fake,
  timeout: 30,
  maxSteps: 10,
  headless: true,
  username: '',
  accessKey: '',
  requireEvidence: true,
  allowPrivateTargets: true,
  acceptFixtureEngine: true,
  demoMutations: true,
  demoMutationUsers: ['judge@example.com'],
};

function client(base) {
  const jar = {};
  return async (method, url, body, who = 'a', headers = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(jar[who] ? { Cookie: jar[who] } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) jar[who] = sc.split(';')[0];
    return {
      status: res.status,
      body: (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text(),
      headers: res.headers,
    };
  };
}

let S;
before(async () => {
  console.log('BEFORE: starting createApp');
  // Private workspace copy: the loop's repair must never modify the working tree.
  const ws = path.join(tmp, 'ws'); fs.mkdirSync(ws);
  fs.cpSync(path.join(root, 'demo-app'), path.join(ws, 'demo-app'), { recursive: true });
  for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(root, f), path.join(ws, f));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(ws, 'node_modules'));
  const ctx = createApp({ dataDir: path.join(tmp, 'app'), config: baseConfig, workspaceDir: ws });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  S = { ...ctx, server, base, api: client(base), stop: async () => { server.close(); server.closeAllConnections?.(); await ctx.shutdown(); } };
  console.log('BEFORE: ready at', base);
});

after(async () => {
  await S.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
  const pricingFile = path.join(root, 'demo-app', 'pricing.js');
  if (fs.existsSync(pricingFile)) {
    const raw = fs.readFileSync(pricingFile, 'utf8');
    if (raw.includes('const total = subtotal - discount;')) {
      fs.writeFileSync(pricingFile, raw.replace('const total = subtotal - discount;', 'const total = subtotal;'), 'utf8');
    }
  }
});

test('Autonomous Loop: Steps Writer API generates and persists versioned specifications', async () => {
  await S.api('POST', '/api/auth/signup', { email: 'judge@example.com', name: 'Judge', password: 'correct-horse' });
  const pRes = await S.api('POST', '/api/projects', { name: 'E-Commerce App', appUrl: 'http://127.0.0.1:4100/' });
  const pid = pRes.body.project.id;

  const gen = await S.api('POST', `/api/projects/${pid}/specifications/generate`, {
    task: 'Applying coupon SAVE10 to cart ($80.00) reduces total to $72.00.',
  });
  assert.equal(gen.status, 200);
  assert.ok(gen.body.specifications.length >= 1);

  const spec = gen.body.specifications[0];
  const save = await S.api('POST', `/api/projects/${pid}/specifications`, spec);
  assert.equal(save.status, 201);
  assert.equal(save.body.specification.version, 1);

  const list = await S.api('GET', `/api/projects/${pid}/specifications`);
  assert.equal(list.body.specifications.length, 1);
});

test('Autonomous Loop: Gatekeeper API scans lockfile and returns security verdict', async () => {
  const pRes = await S.api('POST', '/api/projects', { name: 'Security Scanned App', appUrl: 'http://127.0.0.1:4100/' });
  const pid = pRes.body.project.id;

  const scan = await S.api('POST', `/api/projects/${pid}/security/scan`, {});
  assert.equal(scan.status, 201);
  assert.equal(scan.body.scan.verdict, 'ALLOWED');
  assert.ok(scan.body.scan.packageCount > 0);

  const latest = await S.api('GET', `/api/projects/${pid}/security/latest`);
  assert.equal(latest.status, 200);
  assert.equal(latest.body.scan.verdict, 'ALLOWED');
});

test('Autonomous Loop: OQED API returns accurate toolchain diagnostics without faking', async () => {
  const sysOqed = await S.api('GET', '/api/system/oqed');
  assert.equal(sysOqed.status, 200);
  assert.ok(sysOqed.body.oqed.engine.includes('OQED'));

  const pRes = await S.api('POST', '/api/projects', { name: 'OQED Eval App', appUrl: 'http://127.0.0.1:4100/' });
  const pid = pRes.body.project.id;

  const elig = await S.api('GET', `/api/projects/${pid}/oqed/eligibility`);
  assert.equal(elig.status, 200);
  assert.ok(typeof elig.body.eligibility.eligible === 'boolean');
});

test('Autonomous Loop: Judge Demo Scenario endpoint sets up unified evaluation in one click', async () => {
  const demo = await S.api('POST', '/api/demo/judge-scenario', {});
  assert.equal(demo.status, 200);
  assert.ok(demo.body.project.id > 0);
  assert.ok(demo.body.specification.specKey.startsWith('SPEC-'));
  assert.equal(demo.body.securityScan.verdict, 'ALLOWED');
  assert.ok(demo.body.criterion.id > 0);
  assert.match(demo.body.message, /Judge Demo scenario prepared/);
});

test('Autonomous Loop: Complete end-to-end cycle (Specify -> Secure -> Kane verify -> Pass -> Verified)', async () => {
  const pRes = await S.api('POST', '/api/projects', { name: 'Autoloop Target', appUrl: 'http://127.0.0.1:4100/' });
  const pid = pRes.body.project.id;
  setState({ mode: 'ok', failWhen: [] });

  const loop = await S.api('POST', `/api/projects/${pid}/loop/start`, {
    taskDescription: 'Order checkout total reflects correct discount.',
    autoRepair: true,
  });
  assert.equal(loop.status, 202);
  const execId = loop.body.executionId;
  assert.ok(execId > 0);

  // Allow orchestrator stages to finish
  await S.orchestrator.waitFor(execId);

  const state = await S.api('GET', `/api/projects/${pid}/loop/${execId}`);
  assert.equal(state.status, 200);
  assert.ok([WORKFLOW_STATES.VERIFIED, WORKFLOW_STATES.RELEASE_READY].includes(state.body.execution.status));
  assert.ok(state.body.execution.specId > 0);
  assert.ok(state.body.execution.scanId > 0);
});

test('Autonomous Loop: Failure triggers Playtest investigation, Coding Agent repair, and Kane reverification', async () => {
  const pRes = await S.api('POST', '/api/projects', { name: 'Autoloop Failure Repair Target', appUrl: 'http://127.0.0.1:4100/' });
  const pid = pRes.body.project.id;

  // The stand-in fails twice (original run + independent replay), then passes on re-verification.
  // It never looks at the application, so it CANNOT detect the reintroduced defect in the regression trial.
  setState({ mode: 'ok', failTimes: 2 });

  const loop = await S.api('POST', `/api/projects/${pid}/loop/start`, {
    taskDescription: 'Order checkout total reflects correct discount after coupon SAVE10.',
    autoRepair: true,
  });
  assert.equal(loop.status, 202);
  const execId = loop.body.executionId;
  await S.orchestrator.waitFor(execId);

  const ex = (await S.api('GET', `/api/projects/${pid}/loop/${execId}`)).body.execution;
  assert.ok(ex.investigationId > 0, 'Playtest investigation was recorded');
  assert.equal(ex.retryCount, 1, 'one repair attempt');
  assert.equal(ex.repairs[0].status, 'applied');
  assert.deepEqual(ex.repairs[0].changedFiles, ['demo-app/pricing.js']);
  assert.notEqual(ex.repairs[0].fileHashes[0].beforeSha256, ex.repairs[0].fileHashes[0].afterSha256, 'the source file really changed');
  assert.equal(ex.repairs[0].outcome, 'verified');

  const inv = (await S.api('GET', `/api/projects/${pid}/investigations/${ex.investigationId}`)).body.investigation;
  assert.equal(inv.reproduced, true);
  assert.ok(inv.replay.resultId > 0 && inv.replay.resultId !== inv.resultId, 'reproduction is backed by a separate replay execution');
  assert.equal(inv.replay.status, 'failed');

  // A regression trial was really executed; the stand-in passed the defective copy, which is recorded as a miss
  // and withholds RELEASE_READY — a state label alone can never produce a regression success.
  assert.equal(ex.regression.outcome, 'missed');
  assert.equal(ex.regression.runs.length, 2);
  assert.equal(ex.regression.runs[1].groundTruth.defectPresent, true);
  assert.equal(ex.regression.runs[1].status, 'passed');
  assert.equal(ex.status, WORKFLOW_STATES.NOT_RELEASE_READY);
  assert.equal(ex.currentStage, 'REGRESSION_NOT_DETECTED');
});
