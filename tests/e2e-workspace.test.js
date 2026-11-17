// Browser test of the SHIPPROOF ENGINEER workspace (Playwright + Chromium), skipped when Playwright is unavailable.
// Real: the SPA, the server's session and activity stream (SSE), the text conversation path, permissions enforced by the
// server, the command palette and phone-sized layout. The engineer's model is scripted (tests/fixtures/oncall-doubles.js).
// Set WORKSPACE_SHOTS=<dir> to save screenshots.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { oncallConfig } from '../server/oncall/config.js';
import { scriptedReasoning, makeRepo, say } from './fixtures/oncall-doubles.js';

process.env.LOG_LEVEL = 'silent';
const here = path.dirname(fileURLToPath(import.meta.url));
let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch {}
const shotDir = process.env.WORKSPACE_SHOTS || null;
const IGNORED_CONSOLE = /net::ERR|Failed to load resource|fonts\.g|favicon/;

test('SHIPPROOF ENGINEER: persistent drawer, real conversation, reconnect without duplicates, permissions, palette, phone layout', { skip: !chromium && 'playwright not available', timeout: 240000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shipproof-workspace-e2e-'));
  const repo = makeRepo(tmp);
  const reasoning = scriptedReasoning([
    () => [say('There are no verification runs for this project yet, so there are no release blockers to explain.')],
    () => [say('Reconnected: this reply arrives exactly once.')],
  ]);
  const { createApp } = await import('../server/app.js');
  const config = oncallConfig({ ONCALL_APPROVERS: 'ada@example.com', ONCALL_READERS: 'bob@example.com', ONCALL_REPO_DIR: repo.work }, { workspaceDir: repo.work });
  const ctx = createApp({ dataDir: path.join(tmp, 'data'), config: { bin: path.join(here, 'fixtures', 'fake-kane.js'), timeout: 30, maxSteps: 10, headless: true, username: '', accessKey: '', requireEvidence: true, allowPrivateTargets: true, acceptFixtureEngine: true },
    oncallOptions: { config, overrides: { reasoning } } });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const errors = [];
  const shot = async (page, name) => { if (shotDir) { fs.mkdirSync(shotDir, { recursive: true }); await page.screenshot({ path: path.join(shotDir, `${name}.png`) }); } };
  const watch = (page, label) => {
    page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !IGNORED_CONSOLE.test(m.text())) errors.push(`${label}: ${m.text()}`); });
  };
  const signup = async (context, email, name) => assert.equal((await context.request.post(`${base}/api/auth/signup`, { data: { email, name, password: 'correct-horse' } })).status(), 200);
  const drawer = (page) => page.locator('#agent');
  const transcript = (page) => page.locator('#ag-transcript').innerText();

  try {
    // ---------- owner (approver): desktop
    const ada = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: shotDir ? 2 : 1 });
    const sessionCreates = [];
    const page = await ada.newPage(); watch(page, 'ada');
    page.on('request', (r) => { if (r.method() === 'POST' && /\/api\/oncall\/sessions$/.test(r.url())) sessionCreates.push(r.url()); });
    await signup(ada, 'ada@example.com', 'Ada');
    const created = await ada.request.post(`${base}/api/projects`, { data: { name: 'Checkout', appUrl: 'http://127.0.0.1:4100/' } });
    assert.equal(created.status(), 201, await created.text());
    const body = await created.json(), pid = body.project?.id ?? body.id;

    await page.goto(`${base}/#/p/${pid}`);
    await page.getByRole('heading', { name: 'Checkout', level: 1 }).waitFor();
    const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
    assert.match(await crumbs.innerText(), /Projects\s*\/\s*Checkout/, 'breadcrumb names the project');
    assert.equal(await drawer(page).isVisible(), false, 'the engineer drawer starts closed');

    await page.locator('.top').getByRole('button', { name: /Engineer/ }).click();
    await drawer(page).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Start conversation' }).click();
    await page.waitForFunction(() => { const i = document.querySelector('#ag-input'); return i && !i.disabled; });
    assert.match(await page.locator('#ag-project').innerText(), /This page: Checkout/);
    assert.match(await page.locator('#ag-project').innerText(), /Conversation: Checkout/, 'the conversation is bound to the project it was started for');

    const input = page.locator('#ag-input');
    await input.fill('Explain the current release blockers.');
    await input.press('Enter');
    await page.locator('#ag-transcript').getByText('no verification runs', { exact: false }).waitFor();
    assert.equal(await input.inputValue(), '', 'Enter sends and clears the composer');
    assert.equal(await page.locator('#ag-transcript li.who-user').count(), 1, 'one message, one transcript entry');
    await shot(page, 'desktop-drawer-conversation');

    // ---------- the drawer survives SPA navigation: same document, same stream, same conversation
    await page.evaluate(() => { window.__sameDocument = true; });
    await page.goto(`${base}/#/oncall`);
    await page.locator('.oc').waitFor();
    assert.equal(await page.evaluate(() => window.__sameDocument), true, 'route change is not a page reload');
    assert.equal(await drawer(page).isVisible(), true, 'the drawer stays open across routes');
    assert.match(await transcript(page), /no verification runs/, 'the transcript survives the route change');
    await page.goto(`${base}/#/app`);
    await page.waitForFunction(() => location.hash === '#/app');
    assert.equal(sessionCreates.length, 1, 'navigating never creates a second conversation');
    await page.waitForFunction(() => document.querySelector('#ag-status')?.textContent.includes('Live'), null, { timeout: 15000 });

    // ---------- permissions: the owner may raise the level; the server decides
    await drawer(page).locator('select').first().selectOption('engineering');
    await page.getByText('Permission: Engineering autonomy').waitFor();
    assert.equal(await drawer(page).locator('select').first().inputValue(), 'engineering');

    // ---------- network drop and recovery: the stream reconnects, replays the gap, and nothing is duplicated
    await ada.setOffline(true); await page.waitForTimeout(1200); await ada.setOffline(false);
    await page.waitForFunction(() => document.querySelector('#ag-status')?.textContent.includes('Live'), null, { timeout: 30000 });
    await input.fill('Confirm the conversation still works after reconnecting.');
    await input.press('Enter');
    await page.locator('#ag-transcript').getByText('arrives exactly once', { exact: false }).waitFor({ timeout: 20000 });
    await page.waitForTimeout(500);
    assert.equal((await transcript(page)).split('arrives exactly once').length - 1, 1, 'the reconnected stream adds no duplicate lines');

    // ---------- escape closes, Ctrl+K opens the palette, the palette navigates
    await input.focus(); await page.keyboard.press('Escape');
    assert.equal(await drawer(page).isVisible(), false, 'Escape closes the drawer');
    await page.keyboard.press('Control+K');
    const palette = page.getByRole('dialog', { name: 'Search and commands' });
    await palette.waitFor();
    await palette.getByRole('combobox').fill('checkout');
    await palette.getByRole('option', { name: /Checkout · Failure analysis/ }).waitFor();
    await palette.getByRole('combobox').press('Escape');
    await palette.waitFor({ state: 'detached' });
    await page.keyboard.press('Control+K');
    await palette.waitFor();
    await palette.getByRole('combobox').fill('on-call');
    await palette.getByRole('option', { name: /On-call engineer/ }).first().waitFor();
    await palette.getByRole('combobox').press('Enter');
    await page.waitForFunction(() => location.hash === '#/oncall');
    assert.equal(await palette.count(), 0);

    // ---------- conversation ends on request, after confirmation
    await page.goto(`${base}/#/app`);
    await page.locator('.top').getByRole('button', { name: /Engineer/ }).click();
    await drawer(page).getByRole('button', { name: 'End conversation' }).click();
    const confirm = page.getByRole('dialog').filter({ hasText: 'End this conversation?' });
    await confirm.waitFor();
    await confirm.getByRole('button', { name: 'End conversation' }).click();
    await page.waitForFunction(() => document.querySelector('#ag-status')?.textContent.includes('Conversation ended'), null, { timeout: 15000 });
    assert.equal(await input.isDisabled(), true, 'an ended conversation cannot receive messages');

    // ---------- reader (read-only): the server refuses an escalation, and the drawer offers only read-only
    const bob = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const bobPage = await bob.newPage(); watch(bobPage, 'bob');
    await signup(bob, 'bob@example.com', 'Bob');
    await bobPage.goto(`${base}/#/app`);
    await bobPage.locator('.top').getByRole('button', { name: /Engineer/ }).click();
    await bobPage.getByRole('button', { name: 'Start conversation' }).click();
    await bobPage.waitForFunction(() => { const i = document.querySelector('#ag-input'); return i && !i.disabled; });
    assert.deepEqual(await bobPage.locator('#agent select').first().locator('option').allInnerTexts(), ['Read-only'], 'a reader is offered only read-only');
    const bobSession = (await (await bob.request.get(`${base}/api/oncall/status`)).json()).activeSession;
    const escalate = await bob.request.post(`${base}/api/oncall/sessions/${bobSession.id}/permission`, { data: { level: 'engineering' } });
    assert.equal(escalate.status(), 403, 'the server refuses engineering autonomy for a reader');
    await bob.close();

    // ---------- phone: bottom navigation, full-height drawer, composer above the fold, no horizontal overflow
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, storageState: await ada.storageState(), deviceScaleFactor: shotDir ? 2 : 1 });
    const mp = await phone.newPage(); watch(mp, 'phone');
    for (const route of ['#/app', `#/p/${pid}`, '#/oncall']) {
      await mp.goto(`${base}/${route}`);
      await mp.locator('.bottomnav').waitFor({ state: 'visible' });
      assert.ok(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${route} has no horizontal overflow on a 390px screen`);
    }
    await mp.goto(`${base}/#/app`);
    const navBoxes = await mp.locator('.bottomnav > *').evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height, text: el.textContent.trim() }; }));
    assert.equal(navBoxes.length, 4, 'four primary destinations');
    for (const b of navBoxes) assert.ok(b.h >= 44 && b.w >= 44, `touch target ${b.text} is at least 44px`);
    await shot(mp, 'phone-projects');

    await mp.locator('.bottomnav').getByRole('button', { name: /Engineer/ }).click();
    await drawer(mp).waitFor({ state: 'visible' });
    const dBox = await drawer(mp).boundingBox();
    assert.ok(Math.round(dBox.width) === 390 && dBox.height >= 840, 'the drawer is full-screen on a phone');
    await mp.getByRole('button', { name: 'Start conversation' }).click();
    await mp.waitForFunction(() => { const i = document.querySelector('#ag-input'); return i && !i.disabled; }, null, { timeout: 15000 });
    const composer = await mp.locator('#ag-input').boundingBox(), send = await mp.getByRole('button', { name: 'Send' }).boundingBox();
    assert.ok(composer && composer.y + composer.height <= 844, 'the composer sits on screen above the bottom edge');
    assert.ok(send && send.y + send.height <= 844 && send.height >= 44, 'the send button is on screen and a usable size');
    await shot(mp, 'phone-drawer');
    await mp.getByRole('button', { name: 'Close SHIPPROOF ENGINEER' }).click();
    assert.equal(await drawer(mp).isVisible(), false, 'the phone drawer closes');

    await mp.goto(`${base}/#/p/${pid}`);
    await mp.getByRole('heading', { name: 'Checkout', level: 1 }).waitFor();
    await shot(mp, 'phone-project');
    await phone.close();

    assert.deepEqual(errors, [], 'no page errors or console errors');
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
    await ctx.shutdown?.();
  }
});
