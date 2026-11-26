#!/usr/bin/env node
// Creates each Python engine's own virtualenv with uv, so workers stop depending on the system Python.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const engines = ['gatekeeper-main', 'playtest-agent-main'];
if (process.platform === 'linux' && process.arch === 'x64') engines.push('oqed-main');
let failed = 0;
for (const dir of engines) {
  if (!fs.existsSync(path.join(root, dir, 'pyproject.toml'))) continue;
  const r = spawnSync('uv', ['sync', '--frozen'], { cwd: path.join(root, dir), stdio: 'inherit', shell: false });
  if (r.error) { console.error(`uv not found (${r.error.message}). Install uv: https://docs.astral.sh/uv/`); process.exit(2); }
  let ok = r.status === 0;
  // Some engines (playtest-agent-main) list their packages in requirements.txt rather than pyproject.toml.
  if (ok && fs.existsSync(path.join(root, dir, 'requirements.txt'))) {
    const q = spawnSync('uv', ['pip', 'install', '-r', 'requirements.txt'], { cwd: path.join(root, dir), stdio: 'inherit', shell: false });
    ok = q.status === 0;
  }
  r.status = ok ? 0 : 1;
  console.log(`${dir}: ${ok ? 'ready' : 'FAILED'}`);
  if (r.status !== 0) failed++;
}
process.exit(failed ? 1 : 0);
