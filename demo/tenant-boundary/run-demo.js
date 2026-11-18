#!/usr/bin/env node
// TenantSeal demonstration: vulnerable NoteVault → LEAKING → repair patch → fresh canary → SIMULATED_SEALED.
// Runs in a throwaway workspace so the repository copy is never modified. The engine is the labelled test
// fixture (SIMULATED). Live Kane is used with `shipproof tenant scan --engine kane` once kane-cli is logged in.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const { loadTenantConfig } = await import(pathToFileURL(path.join(repoRoot, 'server', 'tenantseal', 'config.js')).href);
const { runTenantScan } = await import(pathToFileURL(path.join(repoRoot, 'server', 'tenantseal', 'scan.js')).href);

// Documented demo-only passwords for the NoteVault accounts. Real credentials are never stored in this repository.
process.env.TB_ALICE_PASSWORD ??= 'alice-demo-pass';
process.env.TB_BOB_PASSWORD ??= 'bob-demo-pass';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.unref();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function startApp(file, port, version) {
  const mod = await import(pathToFileURL(file).href + `?v=${version}`);
  const server = mod.createApp();
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}

const line = (s = '') => console.log(s);
const summarise = (label, scan, dir) => {
  line(`\n${label}: ${scan.verdict}  (release blocking: ${scan.releaseBlocking ? 'yes' : 'no'})`);
  for (const r of scan.reasons || []) line(`  - ${r}`);
  line(`  report: ${path.join(dir, '.tenantseal', 'scans', scan.scanId, 'report.md')}`);
};

async function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tenantseal-demo-'));
  const dir = path.join(workspace, 'demo', 'tenant-boundary');
  fs.mkdirSync(path.join(dir, '.tenantseal'), { recursive: true });
  fs.copyFileSync(path.join(here, 'app.js'), path.join(dir, 'app.js'));
  const port = await freePort();
  const cfg = JSON.parse(fs.readFileSync(path.join(here, 'tenantseal', 'config.json'), 'utf8'));
  cfg.target.url = `http://127.0.0.1:${port}/`;
  fs.writeFileSync(path.join(dir, '.tenantseal', 'config.json'), JSON.stringify(cfg, null, 2));

  line(`TenantSeal demo workspace: ${dir}`);
  line(`NoteVault listening on http://127.0.0.1:${port}/ (vulnerable build)`);
  let server = await startApp(path.join(dir, 'app.js'), port, 'before');
  try {
    const config = loadTenantConfig(dir);
    const before = await runTenantScan({ cwd: dir, config, engineKind: 'simulated' });
    summarise('FIRST SCAN (vulnerable build)', before, dir);

    line('\nApplying the repair (demo/tenant-boundary/fix.patch) to the workspace copy…');
    execFileSync('git', ['apply', '-p1', path.join(here, 'fix.patch')], { cwd: workspace, stdio: 'inherit' });
    await new Promise((resolve) => server.close(resolve));
    server = await startApp(path.join(dir, 'app.js'), port, 'after');
    line(`NoteVault restarted with the repaired source on port ${port}`);

    const after = await runTenantScan({ cwd: dir, config, engineKind: 'simulated' });
    summarise('SECOND SCAN (repaired build, fresh canary)', after, dir);

    const ok = before.verdict === 'LEAKING' && after.verdict === 'SIMULATED_SEALED';
    const summary = { workspace, before: { verdict: before.verdict, scanId: before.scanId }, after: { verdict: after.verdict, scanId: after.scanId }, ok };
    fs.writeFileSync(path.join(workspace, 'demo-summary.json'), JSON.stringify(summary, null, 2));
    line(`\nDemo result: ${ok ? 'OK (LEAKING → SIMULATED_SEALED)' : 'UNEXPECTED'} · summary: ${path.join(workspace, 'demo-summary.json')}`);
    process.exitCode = ok ? 0 : 1;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
