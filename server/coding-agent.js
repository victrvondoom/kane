// Coding Agent Adapter & Feedback Bridge
// Formulates repair dossiers from Kane failures and Playtest investigations,
// executes targeted code repairs within authorized workspace boundaries,
// and enforces retry limits.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { now } from './db.js';
import { DEFECTS, defectFor, setDefectState } from './demo-defects.js';

export const MAX_REPAIR_ATTEMPTS = 3;

/**
 * Construct the structured failure dossier for the coding agent.
 */
export function buildFailureDossier({
  task,
  specification,
  failedResult,
  playtestInvestigation,
  sourceFiles = [],
}) {
  const step = failedResult.failing_step
    ? (typeof failedResult.failing_step === 'string' ? JSON.parse(failedResult.failing_step) : failedResult.failing_step)
    : null;

  return {
    taskId: task?.id || 'TASK-REPAIR',
    taskDescription: task?.description || 'Fix reported application discrepancy',
    criterionKey: failedResult.criterion_key,
    criterionText: failedResult.criterion_text,
    failingStepNumber: step?.step ?? null,
    failingStepRemark: step?.remark || failedResult.observed || failedResult.reason,
    expectedOutcome: specification?.expected || failedResult.expected || 'Assertion condition holds true',
    observedOutcome: failedResult.observed || failedResult.summary || failedResult.reason,
    playtestDiagnosis: playtestInvestigation?.diagnosis || 'Kane CLI test failed during browser execution',
    defectConfirmed: playtestInvestigation ? !!playtestInvestigation.reproduced : true,
    evidenceReferences: (failedResult.evidence || []).map((e) => ({
      kind: e.kind,
      name: e.name,
      url: e.url || null,
    })),
    relevantFiles: sourceFiles,
  };
}

const fileSha = (workspaceDir, rel) => {
  const f = path.resolve(workspaceDir, rel);
  if (!f.startsWith(path.resolve(workspaceDir) + path.sep) || !fs.existsSync(f)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
};

/**
 * Execute one repair attempt. Records what actually changed (file hashes); an attempt that changed nothing is
 * `proposed`, never `applied`. A repeated submission of the same attempt number returns the stored attempt and
 * does not touch the workspace again. Source is only modified when `mutationAuthorized` is true.
 */
export async function executeRepair({ db, executionId, attemptNumber, workspaceDir, dossier, repairFn = null, mutationAuthorized = false, sourceResultId = null }) {
  if (db && executionId) {
    const prior = db.get('SELECT * FROM agent_repair_attempts WHERE execution_id = ? AND attempt_number = ?', executionId, attemptNumber);
    if (prior) return { status: prior.status, patchSummary: prior.patch_summary, changedFiles: JSON.parse(prior.changed_files_json || '[]'), attemptNumber, attemptId: prior.id, duplicate: true, needsHumanApproval: prior.status !== 'applied' };
  }
  if (attemptNumber > MAX_REPAIR_ATTEMPTS) {
    return { status: 'escalated', patchSummary: `Maximum repair attempts (${MAX_REPAIR_ATTEMPTS}) exceeded. Escalated to human review.`, changedFiles: [], needsHumanApproval: true };
  }
  let patchSummary = '', changedFiles = [], hashes = [];
  if (!mutationAuthorized) {
    patchSummary = 'No source change was made: modifying the server workspace is not authorized for this user/environment.';
  } else if (repairFn) {
    const res = await repairFn({ workspaceDir, dossier, attemptNumber });
    patchSummary = res.patchSummary || 'Custom repair applied';
    // Only files that exist inside the workspace count as changed.
    changedFiles = (res.changedFiles || []).filter((f) => fileSha(workspaceDir, f));
    hashes = changedFiles.map((f) => ({ file: f, afterSha256: fileSha(workspaceDir, f) }));
  } else {
    // Built-in deterministic repair for the bundled demo store only (not a general coding agent).
    const key = defectFor(dossier.criterionText);
    try {
      const r = key ? setDefectState(workspaceDir, key, false) : null;
      if (r?.changed) {
        changedFiles = [r.file]; hashes = [{ file: r.file, beforeSha256: r.beforeSha256, afterSha256: r.afterSha256 }];
        patchSummary = `Built-in demo repair for "${key}": ${DEFECTS[key].description} Replaced \`${DEFECTS[key].defective}\` with \`${DEFECTS[key].healthy}\` in ${r.file}.`;
      } else patchSummary = r ? `No change made: ${r.file} already contains the corrected line.` : `No built-in repair exists for ${dossier.criterionKey}; no file was modified.`;
    } catch (e) { patchSummary = `No change made: ${e.message}`; }
  }
  const status = changedFiles.length ? 'applied' : 'proposed';
  let attemptId = null;
  if (db && executionId) {
    attemptId = Number(db.run(`INSERT INTO agent_repair_attempts (execution_id, attempt_number, patch_summary, changed_files_json, status, created_at, file_hashes_json, source_result_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, executionId, attemptNumber, patchSummary, JSON.stringify(changedFiles), status, now(), JSON.stringify(hashes), sourceResultId).lastInsertRowid);
  }
  return { status, patchSummary, changedFiles, fileHashes: hashes, attemptNumber, attemptId, duplicate: false, needsHumanApproval: status !== 'applied' };
}

export function listRepairAttempts(db, executionId) {
  const rows = db.all('SELECT * FROM agent_repair_attempts WHERE execution_id = ? ORDER BY attempt_number', executionId);
  return rows.map((r) => ({
    id: r.id,
    executionId: r.execution_id,
    attemptNumber: r.attempt_number,
    patchSummary: r.patch_summary,
    changedFiles: JSON.parse(r.changed_files_json || '[]'),
    status: r.status,
    createdAt: r.created_at,
  }));
}

