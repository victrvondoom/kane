// Measured engine availability. Every status shown in the UI comes from here, never from a literal:
// each Python engine is probed by importing what its worker imports, with the same interpreter the worker uses.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePython } from './engine-worker.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TTL_MS = 60_000;

// What each worker needs at import time (mirrors the try/import blocks in server/*-worker.py).
export const ENGINES = {
  gatekeeper: { label: 'Gatekeeper', what: 'supply-chain audit', path: 'gatekeeper-main/src', code: 'import gatekeeper.audit, gatekeeper.guard.core' },
  playtest: { label: 'Playtest', what: 'replay judge', path: 'playtest-agent-main', code: 'import pt.judge, PIL' },
  oqed: { label: 'OQED', what: 'native superoptimizer', path: 'oqed-main/src', code: 'import oqed', platform: 'linux-x64' },
  sae: { label: 'SAE Lab', what: 'interpretability engine', path: 'server/sae', code: 'import sae_engine' },
};

let cache = null;

function probe(engine, spec) {
  const started = Date.now();
  if (spec.platform === 'linux-x64' && !(process.platform === 'linux' && process.arch === 'x64')) {
    return Promise.resolve({ engine, label: spec.label, what: spec.what, state: 'unsupported', ms: 0,
      detail: `requires Linux x86-64; this server is ${process.platform}-${process.arch}` });
  }
  const python = resolvePython(engine);
  const script = `import sys; sys.path.insert(0, ${JSON.stringify(path.join(ROOT, spec.path))}); ${spec.code}; print(sys.version.split()[0])`;
  return new Promise((resolve) => {
    execFile(python, ['-c', script], { timeout: 8000, cwd: ROOT }, (err, stdout, stderr) => {
      const ms = Date.now() - started;
      if (!err) return resolve({ engine, label: spec.label, what: spec.what, state: 'ready', ms, detail: `Python ${stdout.trim()}` });
      const last = String(stderr || err.message).trim().split('\n').pop().slice(0, 200);
      const detail = err.code === 'ENOENT' ? `Python interpreter not found (${python})`
        : err.killed ? 'import probe timed out' : `${last} — run npm run setup:engines`;
      resolve({ engine, label: spec.label, what: spec.what, state: 'unavailable', ms, detail });
    });
  });
}

/** Probe every engine (cached for a minute). `fresh` forces a re-probe. */
export async function engineHealth({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const list = await Promise.all(Object.entries(ENGINES).map(([k, spec]) => probe(k, spec)));
  const value = { checkedAt: new Date().toISOString(), engines: Object.fromEntries(list.map((e) => [e.engine, e])) };
  cache = { at: Date.now(), value };
  return value;
}
