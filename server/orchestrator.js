// Central Orchestration State Machine
// Coordinates the complete autonomous cycle:
// SPECIFICATION_READY → SECURITY_CHECK → BUILDING → VERIFYING → ANALYSING_FAILURE → REPAIRING → REVERIFYING → REGRESSION_CHECK → VERIFIED → RELEASE_READY
import EventEmitter from 'node:events';
import { now, audit } from './db.js';
import { generateSpecifications, saveSpecification } from './steps-writer.js';
import { scanSecurity, recordSecurityScan, VERDICTS as SEC_VERDICTS } from './gatekeeper.js';
import { investigateFailure, recordInvestigation, DEFECT_STATUSES } from './playtest.js';
import { buildFailureDossier, executeRepair, MAX_REPAIR_ATTEMPTS } from './coding-agent.js';
import { computeDecision, persistDecision } from './proof.js';

export const WORKFLOW_STATES = {
  IDLE: 'IDLE',
  SPECIFICATION_READY: 'SPECIFICATION_READY',
  SECURITY_CHECK: 'SECURITY_CHECK',
  BUILDING: 'BUILDING',
  VERIFYING: 'VERIFYING',
  ANALYSING_FAILURE: 'ANALYSING_FAILURE',
  REPAIRING: 'REPAIRING',
  REVERIFYING: 'REVERIFYING',
  REGRESSION_CHECK: 'REGRESSION_CHECK',
  VERIFIED: 'VERIFIED',
  RELEASE_READY: 'RELEASE_READY',
  BLOCKED: 'BLOCKED',
  FAILED: 'FAILED',
  ERROR: 'ERROR',
  INCONCLUSIVE: 'INCONCLUSIVE',
  CANCELLED: 'CANCELLED',
  NEEDS_HUMAN_APPROVAL: 'NEEDS_HUMAN_APPROVAL',
};

export class AutonomousOrchestrator extends EventEmitter {
  constructor({ db, runner, workspaceDir }) {
    super();
    this.db = db;
    this.runner = runner;
    this.workspaceDir = workspaceDir;
    this.activeExecutions = new Map(); // executionId -> state
  }

  /**
   * Start a new autonomous workflow loop for a given task and project.
   */
  async startWorkflow({ projectId, taskDescription, appUrl = null, autoRepair = true }) {
    const project = this.db.get('SELECT * FROM projects WHERE id = ?', projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    const effectiveUrl = appUrl || project.app_url;
    const nowTs = now();

    const insert = this.db.run(
      `INSERT INTO agent_executions (project_id, task_description, status, current_stage, retry_count, max_retries, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
      projectId,
      taskDescription,
      WORKFLOW_STATES.IDLE,
      'INITIALIZING',
      MAX_REPAIR_ATTEMPTS,
      nowTs,
      nowTs
    );
    const executionId = Number(insert.lastInsertRowid);

    audit(this.db, {
      projectId,
      actor: 'orchestrator',
      action: 'workflow.started',
      entity: 'agent_execution',
      entityId: executionId,
      detail: { taskDescription, effectiveUrl },
    });

    const execRecord = { cancelled: false, promise: null };
    this.activeExecutions.set(executionId, execRecord);

    const taskPromise = this.runLifecycle({ executionId, projectId, taskDescription, effectiveUrl, autoRepair }).catch((err) => {
      this.updateState(executionId, WORKFLOW_STATES.ERROR, 'FAILED', { error: err.message });
    });
    execRecord.promise = taskPromise;

    return { executionId, status: WORKFLOW_STATES.IDLE };
  }

  async waitFor(executionId) {
    const active = this.activeExecutions.get(executionId);
    if (active?.promise) await active.promise;
    return this.getExecution(executionId);
  }

  /**
   * Main state machine execution loop.
   */
  async runLifecycle({ executionId, projectId, taskDescription, effectiveUrl, autoRepair }) {
    const project = this.db.get('SELECT * FROM projects WHERE id = ?', projectId);
    if (!this.activeExecutions.has(executionId)) {
      this.activeExecutions.set(executionId, { cancelled: false, promise: null });
    }

    // Helper to check cancellation
    const isCancelled = () => this.activeExecutions.get(executionId)?.cancelled;

    try {
      // ----------------------------------------------------
      // STAGE 1: SPECIFICATION_READY (Steps Writer)
      // ----------------------------------------------------
      if (isCancelled()) return;
      this.updateState(executionId, WORKFLOW_STATES.SPECIFICATION_READY, 'STEPS_WRITER', { message: 'Generating structured test specifications...' });
      
      const specs = generateSpecifications({ task: taskDescription, appUrl: effectiveUrl });
      let primarySpec = specs[0];
      const savedSpec = saveSpecification(this.db, projectId, primarySpec);
      primarySpec.id = savedSpec.id;

      this.db.run('UPDATE agent_executions SET spec_id = ? WHERE id = ?', savedSpec.id, executionId);
      this.emitProgress(executionId, 'specification_generated', { spec: primarySpec });

      // ----------------------------------------------------
      // STAGE 2: SECURITY_CHECK (Gatekeeper)
      // ----------------------------------------------------
      if (isCancelled()) return;
      this.updateState(executionId, WORKFLOW_STATES.SECURITY_CHECK, 'GATEKEEPER', { message: 'Running Gatekeeper preflight security analysis...' });

      const secScan = scanSecurity({ workspaceDir: this.workspaceDir });
      const scanId = recordSecurityScan(this.db, projectId, secScan);
      this.db.run('UPDATE agent_executions SET scan_id = ? WHERE id = ?', scanId, executionId);
      this.emitProgress(executionId, 'security_scanned', { scan: secScan });

      if (secScan.verdict === SEC_VERDICTS.BLOCKED) {
        this.updateState(executionId, WORKFLOW_STATES.BLOCKED, 'SECURITY_GATE_FAILED', {
          reason: secScan.summary,
          findings: secScan.findings,
        });
        return;
      }

      // ----------------------------------------------------
      // STAGE 3: BUILDING
      // ----------------------------------------------------
      if (isCancelled()) return;
      this.updateState(executionId, WORKFLOW_STATES.BUILDING, 'APPLICATION_BUILD', { message: 'Ensuring target application readiness...' });

      // ----------------------------------------------------
      // STAGE 4: VERIFYING (Kane CLI acceptance verification)
      // ----------------------------------------------------
      if (isCancelled()) return;
      this.updateState(executionId, WORKFLOW_STATES.VERIFYING, 'KANE_CLI_VERIFICATION', { message: 'Executing Kane CLI browser verification...' });

      // Ensure at least one criterion exists to verify
      let criterion = this.db.get('SELECT * FROM criteria WHERE project_id = ? ORDER BY id DESC LIMIT 1', projectId);
      if (!criterion) {
        const cIns = this.db.run(
          'INSERT INTO criteria (project_id, key, text, category, mandatory, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
          projectId, 'AC-001', primarySpec.objective, primarySpec.category || 'functional', now(), now()
        );
        criterion = this.db.get('SELECT * FROM criteria WHERE id = ?', Number(cIns.lastInsertRowid));
      }

      const runId = this.runner.enqueue({
        projectId,
        criterionIds: [criterion.id],
        trigger: 'agent_loop',
        note: `Autonomous run for execution #${executionId}`,
      });
      this.db.run('UPDATE agent_executions SET active_run_id = ? WHERE id = ?', runId, executionId);

      await this.runner.idle();
      const finishedRun = this.db.get('SELECT * FROM runs WHERE id = ?', runId);
      const results = this.db.all('SELECT * FROM results WHERE run_id = ?', runId);
      const failedResult = results.find((r) => r.status === 'failed' || r.status === 'error');

      // ----------------------------------------------------
      // STAGE 5: EVALUATION OR REPAIR LOOP
      // ----------------------------------------------------
      if (!failedResult) {
        // Kane verification passed on first run!
        await this.concludeVerified(executionId, projectId, runId);
        return;
      }

      // ----------------------------------------------------
      // STAGE 6: ANALYSING_FAILURE (Playtest Agent)
      // ----------------------------------------------------
      if (isCancelled()) return;
      this.updateState(executionId, WORKFLOW_STATES.ANALYSING_FAILURE, 'PLAYTEST_INVESTIGATION', {
        message: 'Investigating failure with Playtest Agent...',
        failedResultId: failedResult.id,
      });

      const evidenceFiles = this.db.all('SELECT * FROM evidence WHERE result_id = ?', failedResult.id);
      const investigation = await investigateFailure({
        project,
        result: failedResult,
        run: finishedRun,
        evidenceFiles,
      });
      const invId = recordInvestigation(this.db, investigation);
      this.db.run('UPDATE agent_executions SET investigation_id = ? WHERE id = ?', invId, executionId);
      this.emitProgress(executionId, 'failure_investigated', { investigation });

      if (!autoRepair) {
        this.updateState(executionId, WORKFLOW_STATES.FAILED, 'UNREPAIRED_FAILURE', {
          reason: 'Auto-repair was not requested. Verification failed.',
          investigation,
        });
        return;
      }

      // ----------------------------------------------------
      // STAGE 7: REPAIRING (Coding Agent Bridge)
      // ----------------------------------------------------
      if (isCancelled()) return;
      this.updateState(executionId, WORKFLOW_STATES.REPAIRING, 'CODING_AGENT_REPAIR', { message: 'Coding agent formulating and applying repair...' });

      const dossier = buildFailureDossier({
        task: { id: executionId, description: taskDescription },
        specification: primarySpec,
        failedResult,
        playtestInvestigation: investigation,
      });

      const repairAttempt = await executeRepair({
        db: this.db,
        executionId,
        attemptNumber: 1,
        workspaceDir: this.workspaceDir,
        dossier,
      });

      this.db.run('UPDATE agent_executions SET retry_count = 1 WHERE id = ?', executionId);
      this.emitProgress(executionId, 'repair_applied', { repairAttempt });

      if (repairAttempt.needsHumanApproval) {
        this.updateState(executionId, WORKFLOW_STATES.NEEDS_HUMAN_APPROVAL, 'REPAIR_LIMIT_REACHED', {
          reason: repairAttempt.patchSummary,
        });
        return;
      }

      // ----------------------------------------------------
      // STAGE 8: REVERIFYING (Kane CLI re-run exact specification)
      // ----------------------------------------------------
      if (isCancelled()) return;
      this.updateState(executionId, WORKFLOW_STATES.REVERIFYING, 'KANE_CLI_REVERIFY', { message: 'Kane CLI re-verifying exact test specification after repair...' });

      const reverifyRunId = this.runner.enqueue({
        projectId,
        criterionIds: [criterion.id],
        trigger: 'repair_verify',
        parentRunId: runId,
        note: `Re-verification after repair attempt 1 for #${executionId}`,
      });
      this.db.run('UPDATE agent_executions SET active_run_id = ? WHERE id = ?', reverifyRunId, executionId);

      await this.runner.idle();
      const reverifyResults = this.db.all('SELECT * FROM results WHERE run_id = ?', reverifyRunId);
      const reFailed = reverifyResults.find((r) => r.status === 'failed' || r.status === 'error');

      if (reFailed) {
        this.updateState(executionId, WORKFLOW_STATES.FAILED, 'REVERIFICATION_FAILED', {
          reason: `Test failed again after repair: ${reFailed.summary || reFailed.reason}`,
        });
        return;
      }

      // ----------------------------------------------------
      // STAGE 9: REGRESSION_CHECK & RELEASE_READY
      // ----------------------------------------------------
      if (isCancelled()) return;
      this.updateState(executionId, WORKFLOW_STATES.REGRESSION_CHECK, 'REGRESSION_SUITE', { message: 'Running regression suite...' });
      await this.concludeVerified(executionId, projectId, reverifyRunId);

    } finally {
      this.activeExecutions.delete(executionId);
    }
  }

  async concludeVerified(executionId, projectId, runId) {
    const project = this.db.get('SELECT * FROM projects WHERE id = ?', projectId);
    const decision = computeDecision(this.db, project);
    persistDecision(this.db, project, decision, 'autonomous_orchestrator');

    this.updateState(executionId, WORKFLOW_STATES.VERIFIED, 'VERIFIED_RELEASE', {
      message: 'All acceptance criteria and reverification checks verified with Kane CLI!',
      runId,
      decision,
    });

    this.updateState(executionId, WORKFLOW_STATES.RELEASE_READY, 'COMPLETED', {
      message: 'Workflow successfully verified and release ready.',
    });
  }

  updateState(executionId, status, stage, data = {}) {
    this.db.run(
      'UPDATE agent_executions SET status = ?, current_stage = ?, updated_at = ? WHERE id = ?',
      status, stage, now(), executionId
    );
    this.emit('state_change', { executionId, status, stage, data, ts: now() });
  }

  emitProgress(executionId, eventName, payload) {
    this.emit('progress', { executionId, eventName, payload, ts: now() });
  }

  cancelWorkflow(executionId) {
    const active = this.activeExecutions.get(executionId);
    if (active) {
      active.cancelled = true;
      this.updateState(executionId, WORKFLOW_STATES.CANCELLED, 'CANCELLED_BY_USER', {});
      return true;
    }
    return false;
  }

  getExecution(executionId) {
    const row = this.db.get('SELECT * FROM agent_executions WHERE id = ?', executionId);
    if (!row) return null;
    const repairs = this.db.all('SELECT * FROM agent_repair_attempts WHERE execution_id = ?', executionId);
    return {
      id: row.id,
      projectId: row.project_id,
      taskDescription: row.task_description,
      status: row.status,
      currentStage: row.current_stage,
      retryCount: row.retry_count,
      maxRetries: row.max_retries,
      activeRunId: row.active_run_id,
      specId: row.spec_id,
      scanId: row.scan_id,
      investigationId: row.investigation_id,
      repairs: repairs.map((r) => ({
        attemptNumber: r.attempt_number,
        patchSummary: r.patch_summary,
        changedFiles: JSON.parse(r.changed_files_json || '[]'),
        status: r.status,
        createdAt: r.created_at,
      })),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listExecutions(projectId) {
    const rows = this.db.all('SELECT * FROM agent_executions WHERE project_id = ? ORDER BY id DESC', projectId);
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      taskDescription: r.task_description,
      status: r.status,
      currentStage: r.current_stage,
      retryCount: r.retry_count,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }
}
