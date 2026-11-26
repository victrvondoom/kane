// Boot smoke test: every route and every project tab renders without a page error, a console error,
// the router's error panel, or the not-found panel. A merge once dropped four imports from public/app.js
// and every user got a blank page; the journeys failed with selector timeouts that were misread as
// environment problems. This test names the broken route and the exact error instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch {}

test('boot: every route and project tab renders without errors', { skip: !chromium && 'playwright not available', timeout: 180000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shipproof-boot-'));
  const { createApp } = await import('../server/app.js');
  const ctx = createApp({ dataDir: path.join(tmp, 'data'), config: { bin: path.join(here, 'fixtures', 'fake-kane.js'), timeout: 30, maxSteps: 10, headless: true, username: '', accessKey: '', requireEvidence: true, allowPrivateTargets: true, acceptFixtureEngine: true } });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const problems = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    let route = '(initial load)';
    page.on('pageerror', (e) => problems.push(`${route}: page error: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/status of 40[0-9]|status of 410/.test(m.text())) problems.push(`${route}: console error: ${m.text()}`); });

    // Renders a hash route and waits for the router to finish (it stamps #app with the route it rendered).
    const visit = async (hash) => {
      route = hash || '/';
      await page.goto(base + '/' + hash); await page.reload();
      await page.waitForFunction((h) => document.getElementById('app')?.dataset.route === h, hash, { timeout: 20000 })
        .catch(() => problems.push(`${route}: never finished rendering`));
      const text = await page.locator('#app').innerText();
      if (/Something went wrong/.test(text)) problems.push(`${route}: router error panel: ${text.split('Something went wrong')[1].trim().split('\n')[0]}`);
      if (/Page not found/.test(text)) problems.push(`${route}: not-found panel`);
      if (!text.trim()) problems.push(`${route}: rendered nothing`);
    };

    await visit('');
    await visit('#/login');
    await visit('#/signup');

    // Sign in through the real API from the page, so the session cookie lands in the browser.
    const signup = await page.evaluate(async () => (await fetch('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Boot', email: 'boot@example.com', password: 'boot-check-123' }) })).status);
    assert.equal(signup, 200, 'signup succeeds');

    await visit('#/app');
    await visit('#/new');
    await visit('#/oncall');
    await visit('#/no-such-page'); // must render the not-found panel, which is the one expected "problem"
    const nf = problems.findIndex((x) => x === '#/no-such-page: not-found panel');
    assert.ok(nf >= 0, `unknown routes render the not-found panel (got: ${problems.join(' | ')})`);
    problems.splice(nf, 1);

    const created = await page.evaluate(async () => (await (await fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Boot check', appUrl: 'http://127.0.0.1:9/', context: '' }) })).json()).project);
    assert.ok(created?.id, 'project created');
    await visit('');

    // Every tab the project page offers, read from the rendered tab bar rather than a hardcoded list.
    await visit(`#/p/${created.id}`);
    const tabs = await page.locator('nav.tabs a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    assert.ok(tabs.length >= 10, `project tab bar renders (${tabs.length} tabs)`);
    for (const href of tabs) {
      await visit(href);
      const on = await page.locator('nav.tabs a.on').getAttribute('href').catch(() => null);
      if (on !== href) problems.push(`${href}: tab bar does not mark this tab as current (current: ${on})`);
    }

    assert.deepEqual(problems, [], `routes rendered with problems:\n${problems.join('\n')}`);
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
    ctx.close?.();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
