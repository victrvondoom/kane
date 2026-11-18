// Agent completion gate: spec validation, protected files, fingerprints, decision rules, Claude Code hook
// protocol, settings install/uninstall safety, and Stop-hook runs through the real Kane adapter.
// Engine used here: tests/fixtures/fake-kane.js — a TEST-ONLY stand-in (it identifies itself as a fixture and
// its results are never Kane evidence). The one live check is opt-in (SHIPPROOF_LIVE_KANE=1) and spends no credits.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateSpec, loadSpec, isProtected, globToRegExp, TEMPLATE, SpecError } from '../server/agentgate/spec.js';
import { scanTree, partition, diffMaps, diffIsEmpty } from '../server/agentgate/fingerprint.js';
import { evaluateStop, impactedCriteria, isRelevantPath } from '../server/agentgate/gate.js';
import { handleHook } from '../server/agentgate/hooks.js';
import { installHooks, uninstallHooks, hookStatus, MARKER } from '../server/agentgate/settings.js';
import { verifyCriteria } from '../server/agentgate/verify.js';
import { kaneStatus, kaneConfig } from '../server/kane.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const FIXTURE = path.join(root, 'tests', 'fixtures', 'fake-kane.js');
const CLI = path.join(root, 'cli', 'shipproof.js');

function project(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipproof-gate-'));
  const spec = { ...JSON.parse(JSON.stringify(TEMPLATE)), criteria: [
    { id: 'AC-001', text: 'The checkout total applies the coupon discount.', paths: ['src/**'] },
    { id: 'AC-002', text: 'The product page shows the price in dollars.', paths: ['public/**'] },
  ] };
  const all = { '.shipproof/criteria.json': JSON.stringify(spec, null, 2), 'src/pricing.js': 'export const total = 80;\n',
    'public/product.html': '<p>$80</p>\n', 'README.md': '# demo\n', ...files };
  for (const [rel, body] of Object.entries(all)) writeIn(dir, rel, body);
  return dir;
}

async function withFixture(state, fn) {
  const stateFile = path.join(os.tmpdir(), `fake-kane-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const saved = { bin: process.env.KANE_CLI_BIN, st: process.env.FAKE_KANE_STATE, user: process.env.LT_USERNAME, key: process.env.LT_ACCESS_KEY };
  process.env.KANE_CLI_BIN = FIXTURE;
  process.env.FAKE_KANE_STATE = stateFile;
  delete process.env.LT_USERNAME; delete process.env.LT_ACCESS_KEY;
  try {
    return await fn(stateFile);
  } finally {
    for (const [k, v] of [['KANE_CLI_BIN', saved.bin], ['FAKE_KANE_STATE', saved.st], ['LT_USERNAME', saved.user], ['LT_ACCESS_KEY', saved.key]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(stateFile, { force: true });
  }
}
const setFixture = (file, state) => fs.writeFileSync(file, JSON.stringify(state));
const runsIn = (dir) => fs.existsSync(path.join(dir, '.shipproof', 'runs')) ? fs.readdirSync(path.join(dir, '.shipproof', 'runs')) : [];
function writeIn(dir, rel, body) { const abs = path.join(dir, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, body); }

// ---------- spec ----------

test('spec: glob semantics and default protection', () => {
  assert.ok(globToRegExp('src/**').test('src/a/b.js'));
  assert.ok(!globToRegExp('src/*').test('src/a/b.js'));
  assert.ok(globToRegExp('a?c.js').test('abc.js'));
  assert.ok(isProtected('.shipproof/criteria.json'));
  assert.ok(isProtected('.claude/settings.local.json'));
  assert.ok(isProtected('.github/workflows/ci.yml'));
  assert.ok(!isProtected('src/pricing.js'));
  assert.ok(isProtected('secrets/key.txt', { protected: ['secrets/**'] }));
});

test('spec: invalid specifications are rejected with a precise reason', () => {
  const base = () => JSON.parse(JSON.stringify(TEMPLATE));
  const cases = [
    [(s) => { s.app.url = 'ftp://x'; }, /http or https/],
    [(s) => { s.app.url = 'not a url'; }, /absolute http/],
    [(s) => { s.criteria = []; }, /non-empty/],
    [(s) => { s.criteria.push({ ...s.criteria[0] }); }, /duplicate criterion id/],
    [(s) => { s.criteria[0].id = 'bad id!'; }, /must match/],
    [(s) => { s.criteria[0].text = 'hi'; }, /5-1000/],
    [(s) => { s.version = 2; }, /version/],
  ];
  for (const [mutate, re] of cases) {
    const s = base(); mutate(s);
    assert.throws(() => validateSpec(s), (e) => e instanceof SpecError && re.test(e.message), re.toString());
  }
  assert.doesNotThrow(() => validateSpec(base()));
});

test('spec: a broken criteria.json is an error, never silently treated as absent', () => {
  const dir = project({ '.shipproof/criteria.json': '{ not json' });
  assert.throws(() => loadSpec(dir), /not valid JSON/);
});

// ---------- fingerprints ----------

test('fingerprints: deterministic, ignore runtime and dependency folders, and detect every kind of change', () => {
  const dir = project({ 'node_modules/x/index.js': 'x', '.shipproof/runs/r1/out.json': '{}' });
  const spec = loadSpec(dir);
  const a = scanTree(dir);
  assert.ok(![...a.keys()].some((k) => k.startsWith('node_modules/') || k.startsWith('.shipproof/runs/')));
  assert.equal(scanTree(dir).get('src/pricing.js'), a.get('src/pricing.js'));
  const before = partition(a, spec);
  writeIn(dir, 'src/pricing.js', 'export const total = 72;\n');
  writeIn(dir, 'src/new.js', 'export {};\n');
  fs.rmSync(path.join(dir, 'public', 'product.html'));
  const d = diffMaps(before.sourceMap, partition(scanTree(dir), spec).sourceMap);
  assert.deepEqual(d.changed, ['src/pricing.js']);
  assert.deepEqual(d.added, ['src/new.js']);
  assert.deepEqual(d.removed, ['public/product.html']);
  assert.ok(!diffIsEmpty(d));
});

test('relevance: documentation, images and lock files never count as application change', () => {
  assert.equal(isRelevantPath('README.md'), false);
  assert.equal(isRelevantPath('docs/logo.png'), false);
  assert.equal(isRelevantPath('package-lock.json'), true, 'lockfiles are not in the ignore list only when they are .lock');
  assert.equal(isRelevantPath('src/pricing.js'), true);
});

test('impact: changed files select mapped criteria; unmapped changes conservatively select all', () => {
  const spec = validateSpec(JSON.parse(fs.readFileSync(path.join(project(), '.shipproof', 'criteria.json'), 'utf8')));
  assert.deepEqual(impactedCriteria(spec, ['src/pricing.js']).ids, ['AC-001']);
  assert.deepEqual(impactedCriteria(spec, ['public/product.html']).ids, ['AC-002']);
  const all = impactedCriteria(spec, ['server/unknown.js']);
  assert.equal(all.mode, 'all');
  assert.deepEqual(all.ids, ['AC-001', 'AC-002']);
});

// ---------- decision rules (pure) ----------

const pass = { id: 'AC-001', text: 't', status: 'passed', errorKind: null, reason: null };
const fail = { id: 'AC-001', text: 'The checkout total applies the coupon discount.', status: 'failed', reason: 'Expected outcome not observed',
  failingStep: { step: 2, remark: 'Order total shows $80.00, expected $72.00' }, evidenceDir: '.shipproof/runs/r/evidence' };
const authErr = { id: 'AC-001', text: 't', status: 'not_run', errorKind: 'auth', reason: 'Kane CLI is not authenticated.' };

test('decision: every path of the completion rule', () => {
  assert.equal(evaluateStop({ hasBaseline: false }).decision, 'block');
  assert.equal(evaluateStop({ hasBaseline: false }).code, 'NO_BASELINE');
  assert.equal(evaluateStop({ specError: 'bad json' }).code, 'SPEC_INVALID');
  assert.equal(evaluateStop({ hasSpec: false, sourceChanged: true }).code, 'NO_SPEC');
  const p = evaluateStop({ protectedChanged: ['.shipproof/criteria.json'], sourceChanged: true, results: [pass] });
  assert.equal(p.code, 'PROTECTED_MODIFIED'); assert.match(p.message, /criteria\.json/);
  assert.equal(evaluateStop({ sourceChanged: false }).decision, 'allow');
  const f = evaluateStop({ sourceChanged: true, results: [fail] });
  assert.equal(f.code, 'CRITERIA_FAILED'); assert.equal(f.decision, 'block');
  assert.match(f.message, /Failing step 2/); assert.match(f.message, /\$72\.00/); assert.match(f.message, /Evidence/);
  const e = evaluateStop({ sourceChanged: true, results: [authErr] });
  assert.equal(e.code, 'VERIFICATION_INCOMPLETE'); assert.equal(e.decision, 'block');
  assert.match(e.message, /environment problem, not a defect/);
  assert.equal(evaluateStop({ sourceChanged: true, results: [pass] }).code, 'VERIFIED');
});

test('decision: an unverified outcome is never allowed as a pass', () => {
  for (const status of ['error', 'timeout', 'cancelled', 'not_run']) {
    const d = evaluateStop({ sourceChanged: true, results: [{ id: 'AC-001', status, errorKind: 'x', reason: 'r' }] });
    assert.notEqual(d.decision, 'allow', status);
  }
});

test('decision: blocking is bounded; the stop then becomes an explicit NOT VERIFIED record', () => {
  const d = evaluateStop({ sourceChanged: true, results: [fail], blocks: 3, maxBlocks: 3 });
  assert.equal(d.decision, 'needs_human');
  assert.match(d.message, /^NOT VERIFIED/);
  assert.equal(evaluateStop({ sourceChanged: true, results: [fail], blocks: 2, maxBlocks: 3 }).decision, 'block');
});

// ---------- Claude Code hook protocol ----------

test('PreToolUse: editing a protected file is denied with the documented JSON; source edits are allowed', async () => {
  const dir = project();
  const deny = await handleHook('PreToolUse', { cwd: dir, tool_name: 'Edit', tool_input: { file_path: path.join(dir, '.shipproof', 'criteria.json') } });
  assert.equal(deny.exitCode, 0);
  const body = JSON.parse(deny.stdout);
  assert.equal(body.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(body.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(body.hookSpecificOutput.permissionDecisionReason, /protected/);
  const claude = await handleHook('PreToolUse', { cwd: dir, tool_name: 'Write', tool_input: { file_path: '.claude/settings.local.json' } });
  assert.equal(JSON.parse(claude.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const ok = await handleHook('PreToolUse', { cwd: dir, tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src', 'pricing.js') } });
  assert.equal(ok.stdout, '');
  assert.equal(ok.exitCode, 0);
  const notEdit = await handleHook('PreToolUse', { cwd: dir, tool_name: 'Bash', tool_input: { command: 'echo x > .shipproof/criteria.json' } });
  assert.equal(notEdit.stdout, '');
});

test('Stop without a turn baseline fails closed (the gate is not armed)', async () => {
  const dir = project();
  const r = await handleHook('Stop', { cwd: dir, session_id: 'never-started' });
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /NO_BASELINE/);
});

test('Stop: protected edits made through Bash are caught at completion without running Kane', async () => {
  await withFixture({ mode: 'pass' }, async () => {
    const dir = project();
    await handleHook('UserPromptSubmit', { cwd: dir, session_id: 's-protect' });
    writeIn(dir, '.shipproof/criteria.json', JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(dir, '.shipproof', 'criteria.json'), 'utf8')), criteria: [] }));
    const r = await handleHook('Stop', { cwd: dir, session_id: 's-protect' });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /PROTECTED_MODIFIED/);
    assert.deepEqual(runsIn(dir), [], 'no Kane run may be started for a tampered specification');
  });
});

test('Stop: a turn with only documentation changes is allowed without any verification', async () => {
  await withFixture({ mode: 'pass' }, async () => {
    const dir = project();
    await handleHook('UserPromptSubmit', { cwd: dir, session_id: 's-noop' });
    writeIn(dir, 'README.md', '# changed docs only\n');
    const r = await handleHook('Stop', { cwd: dir, session_id: 's-noop' });
    assert.equal(r.exitCode, 0);
    assert.deepEqual(runsIn(dir), []);
  });
});

test('Stop end to end: failure blocks with evidence, the repaired code passes, and an unchanged pass is reused', async () => {
  await withFixture({ mode: 'run', failWhen: ['coupon'] }, async (stateFile) => {
    const dir = project();
    await handleHook('UserPromptSubmit', { cwd: dir, session_id: 's-e2e' });
    writeIn(dir, 'src/pricing.js', 'export const total = 80; // coupon not applied\n');

    const first = await handleHook('Stop', { cwd: dir, session_id: 's-e2e' });
    assert.equal(first.exitCode, 2, first.stderr);
    assert.match(first.stderr, /CRITERIA_FAILED/);
    assert.match(first.stderr, /AC-001 FAILED/);
    assert.match(first.stderr, /Order total shows \$80\.00/);
    assert.equal(runsIn(dir).length, 1, 'one real Kane execution for the impacted criterion');
    const runDir = path.join(dir, '.shipproof', 'runs', runsIn(dir)[0]);
    assert.ok(fs.existsSync(path.join(runDir, 'evidence')), 'failure evidence is preserved');

    // The agent repairs the application. The same, unchanged criterion must now pass.
    writeIn(dir, 'src/pricing.js', 'export const total = 72;\n');
    setFixture(stateFile, { mode: 'run', failWhen: [] });
    const second = await handleHook('Stop', { cwd: dir, session_id: 's-e2e' });
    assert.equal(second.exitCode, 0, second.stderr);
    assert.match(second.stderr, /Verified: AC-001/);
    assert.equal(runsIn(dir).length, 2);
    const cache = JSON.parse(fs.readFileSync(path.join(dir, '.shipproof', 'state', 'verification-cache.json'), 'utf8'));
    assert.ok(cache['AC-001'], 'the pass is cached against its source scope');

    // New turn, only documentation changed: nothing is re-verified and no browser run is spent.
    await handleHook('UserPromptSubmit', { cwd: dir, session_id: 's-e2e' });
    writeIn(dir, 'README.md', '# docs\n');
    const third = await handleHook('Stop', { cwd: dir, session_id: 's-e2e' });
    assert.equal(third.exitCode, 0);
    assert.equal(runsIn(dir).length, 2, 'no new Kane run');
  });
});

test('Stop: repeated failures are bounded, then escalated as NOT VERIFIED and not re-run in the same turn', async () => {
  await withFixture({ mode: 'run', failWhen: ['coupon'] }, async () => {
    const dir = project();
    await handleHook('UserPromptSubmit', { cwd: dir, session_id: 's-bound' });
    writeIn(dir, 'src/pricing.js', 'export const total = 80; // coupon ignored\n');
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await handleHook('Stop', { cwd: dir, session_id: 's-bound' })).exitCode);
    assert.deepEqual(codes, [2, 2, 2]);
    const fourth = await handleHook('Stop', { cwd: dir, session_id: 's-bound' });
    assert.equal(fourth.exitCode, 0);
    assert.match(fourth.stderr, /NEEDS_HUMAN|NOT VERIFIED/);
    const runsBefore = runsIn(dir).length;
    const fifth = await handleHook('Stop', { cwd: dir, session_id: 's-bound' });
    assert.equal(fifth.exitCode, 0);
    assert.equal(runsIn(dir).length, runsBefore, 'escalated turns do not re-run Kane');
    // A new user turn starts a fresh budget: a new change is blocked again, counted as attempt 1.
    await handleHook('UserPromptSubmit', { cwd: dir, session_id: 's-bound' });
    writeIn(dir, 'src/pricing.js', 'export const total = 80; // still broken\n');
    const again = await handleHook('Stop', { cwd: dir, session_id: 's-bound' });
    assert.equal(again.exitCode, 2);
    assert.match(again.stderr, /attempt 1 of 3/);
  });
});

test('Stop: an unauthenticated Kane is reported as unverified, never as a defect and never as a pass', async () => {
  await withFixture({ mode: 'unauthenticated' }, async () => {
    const dir = project();
    await handleHook('UserPromptSubmit', { cwd: dir, session_id: 's-auth' });
    writeIn(dir, 'src/pricing.js', 'export const total = 72;\n');
    const r = await handleHook('Stop', { cwd: dir, session_id: 's-auth' });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /VERIFICATION_INCOMPLETE/);
    assert.match(r.stderr, /auth/);
    assert.doesNotMatch(r.stderr, /CRITERIA_FAILED/);
  });
});

test('verification: a pass with no evidence is treated as unverified', async () => {
  await withFixture({ mode: 'pass_no_evidence' }, async () => {
    const dir = project();
    const spec = loadSpec(dir);
    const sourceMap = partition(scanTree(dir), spec).sourceMap;
    const res = await verifyCriteria({ spec, cwd: dir, sourceMap, runsRoot: path.join(dir, '.shipproof', 'runs'), cache: {}, ids: ['AC-001'], config: kaneConfig() });
    assert.equal(res.results[0].status, 'error');
    assert.equal(res.results[0].errorKind, 'missing_evidence');
  });
});

test('Stop: a crashed Kane run (no run_end) never passes the gate', async () => {
  await withFixture({ mode: 'crash' }, async () => {
    const dir = project();
    await handleHook('UserPromptSubmit', { cwd: dir, session_id: 's-crash' });
    writeIn(dir, 'src/pricing.js', 'export const total = 1;\n');
    const r = await handleHook('Stop', { cwd: dir, session_id: 's-crash' });
    assert.equal(r.exitCode, 2);
  });
});

// ---------- settings installer ----------

test('settings: install preserves unrelated configuration, backs up, is idempotent, and uninstall restores the rest', () => {
  const dir = project();
  const file = path.join(dir, '.claude', 'settings.local.json');
  const original = {
    permissions: { allow: ['Bash(npm test)'] },
    env: { FOO: 'bar' },
    hooks: { Notification: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }] },
  };
  writeIn(dir, '.claude/settings.local.json', JSON.stringify(original, null, 2));
  const r1 = installHooks(dir, { cliPath: CLI });
  assert.equal(r1.changed, true);
  assert.ok(r1.backup && fs.existsSync(r1.backup), 'previous settings backed up');
  const installed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(installed.permissions, original.permissions);
  assert.equal(installed.env.FOO, 'bar');
  assert.equal(installed.hooks.Notification[0].hooks[0].command, 'echo user-hook');
  for (const ev of ['UserPromptSubmit', 'PreToolUse', 'Stop']) assert.ok(installed.hooks[ev].some((g) => g.hooks.some((h) => h.command.includes(MARKER))), ev);
  const r2 = installHooks(dir, { cliPath: CLI });
  assert.equal(r2.changed, false, 'second install changes nothing');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.Stop.length, 1, 'no duplicate hooks');
  assert.ok(Object.values(hookStatus(dir).local.installed).every(Boolean));

  const u = uninstallHooks(dir);
  assert.equal(u.removed, 3);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(after, original, 'uninstall returns exactly the user configuration');
});

test('settings: an invalid settings file is refused and left untouched', () => {
  const dir = project();
  writeIn(dir, '.claude/settings.local.json', '{ "hooks": ');
  assert.throws(() => installHooks(dir, { cliPath: CLI }), /not valid JSON/);
  assert.equal(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8'), '{ "hooks": ');
});

// ---------- CLI ----------

function cli(cwd, ...argv) {
  return spawnSync(process.execPath, [CLI, ...argv], { cwd, encoding: 'utf8', env: { ...process.env, KANE_CLI_BIN: FIXTURE, FAKE_KANE_STATE: '' } });
}

test('CLI: init creates a valid spec and ignore rules; a second init refuses to overwrite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipproof-cli-'));
  const r = cli(dir, 'init', '--url', 'http://127.0.0.1:4100/');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(loadSpec(dir));
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /\.shipproof\/state\//);
  const again = cli(dir, 'init');
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists/);
});

test('CLI: unknown commands and invalid specs have distinct exit codes', () => {
  const dir = project({ '.shipproof/criteria.json': '{}' });
  assert.equal(cli(dir, 'nope').status, 64);
  assert.equal(cli(dir, 'verify').status, 3);
  assert.match(cli(dir, 'verify').stderr, /Invalid/);
});

test('CLI: hook install and uninstall through the command line', () => {
  const dir = project();
  const ins = cli(dir, 'hook', 'install');
  assert.equal(ins.status, 0, ins.stderr);
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'settings.local.json')));
  const st = JSON.parse(cli(dir, 'hook', 'status').stdout);
  assert.ok(Object.values(st.local.installed).every(Boolean));
  assert.equal(cli(dir, 'hook', 'uninstall').status, 0);
});

// ---------- live engine check (opt-in, spends no credits) ----------

test('live: the installed kane-cli is never reported as passing when it cannot run', { skip: process.env.SHIPPROOF_LIVE_KANE !== '1' && 'set SHIPPROOF_LIVE_KANE=1 to check the installed kane-cli' }, async () => {
  const savedBin = process.env.KANE_CLI_BIN;
  delete process.env.KANE_CLI_BIN;
  try {
    const cfg = kaneConfig();
    const st = await kaneStatus(cfg, { fresh: true });
    const dir = project();
    const spec = loadSpec(dir);
    const res = await verifyCriteria({ spec, cwd: dir, sourceMap: partition(scanTree(dir), spec).sourceMap, runsRoot: path.join(dir, '.shipproof', 'runs'), cache: {}, ids: ['AC-001'], config: cfg });
    if (!st.ready) assert.notEqual(res.results[0].status, 'passed', `engine state ${st.state} must not produce a pass`);
    assert.ok(['passed', 'failed', 'error', 'timeout', 'cancelled', 'not_run'].includes(res.results[0].status));
  } finally {
    if (savedBin !== undefined) process.env.KANE_CLI_BIN = savedBin;
  }
});
