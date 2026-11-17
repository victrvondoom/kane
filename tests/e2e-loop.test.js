// Browser test of the Autonomous Loop screen: every panel must show the execution's persisted records,
// not fixed text. OFFLINE: the engine is the labelled fake-kane stand-in. Skipped when Playwright is absent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

process.env.LOG_LEVEL = 'silent';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch {}

test('loop screen renders live execution records (failure → replay → repair → regression → decision)', { skip: !chromium && 'playwright not available', timeout: 120000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shipproof-e2e-loop-'));
  const stateFile = path.join(tmp, 'state.json'); process.env.FAKE_KANE_STATE = stateFile;
  const setState = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));
  const ws = path.join(tmp, 'ws'); fs.mkdirSync(ws);
  fs.cpSync(path.join(root, 'demo-app'), path.join(ws, 'demo-app'), { recursive: true });
  for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(root, f), path.join(ws, f));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(ws, 'node_modules'));
  const { createApp } = await import('../server/app.js');
  const ctx = createApp({ dataDir: path.join(tmp, 'data'), workspaceDir: ws, watchOptions: { tickMs: 0 },
    config: { bin: path.join(here, 'fixtures', 'fake-kane.js'), timeout: 30, maxSteps: 10, headless: true, username: '', accessKey: '', requireEvidence: true,
      allowPrivateTargets: true, acceptFixtureEngine: true, demoMutations: true, demoMutationUsers: ['lo@example.com'], demoAppUrl: 'http://127.0.0.1:4100/' } });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    const pageErrors = []; page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(base + '/#/signup');
    await page.fill('input[name=name]', 'Lo'); await page.fill('input[name=email]', 'lo@example.com'); await page.fill('input[name=password]', 'correct-horse');
    await page.click('button[type=submit]'); await page.waitForSelector('text=No projects yet');
    const pid = await page.evaluate(async () => (await (await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Loop UI', appUrl: 'http://127.0.0.1:4100/' }) })).json()).project.id);

    // empty state: nothing is shown as done before anything ran
    await page.goto(`${base}/#/p/${pid}/loop`); await page.waitForSelector('text=No autonomous execution yet');
    assert.equal(await page.inputValue('input[placeholder^="Enter natural language"]'), '', 'no canned task');
    for (const canned of ['DEFECT CONFIRMED', 'REPAIR APPLIED', 'CERTIFIED VERIFICATION', 'ALLOWED']) assert.equal(await page.locator(`text=${canned}`).count(), 0, canned);

    // run 1: engine cannot authenticate → inconclusive; the screen says so and claims no defect, repair or release
    setState({ mode: 'unauthenticated' });
    await page.fill('input[placeholder^="Enter natural language"]', 'Coupon SAVE10 reduces the order total.');
    await page.click('button:has-text("Start Autonomous Loop")');
    await page.waitForSelector('.tag:has-text("INCONCLUSIVE")');
    await page.waitForSelector('text=Failure class: authentication');
    await page.waitForSelector('text=NOT ENGAGED'); await page.waitForSelector('text=NO REPAIR'); await page.waitForSelector('text=NO DECISION');
    await page.waitForSelector('text=NOT VERIFIED');
    assert.equal(await page.locator('text=RELEASE VERIFIED').count(), 0);

    // run 2: fails twice (run + replay), repaired, re-verified; the stand-in then misses the regression
    setState({ mode: 'ok', failTimes: 2 });
    await page.click('button:has-text("Start Autonomous Loop")');
    await page.waitForSelector('.tag:has-text("NOT RELEASE READY")', { timeout: 60000 });
    const ex = ctx.orchestrator.getExecution(ctx.db.get('SELECT MAX(id) id FROM agent_executions').id);
    const text = (await page.locator('body').innerText()).toLowerCase();
    const body = { includes: (x) => text.includes(String(x).toLowerCase()) }; // tags are upper-cased by CSS
    // each panel shows this execution's own records
    assert.ok(body.includes(`${ex.specification.specKey} v${ex.specification.version}`), 'specification key and version');
    assert.ok(body.includes(ex.specification.objective));
    assert.ok(body.includes(ex.securityScan.summary), 'scan summary');
    assert.ok(body.includes('CONFIRMED DEFECT'));
    assert.ok(body.includes(`run #${ex.investigation.replay.runId}, result #${ex.investigation.replay.resultId} → failed`), 'replay ids');
    const hsh = ex.repairs[0].fileHashes[0];
    assert.ok(body.includes(`${hsh.beforeSha256.slice(0, 12)} → ${hsh.afterSha256.slice(0, 12)}`), 'real file hashes');
    assert.ok(body.includes(`#${ex.repairs[0].verifyRunId}`));
    assert.ok(body.includes('MISSED') && body.includes(ex.regression.reason), 'regression outcome and reason');
    assert.ok(body.includes(`DECISION #${ex.decision.id}: VERIFIED`));
    assert.ok(body.includes('REGRESSION_NOT_DETECTED'));
    assert.equal(await page.locator('text=RELEASE VERIFIED').count(), 0, 'no release stamp when the workflow is not release-ready');
    // timeline is the recorded sequence
    assert.deepEqual((await page.locator('.stage-item .mono').allInnerTexts()).map((t) => t.toUpperCase()), ex.events.map((e) => e.status.replace(/_/g, ' ')));
    // history lists both executions; selecting the first shows its (different) records
    assert.equal(await page.locator('tr.click').count(), 2);
    await page.locator('tr.click').last().click(); await page.waitForSelector('text=Failure class: authentication');
    assert.equal(await page.locator('text=CONFIRMED DEFECT').count(), 0);
    assert.deepEqual(pageErrors, []);
    assert.equal(await page.locator('.toast.err, .toast.error').count(), 0);
    // phone width: no horizontal page scroll
    await page.setViewportSize({ width: 390, height: 800 }); await page.waitForTimeout(300);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'loop screen fits a phone viewport');
  } finally {
    await browser.close(); server.close(); server.closeAllConnections?.(); await ctx.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
