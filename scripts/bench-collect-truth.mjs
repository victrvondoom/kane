// Measures GROUND TRUTH for the algorithm benchmarks by actually running the Node test suite.
//
// For every tests/*.test.js file it records:
//   - loaded:     server/ modules the run really executed (V8 precise coverage, NODE_V8_COVERAGE),
//                 including modules loaded by child processes the test spawned;
//   - durationMs: wall time of an UNINSTRUMENTED run of that file (coverage overhead excluded);
//   - passed:     per-file pass/fail of that run (used by fault localization).
//
// Output: benchmarks/algorithm-intelligence/truth.json. Nothing here is a claim about production
// regressions: it is execution truth for this repository's own suite.
//
//   node scripts/bench-collect-truth.mjs            # measure and write truth.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'benchmarks', 'algorithm-intelligence');

/** Test files that the benchmark treats as independent criteria. */
export function testFiles(dir = path.join(root, 'tests')) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => `tests/${f}`);
}

/** Parse NODE_V8_COVERAGE output: returns repo-relative server/ paths whose module body executed. */
export function loadedServerModules(coverageDir) {
  const loaded = new Set();
  if (!fs.existsSync(coverageDir)) return [];
  for (const f of fs.readdirSync(coverageDir).filter((x) => x.endsWith('.json'))) {
    const data = JSON.parse(fs.readFileSync(path.join(coverageDir, f), 'utf8'));
    for (const script of data.result || []) {
      if (!script.url?.startsWith('file://')) continue;
      const abs = fileURLToPath(script.url);
      const rel = path.relative(root, abs);
      if (rel.startsWith('..') || !rel.startsWith('server' + path.sep)) continue;
      // The module wrapper is functions[0]; its range count is the number of times the module ran.
      const moduleRun = (script.functions || []).find((fn) => fn.ranges?.length)?.ranges[0]?.count ?? 0;
      if (moduleRun > 0) loaded.add(rel.split(path.sep).join('/'));
    }
  }
  return [...loaded].sort();
}

// Failures caused by the environment (browser launch or navigation timeouts, refused connections, missing binaries)
// are INFRASTRUCTURE results: they say nothing about the application and are excluded from fault localization.
const INFRA = /TimeoutError|ECONNREFUSED|ERR_CONNECTION|net::ERR_|Executable doesn't exist|browserType\.launch|timed out|EADDRINUSE/;

/** Classifies each failing TAP subtest by its YAML error block. Returns { failing, infra } counts. */
export function classifyFailures(output) {
  const lines = output.split('\n');
  let failing = 0, infra = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*not ok \d+/.test(lines[i])) continue;
    failing++;
    const block = lines.slice(i, i + 40).join('\n');
    if (INFRA.test(block)) infra++;
  }
  return { failing, infra, applicationFailures: failing - infra };
}

function runTestFile(file, env = {}) {
  const started = process.hrtime.bigint();
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', file], {
    cwd: root, env: { ...process.env, LOG_LEVEL: 'silent', ...env }, encoding: 'utf8', timeout: 20 * 60 * 1000, maxBuffer: 64 * 1024 * 1024,
  });
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const pass = Number((out.match(/^# pass (\d+)/m) || [])[1] ?? 0), fail = Number((out.match(/^# fail (\d+)/m) || [])[1] ?? 0);
  const cls = classifyFailures(out);
  // A file "passed" when the process exited cleanly. An infra-only failure is not a passing run, but it is not an
  // application failure either: it is recorded as `infra` so the spectrum can exclude it.
  const infraOnly = r.status !== 0 && cls.failing > 0 && cls.applicationFailures === 0;
  return { exitCode: r.status, durationMs: Math.round(durationMs), pass, fail, passed: r.status === 0 && fail === 0, infra: infraOnly, classes: cls };
}

export function collect() {
  fs.mkdirSync(outDir, { recursive: true });
  const files = {};
  for (const file of testFiles()) {
    const covDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cov-'));
    const instrumented = runTestFile(file, { NODE_V8_COVERAGE: covDir });
    const loaded = loadedServerModules(covDir);
    fs.rmSync(covDir, { recursive: true, force: true });
    // Second, uninstrumented run gives the cost of the test as a real CI job would pay it.
    const timed = runTestFile(file);
    // The uninstrumented run defines the baseline outcome and cost; the instrumented run defines what was loaded.
    files[file] = { loaded, durationMs: timed.durationMs, passed: timed.passed, infra: timed.infra, pass: timed.pass, fail: timed.fail,
      exitCode: timed.exitCode, failureClasses: timed.classes, instrumentedPassed: instrumented.passed, instrumentedInfra: instrumented.infra };
    const status = timed.passed ? 'pass' : timed.infra ? 'INFRA-FAIL' : 'FAIL';
    process.stderr.write(`${file}: ${loaded.length} server modules, ${timed.durationMs} ms, ${status}\n`);
  }
  const truth = { schema: 'shipproof.bench.truth/v1', generatedAt: new Date().toISOString(), node: process.version,
    kind: 'execution truth for this repository\'s Node test suite (synthetic-free, repository-derived)', files };
  fs.writeFileSync(path.join(outDir, 'truth.json'), JSON.stringify(truth, null, 1));
  return truth;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) collect();
