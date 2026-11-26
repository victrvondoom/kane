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
  console.log(`${dir}: ${r.status === 0 ? 'ready' : 'FAILED'}`);
  if (r.status !== 0) failed++;
}
process.exit(failed ? 1 : 0);
