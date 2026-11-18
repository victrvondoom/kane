// Agent completion gate: decides whether a coding agent may declare its task complete.
//   evaluateStop()   pure decision over facts (unit-tested)
//   runStopGate()    takes the live snapshot, runs impacted criteria through Kane, persists the outcome
// Fail-closed: anything that cannot be established (no baseline, invalid spec, protected edits, failed or
// unverified criteria) blocks completion. Blocking is bounded per turn; after the bound the stop is allowed
// only as an explicit NEEDS_HUMAN record, never as a pass.
import { loadSpec, matchesAny, SpecError } from './spec.js';
import { snapshot, diffMaps, diffIsEmpty, diffPaths, mapOf } from './fingerprint.js';
import { verifyCriteria, isUnresolved } from './verify.js';
import { loadSession, saveSession, loadCache, saveCache, runsRootOf } from './state.js';
import { kaneConfig } from '../kane.js';
import { loadTenantConfig } from '../tenantseal/config.js';
import { runTenantScan } from '../tenantseal/scan.js';

export const DEFAULT_MAX_BLOCKS = 3;

// Changes to documentation, images, logs and lock files cannot change application behaviour, so they never
// trigger verification (they would only spend Kane runs).
const IRRELEVANT = /\.(md|mdx|txt|rst|png|jpe?g|gif|svg|webp|ico|map|log|lock)$/i;
export const isRelevantPath = (p) => !IRRELEVANT.test(p) && !/^(LICENSE|CHANGELOG)/i.test(p);

/** Criteria to run for a set of changed application files. Conservative when nothing maps. */
export function impactedCriteria(spec, changedPaths) {
  const mapped = spec.criteria.filter((c) => c.paths.length && changedPaths.some((p) => matchesAny(p, c.paths)));
  const withoutScope = spec.criteria.filter((c) => c.paths.length === 0);
  if (mapped.length === 0) {
    return { ids: spec.criteria.map((c) => c.id), mode: 'all', reason: 'No criterion maps to the changed files, so every criterion is run (conservative).' };
  }
  const ids = spec.criteria.filter((c) => mapped.includes(c) || withoutScope.includes(c)).map((c) => c.id);
  return { ids, mode: 'mapped', reason: `${mapped.length} criteria map to the changed files${withoutScope.length ? ' (plus criteria without a path scope)' : ''}.` };
}

const ENV_KINDS = ['auth', 'network', 'kane_not_installed', 'spawn_failed', 'incompatible', 'environment'];

/**
 * Map a TenantSeal scan onto the gate's result shape. SEALED passes; LEAKING fails with the evidence path; anything
 * else is unverified (never a pass). Returns null when the project has no TenantSeal configuration or the changes
 * are not security-relevant.
 */
export async function tenantResult(cwd, changedPaths, config = kaneConfig()) {
  let tcfg;
  try { tcfg = loadTenantConfig(cwd); }
  catch (e) { return { id: 'TENANTSEAL', text: 'Tenant isolation', status: 'error', errorKind: 'environment', reason: `TenantSeal configuration invalid: ${e.message}` }; }
  if (!tcfg || !changedPaths.some((p) => matchesAny(p, tcfg.securityPaths))) return null;
  const engineKind = process.env.SHIPPROOF_TENANT_ENGINE === 'simulated' ? 'simulated' : 'kane';
  const scan = await runTenantScan({ cwd, config: tcfg, engineKind });
  const reportDir = `.tenantseal/scans/${scan.scanId}`;
  const reasons = (scan.reasons || []).join('; ');
  if (scan.verdict === 'SEALED' || scan.verdict === 'SIMULATED_SEALED') {
    return { id: 'TENANTSEAL', text: 'Tenant isolation: no cross-tenant read, write or owner lockout', status: 'passed', errorKind: null, reason: scan.verdict, evidenceDir: reportDir };
  }
  if (scan.verdict === 'LEAKING') {
    return { id: 'TENANTSEAL', text: 'Tenant isolation: no cross-tenant read, write or owner lockout', status: 'failed', errorKind: null, reason: `LEAKING: ${reasons}`, evidenceDir: reportDir, failingStep: null };
  }
  return { id: 'TENANTSEAL', text: 'Tenant isolation', status: 'error', errorKind: 'environment', reason: `${scan.verdict}: ${reasons}`, evidenceDir: reportDir };
}

function resultLine(r) {
  if (r.status === 'failed') {
    const step = r.failingStep ? ` Failing step ${r.failingStep.step ?? '?'}: ${r.failingStep.remark ?? ''}.` : '';
    return `- ${r.id} FAILED: ${r.text}\n  Kane: ${r.reason || 'Objective did not pass.'}${step}\n  Evidence: ${r.evidenceDir}`;
  }
  if (r.status === 'reused' || r.status === 'passed') return `- ${r.id} passed.`;
  const env = ENV_KINDS.includes(r.errorKind);
  return `- ${r.id} NOT VERIFIED (${r.status}${r.errorKind ? ', ' + r.errorKind : ''}): ${r.reason || 'no verdict'}${env ? '\n  This is an environment problem, not a defect in the application. Completion stays unverified until it is fixed.' : ''}`;
}

/**
 * Pure decision. Inputs are facts; output is what the Stop hook does.
 *   decision: 'allow' | 'block' | 'needs_human'
 */
export function evaluateStop({ hasBaseline = true, specError = null, hasSpec = true, protectedChanged = [], sourceChanged = false,
  results = [], blocks = 0, maxBlocks = DEFAULT_MAX_BLOCKS }) {
  const exhausted = blocks >= maxBlocks;
  const stop = (decision, code, message, unresolved = []) => {
    if (decision === 'block' && exhausted) {
      return { decision: 'needs_human', code: 'NEEDS_HUMAN', unresolved, message:
        `NOT VERIFIED. The agent was blocked ${blocks} time(s) in this turn (${code}) and the completion is now allowed only as an unresolved record. A person must resolve this before any release.\n${message}` };
    }
    return { decision, code, unresolved, message };
  };

  if (!hasBaseline) return stop('block', 'NO_BASELINE',
    'The completion gate has no baseline for this turn, so it cannot tell what changed. Start the next task with the SHIPPROOF hooks installed (`shipproof hook install`).');
  // Tampering is checked before validity: an emptied or broken specification is itself a protected change.
  if (protectedChanged.length) return stop('block', 'PROTECTED_MODIFIED',
    `Protected files were modified during this task: ${protectedChanged.join(', ')}.\nAcceptance criteria, gate configuration and agent settings cannot be changed by the agent. Restore those files to their original content (for example \`git checkout -- <file>\`) and repair the application code instead.`);
  if (specError) return stop('block', 'SPEC_INVALID', `The acceptance specification is invalid: ${specError}. Fix .shipproof/criteria.json.`);
  if (!hasSpec && sourceChanged) return stop('block', 'NO_SPEC',
    'Application code changed but this project has no acceptance criteria. Run `shipproof init` and define the criteria the change must satisfy.');
  if (!sourceChanged) return { decision: 'allow', code: 'NO_APP_CHANGES', unresolved: [], message: 'No application code changed in this turn; no verification was required.' };

  const failed = results.filter((r) => r.status === 'failed');
  const unresolved = results.filter(isUnresolved);
  if (failed.length) {
    const lines = results.filter((r) => r.status === 'failed' || isUnresolved(r)).map(resultLine).join('\n');
    return stop('block', 'CRITERIA_FAILED',
      `Kane verification failed for ${failed.length} acceptance criteri${failed.length === 1 ? 'on' : 'a'}:\n${lines}\nRepair the application so the criteria pass. Do not edit .shipproof/, .claude/, the criterion text, or the tests to make a failure disappear.`,
      failed.map((r) => r.id));
  }
  if (unresolved.length) {
    return stop('block', 'VERIFICATION_INCOMPLETE',
      `Acceptance verification did not complete:\n${unresolved.map(resultLine).join('\n')}`,
      unresolved.map((r) => r.id));
  }
  return { decision: 'allow', code: 'VERIFIED', unresolved: [], message: `Verified: ${results.map((r) => (r.id === 'TENANTSEAL' && r.reason ? `${r.id} ${r.reason}` : r.id)).join(', ')} passed on the current source.` };
}

/**
 * The live Stop-hook gate. Persists the session block counter and the verification cache.
 * Never throws: an internal error is reported as a block (fail-closed), subject to the same bound.
 */
export async function runStopGate({ cwd, sessionId, config = kaneConfig(), maxBlocks = DEFAULT_MAX_BLOCKS, maxRuns = 10 }) {
  const session = loadSession(cwd, sessionId) || { sessionId, baseline: null, blocks: 0 };
  let spec = null, specError = null;
  try { spec = loadSpec(cwd); } catch (e) { specError = e instanceof SpecError ? e.message : `unexpected error: ${e.message}`; }

  let decision;
  try {
    const now = snapshot(cwd, spec);
    const base = session.baseline;
    const hasBaseline = !!base;
    const srcDiff = hasBaseline ? diffMaps(mapOf(base.sourceFiles), mapOf(now.sourceFiles)) : null;
    const protDiff = hasBaseline ? diffMaps(mapOf(base.protectedFiles), mapOf(now.protectedFiles)) : null;
    const relevantChanged = hasBaseline ? diffPaths(srcDiff).filter(isRelevantPath) : [];
    const sourceChanged = relevantChanged.length > 0;
    const protectedChanged = hasBaseline ? diffPaths(protDiff) : [];

    let results = [], impacted = null, engine = null;
    const needsRun = hasBaseline && !specError && spec && sourceChanged && !protectedChanged.length;
    if (needsRun) {
      impacted = impactedCriteria(spec, relevantChanged);
      const cache = loadCache(cwd);
      const out = await verifyCriteria({ spec, cwd, sourceMap: mapOf(now.sourceFiles), runsRoot: runsRootOf(cwd), cache,
        ids: impacted.ids, config, maxRuns });
      saveCache(cwd, cache);
      results = out.results; engine = out.engine;
      // TenantSeal: a change to security-relevant code also needs a tenant-isolation scan before completion.
      const tenant = await tenantResult(cwd, relevantChanged, config);
      if (tenant) results.push(tenant);
    }
    decision = evaluateStop({ hasBaseline, specError, hasSpec: !!spec, protectedChanged, sourceChanged, results,
      blocks: session.blocks || 0, maxBlocks });
    decision = { ...decision, results, impacted, engine, protectedChanged, sourceChanged, changedSource: relevantChanged };
  } catch (e) {
    const d = evaluateStop({ hasBaseline: true, specError: null, hasSpec: true, sourceChanged: true,
      results: [{ id: 'gate', text: 'gate', status: 'error', errorKind: 'internal', reason: e.message }], blocks: session.blocks || 0, maxBlocks });
    decision = { ...d, message: `The completion gate failed internally: ${e.message}\n${d.message}`, results: [], protectedChanged: [], sourceChanged: true, changedSource: [], impacted: null, engine: null };
  }

  // Persist the turn state. Blocks are counted per turn; a new user prompt resets them (see hooks.js).
  const next = { ...session, lastDecision: { decision: decision.decision, code: decision.code, at: new Date().toISOString() } };
  if (decision.decision === 'block') next.blocks = (session.blocks || 0) + 1;
  if (decision.decision === 'needs_human') next.humanRequired = { code: decision.code, unresolved: decision.unresolved, at: new Date().toISOString() };
  saveSession(cwd, sessionId, next);
  return { ...decision, blocks: next.blocks || 0, maxBlocks, sessionId };
}
