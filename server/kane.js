// Kane CLI execution adapter.
// Spawns the real `kane-cli run ... --agent` process per acceptance criterion,
// streams its NDJSON events, and classifies the outcome conservatively:
// anything that is not an explicit, exit-code-0 pass with a run_end event is NOT a pass.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function kaneConfig(env = process.env) {
  return {
    bin: env.KANE_CLI_BIN || 'kane-cli',
    timeout: Math.max(30, Number(env.KANE_TIMEOUT_SECONDS) || 240),
    maxSteps: Math.max(5, Number(env.KANE_MAX_STEPS) || 40),
    headless: env.KANE_HEADLESS !== '0',
    username: env.LT_USERNAME || '',
    accessKey: env.LT_ACCESS_KEY || '',
    // A pass with no evidence artifact is treated as unverified ("missing evidence means unverified").
    requireEvidence: env.REQUIRE_EVIDENCE !== '0',
    // SSRF guard: loopback/private targets are refused unless explicitly allowed (local demo, private staging).
    allowPrivateTargets: env.ALLOW_PRIVATE_TARGETS === '1',
  };
}

const PASS = /^(pass|passed|success|succeeded|completed|done)$/i;
// Oldest CLI whose agent-mode contract (stream_start + run_end NDJSON, documented exit codes) this adapter was written against.
export const MIN_KANE_VERSION = '0.8.17';
export const TESTED_KANE_VERSION = '0.10.4';
const NETWORK = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|getaddrinfo|fetch failed|network (?:error|unavailable|unreachable)|socket hang up|tunnel|proxy/i;
const AUTH = /not authenticated|not logged in|kane-cli login|unauthori[sz]ed|invalid (?:access key|credentials)|401/i;

/** Pure classification of a finished kane-cli process. Exported for unit tests. */
export function classify({ exitCode, signal, runEnd, stderr = '', spawnError, timedOut, cancelled }) {
  if (cancelled) return { status: 'cancelled', errorKind: 'cancelled', reason: 'Run was cancelled before Kane CLI finished.' };
  if (spawnError) {
    const missing = spawnError.code === 'ENOENT';
    return { status: 'error', errorKind: missing ? 'kane_not_installed' : 'spawn_failed',
      reason: missing ? 'Kane CLI binary not found. Install it with: npm install -g @testmuai/kane-cli'
        : `Could not start Kane CLI: ${spawnError.message}` };
  }
  if (timedOut || exitCode === 3) {
    return { status: 'timeout', errorKind: 'timeout', reason: runEnd?.reason || 'Kane CLI run timed out or was cancelled (exit 3).' };
  }
  if (!runEnd) {
    if (AUTH.test(stderr)) {
      return { status: 'error', errorKind: 'auth', reason: 'Kane CLI is not authenticated. Run `kane-cli login` on the server or set LT_USERNAME / LT_ACCESS_KEY.' };
    }
    if (NETWORK.test(stderr)) {
      return { status: 'error', errorKind: 'network', reason: 'Kane CLI could not reach the TestMu AI service or the target (network error). Nothing was verified. ' + stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300) };
    }
    const tail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400);
    return { status: 'error', errorKind: 'did_not_start',
      reason: `Kane CLI exited ${signal ? 'on ' + signal : 'with code ' + exitCode} without a run_end event — nothing was verified.${tail ? ' ' + tail : ''}` };
  }
  if (exitCode === 0 && PASS.test(String(runEnd.status || ''))) return { status: 'passed', errorKind: null, reason: null };
  if (exitCode === 0) {
    return { status: 'error', errorKind: 'inconsistent',
      reason: `Kane CLI exited 0 but reported status "${runEnd.status}". Treated as unverified.` };
  }
  if (PASS.test(String(runEnd.status || ''))) {
    return { status: 'error', errorKind: 'inconsistent',
      reason: `Kane CLI reported "${runEnd.status}" but exited with code ${exitCode} (e.g. upload failure). Treated as unverified.` };
  }
  if (exitCode === 2) return { status: 'error', errorKind: 'did_not_start', reason: runEnd.reason || runEnd.summary || 'Kane CLI did not start the run (exit 2).' };
  return { status: 'failed', errorKind: null, reason: runEnd.reason || runEnd.summary || 'Objective did not pass.' };
}

export function buildObjective({ appUrl, context, criterionText }) {
  const parts = [`Go to ${appUrl}.`];
  if (context && context.trim()) parts.push(context.trim().replace(/\s+/g, ' '));
  parts.push(`Then verify this acceptance criterion exactly as written, acting as a real user: ${criterionText.trim()}`);
  parts.push('Finish by asserting the expected outcome is visible on the page. If the outcome is not observed, the check fails.');
  return parts.join(' ');
}

export function redact(text, secrets) {
  let out = String(text ?? '');
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('«redacted»');
  return out;
}

/**
 * Execute one objective. Returns a promise of the raw outcome; never throws.
 * onEvent({kind:'kane'|'stderr', payload}) is called for every NDJSON line / stderr chunk.
 */
export function runKane({ objective, url, workDir, variables = [], config = kaneConfig(), onEvent = () => {}, onSpawn = () => {} }) {
  return new Promise((resolve) => {
    fs.mkdirSync(workDir, { recursive: true });
    const args = ['run', objective, '--agent', '--url', url, '--timeout', String(config.timeout), '--max-steps', String(config.maxSteps)];
    if (config.headless) args.push('--headless');
    const secrets = [config.accessKey, ...variables.filter((v) => v.secret).map((v) => v.value)];
    let varsFile = null;
    if (variables.length) {
      varsFile = path.join(workDir, 'variables.json');
      const json = Object.fromEntries(variables.map((v) => [v.key, { value: v.value, secret: !!v.secret }]));
      fs.writeFileSync(varsFile, JSON.stringify(json), { mode: 0o600 });
      args.push('--variables-file', varsFile);
    }
    const shown = [config.bin, ...args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))];
    if (config.username && config.accessKey) {
      args.push('--username', config.username, '--access-key', config.accessKey);
      shown.push('--username', '«env»', '--access-key', '«redacted»');
    }
    const started = Date.now();
    let stdout = '', stderr = '', buf = '', runEnd = null, timedOut = false, cancelled = false, settled = false;
    const events = [];
    const cap = (s, add) => (s.length < 1_000_000 ? s + add : s);
    let child;
    const finish = (extra) => {
      if (settled) return; settled = true;
      clearTimeout(watchdog);
      if (varsFile) fs.rm(varsFile, { force: true }, () => {});
      resolve({ command: shown.join(' '), stdout: redact(stdout, secrets), stderr: redact(stderr, secrets), runEnd, events,
        timedOut, cancelled, durationMs: Date.now() - started, exitCode: null, signal: null, spawnError: null, engine: null, ...extra });
    };
    const kill = (sig) => { if (!child?.pid) return; try { process.platform !== 'win32' ? process.kill(-child.pid, sig) : child.kill(sig); } catch { try { child.kill(sig); } catch {} } };
    const watchdog = setTimeout(() => { timedOut = true; kill('SIGKILL'); }, (config.timeout + 45) * 1000);
    try {
      // Own process group so the browser Kane launches is cleaned up with it.
      child = spawn(config.bin, args, { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
        env: { ...process.env, KANE_CLI_USER_AGENT: 'shipproof', NO_COLOR: '1', FORCE_COLOR: '0' } });
    } catch (e) { return finish({ spawnError: e }); }
    onSpawn({ pid: child.pid, cancel() { cancelled = true; kill('SIGTERM'); setTimeout(() => kill('SIGKILL'), 3000).unref(); } });
    const handleLine = (line) => {
      if (!line.trim()) return;
      let ev;
      line = redact(line, secrets); // secrets never reach persisted events or the browser
      try { ev = JSON.parse(line); } catch { ev = { type: 'raw', text: line.slice(0, 2000) }; }
      if (ev && ev.type === 'run_end') runEnd = ev;
      events.push(ev);
      onEvent({ kind: 'kane', payload: ev });
    };
    child.stdout.on('data', (d) => {
      const s = d.toString(); stdout = cap(stdout, s); buf += s;
      let i; while ((i = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.on('data', (d) => {
      const s = d.toString(); stderr = cap(stderr, s);
      onEvent({ kind: 'stderr', payload: { text: redact(s, secrets).slice(0, 4000) } });
    });
    child.on('error', (e) => finish({ spawnError: e }));
    child.on('close', (code, signal) => {
      if (buf) handleLine(buf);
      kill('SIGKILL'); // reap anything the CLI left behind in its process group
      const start = events.find((e) => e && e.type === 'stream_start');
      finish({ exitCode: code, signal, engine: start?.cli_version ? `kane-cli ${start.cli_version}` : null });
    });
  });
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.json': 'application/json', '.ndjson': 'application/x-ndjson', '.md': 'text/markdown', '.txt': 'text/plain', '.log': 'text/plain',
  '.har': 'application/json', '.webm': 'video/webm', '.mp4': 'video/mp4', '.html': 'text/html', '.evidence': 'application/octet-stream',
  '.zip': 'application/zip', '.yaml': 'text/yaml', '.yml': 'text/yaml' };

/** Copy whatever Kane actually wrote (session dir + sealed .evidence packs) into our evidence store. */
export function collectEvidence({ outcome, workDir, destDir, maxBytes = 80 * 1024 * 1024, maxFiles = 400 }) {
  const roots = new Set();
  const sd = outcome.runEnd?.session_dir;
  if (sd && fs.existsSync(sd)) roots.add(path.resolve(sd));
  const local = path.join(workDir, '.testmuai');
  if (fs.existsSync(local)) roots.add(local);
  for (const m of outcome.stderr.matchAll(/(\/[^\s'"]+\.evidence)\b/g)) if (fs.existsSync(m[1])) roots.add(m[1]);
  const files = [];
  let total = 0;
  const walk = (root, p, depth) => {
    if (files.length >= maxFiles || depth > 8) return;
    let st; try { st = fs.lstatSync(p); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) { for (const n of fs.readdirSync(p).sort()) walk(root, path.join(p, n), depth + 1); return; }
    const ext = path.extname(p).toLowerCase();
    if (!MIME[ext] || path.basename(p) === 'variables.json' || total + st.size > maxBytes) return;
    const rel = path.join(path.basename(root), path.relative(root, p) || path.basename(p)).replace(/\.\.+/g, '_');
    const dest = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(p, dest);
    total += st.size;
    const kind = MIME[ext].startsWith('image/') ? 'screenshot' : MIME[ext].startsWith('video/') ? 'video'
      : ext === '.evidence' ? 'evidence_pack' : 'log';
    files.push({ kind, name: rel, relPath: rel, mime: MIME[ext], size: st.size });
  };
  for (const r of roots) walk(fs.statSync(r).isDirectory() ? r : path.dirname(r), r, 0);
  return files;
}

/** Find the step Kane marked failed (progress events carry step/status/remark). */
export function failingStep(events) {
  const failed = events.filter((e) => e && !e.type && /fail/i.test(String(e.status || '')));
  const last = failed.at(-1);
  if (last) return { step: last.step ?? null, remark: last.remark ?? null };
  const err = events.filter((e) => e && e.type === 'error').at(-1);
  return err ? { step: null, remark: err.message || err.error || JSON.stringify(err).slice(0, 300) } : null;
}

export function versionAtLeast(v, min) {
  const a = String(v || '').split(/[.-]/).map(Number), b = min.split('.').map(Number);
  if (a.slice(0, 3).some(Number.isNaN)) return /fixture/.test(String(v)); // test stand-ins identify themselves
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) > b[i]) return true; if ((a[i] || 0) < b[i]) return false; }
  return true;
}
export const resetKaneStatusCache = () => { cached = { at: 0, value: null }; };
let cached = { at: 0, value: null };
const ex = (bin, args) => new Promise((res) => execFile(bin, args, { timeout: 15000, env: { ...process.env, NO_COLOR: '1' } },
  (err, stdout, stderr) => res({ code: err ? (err.code ?? 1) : 0, out: String(stdout) + String(stderr) })));

/** Real engine status for the UI: installed version and whether a login/credentials exist. No secrets returned. */
export async function kaneStatus(config = kaneConfig(), { fresh = false } = {}) {
  if (!fresh && cached.value && Date.now() - cached.at < 30000) return cached.value;
  const v = await ex(config.bin, ['--version']);
  const installed = v.code === 0;
  let auth = 'unknown', detail = '';
  if (!installed) { auth = 'unavailable'; detail = 'kane-cli not found on the server PATH.'; }
  else if (config.username && config.accessKey) { auth = 'env_credentials'; detail = 'Using LT_USERNAME / LT_ACCESS_KEY from the server environment.'; }
  else {
    const w = await ex(config.bin, ['whoami']);
    auth = w.code === 0 && !/not logged in/i.test(w.out) ? 'logged_in' : 'not_authenticated';
    detail = auth === 'logged_in' ? 'kane-cli login profile found on the server.' : 'Not logged in. Run `kane-cli login` on the server or set LT_USERNAME / LT_ACCESS_KEY.';
  }
  const version = installed ? (v.out.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0] ?? v.out.trim().split('\n')[0]) : null;
  const compatible = installed && versionAtLeast(version, MIN_KANE_VERSION);
  if (installed && !compatible) detail = `kane-cli ${version} is older than the minimum supported ${MIN_KANE_VERSION}. Upgrade: npm install -g @testmuai/kane-cli`;
  const state = !installed ? 'unavailable' : !compatible ? 'incompatible' : auth === 'not_authenticated' ? 'not_authenticated' : 'ready';
  cached = { at: Date.now(), value: { installed, version, compatible, minVersion: MIN_KANE_VERSION, testedVersion: TESTED_KANE_VERSION, auth, detail, state,
    ready: state === 'ready', timeoutSeconds: config.timeout, headless: config.headless,
    policy: { requireEvidence: !!config.requireEvidence, allowPrivateTargets: !!config.allowPrivateTargets } } };
  return cached.value;
}
