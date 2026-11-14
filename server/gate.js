// Derived truth: criterion status, release gate and repair tasks.
// Everything here is computed from persisted execution rows — never from user input or model opinion.
import { now, audit } from './db.js';
import { textHash } from './requirements.js';

const KIND = { auth: 'Kane CLI not authenticated', did_not_start: 'Kane CLI did not start', timeout: 'timeout', inconsistent: 'exit code and status disagreed', kane_not_installed: 'Kane CLI not installed', interrupted: 'execution interrupted', network: 'network unavailable', no_evidence: 'pass reported without evidence', target_blocked: 'target refused by server policy', spawn_failed: 'Kane CLI could not be started', runner: 'internal runner error' };
const TERMINAL = ['passed', 'failed', 'error', 'timeout'];

/** Status of each active criterion = its latest terminal result for the CURRENT criterion text. */
export function criteriaStatus(db, projectId) {
  const criteria = db.all('SELECT * FROM criteria WHERE project_id = ? AND archived = 0 ORDER BY id', projectId);
  return criteria.map((c) => {
    const hash = textHash(c.text);
    const latest = db.get(
      `SELECT id, run_id, status, error_kind, exit_code, summary, one_liner, reason, test_url, finished_at, duration_ms, failing_step
       FROM results WHERE criterion_id = ? AND text_hash = ? AND status IN ('passed','failed','error','timeout')
       ORDER BY id DESC LIMIT 1`, c.id, hash);
    const attempts = db.get(`SELECT COUNT(*) n FROM results WHERE criterion_id = ? AND status IN ('passed','failed','error','timeout')`, c.id).n;
    const evidenceCount = latest ? db.get('SELECT COUNT(*) n FROM evidence WHERE result_id = ?', latest.id).n : 0;
    let status = 'untested';
    if (latest) status = latest.status === 'passed' ? 'verified' : latest.status === 'failed' ? 'failed' : 'blocked';
    return { id: c.id, key: c.key, text: c.text, category: c.category, mandatory: !!c.mandatory, requirementId: c.requirement_id,
      status, attempts, evidenceCount,
      latest: latest ? { ...latest, failing_step: latest.failing_step ? JSON.parse(latest.failing_step) : null } : null };
  });
}

export function releaseGate(criteria) {
  const mandatory = criteria.filter((c) => c.mandatory);
  const count = (list, s) => list.filter((c) => c.status === s).length;
  const reasons = [];
  if (!criteria.length) reasons.push('No acceptance criteria defined — nothing has been verified.');
  else if (!mandatory.length) reasons.push('No mandatory acceptance criteria — a release cannot be verified without at least one.');
  for (const c of mandatory) {
    if (c.status === 'failed') reasons.push(`${c.key} failed in Kane CLI execution.`);
    else if (c.status === 'blocked') reasons.push(`${c.key} has no valid evidence: last execution ended without a verdict (${KIND[c.latest?.error_kind] || c.latest?.error_kind || c.latest?.status}).`);
    else if (c.status === 'untested') reasons.push(`${c.key} has never been executed against its current text.`);
  }
  const verdict = reasons.length === 0 ? 'verified' : mandatory.some((c) => c.status === 'failed') ? 'blocked' : 'unverified';
  return {
    verdict, reasons,
    totals: { total: criteria.length, verified: count(criteria, 'verified'), failed: count(criteria, 'failed'),
      blocked: count(criteria, 'blocked'), untested: count(criteria, 'untested'),
      mandatory: mandatory.length, mandatoryVerified: count(mandatory, 'verified') },
  };
}

const DIAG = {
  auth: 'Kane CLI could not authenticate, so no browser check ran. This is an environment problem, not an application defect.',
  kane_not_installed: 'Kane CLI is not installed on the verification server.',
  did_not_start: 'Kane CLI did not start the run (configuration, Chrome, network or start URL). Nothing was verified.',
  timeout: 'The run hit its time limit before reaching a verdict. The app may be slow or the criterion too broad for one run.',
  inconsistent: 'Kane CLI output and exit code disagreed; the result is treated as unverified.',
  spawn_failed: 'The Kane CLI process could not be started on the server.',
  network: 'Kane CLI could not reach the network (TestMu AI service or the target application). Nothing was verified.',
  no_evidence: 'Kane CLI reported a pass, but no evidence artifact was produced or collected. Without evidence the criterion stays unverified.',
  target_blocked: 'The application URL is not allowed by this server\'s target policy, so Kane CLI was not started.',
  interrupted: 'The server stopped while this check was in flight. Re-run it.',
  runner: 'An internal error stopped this check before a verdict.',
};
/**
 * What kind of non-pass is this? Only an engine verdict of `failed` (a completed run whose expected outcome was
 * not observed) is an application defect. Everything else is infrastructure: nothing was verified, so nothing
 * about the application is known and application source must never be repaired on its account.
 */
const FAILURE_CLASS = { auth: 'authentication', network: 'network', timeout: 'timeout', interrupted: 'interrupted', cancelled: 'interrupted',
  no_evidence: 'missing_evidence', target_blocked: 'environment', kane_not_installed: 'engine_error', did_not_start: 'engine_error',
  inconsistent: 'engine_error', spawn_failed: 'engine_error', runner: 'engine_error' };
export function classifyFailure(result) {
  if (!result) return { failureClass: 'no_execution', applicationDefect: false, repairable: false, reason: 'No execution record exists.' };
  if (result.status === 'passed') return { failureClass: 'none', applicationDefect: false, repairable: false, reason: null };
  if (result.status === 'failed' && !result.error_kind)
    return { failureClass: 'application_defect', applicationDefect: true, repairable: true, reason: result.reason || result.summary || 'Expected outcome was not observed.' };
  if (['queued', 'starting', 'running'].includes(result.status))
    return { failureClass: 'pending', applicationDefect: false, repairable: false, reason: 'Execution has not finished.' };
  const failureClass = result.status === 'timeout' ? 'timeout' : result.status === 'cancelled' ? 'interrupted' : FAILURE_CLASS[result.error_kind] || 'engine_error';
  return { failureClass, applicationDefect: false, repairable: false, reason: result.reason || explainError(result.error_kind) };
}
export const explainError = (kind) => DIAG[kind] || 'Execution ended without a verdict.';

/** Called once per finished result. Opens/updates a repair task on genuine failure, verifies it on a later pass. */
export function syncRepairTask(db, result, project) {
  const open = db.get(`SELECT * FROM repair_tasks WHERE criterion_id = ? AND status != 'verified' ORDER BY id DESC LIMIT 1`, result.criterion_id);
  if (result.status === 'passed') {
    if (open) {
      // Only a passing execution of this exact criterion closes its task.
      db.run(`UPDATE repair_tasks SET status = 'verified', verified_result_id = ?, verify_run_id = ?, closed_at = ?, updated_at = ? WHERE id = ?`, result.id, result.run_id, now(), now(), open.id);
      audit(db, { projectId: project.id, actor: 'engine', action: 'repair_task.verified', entity: 'repair_task', entityId: open.id, detail: { criterion: result.criterion_key, runId: result.run_id, resultId: result.id } });
    }
    return;
  }
  if (result.status !== 'failed') return; // errors/timeouts are not application defects
  const step = result.failing_step ? JSON.parse(result.failing_step) : null;
  const observed = [result.summary, result.reason && result.reason !== result.summary ? result.reason : null,
    step?.remark ? `Failing step${step.step != null ? ' ' + step.step : ''}: ${step.remark}` : null].filter(Boolean).join('\n')
    || 'Kane CLI reported the objective as not passed without further detail (see execution log).';
  const diagnosis = `Kane CLI drove a real browser against ${project.app_url} and the expected outcome was not observed. ` +
    `The implementation does not satisfy ${result.criterion_key}; fix the application, not the criterion.`;
  if (open) {
    db.run(`UPDATE repair_tasks SET status = 'open', source_result_id = ?, observed = ?, diagnosis = ?, failures = failures + 1, updated_at = ? WHERE id = ?`,
      result.id, observed, diagnosis, now(), open.id);
    audit(db, { projectId: project.id, actor: 'engine', action: 'repair_task.failed_again', entity: 'repair_task', entityId: open.id, detail: { criterion: result.criterion_key, runId: result.run_id, resultId: result.id } });
  } else {
    const r = db.run(`INSERT INTO repair_tasks (project_id, criterion_id, source_result_id, origin_run_id, status, expected, observed, diagnosis, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`, project.id, result.criterion_id, result.id, result.run_id, result.criterion_text, observed, diagnosis, now(), now());
    audit(db, { projectId: project.id, actor: 'engine', action: 'repair_task.opened', entity: 'repair_task', entityId: Number(r.lastInsertRowid), detail: { criterion: result.criterion_key, runId: result.run_id, resultId: result.id } });
  }
}

export function repairTaskView(db, t, baseUrl = '') {
  const r = db.get('SELECT id, run_id, criterion_key, criterion_text, objective, command, exit_code, kane_status, summary, reason, test_url, finished_at, failing_step FROM results WHERE id = ?', t.source_result_id);
  const p = db.get('SELECT name, app_url FROM projects WHERE id = ?', t.project_id);
  const ev = db.all('SELECT uid id, kind, name, url, mime FROM evidence WHERE result_id = ?', t.source_result_id);
  const verified = t.verified_result_id ? db.get('SELECT id, run_id, finished_at FROM results WHERE id = ?', t.verified_result_id) : null;
  const evidenceLines = ev.slice(0, 12).map((e) => `- ${e.kind}: ${e.url || `${baseUrl}/api/evidence/${e.id}/file`} (${e.name})`);
  const prompt = [
    `# Repair task RT-${t.id} — ${r.criterion_key} failed real-browser verification`,
    '', `Application under test: ${p.app_url}`, `Project: ${p.name}`, '',
    '## Acceptance criterion (do NOT edit, weaken or delete it)', r.criterion_text, '',
    '## Expected', t.expected, '', '## Observed by Kane CLI', t.observed, '',
    '## Diagnosis', t.diagnosis, '',
    '## Execution', `- Kane exit code: ${r.exit_code}`, `- Kane status: ${r.kane_status ?? 'n/a'}`,
    `- Finished: ${r.finished_at}`, r.test_url ? `- Test Manager: ${r.test_url}` : null,
    evidenceLines.length ? '\n## Evidence' : null, ...evidenceLines, '',
    '## What to do', '1. Reproduce the flow above in the application code.', '2. Fix the implementation so the expected outcome is observable to a real user.',
    '3. Do not modify the acceptance criterion or any test to force a pass.',
    `4. Report the fix, then SHIPPROOF re-runs ${r.criterion_key} through Kane CLI. Only that run can close this task.`,
  ].filter((l) => l !== null).join('\n');
  return { id: t.id, status: t.status, criterionId: t.criterion_id, criterionKey: r.criterion_key, criterionText: r.criterion_text,
    expected: t.expected, observed: t.observed, diagnosis: t.diagnosis, failures: t.failures, fixNote: t.fix_note,
    createdAt: t.created_at, updatedAt: t.updated_at, originRunId: t.origin_run_id, fixDeclaredAt: t.fix_declared_at, fixDeclaredBy: t.fix_declared_by,
    verifyRunId: t.verify_run_id, closedAt: t.closed_at,
    timeline: db.all(`SELECT ts, actor, action, detail FROM audit_events WHERE entity = 'repair_task' AND entity_id = ? ORDER BY id`, t.id).map((e) => ({ ...e, detail: JSON.parse(e.detail) })),
    sourceResult: { ...r, failing_step: r.failing_step ? JSON.parse(r.failing_step) : null },
    verifiedBy: verified, evidence: ev, prompt };
}
export { TERMINAL };
