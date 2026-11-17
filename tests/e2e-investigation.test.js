// Browser end-to-end test of the failure investigation journey (Playwright + Chromium; skipped when Playwright is absent).
// Engine: TEST-ONLY stand-in tests/fixtures/fake-kane.js. Assertions check persisted state as well as what is painted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';

process.env.LOG_LEVEL = 'silent';
const here = path.dirname(fileURLToPath(import.meta.url));
let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch {}
const waitFor = async (fn, ms = 15000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out waiting for condition'); await new Promise((r) => setTimeout(r, 100)); } };

test('browser: failed run → Investigate failure → notes, verification, reload, investigations list', { skip: !chromium && 'playwright not available', timeout: 180000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shipproof-e2einv-'));
  const stateFile = path.join(tmp, 'state.json'); fs.writeFileSync(stateFile, JSON.stringify({ mode: 'ok', failWhen: ['SAVE10'] })); process.env.FAKE_KANE_STATE = stateFile;
  const config = { bin: path.join(here, 'fixtures', 'fake-kane.js'), timeout: 30, maxSteps: 10, headless: true, username: '', accessKey: '', requireEvidence: true, allowPrivateTargets: true, acceptFixtureEngine: true };
  const ctx = createApp({ dataDir: path.join(tmp, 'data'), config, watchOptions: { tickMs: 0 }, eventOptions: { tickMs: 0 } });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/40[0149]|410|429/.test(m.text())) errors.push(m.text()); });
    await page.goto(base + '/#/signup');
    await page.fill('input[name=name]', 'Ada'); await page.fill('input[name=email]', 'ada@example.com'); await page.fill('input[name=password]', 'correct-horse');
    await page.click('button[type=submit]');
    await page.waitForSelector('text=No projects yet');
    const post = async (u, data) => (await page.request.post(base + u, { data })).json();
    const pid = (await post('/api/projects', { name: 'Shop', appUrl: 'http://127.0.0.1:9/' })).project.id;
    await post(`/api/projects/${pid}/requirements`, { text: 'Coupon SAVE10 reduces the total.' });
    const runId = (await post(`/api/projects/${pid}/runs`, {})).run.id;
    await ctx.runner.waitForRun(runId);
    const resultId = ctx.db.get('SELECT id FROM results WHERE run_id = ?', runId).id;
    // the run page offers the investigation on the failed result
    await page.goto(`${base}/#/run/${runId}/${resultId}`);
    await page.waitForSelector('button:has-text("Investigate failure")');
    await page.click('button:has-text("Investigate failure")');
    await page.waitForURL(/#\/i\//);
    const invUid = page.url().split('#/i/')[1];
    const inv = await waitFor(() => ctx.db.get('SELECT * FROM investigations WHERE result_id = ?', resultId));
    assert.equal(inv.uid, invUid, 'the page opened the persisted investigation');
    assert.equal(inv.status, 'OPEN');
    assert.equal(ctx.db.get('SELECT COUNT(*) n FROM results WHERE id = ?', resultId).n, 1);
    await page.waitForSelector('text=Failure summary');
    assert.ok(await page.locator('text=Diagnosis').count(), 'the diagnosis is shown');
    assert.ok(await page.locator('text=Evidence explorer').count());
    // a note is written through the API and survives a reload
    await page.fill('textarea[aria-label="Investigation note"]', 'Checked the coupon code path in pricing.js');
    await page.click('button:has-text("Add note")');
    await page.waitForSelector('text=Note saved');
    await page.reload();
    await page.waitForSelector('text=Checked the coupon code path in pricing.js');
    // lifecycle: the page offers only the transitions the server allows
    await page.click('button[data-transition="INVESTIGATING"]');
    await page.waitForSelector('text=Status: Investigating');
    assert.equal(ctx.db.get('SELECT status FROM investigations WHERE id = ?', inv.id).status, 'INVESTIGATING');
    // fix verification: the same flow is re-run through the runner, and the outcome is decided from its evidence
    fs.writeFileSync(stateFile, JSON.stringify({ mode: 'ok', failWhen: [] }));
    await page.click('button:has-text("Run verification")');
    await page.waitForSelector('text=Attempt 1');
    const verification = await waitFor(() => ctx.db.get('SELECT * FROM investigation_verifications WHERE investigation_id = ?', inv.id));
    await ctx.runner.idle();
    await page.reload();
    await page.waitForSelector('text=Attempt 1 · Fix verified');
    const v = ctx.db.get('SELECT * FROM investigation_verifications WHERE id = ?', verification.id);
    assert.equal(v.outcome, 'VERIFIED_FIXED'); assert.equal(v.status, 'COMPLETED');
    assert.equal(ctx.db.get('SELECT status FROM investigations WHERE id = ?', inv.id).status, 'VERIFIED_FIXED');
    // the original Kane verdict is untouched by the verification
    assert.equal(ctx.db.get('SELECT status FROM results WHERE id = ?', resultId).status, 'failed');
    // the investigation appears in the project's list and its history lists the lifecycle
    await page.goto(`${base}/#/p/${pid}/investigations`);
    await page.waitForSelector(`text=${inv.criterion_key}`);
    await page.goto(`${base}/#/i/${invUid}`);
    await page.waitForSelector('text=Verified fixed');
    assert.ok(await page.locator('text=verification attempt 1 requested').count());
    assert.ok(await page.locator('text=verification 1: VERIFIED_FIXED').count(), 'the completed verification is in the history');
    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    await browser?.close();
    server.close(); server.closeAllConnections?.();
    await ctx.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
