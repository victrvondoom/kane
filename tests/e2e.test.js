// Browser end-to-end test of the whole product through the real UI (Playwright + Chromium).
// The engine is the TEST-ONLY stand-in tests/fixtures/store-check-kane.js, which makes real HTTP
// requests to a private copy of the demo store. Skipped automatically when Playwright is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

process.env.LOG_LEVEL = 'silent';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch {}
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });

test('browser journey: create → fail → inspect → real fix → verify → share → revoke, on desktop and mobile', { skip: !chromium && 'playwright not available', timeout: 120000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shipproof-e2e-'));
  const store = path.join(tmp, 'store');
  fs.mkdirSync(path.join(store, 'demo'), { recursive: true });
  fs.cpSync(path.join(root, 'demo-app'), path.join(store, 'demo-app'), { recursive: true });
  fs.copyFileSync(path.join(root, 'demo', 'fix-coupon.patch'), path.join(store, 'demo', 'fix-coupon.patch'));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(store, 'node_modules'));
  const port = await freePort();
  process.env.DEMO_PORT = String(port); // read by server/demo-template.js at import
  const startStore = async () => {
    const child = spawn(process.execPath, ['demo-app/server.js'], { cwd: store, env: { ...process.env }, stdio: 'ignore' });
    for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return child; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    throw new Error('demo store did not start');
  };
  let storeProc = await startStore();
  const { createApp } = await import('../server/app.js');
  const ctx = createApp({ dataDir: path.join(tmp, 'data'), config: { bin: path.join(here, 'fixtures', 'store-check-kane.js'), timeout: 30, maxSteps: 10, headless: true, username: '', accessKey: '', requireEvidence: true, allowPrivateTargets: true, acceptFixtureEngine: true } });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/40[149]|410/.test(m.text())) errors.push(m.text()); });
    const stamp = () => page.locator('.stamp span').first().textContent();

    // account + project from the demo scenario
    await page.goto(base + '/'); await page.click('text=Get started');
    await page.fill('input[name=name]', 'Ada'); await page.fill('input[name=email]', 'ada@example.com'); await page.fill('input[name=password]', 'correct-horse'); await page.click('button[type=submit]');
    await page.waitForSelector('text=No projects yet');
    await page.click('text=Create your first project'); await page.click('text=Load demo scenario');
    await page.waitForSelector('text=6 acceptance criteria will be created');
    await page.click('button:has-text("Create project")'); await page.waitForSelector('text=Run full verification');
    assert.equal(await stamp(), 'NOT VERIFIED');
    assert.equal(ctx.db.get('SELECT COUNT(*) n FROM criteria').n, 6, 'criteria are persisted server-side');

    // run; refresh mid-flight must not lose state
    await page.click('text=Run full verification'); await page.waitForSelector('text=Engine output');
    await page.reload();
    const run1 = ctx.db.get('SELECT id FROM runs ORDER BY id LIMIT 1').id;
    await page.waitForSelector('text=run finished');
    await page.click('.exec-list button:has-text("AC-005")');
    const selected = ctx.db.get(`SELECT id FROM results WHERE run_id = ? AND status = 'failed'`, run1).id;
    const persisted = ctx.db.get('SELECT COUNT(*) n FROM run_events WHERE run_id = ? AND (result_id = ? OR result_id IS NULL)', run1, selected).n;
    await page.waitForFunction((n) => document.querySelectorAll('.log > div').length >= n, persisted);
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.log > div').count(), persisted, 'log shows exactly the persisted events — no loss, no duplicates');
    await page.waitForSelector('text=Test fixture'); // stand-in output is labelled in the UI
    await page.waitForSelector('text=Order total shows $80.00, expected $72.00');

    // project state: blocked, one failure; survives a hard reload (deep link)
    await page.click('text=← Northwind'); await page.waitForSelector('.stamp');
    assert.equal(await stamp(), 'RELEASE BLOCKED');
    await page.reload(); await page.waitForSelector('.stamp'); assert.equal(await stamp(), 'RELEASE BLOCKED');
    assert.equal(await page.locator('tbody tr:has-text("AC-005") .tag').first().textContent(), 'Failed');

    // a failing criterion cannot be edited away through the UI
    await page.click('tbody tr:has-text("AC-005") >> text=Edit'); await page.fill('dialog textarea', 'Coupon shows a message.'); await page.click('dialog button[type=submit]');
    await page.waitForSelector('.toast.bad:has-text("open repair task")');
    assert.match(ctx.db.get(`SELECT text FROM criteria WHERE key = 'AC-005'`).text, /\$72\.00/);

    // failure analysis → declare fix WITHOUT fixing → still open
    await page.click('a:has-text("Failure analysis")'); await page.waitForSelector('text=RT-1');
    await page.click('text=Fix applied → re-verify'); await page.waitForSelector('text=run finished', { timeout: 30000 });
    assert.equal(ctx.db.get('SELECT status FROM repair_tasks WHERE id = 1').status, 'open');

    // apply the real code fix, restart the store, re-verify through the UI
    storeProc.kill(); execFileSync('git', ['apply', 'demo/fix-coupon.patch'], { cwd: store }); storeProc = await startStore();
    await page.goBack(); await page.waitForSelector('text=RT-1');
    await page.fill('input[placeholder^="What was changed"]', 'total = subtotal - discount');
    await page.click('text=Fix applied → re-verify'); await page.waitForSelector('text=run finished', { timeout: 30000 });
    await page.waitForSelector('text=Order total shows $72.00 after SAVE10');
    const task = ctx.db.get('SELECT * FROM repair_tasks WHERE id = 1');
    assert.equal(task.status, 'verified'); assert.equal(task.origin_run_id, run1); assert.equal(task.verify_run_id, ctx.db.get('SELECT MAX(id) m FROM runs').m);
    await page.click('text=← Northwind'); await page.waitForSelector('.stamp'); assert.equal(await stamp(), 'RELEASE VERIFIED');
    if (process.env.E2E_SHOT_DIR) { await page.click('a:has-text("Failure analysis")'); await page.waitForSelector('text=RT-1'); await page.screenshot({ path: `${process.env.E2E_SHOT_DIR}/failures.png`, fullPage: true }); await page.goto(base + '/#/app'); await page.waitForSelector('.stats'); await page.screenshot({ path: `${process.env.E2E_SHOT_DIR}/dashboard.png`, fullPage: true }); await page.goto(base + '/#/p/1'); await page.waitForSelector('.stamp'); }

    // history (server-paginated) and dashboard metrics reflect the three runs
    await page.click('a:has-text("History")'); await page.waitForSelector('text=3 of 3 runs');
    await page.selectOption('select[aria-label="Filter by run status"]', 'cancelled'); await page.waitForSelector('text=No cancelled runs.');
    await page.goto(base + '/#/app'); await page.waitForSelector('text=Projects release-verified');
    assert.equal(await page.locator('.stat:has-text("Projects release-verified") b').textContent(), '1/1');
    assert.equal(await page.locator('.stat:has-text("Completed runs") b').textContent(), '3');

    // share → public view in a clean context → revoke
    await page.click('a.panel'); await page.click('a:has-text("Release report")'); await page.click('text=Create shareable link');
    const link = await page.locator('#share-link').textContent();
    const anon = await browser.newContext({ viewport: { width: 390, height: 800 } });
    const pub = await anon.newPage(); await pub.goto(link); await pub.waitForSelector('text=RELEASE VERIFIED');
    await pub.waitForSelector('text=Contains test-fixture executions');
    assert.ok(await pub.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'public report has no horizontal page scroll on mobile');
    assert.ok(!(await pub.content()).includes('correct-horse'));
    await page.click('button:has-text("Revoke")'); await page.waitForSelector('text=Link revoked');
    await pub.reload(); await pub.waitForSelector('text=Report unavailable');

    // a second account cannot see the first account's project, run or evidence via deep links
    const other = await (await browser.newContext({ viewport: { width: 390, height: 800 } })).newPage();
    await other.goto(base + '/#/signup'); await other.fill('input[name=name]', 'Bo'); await other.fill('input[name=email]', 'bo@example.com'); await other.fill('input[name=password]', 'another-pass'); await other.click('button[type=submit]');
    await other.waitForSelector('text=No projects yet');
    assert.ok(await other.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'dashboard fits a phone viewport');
    await other.goto(base + '/#/p/1'); await other.waitForSelector('text=Project not found');
    // owner's project, run and report pages on a phone viewport: no horizontal page scroll
    const phone = await browser.newContext({ viewport: { width: 390, height: 800 }, storageState: await page.context().storageState() });
    const m = await phone.newPage();
    for (const route of ['#/p/1', '#/p/1/failures', '#/p/1/report', '#/p/1/settings', `#/run/${run1}`, '#/new']) {
      await m.goto(base + '/' + route); await m.waitForSelector('main h1'); await m.waitForTimeout(250);
      assert.ok(await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${route} fits a phone viewport`);
    }
    await m.screenshot({ path: process.env.E2E_SHOT_DIR ? `${process.env.E2E_SHOT_DIR}/mobile-run.png` : undefined, fullPage: true }).catch(() => {});
    await other.goto(base + `/#/run/${run1}`); await other.waitForSelector('text=Run not found');
    const ev = ctx.db.get('SELECT uid FROM evidence LIMIT 1').uid;
    assert.equal((await other.request.get(`${base}/api/evidence/${ev}/file`)).status(), 404);
    assert.equal((await page.request.get(`${base}/api/evidence/${ev}/file`)).status(), 200);

    // sign out invalidates the session server-side
    await page.click('text=Sign out'); await page.waitForSelector('text=Get started');
    assert.equal((await page.request.get(`${base}/api/projects`)).status(), 401);
    assert.deepEqual(errors, [], 'no uncaught browser errors');
  } finally {
    await browser.close(); storeProc.kill(); server.close(); server.closeAllConnections?.(); await ctx.shutdown(); fs.rmSync(tmp, { recursive: true, force: true });
  }
});
