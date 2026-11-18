// Allowlisted repository checks. The model picks a *kind* of check; it never supplies a command line.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { safePath } from './git.js';
import { scrubbedEnv } from './redact.js';

const TEST_NAME = /\.(test|spec)\.[cm]?js$/;
/** Resolve a check request to a fixed argv, or explain why that check is unavailable here. */
export function resolveCheck(cfg, dir, kind, target) {
  const rel = (t, rx, what) => { const abs = safePath(dir, t); if (!fs.existsSync(abs)) throw new Error(`${t} does not exist`); if (rx && !rx.test(t)) throw new Error(`${t} is not ${what}`); return path.relative(dir, abs); };
  const scripts = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts || {}; } catch { return {}; } })();
  switch (kind) {
    case 'test': if (!cfg.testCommand.length) throw new Error('No test command is configured'); return cfg.testCommand;
    case 'test_file': return [process.execPath, '--test', ...[].concat(target).map((t) => rel(t, TEST_NAME, 'a test file (*.test.js)'))];
    case 'syntax': return [process.execPath, '--check', rel(target, /\.[cm]?js$/, 'a JavaScript file')];
    case 'build': if (cfg.buildCommand.length) return cfg.buildCommand; if (scripts.build) return ['npm', 'run', 'build']; throw new Error('This repository has no build step (no ONCALL_BUILD_COMMAND and no "build" script)');
    case 'lint': if (cfg.lintCommand.length) return cfg.lintCommand; if (scripts.lint) return ['npm', 'run', 'lint']; throw new Error('This repository has no lint step (no ONCALL_LINT_COMMAND and no "lint" script)');
    default: throw new Error(`Unknown check kind: ${kind}`);
  }
}
/** Run one check to completion. Resolves with the real exit status; output is captured (tail kept) and never streamed to a shell. */
export function runCheck({ argv, cwd, timeoutMs, signal, maxOutput = 200000 }) {
  return new Promise((resolve) => {
    const started = Date.now(); let out = '', done = false, timedOut = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve({ command: argv.map((a) => (a === process.execPath ? 'node' : a)).join(' '), durationMs: Date.now() - started, output: out, ...r }); };
    let child;
    const useShell = process.platform === 'win32' && argv[0] !== process.execPath && !argv[0].endsWith('.exe');
    try { child = spawn(argv[0], argv.slice(1), { cwd, env: scrubbedEnv(process.env, { CI: '1', FORCE_COLOR: '0', NODE_ENV: 'test' }), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', shell: useShell }); }
    catch (e) { return finish({ status: 'error', exitCode: null, output: `Could not start: ${e.message}` }); }
    const kill = () => { try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } };
    const onAbort = () => { kill(); finish({ status: 'cancelled', exitCode: null }); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    const take = (b) => { out += b; if (out.length > maxOutput) out = out.slice(-maxOutput); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    child.on('error', (e) => finish({ status: 'error', exitCode: null, output: `${out}\nCould not start ${argv[0]}: ${e.message}` }));
    child.on('close', (code) => finish(timedOut ? { status: 'timeout', exitCode: code } : { status: code === 0 ? 'passed' : 'failed', exitCode: code }));
  });
}
/** Pull the pass/fail counts out of TAP / node:test spec output when present (reported as measured, never inferred). */
export function testCounts(output) {
  const n = (rx) => { const m = [...String(output).matchAll(rx)].pop(); return m ? Number(m[1]) : null; };
  const c = { tests: n(/^[#ℹ] tests (\d+)/gm), pass: n(/^[#ℹ] pass (\d+)/gm), fail: n(/^[#ℹ] fail (\d+)/gm), skipped: n(/^[#ℹ] skipped (\d+)/gm) };
  return c.tests == null && c.pass == null ? null : c;
}
/** A test command that exits 0 without running a single test proves nothing: record it as an error, not a pass. */
export function honest(kind, r) {
  const counts = testCounts(r.output);
  if ((kind === 'test' || kind === 'test_file') && r.status === 'passed' && counts && counts.tests === 0)
    return { ...r, status: 'error', output: `${r.output}\n[on-call] The command exited 0 but ran 0 tests; this is not counted as a pass.` };
  return r;
}
