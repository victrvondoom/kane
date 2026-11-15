// Browser end-to-end test of the on-call call screen (Playwright + Chromium), skipped when Playwright is unavailable.
// Real: the SPA, getUserMedia (Chromium's fake capture device), a real RTCPeerConnection with audio flowing, SDP
// signalling through the server, the sideband control channel, the engineer loop, git, the test runs and the push.
// Test-only stand-ins (tests/fixtures/oncall-doubles.js): the LLM is scripted, GitHub's REST API and the voice
// provider's HTTP/WebSocket API are local doubles. The "provider" answers the call with a second real WebRTC peer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { oncallConfig } from '../server/oncall/config.js';
import { scriptedReasoning, fakeGithub, fakeLiveProvider, makeRepo, call, say } from './fixtures/oncall-doubles.js';

process.env.LOG_LEVEL = 'silent';
const here = path.dirname(fileURLToPath(import.meta.url));
let chromium = null;
try { chromium = createRequire(import.meta.url)('playwright').chromium; } catch {}
const shots = process.env.ONCALL_SHOTS || null;

test('call screen: start a voice call, speak an incident, watch it get fixed and delivered, end the call', { skip: !chromium && 'playwright not available', timeout: 120000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shipproof-oncall-e2e-'));
  const repo = makeRepo(tmp), gh = await fakeGithub();
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
  let peer; // the page that plays the provider's side of the media connection
  const live = await fakeLiveProvider({ answer: (offer) => peer.evaluate(async (sdp) => {
    const pc = new RTCPeerConnection(); (window.pcs ||= []).push(pc);
    pc.ondatachannel = (e) => { e.channel.onopen = () => e.channel.send(JSON.stringify({ type: 'session.started', session: { id: 'live_e2e' } })); };
    const ac = new AudioContext(), osc = ac.createOscillator(), dst = ac.createMediaStreamDestination(); osc.connect(dst); osc.start();
    dst.stream.getTracks().forEach((t) => pc.addTrack(t, dst.stream));
    await pc.setRemoteDescription({ type: 'offer', sdp }); await pc.setLocalDescription(await pc.createAnswer());
    await new Promise((r) => { if (pc.iceGatheringState === 'complete') return r(); pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && r(); setTimeout(r, 5000); });
    return pc.localDescription.sdp;
  }, offer) });
  const regression = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { total } from '../src/pricing.js';\n\ntest('SAVE10 takes ten percent off', () => { assert.equal(total(80, 'SAVE10'), 72); });\n`;
  const reasoning = scriptedReasoning([
    () => [say('Opening an incident and reading the pricing code.'), call('incident_open', { title: 'SAVE10 coupon produces the wrong order total', description: 'SAVE10 on an $80 order yields $70.00 instead of $72.00.', environment: 'production' }), call('repo_read_file', { path: 'src/pricing.js' })],
    ({ results }) => [call('incident_finding', { kind: 'fact', statement: 'total() subtracts the coupon value as dollars.', evidence: [results[1].ref] }),
      call('incident_diagnose', { primary_failure: 'Order total $70.00 with SAVE10 on $80', root_cause: 'total() subtracts the coupon percentage as a flat amount.', confidence: 'high', affected_components: ['src/pricing.js'], evidence: [results[1].ref] }),
      call('incident_plan', { steps: ['Apply the coupon as a percentage', 'Add a regression test'], verification: ['Regression test red then green', 'Full suite'] }), call('eng_start_branch', { slug: 'save10' }),
      call('eng_edit_file', { path: 'src/pricing.js', old_text: '(subtotal - pct)', new_text: '(subtotal * (1 - pct / 100))' }), call('eng_write_file', { path: 'tests/coupon.test.js', content: regression }),
      call('eng_prove_fix', { test_files: ['tests/coupon.test.js'] }), call('eng_run_check', { kind: 'test' }), call('eng_commit', { message: 'Apply SAVE10 as a percentage discount' }), call('eng_push'),
      call('eng_open_pull_request', { title: 'Apply SAVE10 as a percentage discount', summary: 'total() now applies coupons as a percentage; adds a regression test.' }), call('request_production_action', { action: 'merge_pull_request', reason: 'Small, proven fix; suite passing.' })],
    ({ results }) => { assert.ok(results.every((r) => !r.error), JSON.stringify(results.filter((r) => r.error))); return [say('The fix is pushed and a pull request is open. Merging needs an approval on your screen.')]; },
  ]);
  const { createApp } = await import('../server/app.js');
  const config = oncallConfig({ ONCALL_APPROVERS: 'ada@example.com', ONCALL_REPO_DIR: repo.work, ONCALL_GITHUB_TOKEN: 'test-github-token', ONCALL_GITHUB_API: gh.api, ONCALL_GITHUB_REPO: 'acme/fixture', OPENAI_API_KEY: live.apiKey, ONCALL_VOICE_BASE_URL: live.baseUrl }, { workspaceDir: repo.work });
  const ctx = createApp({ dataDir: path.join(tmp, 'data'), config: { bin: path.join(here, 'fixtures', 'fake-kane.js'), timeout: 30, maxSteps: 10, headless: true, username: '', accessKey: '', requireEvidence: true, allowPrivateTargets: true, acceptFixtureEngine: true }, oncallOptions: { config, overrides: { reasoning } } });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1320, height: 900 }, deviceScaleFactor: shots ? 2 : 1 });
    peer = await context.newPage(); await peer.goto(`${base}/healthz`);
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()); });
    assert.equal((await page.request.post(`${base}/api/auth/signup`, { data: { email: 'ada@example.com', name: 'Ada', password: 'correct-horse' } })).status(), 200);
    await page.goto(`${base}/#/oncall`);
    await page.getByRole('heading', { name: 'Start a call' }).waitFor();
    assert.ok(await page.getByText('Browser calls only').isVisible());
    if (shots) await page.screenshot({ path: path.join(shots, '1-start.png') });
    await page.getByLabel('Permission level').selectOption('engineering');
    await page.getByRole('button', { name: 'Start call' }).click();

    // A real peer connection comes up, the provider's data channel reports the session started, audio flows both ways.
    await page.getByText('Listening', { exact: true }).waitFor({ timeout: 20000 });
    assert.equal(await peer.evaluate(() => window.pcs[0].connectionState), 'connected');
    // Both levels move: the microphone (Chromium's fake capture device beeps intermittently) and the provider's audio.
    await page.evaluate(() => { window.seen = { mic: false, agent: false }; setInterval(() => { if (document.querySelector('.meter.agent.on')) window.seen.agent = true; if (document.querySelector('.meter:not(.agent).on')) window.seen.mic = true; }, 30); });
    await page.waitForFunction(() => window.seen.mic && window.seen.agent, null, { timeout: 15000 }).catch(async () => { throw new Error(`audio levels did not move: ${JSON.stringify(await page.evaluate(() => window.seen))}`); });
    assert.equal(live.created[0].session.delegation.type, 'client');

    // The caller speaks; the live model delegates; the engineer works the incident end to end.
    live.callerSays('Coupon SAVE10 on an 80 dollar order gives 70 instead of 72 in production. Investigate and fix it.');
    await page.getByRole('heading', { name: 'SAVE10 coupon produces the wrong order total' }).waitFor({ timeout: 20000 });
    await page.getByText('Production action — needs approval').waitFor({ timeout: 60000 });
    await page.locator('.verdict').getByText('Verified — failure reproduced before the fix, test suite passes after it').waitFor();
    assert.ok(await page.locator('.tscript').getByText('Coupon SAVE10 on an 80 dollar order').isVisible(), 'the spoken request is in the transcript');
    assert.ok(await page.getByRole('link', { name: '#41 ↗' }).isVisible());
    assert.match(await page.locator('.gitbox').innerText(), /oncall\/inc-1-save10[\s\S]*trunk @ [0-9a-f]{7}[\s\S]*yes/i);
    assert.ok(await page.locator('.feed').getByText('Regression proof holds: before fix failed, after fix passed', { exact: true }).isVisible());
    const spoken = live.received.filter((e) => e.type === 'session.commentary.append').map((e) => e.content);
    assert.ok(spoken.some((t) => /pull request is open/.test(t)), 'the result was sent to the voice model to be spoken');
    if (shots) await page.screenshot({ path: path.join(shots, '2-incident.png'), fullPage: true });

    // Evidence is one click away, and the approval is an on-screen decision.
    await page.locator('.tbl .ref').first().click();
    await page.locator('dialog pre.out').getByText(/72 !== 70|70 !== 72/).waitFor();
    if (shots) await page.screenshot({ path: path.join(shots, '3-evidence.png') });
    await page.getByRole('button', { name: 'Close' }).click();
    assert.equal(gh.state.merged.length, 0);
    reasoning.steps.push(() => [call('prod_merge_pull_request', {})], () => [say('Merged.'), call('incident_close', { outcome: 'resolved', summary: 'SAVE10 was applied as a flat ten dollars; fixed, proven with a regression test, merged after approval.', follow_ups: ['Deploy to production'] })], () => [say('The incident is closed.')]);
    await page.getByRole('button', { name: 'Approve' }).click();
    await page.locator('.feed').getByText('Pull request #41 merged').waitFor({ timeout: 20000 });
    assert.equal(gh.state.merged.length, 1);
    await page.locator('.tag', { hasText: 'resolved' }).first().waitFor();

    await page.getByRole('button', { name: 'Mute' }).click();
    await page.getByText('Muted — the engineer cannot hear you').waitFor();
    assert.equal(await page.evaluate(() => document.querySelector('.meter:not(.agent)').classList.contains('on')), false);
    await page.getByRole('button', { name: 'Unmute' }).click();
    await page.getByRole('button', { name: 'End call' }).click();
    await page.getByRole('heading', { name: 'Call ended' }).waitFor();
    assert.ok(live.received.some((e) => e.type === 'session.close'), 'the provider session was closed');
    await page.waitForFunction(() => true); await peer.waitForFunction(() => ['disconnected', 'failed', 'closed'].includes(window.pcs[0].connectionState) || window.pcs[0].iceConnectionState === 'disconnected', null, { timeout: 20000 });

    // History and the signed report.
    await page.reload(); await page.getByRole('cell', { name: 'SAVE10 coupon produces the wrong order total' }).click();
    await page.getByText('Signed incident report').waitFor();
    assert.match(await page.locator('pre.report').innerText(), /Root cause status:\*\* verified by reproduction[\s\S]*Deploy to production[\s\S]*Signed \(Ed25519/);
    if (shots) await page.screenshot({ path: path.join(shots, '4-report.png'), fullPage: true });

    // Phone-width layout: no horizontal overflow on either page.
    await page.setViewportSize({ width: 390, height: 800 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'incident page fits a phone');
    await page.goto(`${base}/#/oncall`); await page.getByRole('heading', { name: 'Start a call' }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'call screen fits a phone');
    if (shots) await page.screenshot({ path: path.join(shots, '5-mobile.png'), fullPage: true });
    assert.deepEqual(errors, []);
    assert.ok(repo.remoteBranches().includes('oncall/inc-1-save10'));
  } finally {
    await browser.close(); server.close(); server.closeAllConnections?.(); await ctx.shutdown(); await gh.close(); await live.close(); fs.rmSync(tmp, { recursive: true, force: true });
  }
});
