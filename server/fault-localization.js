// Spectrum-based fault localization with the Ochiai coefficient (Algorithm 4). Pure functions.
//
//   Ochiai(c) = n_ef / sqrt( n_f * (n_ef + n_ep) )
//
//   c      a source component (here: a repository file loaded during an execution)
//   n_ef   failed executions that executed c
//   n_f    failed executions in total
//   n_ep   passed executions that executed c
//
// The score ranks components by statistical association with failures. It does NOT establish that a
// component caused a failure; the ranking is a prioritisation of where to look.
//
// Input executions must come from a genuine spectrum (coverage recorded for that execution). Infrastructure
// failures are excluded and counted; a test that both passed and failed across repeats is flaky and is
// excluded and reported separately.
export const ochiai = ({ nef, nep, nf }) => {
  const d = Math.sqrt(nf * (nef + nep));
  return d === 0 ? 0 : nef / d;
};

/**
 * @param executions  [{ testId, passed: boolean, infra?: boolean, components: string[] }]
 *                    `components` are the files this execution loaded (coverage truth).
 * @returns ranked components with the exact counts and the executions that contributed to each score.
 */
export function rankComponents(executions) {
  const excluded = { infra: 0, flaky: 0 };
  const outcomes = new Map();
  for (const e of executions) if (!e.infra) {
    if (!outcomes.has(e.testId)) outcomes.set(e.testId, new Set());
    outcomes.get(e.testId).add(!!e.passed);
  }
  const flakyTests = new Set([...outcomes].filter(([, s]) => s.size > 1).map(([t]) => t));
  const usable = [];
  for (const e of executions) {
    if (e.infra) { excluded.infra++; continue; }
    if (flakyTests.has(e.testId)) { excluded.flaky++; continue; }
    usable.push(e);
  }
  const failed = usable.filter((e) => !e.passed), nf = failed.length;
  const components = new Map();
  const seen = (c) => { if (!components.has(c)) components.set(c, { failingTests: [], passingTests: [] }); return components.get(c); };
  for (const e of usable) for (const c of new Set(e.components || [])) seen(c)[e.passed ? 'passingTests' : 'failingTests'].push(e.testId);
  const ranked = [...components].map(([component, t]) => {
    const nef = t.failingTests.length, nep = t.passingTests.length;
    return { component, score: ochiai({ nef, nep, nf }), nef, nep, nf, np: usable.length - nf,
      failingTests: [...t.failingTests].sort(), passingTests: [...t.passingTests].sort() };
  }).sort((a, b) => b.score - a.score || b.nef - a.nef || a.component.localeCompare(b.component));
  ranked.forEach((r, i) => { r.rank = i + 1; });
  return { algorithm: 'ochiai', formula: 'Ochiai(c) = n_ef / sqrt(n_f * (n_ef + n_ep))', executions: usable.length, failedExecutions: nf,
    excluded, flakyTests: [...flakyTests].sort(), ranking: ranked,
    limitations: ['A high score is an association, not a cause.', 'Granularity is the execution unit supplied (e.g. one test file).',
      'Components are only those the spectrum recorded; anything never loaded cannot be ranked.'] };
}

/**
 * Explicitly labelled fallback when no genuine spectrum exists: components are ordered by dependency distance
 * from the failing tests. No Ochiai score is produced, and the result says so.
 */
export function dependencyFallback({ graph, failingTests, components }) {
  const distance = new Map();
  for (const t of failingTests) {
    if (!graph.files.has(t)) continue;
    const q = [t]; const d = new Map([[t, 0]]);
    for (let i = 0; i < q.length; i++) for (const dep of graph.deps.get(q[i]) || []) if (!d.has(dep)) { d.set(dep, d.get(q[i]) + 1); q.push(dep); }
    for (const [f, k] of d) if (!distance.has(f) || distance.get(f) > k) distance.set(f, k);
  }
  const ranked = components.filter((c) => distance.has(c))
    .map((c) => ({ component: c, distance: distance.get(c), score: null, basis: 'dependency distance from a failing test (fallback, not Ochiai)' }))
    .sort((a, b) => a.distance - b.distance || a.component.localeCompare(b.component));
  ranked.forEach((r, i) => { r.rank = i + 1; });
  return { algorithm: 'dependency-distance-fallback', label: 'Not Ochiai: no genuine execution spectrum was available.', ranking: ranked };
}
