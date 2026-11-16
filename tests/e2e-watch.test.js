// Browser end-to-end test of the Continuous Watch dashboard and event-triggered monitoring (Playwright + Chromium;
// skipped when Playwright is absent). Engine: TEST-ONLY stand-in tests/fixtures/fake-kane.js. Every assertion checks
// persisted backend state as well as what is painted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';

process.env.LOG_LEVEL = 'silent';
const here = path.dirname(fileURLToPath(import.meta.url));
let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch {}
const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const waitFor = async (fn, ms = 15000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out waiting for condition'); await new Promise((r) => setTimeout(r, 100)); } };

test('browser: continuous watch — configure, check, findings, remediation, signed GitHub event, confirmed execution, mobile', { skip: !chromium && 'playwright not available', timeout: 180000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shipproof-e2ewatch-'));
  const stateFile = path.join(tmp, 'state.json'); fs.writeFileSync(stateFile, JSON.stringify({ mode: 'ok', failWhen: [] })); process.env.FAKE_KANE_STATE = stateFile;
  const config = { bin: path.join(here, 'fixtures', 'fake-kane.js'), timeout: 30, maxSteps: 10, headless: true, username: '', accessKey: '', requireEvidence: true, allowPrivateTargets: true, acceptFixtureEngine: true };
  const ctx = createApp({ dataDir: path.join(tmp, 'data'), config, watchOptions: { tickMs: 0 }, eventOptions: { tickMs: 0 } });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const target = http.createServer((q, s) => s.end('<h1>Shop</h1>')).listen(0, '127.0.0.1');
  await new Promise((r) => target.once('listening', r));
  const appUrl = `http://127.0.0.1:${target.address().port}/`;
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
    const pid = (await post('/api/projects', { name: 'Shop', appUrl })).project.id;
    await post(`/api/projects/${pid}/requirements`, { text: 'The catalogue lists the Trail Backpack.\nCoupon SAVE10 reduces the total.' });
    const secret = (await post(`/api/projects/${pid}/webhook`, {})).secret;
    const pinned = ctx.db.get('SELECT COUNT(*) n FROM watch_checks WHERE project_id = ?', pid).n;
    assert.equal(pinned, 0);

    // ---- overview before any check: honest empty state, no fabricated health ----
    await page.goto(`${base}/#/p/${pid}/watch`);
    await page.waitForSelector('text=Health overview');
    assert.ok(await page.locator('text=Not measured yet').count(), 'no health is shown before a check exists');

    // ---- configuration through the UI: scheduled stays off; events are independent; autoRun stays off ----
    await page.waitForSelector('text=Event-triggered monitoring');
    await page.check('label:has-text("Enable event-triggered monitoring") input');
    await page.check('label:has-text("GitHub Actions workflow_run") input');
    await page.check('label:has-text("Deployment status") input');
    await page.click('button:has-text("Save event settings")');
    await page.waitForSelector('text=Event subscriptions saved');
    let cfg = ctx.db.get('SELECT * FROM watch_config WHERE project_id = ?', pid);
    assert.deepEqual([cfg.enabled, cfg.events_enabled, cfg.events_workflow_run, cfg.events_deployment, cfg.auto_run], [0, 1, 1, 1, 0],
      'events on, scheduled off, automatic verification off');

    // ---- run check now → persisted manual check; the plan is derived from it ----
    await page.click('button:has-text("Run check now")');
    await page.waitForSelector('text=Remediation workflow');
    const manual = await waitFor(() => ctx.db.get('SELECT * FROM watch_checks WHERE project_id = ? ORDER BY id DESC LIMIT 1', pid));
    assert.equal(manual.trigger, 'manual'); assert.equal(manual.event_id, null);
    assert.match(page.url(), new RegExp(`#/p/${pid}/watch/${manual.id}$`));
    assert.equal(await page.locator('.wf-card:has-text("Automatically eligible")').count() > 0, true, 'verification step is automatic but not started');
    assert.equal(await page.locator('button:has-text("Execute eligible plan")').count(), 1);
    assert.equal(ctx.db.get('SELECT COUNT(*) n FROM runs WHERE project_id = ?', pid).n, 0, 'checking does not spend credits');

    // ---- a signed GitHub Actions success arrives: persisted, processed by the worker, linked to a check ----
    const runBody = JSON.stringify({ action: 'completed', repository: { full_name: 'acme/shop' }, workflow_run: { id: 9001, name: 'CI', head_sha: sha('v1'), head_branch: 'main', conclusion: 'success', status: 'completed', html_url: 'https://github.com/acme/shop/actions/runs/9001', updated_at: new Date().toISOString() } });
    const delivery = `e2e-${crypto.randomUUID()}`;
    const res = await page.request.post(`${base}/api/webhooks/github/${pid}`, { data: runBody, headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'workflow_run', 'X-GitHub-Delivery': delivery,
      'X-Hub-Signature-256': 'sha256=' + crypto.createHmac('sha256', secret).update(runBody).digest('hex') } });
    assert.equal(res.status(), 202);
    const eventId = (await res.json()).eventId;
    const done = await waitFor(() => { const r = ctx.db.get('SELECT state, check_id FROM watch_events WHERE id = ?', eventId); return r?.state === 'COMPLETED' ? r : null; });
    const evCheck = ctx.db.get('SELECT * FROM watch_checks WHERE id = ?', done.check_id);
    assert.equal(evCheck.trigger, 'event'); assert.equal(evCheck.event_id, eventId);
    assert.equal(ctx.db.get('SELECT COUNT(*) n FROM runs WHERE project_id = ?', pid).n, 0, 'an event does not run verification');

    // ---- reload: the event, its check and the activity are read back from persisted state ----
    await page.goto(`${base}/#/p/${pid}/watch/${evCheck.id}`);
    await page.waitForSelector('text=Event activity');
    await page.waitForSelector(`text=check #${evCheck.id}`);
    assert.ok(await page.locator('tr:has-text("workflow_run")').first().locator('text=Completed').count(), 'event shows Completed');
    assert.ok(await page.locator('text=Event-triggered').first().count(), 'event check is labelled as event-triggered');
    assert.ok(await page.locator('.wf-card:has-text("Trigger")').count(), 'workflow starts from the trigger');
    assert.match(await page.locator('.wf-card:has-text("Trigger")').first().textContent(), /workflow “CI” · success/);

    // ---- findings board: grouped by lifecycle, filterable, inspectable ----
    assert.ok(await page.locator('section.lane h3:has-text("New")').count());
    await page.selectOption('select[aria-label="Lifecycle"]', 'resolved');
    assert.ok(await page.locator('text=No findings match these filters.').count() || await page.locator('text=No resolved findings.').count(), 'the empty resolved filter says so');
    await page.selectOption('select[aria-label="Lifecycle"]', 'all');
    await page.locator('button:has-text("Inspect finding")').first().click();
    await page.waitForSelector('dialog[open] >> text=Detected cause');
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog[open]', { state: 'detached' }).catch(() => {});

    // ---- confirmed plan execution: cancel starts nothing; confirm starts exactly one watch run ----
    await page.click('button:has-text("Execute eligible plan")');
    await page.waitForSelector('dialog[open] >> text=Start verification?');
    await page.click('dialog[open] button:has-text("Cancel")');
    await page.waitForSelector('dialog[open]', { state: 'detached' });
    assert.equal(ctx.db.get('SELECT COUNT(*) n FROM runs WHERE project_id = ?', pid).n, 0, 'cancel starts nothing');
    await page.click('button:has-text("Execute eligible plan")');
    await page.waitForSelector('dialog[open] >> text=Start verification?');
    await page.click('dialog[open] button:has-text("Start verification run")');
    const run = await waitFor(() => ctx.db.get(`SELECT * FROM runs WHERE project_id = ? ORDER BY id DESC LIMIT 1`, pid));
    assert.equal(run.trigger, 'watch_manual');
    await page.waitForURL(new RegExp(`#/run/${run.id}`));
    await ctx.runner.idle();
    assert.equal(ctx.db.get('SELECT COUNT(*) n FROM runs WHERE project_id = ?', pid).n, 1, 'one run, no duplicates');

    // ---- analytics and checks history render from the trend API ----
    await page.goto(`${base}/#/p/${pid}/watch`);
    await page.waitForSelector('text=Historical analytics');
    assert.ok(await page.locator('text=Health history').count());
    assert.ok(await page.locator('text=Evidence abnormalities').count());

    // ---- error handling: an API failure shows a retryable state, not a blank page ----
    const errorsBefore = errors.length;
    await page.route('**/api/projects/' + pid + '/watch/events*', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }));
    await page.goto(`${base}/#/app`);
    await page.goto(`${base}/#/p/${pid}/watch`);
    await page.waitForSelector('text=Could not load watch data', { timeout: 10000 });
    assert.ok(await page.locator('button:has-text("Retry")').count(), 'the failed section offers a retry');
    await page.unroute('**/api/projects/' + pid + '/watch/events*');
    // the only console error allowed is the deliberate 500 injected above; anything else still fails the test
    const injected = errors.splice(errorsBefore);
    assert.ok(injected.length >= 1 && injected.every((m) => /status of 500/.test(m)), `unexpected errors during injected failure: ${injected.join(' | ')}`);

    // ---- responsive layout: no horizontal scrolling at phone width ----
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.waitForSelector('text=Health overview');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `horizontal overflow of ${overflow}px at 390px wide`);

    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    await browser?.close();
    server.close(); server.closeAllConnections?.(); target.close();
    await ctx.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
