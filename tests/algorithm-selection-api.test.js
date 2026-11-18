// Algorithm 1 through the HTTP surface: POST /projects/:pid/builds/:bid/selection. Uses the test-only engine stand-in,
// as the other proof tests do. Nothing here executes a criterion; selection is a plan.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';

process.env.LOG_LEVEL = 'silent';
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shipproof-selection-'));
const stateFile = path.join(tmp, 'state.json');
fs.writeFileSync(stateFile, JSON.stringify({ mode: 'ok', failWhen: [] }));
process.env.FAKE_KANE_STATE = stateFile;
const config = { bin: path.join(here, 'fixtures', 'fake-kane.js'), timeout: 30, maxSteps: 10, headless: true, username: '', accessKey: '', requireEvidence: true, allowPrivateTargets: true, acceptFixtureEngine: true };
const SHA = (n) => crypto.createHash('sha1').update(String(n)).digest('hex');

function client(base) {
  const jar = {};
  return async (method, url, body, who = 'a') => {
    const res = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(jar[who] ? { Cookie: jar[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) jar[who] = sc.split(';')[0];
    return { status: res.status, body: (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text() };
  };
}

let ctx, server, api, base;
before(async () => {
  ctx = createApp({ dataDir: path.join(tmp, 'data'), config });
  server = await new Promise((r) => { const s = ctx.app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  api = client(base);
});
after(async () => { server.close(); server.closeAllConnections?.(); await ctx.shutdown(); fs.rmSync(tmp, { recursive: true, force: true }); });

const SOURCES = {
  'server/db.js': 'export const now = () => new Date().toISOString();\n',
  'server/gate.js': "import { now } from './db.js';\nexport const gate = () => now();\n",
  'server/app.js': "import { gate } from './gate.js';\nexport const app = () => gate();\n",
  'server/ui/index.js': 'export const ui = 1;\n',
};

test('selection plan explains indirect impact, keeps unknown and mandatory criteria, and validates its input', async () => {
  await api('POST', '/api/auth/signup', { email: `s${crypto.randomUUID()}@example.com`, name: 'S', password: 'correct-horse' });
  const pid = (await api('POST', '/api/projects', { name: 'Sel', appUrl: 'http://127.0.0.1:9/' })).body.project.id;
  await api('POST', `/api/projects/${pid}/criteria`, { text: 'The app page loads', paths: ['server/app.js'] });
  await api('POST', `/api/projects/${pid}/criteria`, { text: 'The ui widget renders', paths: ['server/ui/**'], mandatory: false });
  await api('POST', `/api/projects/${pid}/criteria`, { text: 'Checkout is safe', paths: ['server/ui/**'], criticality: 'critical' });
  const bid = (await api('POST', `/api/projects/${pid}/builds`, { commitSha: SHA(1), changedPaths: ['server/db.js'] })).body.build.id;

  const r = await api('POST', `/api/projects/${pid}/builds/${bid}/selection`, { sources: SOURCES });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const byKey = Object.fromEntries(r.body.plan.selected.map((s) => [s.key, s]));
  assert.equal(r.body.plan.changed.join(','), 'server/db.js');
  const app = Object.values(byKey).find((s) => s.tier === 'transitive');
  assert.ok(app && app.chain.join(' → ').includes('server/db.js → server/gate.js → server/app.js'), 'indirect dependency is explained by its chain');
  assert.ok(r.body.plan.excluded.some((e) => e.reason.includes('No changed file')), 'the ui-only criterion is excluded with a reason');
  const critical = r.body.plan.selected.find((s) => s.criticality === 'critical');
  assert.ok(critical && critical.required, 'a critical criterion is selected even though no change reaches its mapping');
  assert.ok(!r.body.plan.excluded.some((s) => s.criticality === 'critical'), 'and it is never listed as excluded');
  assert.equal(r.body.plan.fallback, null);
});

test('an unknown change set falls back to full verification', async () => {
  const pid = (await api('GET', '/api/projects')).body.projects[0].id;
  const bid = (await api('POST', `/api/projects/${pid}/builds`, { commitSha: SHA(2) })).body.build.id;
  const r = await api('POST', `/api/projects/${pid}/builds/${bid}/selection`, { sources: SOURCES });
  assert.equal(r.status, 200);
  assert.match(r.body.plan.fallback.reason, /not known/);
  assert.equal(r.body.plan.selected.length, r.body.plan.totals.total);
});

test('inputs are validated before any graph is built', async () => {
  const pid = (await api('GET', '/api/projects')).body.projects[0].id;
  const bid = (await api('POST', `/api/projects/${pid}/builds`, { commitSha: SHA(3), changedPaths: [] })).body.build.id;
  const url = `/api/projects/${pid}/builds/${bid}/selection`;
  assert.equal((await api('POST', url, {})).status, 400, 'sources are required');
  assert.equal((await api('POST', url, { sources: ['not', 'a', 'map'] })).status, 400);
  assert.equal((await api('POST', url, { sources: { 'a.js': 42 } })).status, 400);
  assert.equal((await api('POST', url, { sources: SOURCES, budget: { maxTests: -1 } })).status, 400);
  assert.equal((await api('POST', url, { sources: SOURCES, budget: { maxTests: 1.5 } })).status, 400);
});

test('another account cannot run selection on this project', async () => {
  await api('POST', '/api/auth/signup', { email: `o${crypto.randomUUID()}@example.com`, name: 'O', password: 'correct-horse' }, 'b');
  const pid = (await api('GET', '/api/projects')).body.projects[0].id;
  const bid = (await api('POST', `/api/projects/${pid}/builds`, { commitSha: SHA(4), changedPaths: ['server/db.js'] })).body.build.id;
  const r = await api('POST', `/api/projects/${pid}/builds/${bid}/selection`, { sources: SOURCES }, 'b');
  assert.ok(r.status === 404 || r.status === 403, `status ${r.status}`);
});
