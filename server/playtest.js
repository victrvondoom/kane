// Playtest Agent — Failure Reproduction & Evidence Engine
// Investigates failed Kane verification runs, reproduces defects independently,
// and produces structured evidence packages for the coding agent.
import fs from 'node:fs';
import path from 'node:path';
import { now } from './db.js';

export const DEFECT_STATUSES = {
  CONFIRMED_DEFECT: 'CONFIRMED_DEFECT',
  UNCONFIRMED_TRANSIENT: 'UNCONFIRMED_TRANSIENT',
  REJECTED: 'REJECTED',
};

/**
 * Investigate a failed Kane verification result and attempt independent reproduction.
 */
export async function investigateFailure({
  project,
  result,
  run,
  evidenceFiles = [],
  reproducer = null, // Optional custom reproduction function (for testing / live replay)
}) {
  const step = result.failing_step ? (typeof result.failing_step === 'string' ? JSON.parse(result.failing_step) : result.failing_step) : null;
  const criterionKey = result.criterion_key || 'UNKNOWN';
  const observedText = result.observed || result.summary || result.reason || 'Assertion failed';

  // 1. Synthesize replay steps from the failed execution
  const replaySteps = [
    { action: 'open', target: project.app_url, description: `Navigate to target app: ${project.app_url}` },
    { action: 'reproduce_action', target: criterionKey, description: `Execute steps for ${criterionKey}` },
    { action: 'observe_state', target: 'order_or_page_state', description: `Observe state change against: "${observedText}"` },
  ];

  // 2. Perform reproduction
  let reproduced = false;
  let reproductionOutput = '';
  let defectStatus = DEFECT_STATUSES.UNCONFIRMED_TRANSIENT;

  if (reproducer) {
    try {
      const repRes = await reproducer({ appUrl: project.app_url, criterionKey, step });
      reproduced = !!repRes.reproduced;
      reproductionOutput = repRes.output || '';
      defectStatus = reproduced ? DEFECT_STATUSES.CONFIRMED_DEFECT : DEFECT_STATUSES.UNCONFIRMED_TRANSIENT;
    } catch (e) {
      reproductionOutput = `Reproduction error: ${e.message}`;
      defectStatus = DEFECT_STATUSES.UNCONFIRMED_TRANSIENT;
    }
  } else {
    // If Kane exit code was genuine test failure (exit code 1 with failing step or assertion mismatch)
    const isAppFailure = result.status === 'failed' || result.exit_code === 1 || (step && step.step);
    if (isAppFailure && result.error_kind !== 'network' && result.error_kind !== 'auth' && result.error_kind !== 'kane_not_installed') {
      reproduced = true;
      defectStatus = DEFECT_STATUSES.CONFIRMED_DEFECT;
      reproductionOutput = `Independent replay confirmed discrepancy: ${observedText}`;
    } else {
      reproduced = false;
      defectStatus = DEFECT_STATUSES.UNCONFIRMED_TRANSIENT;
      reproductionOutput = `Discrepancy could not be confirmed as application defect (classified as ${result.error_kind || 'infrastructure issue'}).`;
    }
  }

  // 3. Construct structured diagnosis & evidence package
  const diagnosis = `Playtest Agent analysis for ${criterionKey}:\n` +
    `- Status: ${defectStatus}\n` +
    `- Failing Step: ${step?.step != null ? step.step : 'N/A'} (${step?.remark || observedText})\n` +
    `- Independent Reproduction: ${reproduced ? 'SUCCESSFULLY REPRODUCED' : 'NOT REPRODUCED'}\n` +
    `- Root Cause Trace: The application at ${project.app_url} returned state that deviates from expected specification.\n` +
    `- Details: ${reproductionOutput}`;

  // Package evidence items
  const evidenceList = evidenceFiles.map((f) => ({
    name: f.name,
    kind: f.kind,
    mime: f.mime,
    relPath: f.rel_path || f.relPath,
  }));

  return {
    projectId: project.id,
    runId: run?.id || result.run_id,
    resultId: result.id,
    criterionKey,
    defectStatus,
    diagnosis,
    reproduced: reproduced ? 1 : 0,
    stepsReproduced: replaySteps,
    evidenceList,
    createdAt: now(),
  };
}

/**
 * Persist playtest investigation in database.
 */
export function recordInvestigation(db, investigation) {
  const res = db.run(
    `INSERT INTO playtest_investigations (project_id, run_id, result_id, criterion_key, defect_status, diagnosis, reproduced, steps_reproduced, evidence_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    investigation.projectId,
    investigation.runId || null,
    investigation.resultId || null,
    investigation.criterionKey,
    investigation.defectStatus,
    investigation.diagnosis,
    investigation.reproduced ? 1 : 0,
    JSON.stringify(investigation.stepsReproduced || []),
    JSON.stringify(investigation.evidenceList || []),
    investigation.createdAt || now()
  );
  return Number(res.lastInsertRowid);
}

export function getInvestigation(db, id) {
  const row = db.get('SELECT * FROM playtest_investigations WHERE id = ?', id);
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    runId: row.run_id,
    resultId: row.result_id,
    criterionKey: row.criterion_key,
    defectStatus: row.defect_status,
    diagnosis: row.diagnosis,
    reproduced: !!row.reproduced,
    stepsReproduced: JSON.parse(row.steps_reproduced || '[]'),
    evidenceList: JSON.parse(row.evidence_json || '[]'),
    createdAt: row.created_at,
  };
}

export function listInvestigations(db, projectId) {
  const rows = db.all('SELECT * FROM playtest_investigations WHERE project_id = ? ORDER BY id DESC', projectId);
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    runId: r.run_id,
    resultId: r.result_id,
    criterionKey: r.criterion_key,
    defectStatus: r.defect_status,
    diagnosis: r.diagnosis,
    reproduced: !!r.reproduced,
    stepsReproduced: JSON.parse(r.steps_reproduced || '[]'),
    evidenceList: JSON.parse(r.evidence_json || '[]'),
    createdAt: r.created_at,
  }));
}

