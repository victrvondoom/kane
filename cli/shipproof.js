#!/usr/bin/env node
// SHIPPROOF command line.
//   shipproof init [--url URL] [--force]        create .shipproof/criteria.json and ignore rules
//   shipproof doctor                             check Node, Kane CLI, credentials, spec, target and hooks
//   shipproof verify [--criterion ID]... [--fresh] [--max-runs N] [--json]
//   shipproof watch [--debounce MS]              re-verify impacted criteria when application files change
//   shipproof hook install|uninstall|status [--shared]
//   shipproof hook run <Event>                   internal: invoked by Claude Code with the hook JSON on stdin
// Exit codes: 0 verified / success · 1 an acceptance criterion failed · 2 unverified (environment or
// incomplete) · 3 invalid specification · 64 usage error.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const { loadSpec, SpecError, SPEC_RELATIVE, TEMPLATE, validateSpec } = await import('../server/agentgate/spec.js');
const { scanTree, partition } = await import('../server/agentgate/fingerprint.js');
const { verifyCriteria, isUnresolved } = await import('../server/agentgate/verify.js');
const { impactedCriteria } = await import('../server/agentgate/gate.js');
const { loadCache, saveCache, runsRootOf } = await import('../server/agentgate/state.js');
const { handleHook } = await import('../server/agentgate/hooks.js');
const { installHooks, uninstallHooks, hookStatus } = await import('../server/agentgate/settings.js');
const { kaneConfig, kaneStatus } = await import('../server/kane.js');
const { loadTenantConfig, resolveCredentials, TenantConfigError, CONFIG_RELATIVE } = await import('../server/tenantseal/config.js');
const { runTenantScan, prepareEngine } = await import('../server/tenantseal/scan.js');

// Same minimal .env loader as server/index.js: real environment variables win; values are never printed.
function loadEnv(dir) {
  const file = path.join(dir, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const args = process.argv.slice(2);
const cwd = process.cwd();
loadEnv(cwd);
if (cwd !== ROOT) loadEnv(ROOT);

const flag = (name) => args.includes(name);
const opt = (name, dflt = null) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; };
const multi = (name) => args.flatMap((a, i) => (a === name && args[i + 1] !== undefined ? [args[i + 1]] : []));
const out = (s = '') => process.stdout.write(s + '\n');
const err = (s = '') => process.stderr.write(s + '\n');

function requireSpec() {
  try {
    const spec = loadSpec(cwd);
    if (!spec) { err(`No ${SPEC_RELATIVE} in ${cwd}. Run \`shipproof init\` first.`); process.exitCode = 3; return null; }
    return spec;
  } catch (e) {
    err(e instanceof SpecError ? `Invalid ${SPEC_RELATIVE}: ${e.message}` : e.message);
    process.exitCode = 3;
    return null;
  }
}

function cmdInit() {
  const file = path.join(cwd, SPEC_RELATIVE);
  if (fs.existsSync(file) && !flag('--force')) { err(`${SPEC_RELATIVE} already exists. Use --force to replace it.`); process.exitCode = 1; return; }
  const template = JSON.parse(JSON.stringify(TEMPLATE));
  const url = opt('--url');
  if (url) template.app.url = url;
  validateSpec(template); // the template itself must be valid
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(template, null, 2) + '\n');
  fs.writeFileSync(path.join(cwd, '.shipproof', '.gitignore'), 'state/\nruns/\n');
  const ignore = path.join(cwd, '.gitignore');
  const want = ['.shipproof/state/', '.shipproof/runs/', '.claude/settings.local.json', '.claude/settings.local.json.shipproof-backup-*'];
  const have = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : '';
  const add = want.filter((w) => !have.split(/\r?\n/).includes(w));
  if (add.length) fs.appendFileSync(ignore, (have && !have.endsWith('\n') ? '\n' : '') + '# SHIPPROOF\n' + add.join('\n') + '\n');
  out(`Created ${SPEC_RELATIVE}. Edit the criteria so each one describes what the application must do.`);
  out(`Application target: ${template.app.url}`);
}

async function cmdDoctor() {
  const rows = [];
  const add = (level, name, detail) => rows.push({ level, name, detail });
  const major = Number(process.versions.node.split('.')[0]), minor = Number(process.versions.node.split('.')[1]);
  add(major > 22 || (major === 22 && minor >= 5) ? 'ok' : 'fail', 'node', `v${process.versions.node} (requires >= 22.5)`);
  const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
  add(git.status === 0 ? 'ok' : 'warn', 'git', git.status === 0 ? git.stdout.trim() : 'not found (only needed for git-based workflows)');
  const config = kaneConfig();
  const ks = await kaneStatus(config, { fresh: true });
  add(ks.state === 'ready' ? 'ok' : ks.state === 'test_fixture' ? 'warn' : 'fail', 'kane-cli',
    `${ks.installed ? 'v' + ks.version : 'not installed'} · state ${ks.state}. ${ks.detail}`);
  add(config.username && config.accessKey ? 'ok' : 'warn', 'credentials',
    config.username && config.accessKey ? 'LT_USERNAME and LT_ACCESS_KEY are set (values not shown)' : 'LT_USERNAME / LT_ACCESS_KEY not set; relies on `kane-cli login`');
  let spec = null;
  try { spec = loadSpec(cwd); add(spec ? 'ok' : 'fail', 'criteria', spec ? `${spec.criteria.length} criteria in ${SPEC_RELATIVE}` : `${SPEC_RELATIVE} missing (run shipproof init)`); }
  catch (e) { add('fail', 'criteria', e.message); }
  if (spec) {
    try {
      const res = await fetch(spec.app.url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(4000) });
      add('ok', 'target', `${spec.app.url} answered HTTP ${res.status}`);
    } catch (e) { add('fail', 'target', `${spec.app.url} is not reachable: ${e.cause?.code || e.message}`); }
  }
  const hs = hookStatus(cwd);
  const installed = Object.values(hs).some((s) => s.installed && typeof s.installed === 'object' && !s.installed.error && Object.values(s.installed).every(Boolean));
  add(installed ? 'ok' : 'warn', 'hooks', installed ? 'Claude Code hooks installed' : 'not installed (run `shipproof hook install`)');
  // Fixed arguments only; on Windows the claude.cmd shim is run through cmd.exe.
  const claude = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/c', 'claude --version'], { encoding: 'utf8', timeout: 15000 })
    : spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 15000 });
  add(claude.status === 0 ? 'ok' : 'warn', 'claude-code', claude.status === 0 ? claude.stdout.trim() : 'claude not found on PATH');
  for (const r of rows) out(`[${r.level.toUpperCase().padEnd(4)}] ${r.name.padEnd(12)} ${r.detail}`);
  process.exitCode = rows.some((r) => r.level === 'fail') ? 1 : 0;
}

async function cmdVerify() {
  const spec = requireSpec();
  if (!spec) return;
  const fresh = flag('--fresh');
  const ids = multi('--criterion');
  const unknown = ids.filter((id) => !spec.criteria.some((c) => c.id === id));
  if (unknown.length) { err(`Unknown criterion: ${unknown.join(', ')}`); process.exitCode = 64; return; }
  const sourceMap = partition(scanTree(cwd), spec).sourceMap;
  const cache = fresh ? {} : loadCache(cwd);
  const config = kaneConfig();
  const maxRuns = Math.max(1, Number(opt('--max-runs', 10)) || 10);
  const json = flag('--json');
  const res = await verifyCriteria({ spec, cwd, sourceMap, runsRoot: runsRootOf(cwd), cache, ids: ids.length ? ids : null, config, maxRuns,
    onProgress: (r) => { if (!json) out(`  ${r.id.padEnd(10)} ${r.status.padEnd(9)} ${r.reason && r.status !== 'passed' && r.status !== 'reused' ? r.reason : ''}`); } });
  if (!fresh) saveCache(cwd, cache);
  const failed = res.results.filter((r) => r.status === 'failed').length;
  const unresolved = res.results.filter(isUnresolved).length;
  const code = failed ? 1 : unresolved ? 2 : 0;
  if (json) out(JSON.stringify({ engine: res.engine, runs: res.runs, results: res.results, exitCode: code }, null, 2));
  else out(`\n${res.results.length} criteria · ${res.runs} Kane run(s) · engine ${res.engine} · ${failed} failed · ${unresolved} unverified`);
  process.exitCode = code;
}

async function cmdWatch() {
  const spec = requireSpec();
  if (!spec) return;
  const debounce = Math.max(200, Number(opt('--debounce', 2000)) || 2000);
  const ignoredDirs = /(^|[\\/])(node_modules|\.git|\.shipproof|\.claude|dist|coverage|data|\.venv|__pycache__|\.testmuai|target)([\\/]|$)/;
  const ignoredExt = /\.(md|txt|png|jpe?g|gif|svg|webp|map|log|lock)$/i;
  const pending = new Set();
  let timer = null, running = false, again = false;
  const log = (m) => out(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
  const currentSpec = () => { try { return loadSpec(cwd); } catch { return null; } };
  const runOnce = async () => {
    if (running) { again = true; return; }
    running = true;
    do {
      again = false;
      const changed = [...pending]; pending.clear();
      if (!changed.length) break;
      const current = currentSpec();
      if (!current) { log('criteria.json is missing or invalid; skipping this change'); break; }
      const impact = impactedCriteria(current, changed);
      log(`changed: ${changed.join(', ')} → ${impact.reason}`);
      const sourceMap = partition(scanTree(cwd), current).sourceMap;
      const cache = loadCache(cwd);
      const res = await verifyCriteria({ spec: current, cwd, sourceMap, runsRoot: runsRootOf(cwd), cache, ids: impact.ids, config: kaneConfig(),
        maxRuns: 10, onProgress: (r) => log(`  ${r.id} ${r.status}${r.reason && !['passed', 'reused'].includes(r.status) ? ': ' + r.reason : ''}`) });
      saveCache(cwd, cache);
      log(res.results.every((r) => ['passed', 'reused'].includes(r.status)) ? 'all impacted criteria verified' : 'impacted criteria NOT verified');
    } while (again);
    running = false;
  };
  log(`watching ${cwd} (debounce ${debounce} ms). Ctrl+C to stop.`);
  fs.watch(cwd, { recursive: true }, (_evt, name) => {
    if (!name) return;
    const rel = String(name).replace(/\\/g, '/');
    if (ignoredDirs.test(rel) || ignoredExt.test(rel)) return;
    pending.add(rel);
    clearTimeout(timer);
    timer = setTimeout(() => { runOnce().catch((e) => log(`watch error: ${e.message}`)); }, debounce);
  });
  await new Promise(() => {}); // runs until interrupted
}

async function cmdHook() {
  const sub = args[1];
  const shared = flag('--shared');
  if (sub === 'install') {
    const r = installHooks(cwd, { shared });
    out(r.changed ? `Installed SHIPPROOF hooks in ${r.file}` : `Hooks already up to date in ${r.file}`);
    if (r.backup) out(`Previous settings backed up to ${r.backup}`);
    out('Events: ' + r.added.join(', ') + '. Restart Claude Code (or open /hooks) so the change takes effect.');
  } else if (sub === 'uninstall') {
    const r = uninstallHooks(cwd, { shared });
    out(r.removed ? `Removed ${r.removed} SHIPPROOF hook(s) from ${r.file}. Other settings were kept.` : `No SHIPPROOF hooks found in ${r.file}`);
  } else if (sub === 'status') {
    out(JSON.stringify(hookStatus(cwd), null, 2));
  } else if (sub === 'run') {
    const event = args[2];
    let payload = {};
    try { const raw = fs.readFileSync(0, 'utf8'); if (raw.trim()) payload = JSON.parse(raw); } catch { payload = {}; }
    if (!payload.cwd) payload.cwd = cwd;
    const r = await handleHook(event, payload);
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr + '\n');
    process.exitCode = r.exitCode;
  } else {
    err('usage: shipproof hook install|uninstall|status [--shared] | shipproof hook run <Event>');
    process.exitCode = 64;
  }
}

// TenantSeal: cross-tenant isolation verification. Exit codes: 0 sealed (live or simulated) · 1 leaking ·
// 2 unverified or misconfigured.
async function cmdTenant() {
  const sub = args[1];
  const tfile = path.join(cwd, CONFIG_RELATIVE);
  if (sub === 'init') {
    if (fs.existsSync(tfile) && !flag('--force')) { err(`${CONFIG_RELATIVE} already exists. Use --force to replace it.`); process.exitCode = 1; return; }
    const template = JSON.parse(fs.readFileSync(path.join(ROOT, 'demo', 'tenant-boundary', 'tenantseal', 'config.json'), 'utf8'));
    const url = opt('--url'); if (url) template.target.url = url;
    template.app.sourceDir = '.';
    loadTenantConfig(cwd, tfile);
    fs.mkdirSync(path.dirname(tfile), { recursive: true });
    fs.writeFileSync(tfile, JSON.stringify(template, null, 2) + '\n');
    out(`Wrote ${CONFIG_RELATIVE} from the NoteVault template. Set the target URL, the persona identities and the passwordEnv names for YOUR application, and export those variables.`);
    return;
  }
  let config;
  try { config = loadTenantConfig(cwd); }
  catch (e) { err(e instanceof TenantConfigError ? `Invalid ${CONFIG_RELATIVE}: ${e.message}` : e.message); process.exitCode = 2; return; }
  if (!config) { err(`No ${CONFIG_RELATIVE} in ${cwd}. Run \`shipproof tenant init\` first.`); process.exitCode = 2; return; }
  if (sub === 'doctor') {
    const rows = [];
    rows.push(['config', 'ok', `${CONFIG_RELATIVE} valid; target ${config.target.origin}`]);
    for (const name of ['owner', 'second']) {
      const set = !!process.env[config.personas[name].passwordEnv];
      rows.push([`persona ${name}`, set ? 'ok' : 'fail', `${config.personas[name].identity} · ${config.personas[name].passwordEnv} ${set ? 'is set (value not shown)' : 'is NOT set'}`]);
    }
    try {
      const res = await fetch(config.target.url, { redirect: 'manual', signal: AbortSignal.timeout(4000) });
      rows.push(['target', 'ok', `answered HTTP ${res.status}`]);
    } catch (e) { rows.push(['target', 'fail', `not reachable: ${e.cause?.code || e.message}`]); }
    const eng = await prepareEngine('kane');
    rows.push(['kane-cli', eng.ok ? 'ok' : 'warn', eng.ok ? `ready (v${eng.status.version})` : eng.reason]);
    for (const r of rows) out(`[${r[1].toUpperCase().padEnd(4)}] ${r[0].padEnd(16)} ${r[2]}`);
    process.exitCode = rows.some((r) => r[1] === 'fail') ? 2 : 0;
    return;
  }
  if (sub === 'scan') {
    const engineKind = opt('--engine', 'kane');
    if (!['kane', 'simulated'].includes(engineKind)) { err('--engine must be kane or simulated'); process.exitCode = 64; return; }
    let creds;
    try { creds = resolveCredentials(config); } catch (e) { err(e.message); process.exitCode = 2; return; }
    const scan = await runTenantScan({ cwd, config, engineKind, credentials: creds });
    if (flag('--json')) { out(JSON.stringify(scan, null, 2)); }
    else {
      out(`${scan.verdict}${scan.engineKind === 'simulated' ? '  (SIMULATED: test fixture, not Kane evidence)' : ''}  release blocking: ${scan.releaseBlocking ? 'yes' : 'no'}`);
      for (const c of scan.checks || []) out(`  ${c.id.padEnd(48)} ${c.verdict}`);
      for (const r of scan.reasons || []) out(`  - ${r}`);
      out(`report: ${scan.report?.markdown ?? '(not written)'}`);
    }
    const code = { SEALED: 0, SIMULATED_SEALED: 0, LEAKING: 1 }[scan.verdict] ?? 2;
    process.exitCode = code;
    return;
  }
  if (sub === 'report') {
    const dir = path.join(cwd, '.tenantseal', 'scans');
    const ids = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
    const id = args[2] || ids.at(-1);
    if (!id || !fs.existsSync(path.join(dir, id, 'report.md'))) { err('no scan report found'); process.exitCode = 2; return; }
    out(fs.readFileSync(path.join(dir, id, 'report.md'), 'utf8'));
    return;
  }
  err('usage: shipproof tenant init [--url URL] [--force] | doctor | scan [--engine kane|simulated] [--json] | report [scanId]');
  process.exitCode = 64;
}

const USAGE = `shipproof — acceptance verification and agent completion gate for Kane CLI

  shipproof tenant init | doctor | scan [--engine kane|simulated] | report [scanId]

  shipproof init [--url URL] [--force]
  shipproof doctor
  shipproof verify [--criterion ID]... [--fresh] [--max-runs N] [--json]
  shipproof watch [--debounce MS]
  shipproof hook install|uninstall|status [--shared]

Exit codes: 0 verified · 1 failed · 2 unverified · 3 invalid spec · 64 usage`;

const cmd = args[0];
try {
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') out(USAGE);
  else if (cmd === 'init') cmdInit();
  else if (cmd === 'doctor') await cmdDoctor();
  else if (cmd === 'verify') await cmdVerify();
  else if (cmd === 'watch') await cmdWatch();
  else if (cmd === 'hook') await cmdHook();
  else if (cmd === 'tenant') await cmdTenant();
  else { err(`unknown command: ${cmd}\n\n${USAGE}`); process.exitCode = 64; }
} catch (e) {
  err(`shipproof: ${e.message}`);
  process.exitCode = 2;
}
