// TEST DOUBLES for the on-call agent tests. Nothing in this file ships in the product.
//   * scriptedReasoning — stands in for the LLM: replays a fixed list of steps (text and tool calls).
//   * fakeGithub        — a local HTTP server answering the three GitHub REST calls the agent makes.
//   * fakeLiveProvider  — a local HTTP + WebSocket server speaking the documented GPT-Live wire protocol, so the REAL
//                         voice adapter (server/oncall/voice/openai-live.js) is exercised end to end.
//   * makeRepo          — a real git repository (with a real bare "origin") containing a small service with a real bug.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let n = 0;
export const call = (name, input = {}) => ({ type: 'tool_use', id: `toolu_test_${++n}`, name, input });
export const say = (text) => ({ type: 'text', text });
/** Evidence refs and raw text of the tool results in the most recent user message. */
export function lastResults(messages) {
  const last = messages.at(-1);
  const blocks = Array.isArray(last?.content) ? last.content.filter((b) => b.type === 'tool_result') : [];
  return blocks.map((b) => ({ ref: /evidence_ref: (E-\d+)/.exec(b.content)?.[1] || null, error: !!b.is_error, text: b.content }));
}
/** steps: array of (ctx) => content blocks. A step with no tool_use ends the turn. Extra calls return a closing line. */
export function scriptedReasoning(steps) {
  const log = [];
  const p = { id: 'test-double', model: 'scripted', configured: () => true, calls: log, steps,
    async complete({ messages, tools, signal }) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const step = p.steps.shift();
      const content = step ? await step({ messages, results: lastResults(messages), tools: tools.map((t) => t.name), signal }) : [say('Done.')];
      log.push({ tools: tools.map((t) => t.name), content });
      return { content, stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: {}, model: 'scripted' };
    },
    describeError: (e) => ({ aborted: e?.name === 'AbortError', retryable: false, message: e?.message || String(e) }) };
  return p;
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const body = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });

export async function fakeGithub() {
  const requests = []; const state = { pulls: [], merged: [] };
  const server = http.createServer(async (req, res) => {
    const raw = await body(req), json = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: json });
    const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.headers.authorization !== 'Bearer test-github-token') return send(401, { message: 'Bad credentials' });
    let m;
    if (req.method === 'GET' && /\/repos\/acme\/fixture\/pulls\?/.test(req.url)) return send(200, state.pulls.filter((p) => req.url.includes(encodeURIComponent(p.head))).map((p) => ({ number: p.number, html_url: p.url, draft: true })));
    if (req.method === 'POST' && req.url === '/repos/acme/fixture/pulls') { const pr = { number: state.pulls.length + 41, url: `https://github.test/acme/fixture/pull/${state.pulls.length + 41}`, ...json }; state.pulls.push(pr); return send(201, { number: pr.number, html_url: pr.url, draft: !!json.draft }); }
    if (req.method === 'PUT' && (m = /\/repos\/acme\/fixture\/pulls\/(\d+)\/merge$/.exec(req.url))) { state.merged.push({ number: Number(m[1]), sha: json.sha }); return send(200, { merged: true, sha: 'f'.repeat(40), message: 'Pull Request successfully merged' }); }
    send(404, { message: 'Not Found' });
  });
  const port = await listen(server);
  return { api: `http://127.0.0.1:${port}`, requests, state, close: () => new Promise((r) => server.close(r)) };
}

// ---- minimal RFC 6455 server (text frames only) for the GPT-Live double ----
function wsAccept(req, socket) {
  const key = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`);
  let buf = Buffer.alloc(0); const handlers = [];
  const send = (obj) => { const p = Buffer.from(JSON.stringify(obj)); const head = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]); if (!socket.destroyed) socket.write(Buffer.concat([head, p])); };
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f; let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4), data = Buffer.from(buf.subarray(off + 4, off + 4 + len)); for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      buf = buf.subarray(off + 4 + len);
      if (op === 8) { try { socket.end(Buffer.from([0x88, 0])); } catch {} return; }
      if (op === 1) for (const h of handlers) h(JSON.parse(data.toString()));
    }
  });
  socket.on('error', () => {});
  return { send, onMessage: (h) => handlers.push(h), drop: () => socket.destroy() };
}
/** `answer(offerSdp)` may supply a real SDP answer (the browser e2e test answers with a second real WebRTC peer). */
export async function fakeLiveProvider({ apiKey = 'sk-test-live-key-000000000000', answer = null } = {}) {
  const created = [], received = [], attaches = []; let seq = 0, conn = null;
  const server = http.createServer(async (req, res) => {
    const raw = await body(req); const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.method === 'POST' && req.url === '/v1/live/sessions') {
      if (req.headers.authorization !== `Bearer ${apiKey}`) return send(401, { error: { code: 'invalid_api_key', message: 'bad key' } });
      const json = JSON.parse(raw); const id = `live_test_${++seq}`; created.push({ id, ...json, safetyId: req.headers['openai-safety-identifier'] });
      return send(201, { session: { id }, transport: { type: 'webrtc', sdp: answer ? await answer(json.transport.sdp) : 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=answer\r\n' } });
    }
    send(404, { error: { message: 'not found' } });
  });
  server.on('upgrade', (req, socket) => {
    const m = /^\/v1\/live\/sessions\/([^/]+)\/attach$/.exec(req.url);
    if (!m || req.headers.authorization !== `Bearer ${apiKey}`) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    conn = wsAccept(req, socket); attaches.push(m[1]);
    conn.onMessage((ev) => {
      received.push(ev);
      if (ev.type === 'session.close') conn.send({ type: 'session.closed', event_id: `ev_closed_${++seq}`, reason: 'close_requested', usage: { seconds: 37 } });
      if (ev.type === 'session.input_audio.mute') conn.send({ type: 'session.input_audio.muted', event_id: `ev_${++seq}`, client_event_id: ev.event_id });
    });
  });
  const port = await listen(server);
  const until = async (pred, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const hit = received.find(pred); if (hit) return hit; await new Promise((r) => setTimeout(r, 15)); } throw new Error('fakeLiveProvider: expected event was not received'); };
  return { baseUrl: `http://127.0.0.1:${port}`, apiKey, created, received, attaches, until,
    emit: (ev) => conn.send({ event_id: `ev_${++seq}`, ...ev }), raw: (ev) => conn.send(ev), dropControl: () => conn.drop(),
    /** Simulate the caller speaking a sentence, then the live model delegating it. */
    callerSays(text) { const id = `item_del_${++seq}`; let ms = 1000 + seq * 5000; text.split(' ').forEach((w, i) => this.emit({ type: 'session.input_transcript.delta', delta: (i ? ' ' : '') + w, start_ms: (ms += 120), end_ms: ms + 100 }));
      this.emit({ type: 'session.delegation.created', offset_ms: ms, delegation: { id, type: 'delegation', target: 'client' } }); return id; },
    close: () => new Promise((r) => { conn?.drop(); server.close(r); server.closeAllConnections?.(); }) };
}

/** A real repository with a real defect: SAVE10 takes 10 dollars off instead of 10 percent. */
export function makeRepo(dir) {
  const origin = path.join(dir, 'origin.git'), work = path.join(dir, 'service');
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' } }).toString().trim();
  fs.mkdirSync(origin, { recursive: true }); git(origin, 'init', '--quiet', '--bare', '--initial-branch=trunk');
  fs.mkdirSync(path.join(work, 'src'), { recursive: true }); fs.mkdirSync(path.join(work, 'tests'));
  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'fixture-service', type: 'module', private: true, scripts: { test: "node --test" } }, null, 2));
  fs.writeFileSync(path.join(work, '.gitignore'), 'node_modules/\n.env\n');
  fs.writeFileSync(path.join(work, 'src', 'pricing.js'), `// Order pricing.\nexport const COUPONS = { SAVE10: 10 };\n\nexport function total(subtotal, coupon) {\n  const pct = COUPONS[coupon] || 0;\n  // percent discount\n  return Math.round((subtotal - pct) * 100) / 100;\n}\n`);
  fs.writeFileSync(path.join(work, 'tests', 'pricing.test.js'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { total } from '../src/pricing.js';\n\ntest('no coupon leaves the subtotal unchanged', () => { assert.equal(total(80, null), 80); });\n`);
  git(work, 'init', '--quiet', '--initial-branch=trunk'); git(work, 'add', '-A'); git(work, 'commit', '--quiet', '-m', 'Initial service');
  fs.appendFileSync(path.join(work, 'src', 'pricing.js'), '\nexport const currency = (n) => `$${n.toFixed(2)}`;\n'); git(work, 'commit', '--quiet', '-am', 'Add currency formatter');
  git(work, 'remote', 'add', 'origin', origin); git(work, 'push', '--quiet', '-u', 'origin', 'trunk');
  git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/trunk'); git(work, 'remote', 'set-head', 'origin', 'trunk');
  return { origin, work, git, trunkSha: () => git(origin, 'rev-parse', 'refs/heads/trunk'), remoteBranches: () => git(origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n') };
}
