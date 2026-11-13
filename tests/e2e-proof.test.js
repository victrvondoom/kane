// Browser end-to-end test of the Layer 3 interfaces (Playwright + Chromium; skipped when Playwright is absent).
// Engine: TEST-ONLY stand-in tests/fixtures/fake-kane.js. Assertions check backend state, not only what is painted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { verifyDossier } from '../server/keys.js';

process.env.LOG_LEVEL = 'silent';
const here = path.dirname(fileURLToPath(import.meta.url));
let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch {}
const SHA = (n) => crypto.createHash('sha1').update(String(n)).digest('hex');

test('browser: builds → impact plan → stale evidence → intelligence → proof trace → CI → dossier', { skip: !chromium && 'playwright not available', timeout: 120000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shipproof-e2e3-'));
  const stateFile = path.join(tmp, 'state.json'); fs.writeFileSync(stateFile, JSON.stringify({ mode: 'ok', failWhen: [] })); process.env.FAKE_KANE_STATE = stateFile;
  const ctx = createApp({ dataDir: path.join(tmp, 'data'), config: { bin: path.join(here, 'fixtures', 'fake-kane.js'), timeout: 30, maxSteps: 10, headless: true, username: '', accessKey: '', requireEvidence: true, allowPrivateTargets: true, acceptFixtureEngine: true } });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/40[0149]|410/.test(m.text())) errors.push(m.text()); });
    const post = async (u, data) => (await page.request.post(base + u, { data })).json();
    const stamp = () => page.locator('.stamp span').first().textContent();
    await page.goto(base + '/#/signup');
    await page.fill('input[name=name]', 'Ada'); await page.fill('input[name=email]', 'ada@example.com'); await page.fill('input[name=password]', 'correct-horse'); await page.click('button[type=submit]');
    await page.waitForSelector('text=No projects yet');
    const pid = (await post('/api/projects', { name: 'Shop', appUrl: 'http://127.0.0.1:9/' })).project.id;
    await post(`/api/projects/${pid}/criteria`, { text: 'Cart totals are right.', paths: ['src/cart/**'], criticality: 'high' });
    await post(`/api/projects/${pid}/criteria`, { text: 'Login works.' });
    await post(`/api/projects/${pid}/runs`, {}); await ctx.runner.idle();

    // coverage metadata through the UI creates a new criterion version
    await page.goto(`${base}/#/p/${pid}`); await page.waitForSelector('.stamp'); assert.equal(await stamp(), 'RELEASE VERIFIED');
    await page.click('tbody tr:has-text("AC-002") >> text=Coverage');
    await page.selectOption('dialog select', 'critical'); await page.fill('dialog input', 'auth'); await page.fill('dialog textarea', 'src/auth/**'); await page.click('dialog button[type=submit]');
    await page.waitForSelector('text=Coverage saved as a new version');
    assert.deepEqual(ctx.db.all('SELECT version, criticality, paths FROM criterion_versions WHERE criterion_id = 2 ORDER BY version').map((v) => [v.version, v.criticality, v.paths]), [[1, 'medium', '[]'], [2, 'critical', '["src/auth/**"]']]);

    // register a build in the UI → change impact analysis
    await page.click('a:has-text("Builds & impact")'); await page.waitForSelector('text=No builds registered');
    await page.fill('input[placeholder^="Commit SHA"]', SHA(1)); await page.fill('input[placeholder="Branch"]', 'main');
    await page.fill('textarea[placeholder^="Changed file paths"]', 'src/cart/total.js\nREADME.md'); await page.click('button:has-text("Register build")');
    await page.waitForSelector('text=Run verification plan (2 of 2)');   // AC-001 is affected; AC-002 was re-mapped after its evidence, so that evidence is not trusted
    assert.equal(await page.locator('.statbtn:has(span:text-is("Affected")) b').textContent(), '1');
    assert.equal(await page.locator('.statbtn:has(span:text-is("Unaffected")) b').textContent(), '1');
    await page.waitForSelector('code:has-text("src/cart/total.js")');
    assert.equal(ctx.db.get('SELECT COUNT(*) n FROM builds').n, 1);
    // the project is now unverified because mapped code changed
    await page.goto(`${base}/#/p/${pid}`); await page.waitForSelector('.stamp'); assert.equal(await stamp(), 'NOT VERIFIED');
    assert.equal(await page.locator('tbody tr:has-text("AC-001") .tag').first().textContent(), 'Stale');

    // release intelligence explains the block and links to the proof
    await page.click('a:has-text("Release intelligence")'); await page.waitForSelector('text=This release is not verified.');
    await page.waitForSelector('code:has-text("STALE_EVIDENCE")'); await page.waitForSelector('text=To resolve: Re-run this criterion against the current build.');
    await page.click('button:has-text("Stability")'); await page.waitForSelector('text=Not enough data');
    await page.click('button:has-text("Risk")'); await page.waitForSelector('code:has-text("criticality")');
    // policy change is persisted as a new version
    await page.uncheck('input[data-rule="blockCriticalUnstable"]'); await page.click('text=Save as new policy version'); await page.waitForSelector('text=Policy v2 saved');
    assert.equal(ctx.db.get('SELECT MAX(version) v FROM policy_versions WHERE project_id = ?', pid).v, 2);

    // run the plan from the impact view
    await page.goto(`${base}/#/p/${pid}/builds/1`); await page.click('button:has-text("Run verification plan")'); await page.waitForSelector('text=run finished', { timeout: 30000 });
    const last = ctx.db.get('SELECT * FROM runs ORDER BY id DESC LIMIT 1');
    assert.deepEqual([last.trigger, last.build_id, ctx.db.get('SELECT COUNT(*) n FROM results WHERE run_id = ?', last.id).n], ['impact_plan', 1, 2]);
    await page.goto(`${base}/#/p/${pid}`); await page.waitForSelector('.stamp'); assert.equal(await stamp(), 'RELEASE VERIFIED');
    await page.reload(); await page.waitForSelector('.stamp'); assert.equal(await stamp(), 'RELEASE VERIFIED');

    // proof explorer: search → trace of one criterion with versions, executions, evidence hashes
    await page.click('a:has-text("Proof explorer")'); await page.fill('input[type=search]', 'cart'); await page.waitForSelector('text=1 of 2 criteria');
    await page.click('tbody tr:has-text("AC-001")'); await page.waitForSelector('text=Criterion versions');
    assert.equal(await page.locator('.node:has(> h3:has-text("Executions")) tbody tr').count(), 2);
    const shown = await page.locator('.node:has(> h3:has-text("Executions")) tbody tr').first().locator('a code').first().getAttribute('title');
    assert.ok(ctx.db.get('SELECT 1 ok FROM evidence WHERE sha256 = ?', shown), 'the hash shown is a stored evidence hash');
    await page.locator('.node:has(> h3:has-text("Executions")) a.key').first().click(); await page.waitForSelector('text=Engine output');   // graph → execution
    await page.goBack(); await page.waitForSelector('text=Criterion versions');

    // CI tab: webhook secret is created once and stored encrypted
    await page.goto(`${base}/#/p/${pid}/ci`); await page.waitForSelector('text=GitHub push webhook'); await page.click('text=Create webhook secret');
    const secret = await page.locator('#webhook-secret').textContent();
    assert.match(secret, /^whsec_/); assert.ok(!ctx.db.get('SELECT webhook_secret_enc e FROM projects WHERE id = ?', pid).e.includes(secret));
    await page.reload(); await page.waitForSelector('text=configured'); assert.equal(await page.locator('#webhook-secret').count(), 0, 'secret is not shown again');
    // a signed push delivered to the URL shown appears in the delivery list
    const raw = JSON.stringify({ ref: 'refs/heads/main', before: SHA(1), after: SHA(2), commits: [{ added: [], modified: ['docs/a.md'], removed: [] }], head_commit: { message: 'docs' } });
    const r = await fetch(`${base}/api/webhooks/github/${pid}`, { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'push', 'X-GitHub-Delivery': 'e2e-delivery-1',
      'X-Hub-Signature-256': 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex') } });
    assert.equal(r.status, 202);
    await page.reload(); await page.waitForSelector('td:has-text("e2e-delivery-1")');
    await page.goto(`${base}/#/p/${pid}`); await page.waitForSelector('.stamp'); assert.equal(await stamp(), 'RELEASE VERIFIED', 'a docs-only push leaves mapped evidence current');

    // dossier: generate, integrity verified in the browser, download verifies offline
    await page.click('a:has-text("Dossier")'); await page.click('button:has-text("Generate dossier")');
    await page.waitForSelector('#dossier-integrity:has-text("Integrity verified")'); await page.waitForSelector('text=produced by a test stand-in engine');
    const d = ctx.db.get('SELECT * FROM dossiers'); const doc = JSON.parse(d.document);
    assert.equal(verifyDossier(doc).valid, true); assert.equal(doc.payload.build.commitSha, SHA(2)); assert.equal(doc.payload.decision.verdict, 'verified');
    const dl = await (await page.request.get(`${base}/api/dossiers/${d.uid}/download`)).json();
    assert.equal(dl.manifest.payloadSha256, d.payload_sha256);
    // a tampered stored document is reported, not shown as valid
    doc.payload.decision.verdict = 'blocked'; ctx.db.run('UPDATE dossiers SET document = ? WHERE id = ?', JSON.stringify(doc), d.id);
    await page.reload(); await page.waitForSelector('#dossier-integrity:has-text("INTEGRITY CHECK FAILED")');

    // phone viewport: no horizontal page scroll on the new views
    const phone = await browser.newContext({ viewport: { width: 390, height: 800 }, storageState: await page.context().storageState() });
    const m = await phone.newPage();
    for (const route of ['proof', 'proof/1', 'builds', 'builds/1', 'intelligence', 'ci', 'dossier', `dossier/${d.uid}`]) {
      await m.goto(`${base}/#/p/${pid}/${route}`); await m.waitForSelector('nav.tabs'); await m.waitForTimeout(400);
      assert.ok(await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${route} fits a phone viewport`);
    }
    if (process.env.E2E_SHOT_DIR) for (const [route, name] of [['intelligence', 'intel'], ['proof/1', 'trace'], ['builds/1', 'impact']]) { await page.goto(`${base}/#/p/${pid}/${route}`); await page.waitForTimeout(700); await page.screenshot({ path: `${process.env.E2E_SHOT_DIR}/${name}.png`, fullPage: true }); }
    assert.deepEqual(errors, [], 'no uncaught browser errors');
  } finally { await browser.close(); server.close(); server.closeAllConnections?.(); await ctx.shutdown(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
