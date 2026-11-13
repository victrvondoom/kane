// Proof intelligence: criterion versions, change impact, evidence freshness, stability, risk,
// release decisions and proof dossiers. Every function here is deterministic and reads only
// persisted rows. Nothing in this file can turn a non-passing execution into a pass.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { now, newUid } from './db.js';
import { textHash } from './requirements.js';
import { criteriaStatus, releaseGate } from './gate.js';
import { canonical, sha256 } from './keys.js';

export const CRITICALITY = ['low', 'medium', 'high', 'critical'];
const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

// ---------- policy ----------
export const DEFAULT_POLICY = {
  requireCurrentEvidence: true,     // mandatory criteria need CURRENT evidence (stale passes do not count)
  unknownImpactInvalidates: true,   // unmapped criteria / unknown change sets invalidate older evidence
  blockCriticalUnstable: true,      // a critical criterion classified intermittent blocks release
  requireSameEnvironment: true,     // evidence from another environment does not verify this build
  pinEngineVersion: false,          // evidence from a different engine version is stale
  reverifyOnPolicyChange: false,    // evidence produced under an older policy version is stale
  requireBuild: false,              // a release decision needs a registered build
  minStabilitySample: 5,            // eligible application outcomes needed before judging stability
  stabilityWindow: 20,              // most recent eligible outcomes considered
};
// Rules that are not configurable.
export const INVARIANTS = [
  'A pass requires engine exit code 0, a passing run_end event and at least one evidence artifact.',
  'Execution errors, authentication failures, timeouts and interruptions never count as passes.',
  'A result only applies to the exact criterion text it executed.',
  'Risk and stability classifications never change a criterion\'s verification state.',
  'Historical executions, criterion versions and decisions are never rewritten.',
];
export function validatePolicy(input) {
  const out = { ...DEFAULT_POLICY };
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Policy must be an object');
  for (const [k, v] of Object.entries(input)) {
    if (!(k in DEFAULT_POLICY)) throw new Error(`Unknown policy rule "${k}"`);
    if (typeof DEFAULT_POLICY[k] === 'boolean') { if (typeof v !== 'boolean') throw new Error(`${k} must be true or false`); out[k] = v; }
    else { if (!Number.isInteger(v)) throw new Error(`${k} must be a whole number`); out[k] = v; }
  }
  if (out.minStabilitySample < 3 || out.minStabilitySample > 50) throw new Error('minStabilitySample must be between 3 and 50');
  if (out.stabilityWindow < out.minStabilitySample || out.stabilityWindow > 200) throw new Error('stabilityWindow must be between minStabilitySample and 200');
  return out;
}
export function getPolicy(db, projectId) {
  let row = db.get('SELECT * FROM policy_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1', projectId);
  if (!row) { db.run('INSERT INTO policy_versions (project_id, version, rules, created_at) VALUES (?, 1, ?, ?)', projectId, '{}', now()); row = { version: 1, rules: '{}', created_at: now() }; }
  return { version: row.version, rules: { ...DEFAULT_POLICY, ...J(row.rules, {}) }, createdAt: row.created_at };
}
export function setPolicy(db, projectId, rules) {
  const clean = validatePolicy(rules), cur = getPolicy(db, projectId);
  if (canonical(clean) === canonical(cur.rules)) return cur;
  db.run('INSERT INTO policy_versions (project_id, version, rules, created_at) VALUES (?, ?, ?, ?)', projectId, cur.version + 1, JSON.stringify(clean), now());
  return getPolicy(db, projectId);
}

// ---------- criterion versions ----------
export function cleanList(v, name, { max = 20, len = 200, pattern = false } = {}) {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new Error(`${name} must be a list`);
  const out = [...new Set(v.map((x) => String(x).trim()).filter(Boolean))];
  if (out.length > max) throw new Error(`${name}: at most ${max} entries`);
  for (const x of out) {
    if (x.length > len || /[\u0000-\u001f\\]/.test(x)) throw new Error(`${name}: invalid entry "${x.slice(0, 40)}"`);
    if (pattern && (x.startsWith('/') || x.split('/').includes('..'))) throw new Error(`${name}: patterns are repository-relative (no leading "/" or "..")`);
  }
  return out.sort();
}
export const contentHash = (c) => sha256(canonical({ textHash: textHash(c.text), category: c.category, mandatory: !!c.mandatory,
  criticality: c.criticality, areas: J(c.areas, []), paths: J(c.paths, []) }));

/** Call after any insert/update of a criteria row: appends a new immutable version when its content changed. */
export function writeVersion(db, criterionId) {
  const c = db.get('SELECT * FROM criteria WHERE id = ?', criterionId);
  const hash = contentHash(c);
  const cur = c.version_id ? db.get('SELECT * FROM criterion_versions WHERE id = ?', c.version_id) : null;
  if (cur && cur.content_hash === hash) return cur.id;
  const n = (db.get('SELECT MAX(version) m FROM criterion_versions WHERE criterion_id = ?', c.id).m || 0) + 1;
  const id = Number(db.run(`INSERT INTO criterion_versions (criterion_id, version, text, text_hash, category, mandatory, criticality, areas, paths, content_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, c.id, n, c.text, textHash(c.text), c.category, c.mandatory, c.criticality, c.areas, c.paths, hash, now()).lastInsertRowid);
  db.run('UPDATE criteria SET version_id = ? WHERE id = ?', id, c.id);
  return id;
}

// ---------- builds ----------
export function normalizePaths(list) {
  if (list === undefined || list === null) return { paths: [], known: false };
  if (!Array.isArray(list)) throw new Error('changedPaths must be a list of repository-relative file paths');
  if (list.length > 5000) return { paths: [], known: false, truncated: true }; // too large to trust as complete
  const out = new Set();
  for (const raw of list) {
    const p = String(raw).replace(/^\.\//, '').trim();
    if (!p) continue;
    if (p.length > 1024 || /[\u0000-\u001f]/.test(p)) throw new Error('changedPaths contains an invalid path');
    out.add(p);
  }
  return { paths: [...out].sort(), known: true };
}
export const validSha = (s) => typeof s === 'string' && /^[0-9a-f]{7,64}$/i.test(s);
const slug = (v, name, max = 100) => {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  if (s.length > max || /[\u0000-\u001f]/.test(s)) throw new Error(`${name} is invalid`);
  return s;
};
/** Idempotent: the same (project, commit, environment) always resolves to the same build row. */
export function registerBuild(db, projectId, input, source) {
  if (!validSha(input.commitSha)) throw new Error('commitSha must be a 7–64 character hexadecimal commit id');
  const sha = input.commitSha.toLowerCase();
  const environment = slug(input.environment, 'environment', 40) || 'default';
  if (!/^[\w.-]+$/.test(environment)) throw new Error('environment may contain letters, digits, ".", "_" and "-"');
  const { paths, known } = normalizePaths(input.changedPaths);
  const existing = db.get('SELECT * FROM builds WHERE project_id = ? AND commit_sha = ? AND environment = ?', projectId, sha, environment);
  if (existing) {
    // A build's change set may be completed later (e.g. webhook after CI), never replaced once known.
    if (!existing.paths_known && known) db.run('UPDATE builds SET changed_paths = ?, paths_known = 1 WHERE id = ?', JSON.stringify(paths), existing.id);
    return { build: db.get('SELECT * FROM builds WHERE id = ?', existing.id), created: false };
  }
  const id = Number(db.run(`INSERT INTO builds (project_id, commit_sha, branch, environment, build_identifier, app_url, source, message, changed_paths, paths_known, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, projectId, sha, slug(input.branch, 'branch', 200), environment, slug(input.buildId, 'buildId', 120),
    input.appUrl || null, source, slug(input.message, 'message', 300), JSON.stringify(paths), known ? 1 : 0, now()).lastInsertRowid);
  return { build: db.get('SELECT * FROM builds WHERE id = ?', id), created: true };
}
export const buildView = (b) => b && ({ id: b.id, commitSha: b.commit_sha, shortSha: b.commit_sha.slice(0, 7), branch: b.branch, environment: b.environment,
  buildId: b.build_identifier, appUrl: b.app_url, source: b.source, message: b.message, changedPaths: J(b.changed_paths, []), pathsKnown: !!b.paths_known, createdAt: b.created_at });
export const currentBuild = (db, projectId) => db.get('SELECT * FROM builds WHERE project_id = ? ORDER BY id DESC LIMIT 1', projectId) || null;

// ---------- change impact ----------
// Glob matching without regular expressions, so user-supplied patterns cannot cause catastrophic backtracking.
// `**` matches any number of path segments, `*` any run of characters inside one segment, `?` one character.
function segMatch(pat, str) {
  let p = 0, s = 0, star = -1, mark = 0;
  while (s < str.length) {
    if (p < pat.length && (pat[p] === '?' || pat[p] === str[s])) { p++; s++; }
    else if (p < pat.length && pat[p] === '*') { star = p++; mark = s; }
    else if (star >= 0) { p = star + 1; s = ++mark; }
    else return false;
  }
  while (pat[p] === '*') p++;
  return p === pat.length;
}
const globCache = new Map();
export function globToRegex(glob) { // name kept for callers; returns an object with test()
  if (globCache.has(glob)) return globCache.get(glob);
  const pat = glob.split('/').filter((x, i, a) => !(x === '**' && a[i - 1] === '**'));
  const m = { test(file) {
    const segs = file.split('/');
    // reach[j] = pattern prefix (so far) can match the first j path segments
    let reach = new Uint8Array(segs.length + 1); reach[0] = 1;
    for (const part of pat) {
      const next = new Uint8Array(segs.length + 1);
      if (part === '**') { let on = 0; for (let j = 0; j <= segs.length; j++) { on = on || reach[j]; next[j] = on; } }
      else for (let j = 0; j < segs.length; j++) if (reach[j] && segMatch(part, segs[j])) next[j + 1] = 1;
      reach = next;
    }
    return reach[segs.length] === 1;
  } };
  if (globCache.size < 2000) globCache.set(glob, m);
  return m;
}
export const matchPaths = (patterns, changed) => { const rx = patterns.map(globToRegex); return changed.filter((p) => rx.some((r) => r.test(p))); };

/** Impact of ONE build's change set on one criterion mapping. */
export function impactOf(patterns, build) {
  if (!patterns.length) return { impact: 'unknown', reason: 'Criterion has no source-path mapping, so any change may affect it.' };
  if (!build.paths_known) return { impact: 'unknown', reason: `The change set of build ${build.commit_sha.slice(0, 7)} is not known.` };
  const hit = matchPaths(patterns, J(build.changed_paths, []));
  return hit.length ? { impact: 'affected', matched: hit.slice(0, 8), matchCount: hit.length, reason: `${hit.length} changed file${hit.length === 1 ? '' : 's'} match its mapping (${hit.slice(0, 3).join(', ')}${hit.length > 3 ? ', …' : ''}).` }
    : { impact: 'unaffected', reason: `None of the ${J(build.changed_paths, []).length} changed files match its mapping.` };
}

// ---------- stability ----------
/** Deterministic classification from application outcomes only (passed / failed). Infrastructure results are counted apart. */
export function classifyStability(outcomes, minSample) {
  const n = outcomes.length, fails = outcomes.filter((o) => o === 'failed').length;
  let flips = 0;
  for (let i = 1; i < n; i++) if (outcomes[i] !== outcomes[i - 1]) flips++;
  const cls = n < minSample ? 'insufficient_data' : fails === 0 ? 'stable_pass' : fails === n ? 'stable_fail' : 'intermittent';
  return { classification: cls, sample: n, minSample, passes: n - fails, failures: fails, failureRate: n ? fails / n : null, flips };
}
function stabilityFor(db, c, policy) {
  const rows = db.all(`SELECT r.id, r.run_id, r.status, r.error_kind, r.finished_at, r.build_id, r.environment FROM results r
    WHERE r.criterion_id = ? AND r.text_hash = ? AND r.status IN ('passed','failed','error','timeout') ORDER BY r.id DESC LIMIT ?`, c.id, textHash(c.text), policy.stabilityWindow * 3);
  const app = rows.filter((r) => r.status === 'passed' || r.status === 'failed').slice(0, policy.stabilityWindow).reverse();
  const infra = rows.filter((r) => r.status === 'error' || r.status === 'timeout');
  return { ...classifyStability(app.map((r) => r.status), policy.minStabilitySample),
    recent: app.slice(-12).map((r) => ({ resultId: r.id, runId: r.run_id, status: r.status, finishedAt: r.finished_at, buildId: r.build_id, environment: r.environment })),
    excluded: { total: infra.length, timeouts: infra.filter((r) => r.status === 'timeout').length,
      byKind: infra.reduce((a, r) => { const k = r.status === 'timeout' ? 'timeout' : r.error_kind || 'error'; a[k] = (a[k] || 0) + 1; return a; }, {}) } };
}

// ---------- freshness ----------
/**
 * State of one criterion's evidence relative to the current build.
 * CURRENT | STALE | UNVERIFIED | FAILED | BLOCKED, with machine-readable reasons.
 */
function freshnessFor(db, c, ctx) {
  const { build, policy, policyVersion, engineVersion, acceptFixture } = ctx;
  const l = c.latest;
  if (!l) {
    const older = db.get(`SELECT id, run_id FROM results WHERE criterion_id = ? AND status = 'passed' ORDER BY id DESC LIMIT 1`, c.id);
    return { state: 'UNVERIFIED', reasons: [older ? { code: 'criterion_changed', message: `The criterion was edited after its last pass (run #${older.run_id}); that result verified different text.`, resultId: older.id, runId: older.run_id }
      : { code: 'never_executed', message: 'No execution has ever been recorded for this criterion.' }], impact: null };
  }
  const ref = { resultId: l.id, runId: l.run_id };
  if (l.status === 'failed') return { state: 'FAILED', reasons: [{ code: 'application_failure', message: l.reason || l.summary || 'The engine observed that the expected outcome did not happen.', ...ref }], impact: null };
  if (l.status !== 'passed') return { state: 'BLOCKED', reasons: [{ code: l.error_kind || l.status, message: l.reason || 'The latest execution ended without a verdict.', ...ref }], impact: null };
  const r = db.get('SELECT engine, build_id, environment, policy_version, criterion_version_id, finished_at FROM results WHERE id = ?', l.id);
  if (/fixture/i.test(r.engine || '') && !acceptFixture)
    return { state: 'BLOCKED', reasons: [{ code: 'fixture_engine', message: `The passing result was produced by a test stand-in (${r.engine}), not Kane CLI.`, ...ref }], impact: null };
  const reasons = [];
  let impact = null;
  if (policy.pinEngineVersion && engineVersion && r.engine && r.engine !== `kane-cli ${engineVersion}`)
    reasons.push({ code: 'engine_version_changed', message: `Evidence was produced by ${r.engine}; the server now runs kane-cli ${engineVersion}.`, ...ref });
  if (policy.reverifyOnPolicyChange && r.policy_version != null && r.policy_version !== policyVersion)
    reasons.push({ code: 'policy_changed', message: `Evidence was produced under policy v${r.policy_version}; the current policy is v${policyVersion}.`, ...ref });
  if (build && r.build_id !== build.id) {
    if (policy.requireSameEnvironment && r.environment && r.environment !== build.environment)
      reasons.push({ code: 'different_environment', message: `Evidence was produced in environment "${r.environment}", the current build is in "${build.environment}".`, ...ref });
    // Every build of this environment registered after the evidence could have invalidated it.
    const chain = db.all('SELECT * FROM builds WHERE project_id = ? AND environment = ? AND id > ? AND id <= ? ORDER BY id', build.project_id, build.environment, r.build_id || 0, build.id);
    const patterns = J(c.paths, []);
    const evidencedPaths = J(db.get('SELECT paths FROM criterion_versions WHERE id = ?', r.criterion_version_id)?.paths, []);
    const per = chain.map((b) => ({ buildId: b.id, shortSha: b.commit_sha.slice(0, 7), ...impactOf(patterns, b) }));
    if (chain.length && canonical(evidencedPaths) !== canonical(patterns)) {
      impact = { impact: 'unknown', builds: per };
      if (policy.unknownImpactInvalidates) reasons.push({ code: 'mapping_changed', message: 'The source-path mapping was changed after this evidence was produced, so impact of later builds cannot be trusted.', ...ref });
    } else {
      const affected = per.filter((p) => p.impact === 'affected'), unknown = per.filter((p) => p.impact === 'unknown');
      impact = { impact: affected.length ? 'affected' : unknown.length ? 'unknown' : 'unaffected', builds: per };
      for (const a of affected) reasons.push({ code: 'affected_by_change', message: `Build ${a.shortSha}: ${a.reason}`, buildId: a.buildId, ...ref });
      if (!affected.length && unknown.length && policy.unknownImpactInvalidates)
        reasons.push({ code: patterns.length ? 'unknown_change_set' : 'unmapped', message: `Build ${unknown[0].shortSha}: ${unknown[0].reason}`, buildId: unknown[0].buildId, ...ref });
    }
  }
  if (reasons.length) return { state: 'STALE', reasons, impact };
  const carried = build && r.build_id !== build.id;
  return { state: 'CURRENT', impact, reasons: [{ code: carried ? 'carried_forward' : build ? 'verified_on_build' : 'no_build_tracking',
    message: carried ? `Passed in run #${l.run_id}; no build since then changed files in its mapping.` : build ? `Passed in run #${l.run_id} on build ${build.commit_sha.slice(0, 7)}.` : `Passed in run #${l.run_id}. No builds are registered, so change impact is not tracked.`, ...ref }] };
}

// ---------- risk ----------
/** Ordinal prioritisation built from listed factors. It is not a probability and never affects the verdict. */
function riskFor(c, fresh, stab) {
  const f = [];
  const crit = CRITICALITY.indexOf(c.criticality);
  if (crit > 0) f.push({ factor: 'criticality', points: crit, detail: `Declared ${c.criticality}` });
  if (c.mandatory) f.push({ factor: 'mandatory', points: 1, detail: 'Mandatory for release' });
  const fp = { FAILED: 4, BLOCKED: 3, UNVERIFIED: 3, STALE: 2, CURRENT: 0 }[fresh.state];
  if (fp) f.push({ factor: 'evidence', points: fp, detail: `Evidence is ${fresh.state.toLowerCase()}: ${fresh.reasons[0].message}` });
  if (stab.classification === 'intermittent') f.push({ factor: 'stability', points: 2, detail: `Intermittent: ${stab.failures} of ${stab.sample} application outcomes failed` });
  else if (stab.classification === 'stable_fail') f.push({ factor: 'stability', points: 2, detail: `Failed in all ${stab.sample} recent application outcomes` });
  else if (stab.classification === 'insufficient_data') f.push({ factor: 'stability', points: 1, detail: `Only ${stab.sample} of ${stab.minSample} outcomes needed to judge stability` });
  else if (stab.failures) f.push({ factor: 'history', points: 1, detail: `${stab.failures} application failure(s) in the window` });
  if (!J(c.paths, []).length) f.push({ factor: 'coverage_gap', points: 1, detail: 'No source-path mapping: every change is treated as potentially affecting it' });
  const score = f.reduce((a, x) => a + x.points, 0);
  return { level: score >= 7 ? 'high' : score >= 4 ? 'medium' : 'low', score, factors: f };
}

// ---------- decision ----------
const ACTION = {
  FAILED: 'Fix the application, then re-verify from Failure analysis.', BLOCKED: 'Resolve the execution problem and re-run this criterion.',
  UNVERIFIED: 'Run this criterion.', STALE_EVIDENCE: 'Re-run this criterion against the current build.',
  CRITICAL_UNSTABLE: 'Investigate the intermittent failures; it must pass consistently before release.', NO_BUILD: 'Register the build being released.',
  NO_CRITERIA: 'Add at least one mandatory acceptance criterion.',
};
/**
 * The single source of truth for "can this ship". Combines the strict gate (unchanged) with
 * freshness and policy. `opts.build` pins the decision to a build; default is the newest one.
 */
export function computeDecision(db, project, opts = {}) {
  const { rules: policy, version: policyVersion } = getPolicy(db, project.id);
  const build = opts.build === undefined ? currentBuild(db, project.id) : opts.build;
  const base = criteriaStatus(db, project.id);
  const strict = releaseGate(base);
  const meta = new Map(db.all('SELECT id, criticality, areas, paths, version_id FROM criteria WHERE project_id = ?', project.id).map((r) => [r.id, r]));
  const ctx = { build, policy, policyVersion, engineVersion: opts.engineVersion || null, acceptFixture: !!opts.acceptFixture };
  const blocking = [];
  const criteria = base.map((b) => {
    const c = { ...b, ...meta.get(b.id) };
    const freshness = freshnessFor(db, c, ctx);
    const stability = stabilityFor(db, c, policy);
    const risk = riskFor(c, freshness, stability);
    const version = db.get('SELECT id, version, content_hash FROM criterion_versions WHERE id = ?', c.version_id);
    const ref = c.latest ? { resultId: c.latest.id, runId: c.latest.run_id } : {};
    const push = (code, message) => blocking.push({ code, criterionId: c.id, criterionKey: c.key, message, action: ACTION[code], ...ref });
    if (c.mandatory) {
      if (freshness.state === 'FAILED') push('FAILED', `${c.key} failed: ${freshness.reasons[0].message}`);
      else if (freshness.state === 'BLOCKED') push('BLOCKED', `${c.key} has no valid evidence: ${freshness.reasons[0].message}`);
      else if (freshness.state === 'UNVERIFIED') push('UNVERIFIED', `${c.key}: ${freshness.reasons[0].message}`);
      else if (freshness.state === 'STALE' && policy.requireCurrentEvidence) push('STALE_EVIDENCE', `${c.key} evidence is stale: ${freshness.reasons.map((r) => r.message).join(' ')}`);
    }
    if (policy.blockCriticalUnstable && c.criticality === 'critical' && stability.classification === 'intermittent')
      push('CRITICAL_UNSTABLE', `${c.key} is critical and intermittent (${stability.failures} of ${stability.sample} recent application outcomes failed).`);
    return { id: c.id, key: c.key, text: c.text, category: c.category, mandatory: c.mandatory, criticality: c.criticality, areas: J(c.areas, []), paths: J(c.paths, []),
      version: version ? { id: version.id, number: version.version, contentHash: version.content_hash } : null, status: c.status, freshness, stability, risk, latest: c.latest ? ref : null };
  });
  if (!base.some((c) => c.mandatory)) blocking.push({ code: 'NO_CRITERIA', message: base.length ? 'No mandatory acceptance criteria — a release cannot be verified without at least one.' : 'No acceptance criteria defined — nothing has been verified.', action: ACTION.NO_CRITERIA });
  if (policy.requireBuild && !build) blocking.push({ code: 'NO_BUILD', message: 'The policy requires a registered build, and none exists.', action: ACTION.NO_BUILD });
  const hard = blocking.some((b) => b.code === 'FAILED' || b.code === 'CRITICAL_UNSTABLE');
  const verdict = blocking.length === 0 && strict.verdict === 'verified' ? 'verified' : hard || strict.verdict === 'blocked' ? 'blocked' : 'unverified';
  const count = (s) => criteria.filter((c) => c.freshness.state === s).length;
  return { verdict, releaseAllowed: verdict === 'verified', decidedAt: now(), policy: { version: policyVersion, rules: policy, invariants: INVARIANTS },
    build: buildView(build), strictGate: { verdict: strict.verdict, totals: strict.totals }, blocking,
    freshness: { CURRENT: count('CURRENT'), STALE: count('STALE'), UNVERIFIED: count('UNVERIFIED'), FAILED: count('FAILED'), BLOCKED: count('BLOCKED') }, criteria };
}
export function persistDecision(db, project, decision, by) {
  const id = Number(db.run('INSERT INTO release_decisions (project_id, build_id, policy_version, verdict, decision, requested_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    project.id, decision.build?.id ?? null, decision.policy.version, decision.verdict, JSON.stringify(decision), by, decision.decidedAt).lastInsertRowid);
  return id;
}

/** Verification plan for a build: which criteria must run, which may be skipped, and why. */
export function impactPlan(db, project, build, opts = {}) {
  const decision = computeDecision(db, project, { ...opts, build });
  const items = decision.criteria.map((c) => {
    const direct = impactOf(c.paths, build);
    const fresh = c.freshness;
    const include = fresh.state !== 'CURRENT';
    const why = fresh.state === 'CURRENT' ? `Excluded — ${fresh.reasons[0].message}`
      : fresh.state === 'STALE' ? `Included — ${fresh.reasons.map((r) => r.message).join(' ')}`
      : `Included — ${fresh.state.toLowerCase()}: ${fresh.reasons[0].message}`;
    return { id: c.id, key: c.key, text: c.text, mandatory: c.mandatory, criticality: c.criticality, paths: c.paths, areas: c.areas,
      impact: direct.impact, impactReason: direct.reason, matched: direct.matched || [], freshness: fresh.state, include, why };
  });
  const n = (k) => items.filter((i) => i.impact === k).length;
  return { build: buildView(build), policyVersion: decision.policy.version, summary: { affected: n('affected'), unaffected: n('unaffected'), unknown: n('unknown'), toVerify: items.filter((i) => i.include).length, total: items.length },
    plan: items.filter((i) => i.include).map((i) => i.id), items };
}

// ---------- proof graph ----------
/** Everything that supports or invalidates one criterion, as linked records. */
export function traceCriterion(db, project, criterionId, opts = {}) {
  const c = db.get('SELECT * FROM criteria WHERE id = ? AND project_id = ?', criterionId, project.id);
  if (!c) return null;
  const decision = computeDecision(db, project, opts);
  const cur = decision.criteria.find((x) => x.id === c.id) || null;
  const builds = new Map(db.all('SELECT * FROM builds WHERE project_id = ?', project.id).map((b) => [b.id, b]));
  const executions = db.all(`SELECT r.*, n.trigger, n.parent_run_id FROM results r JOIN runs n ON n.id = r.run_id WHERE r.criterion_id = ? ORDER BY r.id DESC LIMIT 200`, c.id).map((r) => ({
    resultId: r.id, runId: r.run_id, trigger: r.trigger, parentRunId: r.parent_run_id, status: r.status, errorKind: r.error_kind, exitCode: r.exit_code, engine: r.engine,
    engineKind: !r.engine ? 'unknown' : /fixture/i.test(r.engine) ? 'test-fixture' : 'kane-cli', versionId: r.criterion_version_id, textHash: r.text_hash,
    appliesToCurrentText: r.text_hash === textHash(c.text), build: buildView(builds.get(r.build_id)), environment: r.environment, policyVersion: r.policy_version,
    summary: r.summary, reason: r.reason, startedAt: r.started_at, finishedAt: r.finished_at, durationMs: r.duration_ms,
    eventCount: db.get('SELECT COUNT(*) n FROM run_events WHERE result_id = ?', r.id).n,
    evidence: db.all('SELECT uid id, kind, name, url, size, sha256 FROM evidence WHERE result_id = ? ORDER BY id', r.id) }));
  return {
    project: { id: project.id, name: project.name },
    requirement: c.requirement_id ? db.get('SELECT id, text, created_at FROM requirements WHERE id = ?', c.requirement_id) : null,
    criterion: { id: c.id, key: c.key, text: c.text, archived: !!c.archived, createdAt: c.created_at, ...(cur ? { status: cur.status, freshness: cur.freshness, stability: cur.stability, risk: cur.risk, criticality: cur.criticality, areas: cur.areas, paths: cur.paths, mandatory: cur.mandatory, category: cur.category } : {}) },
    versions: db.all('SELECT * FROM criterion_versions WHERE criterion_id = ? ORDER BY version DESC', c.id).map((v) => ({ id: v.id, number: v.version, text: v.text, textHash: v.text_hash, contentHash: v.content_hash,
      category: v.category, mandatory: !!v.mandatory, criticality: v.criticality, areas: J(v.areas, []), paths: J(v.paths, []), createdAt: v.created_at, current: v.id === c.version_id,
      executions: db.get('SELECT COUNT(*) n FROM results WHERE criterion_version_id = ?', v.id).n })),
    executions,
    repairs: db.all('SELECT * FROM repair_tasks WHERE criterion_id = ? ORDER BY id DESC', c.id).map((t) => ({ id: t.id, status: t.status, originRunId: t.origin_run_id, sourceResultId: t.source_result_id,
      failures: t.failures, fixNote: t.fix_note, fixDeclaredBy: t.fix_declared_by, fixDeclaredAt: t.fix_declared_at, verifyRunId: t.verify_run_id, verifiedResultId: t.verified_result_id, closedAt: t.closed_at, createdAt: t.created_at })),
    decisions: db.all('SELECT id, build_id, policy_version, verdict, requested_by, created_at FROM release_decisions WHERE project_id = ? ORDER BY id DESC LIMIT 10', project.id)
      .map((d) => ({ id: d.id, verdict: d.verdict, policyVersion: d.policy_version, build: buildView(builds.get(d.build_id)), requestedBy: d.requested_by, createdAt: d.created_at })),
  };
}

// ---------- evidence integrity ----------
export const hashFile = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
/** Fill in hashes for evidence stored before hashing existed. */
export function backfillEvidenceHashes(db, evidenceRoot) {
  for (const e of db.all('SELECT id, rel_path FROM evidence WHERE sha256 IS NULL AND rel_path IS NOT NULL')) {
    const f = path.join(evidenceRoot, e.rel_path);
    if (fs.existsSync(f)) db.run('UPDATE evidence SET sha256 = ? WHERE id = ?', hashFile(f), e.id);
  }
}

// ---------- dossier ----------
export function buildDossier(db, project, keys, evidenceRoot, opts = {}) {
  const decision = computeDecision(db, project, opts);
  const decisionId = persistDecision(db, project, decision, opts.by || 'user');
  const builds = new Map(db.all('SELECT * FROM builds WHERE project_id = ?', project.id).map((b) => [b.id, b]));
  const tally = { kaneCli: 0, testFixture: 0, unverified: 0, missingEvidence: 0, evidenceMismatch: 0 };
  const evidenceIndex = [];
  const criteria = decision.criteria.map((c) => {
    const exec = db.all(`SELECT id, run_id, status, error_kind, exit_code, engine, build_id, environment, policy_version, criterion_version_id, started_at, finished_at FROM results
      WHERE criterion_id = ? AND status IN ('passed','failed','error','timeout') ORDER BY id`, c.id);
    const sup = c.freshness.state === 'CURRENT' && c.latest ? exec.find((e) => e.id === c.latest.resultId) : null;
    let supporting = null;
    if (sup) {
      const kind = !sup.engine ? 'unknown' : /fixture/i.test(sup.engine) ? 'test-fixture' : 'kane-cli';
      const files = db.all('SELECT uid, kind, name, url, size, sha256, rel_path FROM evidence WHERE result_id = ? ORDER BY id', sup.id).map((e) => {
        let integrity = 'link';
        if (e.rel_path) {
          const f = path.join(evidenceRoot, e.rel_path);
          integrity = !fs.existsSync(f) ? 'missing' : !e.sha256 ? 'unhashed' : hashFile(f) === e.sha256 ? 'ok' : 'mismatch';
          if (integrity === 'missing') tally.missingEvidence++; if (integrity === 'mismatch') tally.evidenceMismatch++;
          evidenceIndex.push({ id: e.uid, sha256: e.sha256 });
        }
        return { id: e.uid, kind: e.kind, name: e.name, size: e.size, sha256: e.sha256, url: e.url || undefined, integrity };
      });
      kind === 'test-fixture' ? tally.testFixture++ : tally.kaneCli++;
      supporting = { resultId: sup.id, runId: sup.run_id, exitCode: sup.exit_code, engine: sup.engine, engineKind: kind, commitSha: builds.get(sup.build_id)?.commit_sha ?? null,
        buildId: sup.build_id, environment: sup.environment, policyVersion: sup.policy_version, criterionVersionId: sup.criterion_version_id, finishedAt: sup.finished_at, evidence: files };
    } else tally.unverified++;
    return { key: c.key, criterionId: c.id, text: c.text, category: c.category, mandatory: c.mandatory, criticality: c.criticality, areas: c.areas, paths: c.paths, version: c.version,
      freshness: { state: c.freshness.state, reasons: c.freshness.reasons.map((r) => ({ code: r.code, message: r.message })) },
      stability: { classification: c.stability.classification, sample: c.stability.sample, failures: c.stability.failures },
      risk: { level: c.risk.level, score: c.risk.score, factors: c.risk.factors }, supportingExecution: supporting,
      executions: exec.map((e) => ({ resultId: e.id, runId: e.run_id, status: e.status, errorKind: e.error_kind, engine: e.engine, buildId: e.build_id, finishedAt: e.finished_at })) };
  });
  const payload = {
    schema: 'shipproof.dossier/v1', generatedAt: decision.decidedAt,
    project: { id: project.id, name: project.name, appUrl: project.app_url },
    build: decision.build ? { id: decision.build.id, commitSha: decision.build.commitSha, branch: decision.build.branch, environment: decision.build.environment, buildId: decision.build.buildId, appUrl: decision.build.appUrl, registeredAt: decision.build.createdAt } : null,
    policy: decision.policy,
    decision: { id: decisionId, verdict: decision.verdict, releaseAllowed: decision.releaseAllowed, decidedAt: decision.decidedAt, strictGate: decision.strictGate, freshness: decision.freshness,
      blocking: decision.blocking.map((b) => ({ code: b.code, criterionKey: b.criterionKey ?? null, message: b.message, action: b.action, runId: b.runId ?? null, resultId: b.resultId ?? null })) },
    executionSummary: tally,
    criteria,
    repairs: db.all('SELECT t.*, c.key FROM repair_tasks t JOIN criteria c ON c.id = t.criterion_id WHERE t.project_id = ? ORDER BY t.id', project.id).map((t) => ({ id: t.id, criterionKey: t.key, status: t.status,
      originRunId: t.origin_run_id, failures: t.failures, fixDeclaredBy: t.fix_declared_by, fixDeclaredAt: t.fix_declared_at, verifyRunId: t.verify_run_id, verifiedResultId: t.verified_result_id, closedAt: t.closed_at })),
    runs: db.all('SELECT id, trigger, status, build_id, started_at, finished_at FROM runs WHERE project_id = ? ORDER BY id', project.id).map((r) => ({ id: r.id, trigger: r.trigger, status: r.status, buildId: r.build_id, startedAt: r.started_at, finishedAt: r.finished_at })),
  };
  const payloadSha256 = sha256(canonical(payload));
  const sections = ['project', 'build', 'policy', 'decision', 'criteria', 'repairs', 'runs'];
  const manifest = { algorithm: 'ed25519', canonicalization: 'JSON with recursively sorted keys, no whitespace, UTF-8', keyId: keys.keyId, publicKey: keys.publicKey, payloadSha256,
    sectionSha256: Object.fromEntries(sections.map((k) => [k, sha256(canonical(payload[k] ?? null))])), evidence: evidenceIndex, signature: keys.sign(payloadSha256) };
  const document = { payload, manifest };
  const uid = newUid();
  db.run('INSERT INTO dossiers (uid, project_id, build_id, decision_id, verdict, payload_sha256, document, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    uid, project.id, decision.build?.id ?? null, decisionId, decision.verdict, payloadSha256, JSON.stringify(document), payload.generatedAt);
  return { uid, document };
}
