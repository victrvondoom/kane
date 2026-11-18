// Runs acceptance criteria against the real application through the existing Kane CLI adapter
// (server/kane.js). Every outcome is classified by kane.js `classify`: only an explicit, evidence-backed pass is
// a pass. Environment problems (missing binary, not signed in, network) are reported as unverified, never as a
// defect in the application and never as a pass.
import path from 'node:path';
import crypto from 'node:crypto';
import { runKane, classify, buildObjective, collectEvidence, failingStep, kaneStatus, kaneConfig } from '../kane.js';
import { scopeFingerprint } from './fingerprint.js';

// Errors that mean the environment cannot verify anything; further runs in this pass would fail the same way.
const ABORTING = new Set(['auth', 'network', 'kane_not_installed', 'spawn_failed', 'incompatible']);
const ENGINE_STATE_KIND = { unavailable: 'kane_not_installed', not_authenticated: 'auth', incompatible: 'incompatible' };

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * Verify the selected criteria. Returns { engine, results[], runs } and never throws for expected failures.
 *   sourceMap   Map(path -> sha) of application source (from fingerprint.partition)
 *   cache       mutable object: criterionId -> { key, status, runId, at }; only passes are cached
 */
export async function verifyCriteria({ spec, cwd, sourceMap, runsRoot, cache = {}, ids = null, config = kaneConfig(), maxRuns = 10, onProgress = () => {} }) {
  const engineStatus = await kaneStatus(config, { fresh: true });
  const engine = engineStatus.isFixture ? `TEST FIXTURE ${engineStatus.version} (not Kane evidence)`
    : engineStatus.version ? `kane-cli ${engineStatus.version}` : 'kane-cli (not installed)';
  const selected = spec.criteria.filter((c) => !ids || ids.includes(c.id));
  const results = [];
  let runs = 0;
  let abort = null;

  // Do not start a browser run that the engine state already says cannot succeed.
  if (!engineStatus.ready && engineStatus.state !== 'test_fixture') {
    const errorKind = ENGINE_STATE_KIND[engineStatus.state] || 'kane_not_installed';
    abort = { errorKind, reason: engineStatus.detail };
  }

  for (const c of selected) {
    const scopeFp = scopeFingerprint(sourceMap, c.paths);
    const key = sha(JSON.stringify({ text: c.text, scopeFp, url: spec.app.url, context: spec.app.context, engine }));
    const base = { id: c.id, text: c.text };
    const prev = cache[c.id];
    if (prev && prev.key === key && prev.status === 'passed') {
      const r = { ...base, status: 'reused', errorKind: null, reason: 'Source for this criterion, the target and the Kane engine are unchanged since its last pass.', runId: prev.runId, cacheKey: key };
      results.push(r); onProgress(r); continue;
    }
    if (abort) {
      const r = { ...base, status: 'not_run', errorKind: abort.errorKind, reason: `Not run: ${abort.reason}`, cacheKey: key };
      results.push(r); onProgress(r); continue;
    }
    if (runs >= maxRuns) {
      const r = { ...base, status: 'not_run', errorKind: 'budget', reason: `Run budget of ${maxRuns} executions for this pass was reached.`, cacheKey: key };
      results.push(r); onProgress(r); continue;
    }

    runs++;
    const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${c.id}`;
    const workDir = path.join(runsRoot, runId);
    const objective = buildObjective({ appUrl: spec.app.url, context: spec.app.context, criterionText: c.text });
    const outcome = await runKane({ objective, url: spec.app.url, workDir, config });
    const cls = classify(outcome);
    let { status, errorKind, reason } = cls;
    let evidence = [];
    if (status === 'passed' || status === 'failed') {
      evidence = collectEvidence({ outcome, workDir, destDir: path.join(workDir, 'evidence') });
    }
    if (status === 'passed' && config.requireEvidence && evidence.length === 0) {
      status = 'error'; errorKind = 'missing_evidence';
      reason = 'Kane reported a pass but produced no evidence artifacts. Treated as unverified.';
    }
    const r = {
      ...base,
      status, errorKind, reason,
      runId,
      evidenceDir: path.relative(cwd, path.join(workDir, 'evidence')).replace(/\\/g, '/'),
      evidence: evidence.map((e) => ({ kind: e.kind, name: e.name, sha256: e.sha256 })),
      failingStep: status === 'failed' ? failingStep(outcome.events) : null,
      durationMs: outcome.durationMs,
      creditsConsumed: outcome.runEnd?.credits_consumed ?? null, // measured by Kane, or null
      engine: outcome.engine || engine,
      cacheKey: key,
    };
    if (status === 'passed') cache[c.id] = { key, status, runId, at: new Date().toISOString() };
    else delete cache[c.id];
    if (ABORTING.has(errorKind)) abort = { errorKind, reason };
    results.push(r); onProgress(r);
  }
  return { engine, results, runs, engineState: engineStatus.state };
}

export const isUnresolved = (r) => !['passed', 'reused'].includes(r.status);
