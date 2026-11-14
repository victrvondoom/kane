// Playtest Agent — Failure Reproduction & Evidence Engine.
// A defect is "reproduced" only when an independent replay was actually executed, persisted as its own
// run/result, and that replay failed too. Without an executed replay the investigation is INCONCLUSIVE.
import { now } from './db.js';
import { classifyFailure } from './gate.js';

export const DEFECT_STATUSES = {
  CONFIRMED_DEFECT: 'CONFIRMED_DEFECT',          // original failed AND an executed replay failed
  UNCONFIRMED_TRANSIENT: 'UNCONFIRMED_TRANSIENT', // original failed, executed replay passed
  INCONCLUSIVE: 'INCONCLUSIVE',                   // no replay executed, or the replay reached no verdict
  NOT_APPLICATION_FAILURE: 'NOT_APPLICATION_FAILURE', // original was an infrastructure failure; nothing to reproduce
  REJECTED: 'REJECTED',
};

const parseStep = (s) => { try { return typeof s === 'string' ? JSON.parse(s) : s || null; } catch { return null; } };

/**
 * Investigate a non-passing result. `replay` (optional) must perform a real, independent execution of the same
 * criterion and return { runId, resultId, status, errorKind, reason }. Its claim is re-checked against the
 * database by recordInvestigation(); a replay that left no matching result row cannot confirm a defect.
 */
export async function investigateFailure({ project, result, run, evidenceFiles = [], replay = null, reproducer = null }) {
  replay = replay || reproducer;
  const step = parseStep(result.failing_step);
  const criterionKey = result.criterion_key || 'UNKNOWN';
  const observedText = result.observed || result.summary || result.reason || 'Assertion failed';
  const cls = classifyFailure(result);
  let defectStatus = DEFECT_STATUSES.INCONCLUSIVE, reproduced = false, rep = null, detail;

  if (!cls.applicationDefect) {
    defectStatus = DEFECT_STATUSES.NOT_APPLICATION_FAILURE;
    detail = `Original execution was not an application failure (classified as ${result.error_kind || cls.failureClass}): ${cls.reason}. No replay was attempted and no application repair is warranted.`;
  } else if (!replay) {
    detail = 'No independent replay was executed, so the failure is neither confirmed nor refuted.';
  } else {
    try { rep = await replay({ project, result, criterionKey, step }); }
    catch (e) { rep = null; detail = `Replay could not be executed: ${e.message}`; }
    if (rep && rep.resultId && rep.status === 'failed' && !rep.errorKind) {
      defectStatus = DEFECT_STATUSES.CONFIRMED_DEFECT; reproduced = true;
      detail = `Independent replay (run #${rep.runId}, result #${rep.resultId}) failed as well: ${rep.reason || rep.summary || 'expected outcome not observed'}.`;
    } else if (rep && rep.resultId && rep.status === 'passed') {
      defectStatus = DEFECT_STATUSES.UNCONFIRMED_TRANSIENT;
      detail = `Independent replay (run #${rep.runId}, result #${rep.resultId}) passed; the original failure was not reproduced.`;
    } else if (rep) {
      detail = `Replay reached no verdict (${rep.status || 'not executed'}${rep.errorKind ? '/' + rep.errorKind : ''}): ${rep.reason || 'no detail'}.`;
    }
  }

  const stepsReproduced = rep?.resultId
    ? [{ action: 'replay_execution', target: project.app_url, runId: rep.runId, resultId: rep.resultId, status: rep.status, description: `Re-executed ${criterionKey} against ${project.app_url}` }]
    : [];
  const diagnosis = `Playtest Agent analysis for ${criterionKey}:\n` +
    `- Status: ${defectStatus}\n` +
    `- Failure class: ${cls.failureClass}\n` +
    `- Failing Step: ${step?.step != null ? step.step : 'N/A'} (${step?.remark || observedText})\n` +
    `- Independent Reproduction: ${reproduced ? 'SUCCESSFULLY REPRODUCED' : rep?.resultId ? 'NOT REPRODUCED' : 'NOT EXECUTED'}\n` +
    `- Details: ${detail}`;

  return {
    projectId: project.id, runId: run?.id || result.run_id, resultId: result.id, criterionKey, criterionId: result.criterion_id ?? null,
    defectStatus, classification: cls.failureClass, diagnosis, reproduced: reproduced ? 1 : 0,
    replayRunId: rep?.runId ?? null, replayResultId: rep?.resultId ?? null, replayStatus: rep?.status ?? null,
    stepsReproduced,
    evidenceList: evidenceFiles.map((f) => ({ name: f.name, kind: f.kind, mime: f.mime, relPath: f.rel_path || f.relPath })),
    createdAt: now(),
  };
}

/** A "reproduced" claim must be backed by a distinct, failed result row for the same criterion in the same project. */
function replayIsBacked(db, inv) {
  if (!inv.replayResultId || inv.replayResultId === inv.resultId) return false;
  const r = db.get(`SELECT r.status, r.error_kind, r.criterion_id, n.project_id FROM results r JOIN runs n ON n.id = r.run_id WHERE r.id = ? AND r.run_id = ?`, inv.replayResultId, inv.replayRunId);
  if (!r || r.project_id !== inv.projectId || r.status !== 'failed' || r.error_kind) return false;
  const orig = db.get('SELECT criterion_id FROM results WHERE id = ?', inv.resultId);
  return !!orig && orig.criterion_id === r.criterion_id;
}

export function recordInvestigation(db, investigation) {
  const inv = { ...investigation };
  if ((inv.reproduced || inv.defectStatus === DEFECT_STATUSES.CONFIRMED_DEFECT) && !replayIsBacked(db, inv)) {
    inv.reproduced = 0; inv.defectStatus = DEFECT_STATUSES.INCONCLUSIVE;
    inv.diagnosis = `${inv.diagnosis || ''}\n- Downgraded to INCONCLUSIVE: no persisted, failed replay execution of this criterion backs the reproduction claim.`.trim();
    investigation.reproduced = 0; investigation.defectStatus = inv.defectStatus; investigation.diagnosis = inv.diagnosis;
  }
  // Only references to executions that exist are stored.
  if (inv.replayRunId && !db.get('SELECT 1 FROM runs WHERE id = ?', inv.replayRunId)) inv.replayRunId = null;
  if (inv.replayResultId && !db.get('SELECT 1 FROM results WHERE id = ?', inv.replayResultId)) inv.replayResultId = null;
  const res = db.run(
    `INSERT INTO playtest_investigations (project_id, run_id, result_id, criterion_key, defect_status, diagnosis, reproduced, steps_reproduced, evidence_json, created_at,
       classification, replay_run_id, replay_result_id, replay_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    inv.projectId, inv.runId || null, inv.resultId || null, inv.criterionKey, inv.defectStatus, inv.diagnosis, inv.reproduced ? 1 : 0,
    JSON.stringify(inv.stepsReproduced || []), JSON.stringify(inv.evidenceList || []), inv.createdAt || now(),
    inv.classification || null, inv.replayRunId || null, inv.replayResultId || null, inv.replayStatus || null);
  return Number(res.lastInsertRowid);
}

const view = (db, row) => ({
  id: row.id, projectId: row.project_id, runId: row.run_id, resultId: row.result_id, criterionKey: row.criterion_key,
  defectStatus: row.defect_status, classification: row.classification, diagnosis: row.diagnosis, reproduced: !!row.reproduced,
  replay: row.replay_result_id ? { runId: row.replay_run_id, resultId: row.replay_result_id, status: row.replay_status,
    evidence: db.all('SELECT uid id, kind, name, sha256 FROM evidence WHERE result_id = ?', row.replay_result_id) } : null,
  stepsReproduced: JSON.parse(row.steps_reproduced || '[]'), evidenceList: JSON.parse(row.evidence_json || '[]'), createdAt: row.created_at,
});
export function getInvestigation(db, id) {
  const row = db.get('SELECT * FROM playtest_investigations WHERE id = ?', id);
  return row ? view(db, row) : null;
}
export function listInvestigations(db, projectId) {
  return db.all('SELECT * FROM playtest_investigations WHERE project_id = ? ORDER BY id DESC', projectId).map((r) => view(db, r));
}

/** Real replay through the verification queue: a new run of the same criterion, awaited by its own id. */
export function queueReplay({ db, runner, timeoutMs = 0 }) {
  return async ({ project, result }) => {
    if (!result.criterion_id) throw new Error('result has no criterion to replay');
    const runId = runner.enqueue({ projectId: project.id, criterionIds: [result.criterion_id], trigger: 'playtest_replay', parentRunId: result.run_id,
      note: `Independent replay of result #${result.id}` });
    const run = await runner.waitForRun(runId, timeoutMs);
    const r = db.get('SELECT * FROM results WHERE run_id = ? AND criterion_id = ? ORDER BY id LIMIT 1', runId, result.criterion_id);
    if (!r) return { runId, resultId: null, status: 'not_executed', reason: 'Replay run produced no result (criterion missing or archived).' };
    if (!run || run.status !== 'completed') return { runId, resultId: r.id, status: 'error', errorKind: r.error_kind || 'interrupted', reason: r.reason || 'Replay run did not complete.' };
    return { runId, resultId: r.id, status: r.status, errorKind: r.error_kind, reason: r.reason, summary: r.summary };
  };
}
