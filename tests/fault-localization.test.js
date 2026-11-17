// Algorithm 4 — Ochiai spectrum-based fault localization. Hand-computed expectations, no randomness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ochiai, rankComponents, dependencyFallback } from '../server/fault-localization.js';
import { buildImportGraph } from '../server/impact-graph.js';

test('ochiai matches the formula and is zero when undefined', () => {
  assert.equal(ochiai({ nef: 2, nep: 0, nf: 2 }), 1);
  assert.equal(ochiai({ nef: 1, nep: 1, nf: 2 }), 0.5);
  assert.equal(ochiai({ nef: 0, nep: 3, nf: 2 }), 0);
  assert.equal(ochiai({ nef: 0, nep: 0, nf: 0 }), 0, 'no failures: no score, no division by zero');
  assert.ok(Math.abs(ochiai({ nef: 2, nep: 2, nf: 3 }) - 2 / Math.sqrt(3 * 4)) < 1e-12);
});

const EXEC = [
  { testId: 'T1', passed: false, components: ['A', 'B'] },
  { testId: 'T2', passed: false, components: ['A'] },
  { testId: 'T3', passed: true, components: ['B'] },
  { testId: 'T4', passed: true, components: ['C'] },
];

test('ranking reproduces the hand-computed scores and records the contributing executions', () => {
  const r = rankComponents(EXEC);
  assert.equal(r.failedExecutions, 2);
  assert.deepEqual(r.ranking.map((x) => [x.component, x.score]), [['A', 1], ['B', 0.5], ['C', 0]]);
  const a = r.ranking[0];
  assert.equal(a.nef, 2); assert.equal(a.nep, 0); assert.deepEqual(a.failingTests, ['T1', 'T2']);
  assert.equal(r.ranking[1].nep, 1); assert.deepEqual(r.ranking[1].passingTests, ['T3']);
  assert.deepEqual(r.ranking.map((x) => x.rank), [1, 2, 3]);
});

test('infrastructure failures and flaky tests are excluded and counted, never scored', () => {
  const r = rankComponents([
    ...EXEC,
    { testId: 'T5', passed: false, infra: true, components: ['C'] },
    { testId: 'T6', passed: false, components: ['D'] },
    { testId: 'T6', passed: true, components: ['D'] },
  ]);
  assert.equal(r.excluded.infra, 1);
  assert.equal(r.excluded.flaky, 2);
  assert.deepEqual(r.flakyTests, ['T6']);
  assert.ok(!r.ranking.some((x) => x.component === 'D'), 'a component seen only through a flaky test is not ranked');
  assert.equal(r.ranking.find((x) => x.component === 'C').score, 0, 'the infra execution did not add to C');
});

test('no failing executions yields zero scores rather than errors', () => {
  const r = rankComponents([{ testId: 'T', passed: true, components: ['A'] }]);
  assert.equal(r.failedExecutions, 0);
  assert.equal(r.ranking[0].score, 0);
});

test('the dependency fallback is labelled as not Ochiai and orders by distance from the failing test', () => {
  const g = buildImportGraph({
    'tests/t.test.js': "import { a } from '../server/a.js';\n",
    'server/a.js': "import { b } from './b.js';\n",
    'server/b.js': 'export const b = 1;\n',
    'server/unrelated.js': 'export const u = 1;\n',
  });
  const f = dependencyFallback({ graph: g, failingTests: ['tests/t.test.js'], components: ['server/b.js', 'server/a.js', 'server/unrelated.js'] });
  assert.equal(f.algorithm, 'dependency-distance-fallback');
  assert.match(f.label, /Not Ochiai/);
  assert.deepEqual(f.ranking.map((x) => [x.component, x.distance, x.score]), [['server/a.js', 1, null], ['server/b.js', 2, null]]);
});

// ---- benchmark helpers (scripts/bench-sbfl.mjs) ----
import { mutationSites, applyMutation, pessimisticRank } from '../scripts/bench-sbfl.mjs';

test('mutation sites are found in code only, never inside strings or comments', () => {
  const src = "const a = x === 1; // y === 2\nconst s = 'x === 3';\nif (ok && done) return true;\n";
  const sites = mutationSites(src);
  const ops = sites.map((s) => `${s.from}->${s.to}`);
  assert.deepEqual(ops.filter((o) => o === '===->!=='), ['===->!==']);
  assert.ok(ops.includes('&&->||') && ops.includes('true->false'));
  const comment = [src.indexOf('// y'), src.indexOf('\n')];
  const string = [src.indexOf("'x === 3'"), src.indexOf("'x === 3'") + "'x === 3'".length];
  for (const s of sites) {
    assert.ok(!(s.at >= comment[0] && s.at < comment[1]), 'no site inside the comment');
    assert.ok(!(s.at >= string[0] && s.at < string[1]), 'no site inside the string literal');
  }
  assert.equal(sites.filter((s) => s.from === '===').length, 1, 'only the code occurrence of === is a site');
});

test('applying a site changes exactly that operator and nothing else', () => {
  const src = 'if (a >= b) { return x; }\n';
  const [site] = mutationSites(src);
  assert.equal(site.from, '>=');
  assert.equal(applyMutation(src, site), 'if (a > b) { return x; }\n');
});

test('the rank of a module is taken pessimistically when scores tie', () => {
  const ranking = [{ component: 'A', score: 0.8 }, { component: 'B', score: 0.8 }, { component: 'C', score: 0.2 }];
  assert.equal(pessimisticRank(ranking, 'A'), 2, 'tied with B, so counted behind it');
  assert.equal(pessimisticRank(ranking, 'C'), 3);
  assert.equal(pessimisticRank(ranking, 'Z'), null);
});
