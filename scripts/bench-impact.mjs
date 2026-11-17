// Algorithm 1 benchmark: regression-detection recall vs. tests executed, against measured execution truth.
//
// Setup (repository-derived, not synthetic):
//   - Criteria    = each tests/*.test.js file. Its declared mapping is its DIRECT server imports (what a team
//                   would write by hand) plus itself.
//   - Changes     = each server/ module changed in isolation.
//   - Truth       = tests whose real run loaded the changed module (benchmarks/algorithm-intelligence/truth.json).
//   - Strategies  = full suite; direct mapping only; hybrid graph (unbounded); hybrid under 50% and 25% test budgets.
//   - Skipped     = changes that no test loads (no truth set, so recall is undefined).
//
// Writes benchmarks/algorithm-intelligence/impact.json and prints a summary table.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildImportGraph, selectTests } from '../server/impact-graph.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'benchmarks', 'algorithm-intelligence');
const truth = JSON.parse(fs.readFileSync(path.join(outDir, 'truth.json'), 'utf8'));

function listJs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJs(p));
    else if (/\.(c|m)?js$/.test(e.name)) out.push(path.relative(root, p).split(path.sep).join('/'));
  }
  return out.sort();
}

export function runBenchmark() {
  const files = [...listJs(path.join(root, 'server')), ...listJs(path.join(root, 'tests'))];
  const sources = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8')]));
  const t0 = process.hrtime.bigint();
  const graph = buildImportGraph(sources);
  const graphBuildMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const tests = Object.keys(truth.files).filter((t) => graph.files.has(t));
  const criteria = tests.map((t, i) => ({
    id: i + 1, key: t,
    paths: [t, ...[...(graph.deps.get(t) || [])].filter((d) => d.startsWith('server/'))].sort(),
    durationMs: truth.files[t].durationMs,
    history: undefined,
  }));
  const totalMs = criteria.reduce((a, c) => a + c.durationMs, 0);
  const N = criteria.length;

  const changes = Object.keys(sources).filter((f) => f.startsWith('server/'));
  const strategies = {
    full: () => criteria.map((c) => c.key),
    // mapping-only: the required (direct-match) set; a zero budget admits no transitive criteria
    direct: (changed) => selectTests({ changed: [changed], criteria, graph, budget: { maxTests: 0 } }).selected.map((s) => s.key),
    hybrid: (changed) => selectTests({ changed: [changed], criteria, graph }).selected.map((s) => s.key),
    hybrid_50: (changed) => selectTests({ changed: [changed], criteria, graph, budget: { maxTests: Math.ceil(N * 0.5) } }).selected.map((s) => s.key),
    hybrid_25: (changed) => selectTests({ changed: [changed], criteria, graph, budget: { maxTests: Math.ceil(N * 0.25) } }).selected.map((s) => s.key),
  };

  const rows = [];
  let skipped = 0;
  const timing = Object.fromEntries(Object.keys(strategies).map((k) => [k, 0]));
  for (const changed of changes) {
    const T = new Set(tests.filter((t) => truth.files[t].loaded.includes(changed)));
    if (!T.size) { skipped++; continue; }
    const row = { changed, truthCount: T.size, strategies: {} };
    for (const [name, fn] of Object.entries(strategies)) {
      const s0 = process.hrtime.bigint();
      const S = new Set(name === 'full' ? fn() : fn(changed));
      timing[name] += Number(process.hrtime.bigint() - s0) / 1e6;
      const hit = [...T].filter((t) => S.has(t)).length;
      const costMs = [...S].reduce((a, t) => a + (truth.files[t]?.durationMs || 0), 0);
      row.strategies[name] = { selected: S.size, recallHit: hit, recall: hit / T.size, missed: [...T].filter((t) => !S.has(t)),
        executedFraction: S.size / N, costFraction: costMs / totalMs, costMs };
    }
    rows.push(row);
  }

  const summary = {};
  for (const name of Object.keys(strategies)) {
    const rs = rows.map((r) => r.strategies[name]);
    const hits = rs.reduce((a, s) => a + s.recallHit, 0), truthTotal = rows.reduce((a, r) => a + r.truthCount, 0);
    summary[name] = {
      microRecall: hits / truthTotal,
      macroRecall: rs.reduce((a, s) => a + s.recall, 0) / rs.length,
      changesWithFullRecall: rs.filter((s) => s.recall === 1).length,
      meanExecutedFraction: rs.reduce((a, s) => a + s.executedFraction, 0) / rs.length,
      meanCostFraction: rs.reduce((a, s) => a + s.costFraction, 0) / rs.length,
      missedPairs: rs.reduce((a, s) => a + s.missed.length, 0),
      selectionMsTotal: Math.round(timing[name] * 1000) / 1000,
    };
  }
  const report = {
    schema: 'shipproof.bench.impact/v1', generatedAt: new Date().toISOString(), node: process.version,
    dataset: 'repository-derived: this repository\'s server/ modules and tests/ suite, execution truth from V8 coverage',
    criteria: N, changesMeasured: rows.length, changesSkipped: skipped, graph: { files: graph.files.size, unresolvedFiles: [...graph.unresolvedFiles], externalSpecifiers: graph.externalSpecifiers, buildMs: Math.round(graphBuildMs * 100) / 100 },
    notMeasured: ['historical failure ranking (no trustworthy outcome history exists in the repository)', 'learned ranking (no training data)', 'missed-regression severity (no severity labels for tests)'],
    summary, rows,
  };
  fs.writeFileSync(path.join(outDir, 'impact.json'), JSON.stringify(report, null, 1));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = runBenchmark();
  console.log(`criteria=${r.criteria} changes=${r.changesMeasured} skipped(no test loads)=${r.changesSkipped}`);
  console.log('strategy     microRecall  macroRecall  fullRecallChanges  executed  cost   missedPairs');
  for (const [k, s] of Object.entries(r.summary)) {
    console.log(`${k.padEnd(12)} ${s.microRecall.toFixed(3).padStart(11)} ${s.macroRecall.toFixed(3).padStart(12)} ${String(s.changesWithFullRecall + '/' + r.changesMeasured).padStart(18)} ${(s.meanExecutedFraction * 100).toFixed(1).padStart(7)}% ${(s.meanCostFraction * 100).toFixed(1).padStart(5)}% ${String(s.missedPairs).padStart(10)}`);
  }
}
