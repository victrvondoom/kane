#!/usr/bin/env node
// TEST FIXTURE ONLY. Stands in for the kane-cli binary inside the automated test-suite so the
// adapter, queue, gate and repair loop can be exercised deterministically without a browser.
// It is never used by the running product (KANE_CLI_BIN defaults to the real `kane-cli`).
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('0.0.0-fixture'); process.exit(0); }
if (args[0] === 'whoami') process.exit(0);
const state = JSON.parse(fs.readFileSync(process.env.FAKE_KANE_STATE, 'utf8'));
const objective = args[1] || '';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
if (state.mode === 'unauthenticated') {
  out({ type: 'stream_start', cli_version: 'fixture' });
  process.stderr.write('Not authenticated. Run: kane-cli login --oauth\n');
  process.exit(1);
}
if (state.mode === 'network') {
  out({ type: 'stream_start', cli_version: 'fixture' });
  process.stderr.write('Error: getaddrinfo ENOTFOUND api.testmuai.invalid\n');
  process.exit(2);
}
if (state.mode === 'crash') { // dies mid-run without a run_end
  out({ type: 'stream_start', cli_version: 'fixture' });
  out({ step: 1, status: 'done', remark: 'Opened start URL' });
  process.stdout.write('{"step": 2, "status": "runn');
  process.kill(process.pid, 'SIGKILL');
}
if (state.mode === 'garbage') { // malformed lines around a valid stream
  process.stdout.write('\u001b[32mnot json at all\u001b[0m\n{"broken": \n\n');
}
if (state.mode === 'pass_no_evidence') {
  out({ type: 'stream_start', cli_version: 'fixture' });
  out({ type: 'run_end', status: 'passed', summary: 'claims a pass, wrote nothing' });
  process.exit(0);
}
if (state.mode === 'hang') { out({ type: 'stream_start' }); setTimeout(() => {}, 600000); }
else {
  const fails = (state.failWhen || []).some((s) => objective.includes(s));
  const sessionDir = path.join(process.cwd(), 'session');
  fs.mkdirSync(path.join(sessionDir, 'evidence'), { recursive: true });
  // 1x1 PNG
  fs.writeFileSync(path.join(sessionDir, 'evidence', 'step-1.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  fs.writeFileSync(path.join(sessionDir, 'run.log'), 'fixture log\n');
  out({ type: 'stream_start', cli_version: 'fixture' });
  out({ step: 1, status: 'done', remark: 'Opened start URL' });
  if (args.includes('--access-key')) out({ type: 'raw_echo', leaked: args[args.indexOf('--access-key') + 1] });
  if (fails) {
    out({ step: 2, status: 'failed', remark: 'Order total shows $80.00, expected $72.00' });
    out({ type: 'run_end', status: 'failed', summary: 'Assertion failed: total was $80.00', reason: 'Expected outcome not observed', session_dir: sessionDir, credits_consumed: 3 });
    process.exit(1);
  }
  out({ step: 2, status: 'done', remark: 'Outcome verified' });
  out({ type: 'run_end', status: 'passed', summary: 'All checks passed', session_dir: sessionDir, credits_consumed: 3,
    test_url: 'https://example.invalid/fixture-test-case' });
  process.exit(state.exitOverride ?? 0);
}
