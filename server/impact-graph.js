// Hybrid graph-based test impact selection (Algorithm 1).
//
// Pure and deterministic: input is a set of repository files plus the changed paths; output is an explained
// plan. Nothing here reads the database or runs a test, and nothing here can turn a result into a pass.
//
// Pipeline (see ALGORITHM_INTELLIGENCE_PLAN.md §1):
//   changed files -> reverse import closure (who depends on the change, transitively)
//   -> criterion matching on {changed files} (tier "direct") and {dependents} (tier "transitive")
//   -> required set: mandatory/critical, direct, unknown-impact criteria are ALWAYS run
//   -> optional set: transitive criteria, ranked by chain depth, historical failure rate and cost,
//      admitted greedily within a budget
//   -> fallback to full verification when the change set or the graph cannot be trusted.
//
// Unknown impact is never treated as unaffected: an unmapped criterion, an opaque changed file or an
// incomplete graph all put the criterion in the required set.
import { matchPaths } from './proof.js';

export const GLOBAL_PATTERNS = ['package.json', 'package-lock.json', 'Dockerfile', 'docker-compose.yml', '.github/**', 'migrations/**', 'uv.lock', 'pyproject.toml'];
// Files that cannot change application behaviour. A criterion still runs when its own mapping names them.
const INERT = [/\.(md|txt)$/i, /^LICENSE/, /^docs\//];
const JS = /\.(?:[cm]?jsx?|tsx?)$/;
const EXTENSIONS = ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '/index.js', '/index.mjs', '/index.ts', '.json'];

// ---------- lexical masking ----------
/**
 * Same-length copy of `src` in which comments and the CONTENT of string/template literals are blanked
 * (newlines kept, quote characters kept). Code-like text inside strings, such as a child-process probe
 * written as a template, therefore never looks like an import. Offsets match `src` exactly.
 * Known limit: regular-expression literals that contain quote characters are treated as strings up to the
 * end of their line, and `${...}` expressions inside template literals are treated as text.
 */
export function maskSource(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const stop = e === -1 ? n : e; blank(i, stop); i = stop; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const stop = e === -1 ? n : e + 2; blank(i, stop); i = stop; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\n' && c !== '`') break; // unterminated single-line string: stop at the line end
        j += src[j] === '\\' ? 2 : 1;
      }
      const end = Math.min(j, n);
      blank(i + 1, end);
      i = end + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

const STATIC = /\b(?:from|import)\s*(["'])/g;               // import x from 'a' · export * from 'a' · import 'a'
const CALLS = /\b(?:require|import)\s*\(\s*(["'`])/g;      // require('a') · import('a')
const DYNAMIC = /\b(?:require|import)\s*\(\s*(?!["'`\s])/g; // require(expr) · import(expr): cannot be resolved statically

/** Relative module specifiers and the number of non-literal (unresolvable) loads in one file. */
export function scanSpecifiers(src) {
  const masked = maskSource(src);
  const specs = [];
  const take = (re) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(masked))) {
      const quote = m[1];
      const start = m.index + m[0].length;
      const end = masked.indexOf(quote, start);
      if (end === -1) continue;
      specs.push(src.slice(start, end));
    }
  };
  take(STATIC); take(CALLS);
  const dynamic = (masked.match(DYNAMIC) || []).length;
  return { specifiers: [...new Set(specs)].filter((s) => s.startsWith('.')), external: [...new Set(specs)].filter((s) => !s.startsWith('.')), dynamic };
}

const dirname = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
export function normalizePath(p) {
  const parts = [];
  for (const seg of String(p).replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (parts.length) parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
}

function resolveSpecifier(files, fromFile, spec) {
  const base = normalizePath([dirname(fromFile), spec].filter(Boolean).join('/'));
  return EXTENSIONS.map((ext) => base + ext).find((c) => files.has(c)) ?? null;
}

/**
 * Static dependency graph over the JavaScript/TypeScript files in `sources` (object or Map: path -> text).
 * `unresolved` lists files that load a relative module that does not exist in the snapshot, or that contain
 * a load whose target is computed. Such a file makes the graph INCOMPLETE: a dependency may be invisible.
 */
export function buildImportGraph(sources) {
  const entries = sources instanceof Map ? [...sources] : Object.entries(sources);
  const jsFiles = new Map(entries.map(([p, t]) => [normalizePath(p), t]).filter(([p]) => JS.test(p)));
  const files = new Set(jsFiles.keys());
  const deps = new Map(), rdeps = new Map(), unresolved = new Map();
  for (const f of files) { deps.set(f, new Set()); rdeps.set(f, new Set()); }
  let external = 0;
  for (const [file, text] of jsFiles) {
    const { specifiers, external: ext, dynamic } = scanSpecifiers(String(text));
    external += ext.length;
    const missing = [];
    for (const spec of specifiers) {
      const target = resolveSpecifier(files, file, spec);
      if (!target) { missing.push(spec); continue; }
      if (target === file) continue;
      deps.get(file).add(target);
      rdeps.get(target).add(file);
    }
    if (missing.length || dynamic) unresolved.set(file, { missing, dynamic });
  }
  return { files, deps, rdeps, unresolved, unresolvedFiles: new Set(unresolved.keys()), externalSpecifiers: external };
}

/**
 * Breadth-first reverse closure from `seeds`: every file that depends, directly or transitively, on a seed.
 * Returns each reached file with its BFS parent, so the chain seed -> ... -> file can be explained.
 */
export function reverseClosure(graph, seeds) {
  const reached = new Map(), depth = new Map();
  const queue = [];
  for (const s of seeds) if (graph.files.has(s) && !reached.has(s)) { reached.set(s, null); depth.set(s, 0); queue.push(s); }
  for (let q = 0; q < queue.length; q++) {
    const cur = queue[q];
    for (const dependent of [...(graph.rdeps.get(cur) || [])].sort()) {
      if (reached.has(dependent)) continue;
      reached.set(dependent, cur);
      depth.set(dependent, depth.get(cur) + 1);
      queue.push(dependent);
    }
  }
  return { reached, depth };
}

/** seed -> ... -> file, following BFS parents. */
export function chainTo(reached, file) {
  const chain = [];
  for (let cur = file; cur !== null && cur !== undefined; cur = reached.get(cur)) chain.unshift(cur);
  return chain;
}

const alwaysRun = (c) => !!c.mandatory || c.criticality === 'critical' || c.category === 'security';
const failureRate = (c) => (c.history?.attempts ? c.history.failures / c.history.attempts : 0);

/** Classifies one changed path. */
export function classifyChange(p, graph) {
  if (matchPaths(GLOBAL_PATTERNS, [p]).length) return 'global';
  if (graph.files.has(p)) return 'graph';
  if (INERT.some((re) => re.test(p))) return 'inert';
  return 'opaque';
}

function fullPlan(reason, criteria) {
  const selected = criteria.map((c) => ({ id: c.id, key: c.key, tier: 'fallback', required: true, reason: `Full verification: ${reason}.`, durationMs: c.durationMs ?? null }));
  const estimatedMs = selected.reduce((a, x) => a + (x.durationMs || 0), 0);
  return { mode: 'hybrid', fallback: { reason }, confidence: 'low', changed: null, changeKinds: {}, selected, deferred: [], excluded: [],
    totals: { total: criteria.length, selected: selected.length, required: selected.length, transitiveAdmitted: 0, deferred: 0, excluded: 0, estimatedMs, budget: null, overBudget: false } };
}

/**
 * Plan the verification of one commit.
 *   changed    array of repository-relative changed paths, or null/undefined when the change set is unknown
 *   criteria   [{ id, key, paths:[globs], mandatory, criticality, category, durationMs, history:{attempts, failures} }]
 *   graph      result of buildImportGraph
 *   budget     null | { maxTests } | { maxMs }   limits the OPTIONAL (transitive) set only
 */
export function selectTests({ changed, criteria, graph, budget = null }) {
  if (!Array.isArray(changed)) return fullPlan('the change set of this build is not known', criteria);
  const paths = [...new Set(changed.map(normalizePath).filter(Boolean))].sort();
  const kinds = Object.fromEntries(paths.map((p) => [p, classifyChange(p, graph)]));
  const globals = paths.filter((p) => kinds[p] === 'global');
  if (globals.length) return fullPlan(`a build-level file changed (${globals.join(', ')})`, criteria);

  const seeds = paths.filter((p) => kinds[p] === 'graph');
  const { reached, depth } = reverseClosure(graph, seeds);
  const dependents = [...reached.keys()].filter((p) => !paths.includes(p)).sort((a, b) => depth.get(a) - depth.get(b) || a.localeCompare(b));
  const opaque = paths.filter((p) => kinds[p] === 'opaque');
  const uncertain = graph.unresolvedFiles.size > 0;
  const graphNote = uncertain ? `${graph.unresolvedFiles.size} file(s) have loads that cannot be resolved statically` : null;

  const rows = criteria.map((c) => {
    const pats = Array.isArray(c.paths) ? c.paths : [];
    const base = { id: c.id, key: c.key, required: false, durationMs: c.durationMs ?? null, failureRate: failureRate(c), mandatory: !!c.mandatory, criticality: c.criticality || null };
    const req = alwaysRun(c) ? ' Required: mandatory, critical or security criterion.' : '';
    if (!pats.length) return { ...base, tier: 'unknown', required: true, reason: `Unmapped: no source-path mapping, so any change may affect it.${req}` };
    const direct = matchPaths(pats, paths);
    if (direct.length) return { ...base, tier: 'direct', required: true, matched: direct.slice(0, 8), reason: `${direct.length} changed file(s) match its mapping (${direct.slice(0, 3).join(', ')}).${req}` };
    const hit = dependents.filter((p) => matchPaths(pats, [p]).length);
    if (hit.length) {
      const chain = chainTo(reached, hit[0]);
      return { ...base, tier: 'transitive', required: alwaysRun(c), chain, matched: hit.slice(0, 8),
        reason: `Depends on the change through ${chain.join(' → ')}; ${hit[0]} is in its mapping.${req}` };
    }
    if (opaque.length || uncertain) {
      const why = opaque.length ? `changed file(s) with no dependency information: ${opaque.slice(0, 3).join(', ')}` : graphNote;
      return { ...base, tier: 'unknown', required: true, reason: `Cannot be excluded: ${why}.${req}` };
    }
    if (alwaysRun(c)) return { ...base, tier: 'mandatory', required: true, reason: 'Mandatory, critical or security criterion: never excluded by impact analysis.' };
    return { ...base, tier: 'excluded', reason: 'No changed file is in its mapping or in the dependents of the change.' };
  });

  const required = rows.filter((r) => r.required).sort((a, b) => a.key.localeCompare(b.key));
  const optional = rows.filter((r) => !r.required && r.tier === 'transitive')
    .sort((a, b) => a.chain.length - b.chain.length || b.failureRate - a.failureRate || (a.durationMs ?? Infinity) - (b.durationMs ?? Infinity) || a.key.localeCompare(b.key));
  const excluded = rows.filter((r) => r.tier === 'excluded');

  const cost = (r) => r.durationMs || 0;
  const selected = [...required], deferred = [];
  let ms = required.reduce((a, r) => a + cost(r), 0);
  for (const opt of optional) {
    const fits = !budget ? true
      : budget.maxTests != null ? selected.length + 1 <= budget.maxTests
      : budget.maxMs != null ? ms + cost(opt) <= budget.maxMs : true;
    if (fits) { selected.push(opt); ms += cost(opt); }
    else deferred.push({ ...opt, reason: `${opt.reason} Deferred by the budget (${budget.maxTests != null ? `${budget.maxTests} tests` : `${budget.maxMs} ms`}).` });
  }
  const confidence = opaque.length || uncertain ? 'medium' : 'high';
  const overBudget = !!budget && (budget.maxTests != null ? required.length > budget.maxTests : budget.maxMs != null ? required.reduce((a, r) => a + cost(r), 0) > budget.maxMs : false);
  return { mode: 'hybrid', fallback: null, confidence, changed: paths, changeKinds: kinds,
    graph: { files: graph.files.size, unresolvedFiles: [...graph.unresolvedFiles].sort(), externalSpecifiers: graph.externalSpecifiers },
    selected: selected.sort((a, b) => Number(b.required) - Number(a.required) || a.key.localeCompare(b.key)), deferred, excluded,
    totals: { total: criteria.length, selected: selected.length, required: required.length, transitiveAdmitted: selected.length - required.length,
      deferred: deferred.length, excluded: excluded.length, estimatedMs: ms, budget: budget || null, overBudget } };
}
