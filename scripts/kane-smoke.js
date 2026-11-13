#!/usr/bin/env node
// Real Kane CLI smoke test. Run this on a machine that can reach TestMu AI and is signed in
// (`kane-cli login`, or LT_USERNAME / LT_ACCESS_KEY). It uses the same adapter as the server
// and prints exactly how SHIPPROOF would classify the run and which evidence files it found.
//   node scripts/kane-smoke.js [url] ["criterion text"]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runKane, classify, collectEvidence, buildObjective, kaneConfig, kaneStatus } from '../server/kane.js';

const url = process.argv[2] || 'https://example.com/';
const criterion = process.argv[3] || 'The page shows the heading "Example Domain".';
const config = kaneConfig();
const status = await kaneStatus(config, { fresh: true });
console.log('engine:', JSON.stringify({ state: status.state, version: status.version, auth: status.auth, detail: status.detail }));
if (status.state === 'test_fixture') { console.error('KANE_CLI_BIN points at a test stand-in. This script only means something with the real kane-cli.'); process.exit(2); }
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kane-smoke-'));
const outcome = await runKane({ objective: buildObjective({ appUrl: url, context: '', criterionText: criterion }), url, workDir: path.join(work, 'run'), config,
  onEvent: (e) => console.log(e.kind === 'kane' ? `  ${JSON.stringify(e.payload).slice(0, 220)}` : `  stderr: ${e.payload.text.trim().slice(0, 220)}`) });
const files = collectEvidence({ outcome, workDir: path.join(work, 'run'), destDir: path.join(work, 'evidence') });
const verdict = classify(outcome);
console.log('\nexit code :', outcome.exitCode, outcome.signal || '');
console.log('run_end   :', outcome.runEnd ? JSON.stringify({ status: outcome.runEnd.status, summary: outcome.runEnd.summary, session_dir: outcome.runEnd.session_dir, test_url: outcome.runEnd.test_url }) : 'none');
console.log('classified:', verdict.status, verdict.errorKind || '', verdict.reason || '');
console.log(`evidence  : ${files.length} file(s) copied to ${path.join(work, 'evidence')}`);
for (const f of files.slice(0, 20)) console.log(`  ${f.kind.padEnd(13)} ${f.name} (${f.size} B)`);
if (verdict.status === 'passed' && !files.length && !outcome.runEnd?.test_url)
  console.log('\nNOTE: pass without collected evidence. With REQUIRE_EVIDENCE=1 (default) the server records this as "no_evidence".\nPlease report the session_dir layout above so the collector can be adjusted.');
process.exit(verdict.status === 'passed' ? 0 : 1);
