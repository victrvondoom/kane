// Algorithm 1 — hybrid graph test impact selection. Pure-function tests: no database, no browser, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { maskSource, scanSpecifiers, buildImportGraph, reverseClosure, chainTo, selectTests, classifyChange, normalizePath } from '../server/impact-graph.js';

// A small synthetic repository: app -> proof -> gate -> db, plus a test that imports app.
const SOURCES = {
  'server/db.js': "export const now = () => new Date().toISOString();\n",
  'server/gate.js': "import { now } from './db.js';\nexport const gate = () => now();\n",
  'server/proof.js': "import { gate } from './gate.js';\nexport const proof = () => gate();\n",
  'server/app.js': "import { proof } from './proof.js';\nexport const app = () => proof();\n",
  'server/ui/index.js': "export const ui = 1;\n",
  'server/routes.js': "import { ui } from './ui';\nexport const r = ui;\n",
  'tests/app.test.js': "import { app } from '../server/app.js';\nimport test from 'node:test';\n",
  'tests/ui.test.js': "import { ui } from '../server/ui/index.js';\n",
  'docs/notes.md': 'nothing to see',
};

test('maskSource keeps offsets, blanks comments and string contents, and keeps newlines', () => {
  const src = "const a = 'import x from \"./nope.js\"'; // require('./also-no')\n/* import('./no') */ const b = `require(\"./tpl\")`;\n";
  const m = maskSource(src);
  assert.equal(m.length, src.length);
  assert.equal(m.split('\n').length, src.split('\n').length);
  assert.ok(!/import|require/.test(m), 'no code-like text may survive inside literals or comments');
  assert.ok(m.includes("const a = '"), 'quote characters are kept');
});

test('scanSpecifiers finds static, side-effect, re-export, require and literal dynamic loads; flags computed loads', () => {
  const src = [
    "import x, { y } from './a.js';",
    "import './side.js';",
    "export * from '../b';",
    "const c = require('./c.cjs');",
    "const d = await import('./d.js');",
    "const probe = `import('./NOT_A_LOAD.js')`;",
    "const e = require(process.env.X);",
    "import pkg from 'lodash';",
  ].join('\n');
  const r = scanSpecifiers(src);
  assert.deepEqual(r.specifiers.sort(), ['../b', './a.js', './c.cjs', './d.js', './side.js']);
  assert.deepEqual(r.external, ['lodash']);
  assert.equal(r.dynamic, 1, 'one computed require; the template probe is not a load');
});

test('buildImportGraph resolves extensionless and index imports and records unresolvable relative loads', () => {
  const g = buildImportGraph(SOURCES);
  assert.ok(g.deps.get('server/proof.js').has('server/gate.js'));
  assert.ok(g.rdeps.get('server/db.js').has('server/gate.js'));
  assert.ok(g.deps.get('tests/ui.test.js').has('server/ui/index.js'));
  assert.ok(g.deps.get('server/routes.js').has('server/ui/index.js'), "'./ui' resolves through its index.js");
  assert.ok(!g.unresolvedFiles.has('server/routes.js'));
  const broken = buildImportGraph({ 'server/x.js': "import './missing.js';\n" });
  assert.ok(broken.unresolvedFiles.has('server/x.js'));
  assert.deepEqual(broken.unresolved.get('server/x.js').missing, ['./missing.js']);
});

test('reverseClosure reaches transitive dependents with an explainable chain', () => {
  const g = buildImportGraph(SOURCES);
  const { reached, depth } = reverseClosure(g, ['server/db.js']);
  assert.deepEqual([...reached.keys()].sort(), ['server/app.js', 'server/db.js', 'server/gate.js', 'server/proof.js', 'tests/app.test.js']);
  assert.equal(depth.get('tests/app.test.js'), 4);
  assert.deepEqual(chainTo(reached, 'tests/app.test.js'), ['server/db.js', 'server/gate.js', 'server/proof.js', 'server/app.js', 'tests/app.test.js']);
});

test('a change to a deep helper selects an indirect criterion; mapping alone would have missed it', () => {
  const g = buildImportGraph(SOURCES);
  const criteria = [
    { id: 1, key: 'AC-1', paths: ['server/app.js'], durationMs: 100, history: { attempts: 10, failures: 0 } },
    { id: 2, key: 'AC-2', paths: ['server/ui/**'], durationMs: 50, history: { attempts: 10, failures: 0 } },
  ];
  const plan = selectTests({ changed: ['server/db.js'], criteria, graph: g });
  const byKey = Object.fromEntries(plan.selected.map((s) => [s.key, s]));
  assert.equal(byKey['AC-1'].tier, 'transitive', 'AC-1 maps server/app.js which depends on db.js');
  assert.ok(byKey['AC-1'].chain.includes('server/db.js'));
  assert.equal(plan.excluded.length, 1, 'AC-2 (ui only) is excluded: no dependency path from db.js');
  assert.equal(plan.excluded[0].key, 'AC-2');
  assert.match(plan.excluded[0].reason, /No changed file/);
});

test('unmapped criteria, opaque changed files and mandatory criteria are never excluded', () => {
  const g = buildImportGraph(SOURCES);
  const criteria = [
    { id: 1, key: 'UNMAPPED', paths: [] },
    { id: 2, key: 'UI', paths: ['server/ui/**'] },
    { id: 3, key: 'SEC', paths: ['server/ui/**'], category: 'security' },
    { id: 4, key: 'MAND', paths: ['server/ui/**'], mandatory: true },
  ];
  const plan = selectTests({ changed: ['server/db.js', 'static/site.css'], criteria, graph: g });
  const tier = Object.fromEntries(plan.selected.map((s) => [s.key, s.tier]));
  assert.equal(tier.UNMAPPED, 'unknown');
  assert.equal(tier.UI, 'unknown', 'an opaque change cannot exclude a criterion whose mapping does not match it');
  assert.equal(tier.SEC, 'unknown');
  assert.equal(tier.MAND, 'unknown');
  assert.equal(plan.excluded.length, 0);
  assert.equal(plan.confidence, 'medium');
});

test('mandatory criteria stay required even when no change can reach them', () => {
  const g = buildImportGraph(SOURCES);
  const plan = selectTests({ changed: ['docs/notes.md'], criteria: [
    { id: 1, key: 'MAND', paths: ['server/app.js'], mandatory: true },
    { id: 2, key: 'OPT', paths: ['server/app.js'] },
  ], graph: g });
  const mand = plan.selected.find((s) => s.key === 'MAND');
  assert.ok(mand && mand.required && mand.tier === 'mandatory');
  assert.ok(!plan.selected.some((s) => s.key === 'OPT'));
  assert.ok(plan.excluded.some((s) => s.key === 'OPT'));
  assert.ok(!plan.excluded.some((s) => s.key === 'MAND'));
});

test('an unknown change set or a build-level file falls back to full verification', () => {
  const g = buildImportGraph(SOURCES);
  const criteria = [{ id: 1, key: 'A', paths: ['server/ui/**'] }, { id: 2, key: 'B', paths: ['server/app.js'] }];
  const unknown = selectTests({ changed: null, criteria, graph: g });
  assert.equal(unknown.fallback.reason, 'the change set of this build is not known');
  assert.equal(unknown.selected.length, 2);
  assert.equal(unknown.confidence, 'low');
  const lock = selectTests({ changed: ['package-lock.json'], criteria, graph: g });
  assert.match(lock.fallback.reason, /build-level file changed/);
  assert.equal(lock.selected.length, 2);
});

test('an incomplete graph (computed load) makes unmatched criteria unknown rather than excluded', () => {
  const g = buildImportGraph({ ...SOURCES, 'server/loader.js': 'const m = require(name);\n' });
  const plan = selectTests({ changed: ['docs/notes.md'], criteria: [{ id: 1, key: 'X', paths: ['server/ui/**'] }], graph: g });
  assert.equal(plan.selected[0].tier, 'unknown');
  assert.deepEqual(plan.graph.unresolvedFiles, ['server/loader.js']);
});

test('budget limits only the transitive set; required criteria always run and overBudget is reported', () => {
  const g = buildImportGraph(SOURCES);
  const criteria = [
    { id: 1, key: 'DIRECT', paths: ['server/db.js'], durationMs: 500 },
    { id: 2, key: 'T1', paths: ['server/app.js'], durationMs: 300, history: { attempts: 4, failures: 2 } },
    { id: 3, key: 'T2', paths: ['tests/app.test.js'], durationMs: 200, history: { attempts: 4, failures: 0 } },
  ];
  const unlimited = selectTests({ changed: ['server/db.js'], criteria, graph: g });
  assert.equal(unlimited.totals.selected, 3);
  const tight = selectTests({ changed: ['server/db.js'], criteria, graph: g, budget: { maxMs: 600 } });
  assert.deepEqual(tight.selected.map((s) => s.key), ['DIRECT']);
  assert.equal(tight.deferred.length, 2);
  assert.match(tight.deferred[0].reason, /Deferred by the budget/);
  assert.equal(tight.totals.overBudget, false);
  const count = selectTests({ changed: ['server/db.js'], criteria, graph: g, budget: { maxTests: 2 } });
  assert.equal(count.selected.length, 2);
  assert.ok(count.selected.some((s) => s.key === 'DIRECT'));
  // Tie-break among transitive criteria: failure history first, then cost.
  assert.equal(count.selected.find((s) => s.key !== 'DIRECT').key, 'T1');
  const over = selectTests({ changed: ['server/db.js'], criteria: [{ id: 1, key: 'M', paths: ['server/db.js'], mandatory: true, durationMs: 900 }], graph: g, budget: { maxMs: 100 } });
  assert.equal(over.totals.overBudget, true);
  assert.equal(over.selected.length, 1, 'a required criterion is never dropped to meet the budget');
});

test('selection is deterministic for identical input', () => {
  const g = buildImportGraph(SOURCES);
  const criteria = [{ id: 1, key: 'A', paths: ['server/app.js'] }, { id: 2, key: 'B', paths: ['tests/app.test.js'] }];
  const a = JSON.stringify(selectTests({ changed: ['server/gate.js'], criteria, graph: g }));
  const b = JSON.stringify(selectTests({ changed: ['server/gate.js'], criteria, graph: g }));
  assert.equal(a, b);
});

test('helpers classify changes and normalise paths', () => {
  const g = buildImportGraph(SOURCES);
  assert.equal(classifyChange('server/db.js', g), 'graph');
  assert.equal(classifyChange('docs/x.md', g), 'inert');
  assert.equal(classifyChange('public/app.css', g), 'opaque');
  assert.equal(classifyChange('.github/workflows/ci.yml', g), 'global');
  assert.equal(normalizePath('./server//a/../b.js'), 'server/b.js');
});
