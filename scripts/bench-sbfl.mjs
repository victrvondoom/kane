// Algorithm 4 benchmark: does Ochiai rank the module that contains a seeded defect near the top?
//
// Method (repository-derived, seeded defects):
//   1. Spectrum = execution truth from benchmarks/algorithm-intelligence/truth.json: each test file is one execution,
//      its components are the server/ modules it really loaded, its outcome is the baseline outcome.
//   2. Mutants = small operator mutations (===/!==, >=/>, <=/<, &&/||, true/false) at seeded code sites inside one
//      server/ module each. Sites are found on comment- and string-masked code, so text in strings is never mutated.
//   3. A mutant is applied to a COPY of the repository. Only the test files that load the mutated module are re-run:
//      any other test executes identical code, so its baseline outcome is still valid. Undetected mutants are
//      reported and excluded from the ranking metrics.
//   4. Ochiai ranks components from the failing spectrum. The rank of the mutated module is taken PESSIMISTICALLY
//      (1 + number of components with a score >= its own, excluding itself), so ties never help the method.
//   5. Baselines: dependency distance from the failing test files (not Ochiai), and random ordering (expected rank).
//
// Limitation: the spectrum has one execution per test FILE, so n_f is small and scores are coarse.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildImportGraph, maskSource } from '../server/impact-graph.js';
import { rankComponents, dependencyFallback } from '../server/fault-localization.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'benchmarks', 'algorithm-intelligence');

// Deterministic PRNG (mulberry32) so site selection is reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const OPERATORS = [
  ['===', '!=='], ['!==', '==='], ['>=', '>'], ['<=', '<'], ['&&', '||'], ['||', '&&'], ['true', 'false'], ['false', 'true'],
];

/** Mutation sites in code (comments and string contents masked). Returns [{ at, from, to }]. */
export function mutationSites(source) {
  const masked = maskSource(source);
  const sites = [];
  for (const [from, to] of OPERATORS) {
    const re = new RegExp(from === 'true' || from === 'false' ? `\\b${from}\\b` : from.replace(/[|&=<>!]/g, (c) => `\\${c}`), 'g');
    let m;
    while ((m = re.exec(masked))) sites.push({ at: m.index, from, to });
  }
  return sites.sort((a, b) => a.at - b.at);
}

export function applyMutation(source, site) {
  return source.slice(0, site.at) + site.to + source.slice(site.at + site.from.length);
}

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

/** Copies the repository (without VCS and dependency folders) into a fresh workspace; node_modules is linked. */
function makeWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-sbfl-'));
  for (const entry of fs.readdirSync(root)) {
    if (entry === '.git' || entry === 'node_modules' || entry === 'benchmarks') continue;
    fs.cpSync(path.join(root, entry), path.join(ws, entry), { recursive: true });
  }
  const nm = path.join(root, 'node_modules');
  if (fs.existsSync(nm)) fs.symlinkSync(nm, path.join(ws, 'node_modules'), 'dir');
  return ws;
}

function runTest(ws, file, timeoutMs = 180000) {
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', file], { cwd: ws, env: { ...process.env, LOG_LEVEL: 'silent' },
    encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 && !/^# fail [1-9]/m.test(`${r.stdout}`);
}

export function pessimisticRank(ranking, component) {
  const me = ranking.find((r) => r.component === component);
  if (!me) return null;
  return 1 + ranking.filter((r) => r.component !== component && r.score >= me.score).length;
}

export function expectedRandomRank(n) { return (n + 1) / 2; }

export function runSbfl({ seed = 7, fastMs = 30000, maxModules = 14, sitesPerModule = 2, maxTestsPerMutant = 6 } = {}) {
  const truth = JSON.parse(fs.readFileSync(path.join(outDir, 'truth.json'), 'utf8'));
  const testFiles = Object.keys(truth.files);
  const components = [...new Set(testFiles.flatMap((t) => truth.files[t].loaded))].sort();
  // Candidate modules: loaded by at least one fast test, and by few enough tests to keep the re-run cost bounded.
  const fastLoaders = (m) => testFiles.filter((t) => truth.files[t].durationMs < fastMs && truth.files[t].passed && truth.files[t].loaded.includes(m));
  const candidates = components.filter((m) => fastLoaders(m).length > 0 && fastLoaders(m).length <= maxTestsPerMutant);
  const pick = rng(seed);
  // seeded Fisher-Yates shuffle, then a fixed-size sample sorted for a stable report order
  const shuffled = [...candidates];
  for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(pick() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
  const modules = shuffled.slice(0, maxModules).sort();
  const ws = makeWorkspace();
  const graph = buildImportGraph(Object.fromEntries(listFiles(ws).filter((f) => /\.(c|m)?js$/.test(f)).map((f) => [path.relative(ws, f).split(path.sep).join('/'), fs.readFileSync(f, 'utf8')])));
  const mutants = [], undetected = [];
  try {
    for (const m of modules) {
      const abs = path.join(ws, m);
      const original = fs.readFileSync(abs, 'utf8');
      const sites = mutationSites(original);
      if (!sites.length) continue;
      const chosen = [];
      for (let i = 0; i < sitesPerModule && sites.length; i++) chosen.push(sites[Math.floor(pick() * sites.length)]);
      for (const site of [...new Map(chosen.map((s) => [s.at, s])).values()]) {
        const loaders = fastLoaders(m);
        fs.writeFileSync(abs, applyMutation(original, site));
        const outcome = Object.fromEntries(loaders.map((t) => [t, runTest(ws, t)]));
        fs.writeFileSync(abs, original);
        const failing = loaders.filter((t) => !outcome[t]);
        const row = { module: m, operator: `${site.from} -> ${site.to}`, at: site.at, loaders, failing };
        if (!failing.length) { undetected.push(row); continue; }
        // Spectrum for this mutant: baseline outcomes, except the re-run tests (their mutant outcome replaces baseline).
        // Infrastructure-only failures (browser timeouts, refused connections) are excluded from the spectrum entirely.
        const executions = testFiles.map((t) => ({ testId: t, passed: t in outcome ? outcome[t] : truth.files[t].passed,
          infra: !(t in outcome) && !!truth.files[t].infra, components: truth.files[t].loaded }));
        const r = rankComponents(executions);
        const failingTests = executions.filter((e) => !e.passed && !e.infra).map((e) => e.testId);
        const dep = dependencyFallback({ graph, failingTests, components });
        const ochRank = pessimisticRank(r.ranking, m);
        const depRank = dep.ranking.findIndex((x) => x.component === m) + 1 || null;
        mutants.push({ ...row, ochiaiRank: ochRank, ochiaiScore: r.ranking.find((x) => x.component === m)?.score ?? null,
          ochiaiNef: r.ranking.find((x) => x.component === m)?.nef ?? null, ochiaiNep: r.ranking.find((x) => x.component === m)?.nep ?? null,
          dependencyRank: depRank, randomExpectedRank: expectedRandomRank(components.length), candidates: components.length, failingExecutions: r.failedExecutions });
      }
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  const summarize = (key) => {
    const rs = mutants.map((x) => x[key]).filter((x) => x != null);
    return {
      top1: rs.length ? rs.filter((x) => x <= 1).length / rs.length : null,
      top3: rs.length ? rs.filter((x) => x <= 3).length / rs.length : null,
      mrr: rs.length ? rs.reduce((a, x) => a + 1 / x, 0) / rs.length : null,
      meanRank: rs.length ? rs.reduce((a, x) => a + x, 0) / rs.length : null,
    };
  };
  const report = {
    schema: 'shipproof.bench.sbfl/v1', generatedAt: new Date().toISOString(), node: process.version, seed,
    dataset: 'repository-derived: seeded operator mutants in server/ modules; spectrum from measured coverage of tests/',
    settings: { fastMs, maxModules, sitesPerModule, maxTestsPerMutant },
    spectrumGranularity: 'one execution per test file', components: components.length,
    detectedMutants: mutants.length, undetectedMutants: undetected.length,
    metrics: { ochiai: summarize('ochiaiRank'), dependencyDistance: summarize('dependencyRank'), randomExpected: { meanRank: mutants.length ? mutants[0].randomExpectedRank : null } },
    mutants, undetected,
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'sbfl.json'), JSON.stringify(report, null, 1));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = runSbfl();
  console.log(`detected=${r.detectedMutants} undetected=${r.undetectedMutants} components=${r.components}`);
  console.log('ochiai', JSON.stringify(r.metrics.ochiai));
  console.log('dependencyDistance', JSON.stringify(r.metrics.dependencyDistance));
}
