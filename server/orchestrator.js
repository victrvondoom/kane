// Central Orchestration State Machine.
// Invariant: a state is only entered when the execution that justifies it actually happened and is persisted.
//   - it waits for ITS OWN run ids, never for global queue idleness
//   - only an engine verdict of `failed`, confirmed by an executed replay, can lead to source repair
//   - RELEASE_READY is granted solely by the release-decision engine
//   - a regression result exists only if a regression trial was executed
import EventEmitter from 'node:events';
import { now, audit } from './db.js';
import { generateSpecifications, saveSpecification } from './steps-writer.js';
import { scanSecurity, recordSecurityScan, VERDICTS as SEC_VERDICTS } from './gatekeeper.js';
import { investigateFailure, recordInvestigation, queueReplay, DEFECT_STATUSES } from './playtest.js';
import { buildFailureDossier, executeRepair, MAX_REPAIR_ATTEMPTS } from './coding-agent.js';
import { computeDecision, persistDecision, writeVersion } from './proof.js';
import { classifyFailure } from './gate.js';
import { runRegressionTrial, getTrial } from './regression.js';

export const WORKFLOW_STATES = {
  IDLE: 'IDLE', SPECIFICATION_READY: 'SPECIFICATION_READY', SECURITY_CHECK: 'SECURITY_CHECK', BUILDING: 'BUILDING', VERIFYING: 'VERIFYING',
  ANALYSING_FAILURE: 'ANALYSING_FAILURE', REPAIRING: 'REPAIRING', REVERIFYING: 'REVERIFYING', REGRESSION_CHECK: 'REGRESSION_CHECK',
  VERIFIED: 'VERIFIED', RELEASE_READY: 'RELEASE_READY', NOT_RELEASE_READY: 'NOT_RELEASE_READY', BLOCKED: 'BLOCKED', FAILED: 'FAILED', ERROR: 'ERROR',
  INCONCLUSIVE: 'INCONCLUSIVE', CANCELLED: 'CANCELLED', NEEDS_HUMAN_APPROVAL: 'NEEDS_HUMAN_APPROVAL', INTERRUPTED: 'INTERRUPTED',
};
const S = WORKFLOW_STATES;
export const TERMINAL_STATES = new Set([S.RELEASE_READY, S.NOT_RELEASE_READY, S.BLOCKED, S.FAILED, S.ERROR, S.INCONCLUSIVE, S.CANCELLED, S.NEEDS_HUMAN_APPROVAL, S.INTERRUPTED]);
const ACTIVE_SQL = `status NOT IN (${[...TERMINAL_STATES].map((s) => `'${s}'`).join(',')})`;

export class AutonomousOrchestrator extends EventEmitter {
  constructor({ db, runner, workspaceDir, dataDir, config = {}, decide = null, repairFn = null }) {
    super();
    Object.assign(this, { db, runner, workspaceDir, dataDir, config, repairFn });
    this.decide = decide || ((p) => computeDecision(db, p, { acceptFixture: !!config.acceptFixtureEngine }));
    this.activeExecutions = new Map();
    this.stopped = false;
    // Restart recovery: a stage that was in flight when the process died did not finish. It is recorded as
    // interrupted and never advanced; history (events, runs, attempts) is preserved.
    for (const row of db.all(`SELECT id, status, current_stage FROM agent_executions WHERE ${ACTIVE_SQL}`)) {
      this.record(row.id, S.INTERRUPTED, `INTERRUPTED_DURING_${row.status}`, { reason: `Server restarted while this workflow was in ${row.status} (${row.current_stage}). Nothing after that point happened.`, previousStatus: row.status });
    }
  }

  activeFor(projectId) { return this.db.get(`SELECT id FROM agent_executions WHERE project_id = ? AND ${ACTIVE_SQL} ORDER BY id LIMIT 1`, projectId)?.id ?? null; }

  async startWorkflow({ projectId, taskDescription, appUrl = null, autoRepair = true, mutationAuthorized = false }) {
    if (this.stopped) throw Object.assign(new Error('Server is shutting down; try again shortly'), { status: 503 });
    const project = this.db.get('SELECT * FROM projects WHERE id = ?', projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    const effectiveUrl = appUrl || project.app_url;
    const executionId = this.db.tx(() => {
      const busy = this.activeFor(projectId);
      if (busy) throw Object.assign(new Error(`Workflow #${busy} is already active for this project`), { status: 409 });
      const ts = now();
      return Number(this.db.run(`INSERT INTO agent_executions (project_id, task_description, status, current_stage, retry_count, max_retries, created_at, updated_at, auto_repair, mutation_authorized)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`, projectId, taskDescription, S.IDLE, 'INITIALIZING', MAX_REPAIR_ATTEMPTS, ts, ts, autoRepair ? 1 : 0, mutationAuthorized ? 1 : 0).lastInsertRowid);
    });
    audit(this.db, { projectId, actor: 'orchestrator', action: 'workflow.started', entity: 'agent_execution', entityId: executionId, detail: { taskDescription, effectiveUrl } });
    const rec = { cancelled: false, promise: null };
    this.activeExecutions.set(executionId, rec);
    rec.promise = this.runLifecycle({ executionId, projectId, taskDescription, effectiveUrl, autoRepair, mutationAuthorized })
      .catch((err) => { this.updateState(executionId, S.ERROR, 'ORCHESTRATOR_ERROR', { error: err.message }); })
      .finally(() => this.activeExecutions.delete(executionId));
    return { executionId, status: S.IDLE };
  }

  async waitFor(executionId) {
    const active = this.activeExecutions.get(executionId);
    if (active?.promise) await active.promise;
    return this.stopped ? null : this.getExecution(executionId);
  }

  /** Enqueue a run for this workflow and wait for THAT run. Returns its classified outcome from persisted rows. */
  async verify({ executionId, projectId, criterion, trigger, parentRunId = null, note }) {
    const runId = this.runner.enqueue({ projectId, criterionIds: [criterion.id], trigger, parentRunId, note });
    this.db.run('UPDATE agent_executions SET active_run_id = ? WHERE id = ?', runId, executionId);
    const waitMs = ((this.config.timeout || 240) + 90) * 1000 * (this.runner.state().queued + 2);
    const run = await this.runner.waitForRun(runId, waitMs);
    if (this.stopped) return { runId, halted: true };
    const result = this.db.get('SELECT * FROM results WHERE run_id = ? AND criterion_id = ? ORDER BY id LIMIT 1', runId, criterion.id);
    if (!run) return { runId, result, cls: { failureClass: 'timeout', applicationDefect: false, repairable: false, reason: `Run #${runId} did not finish within the orchestration wait limit.` } };
    if (run.status !== 'completed') return { runId, result, cls: { failureClass: 'interrupted', applicationDefect: false, repairable: false, reason: `Run #${runId} ended as ${run.status}.` } };
    return { runId, result, cls: classifyFailure(result) };
  }

  async runLifecycle({ executionId, projectId, taskDescription, effectiveUrl, autoRepair, mutationAuthorized }) {
    const project = this.db.get('SELECT * FROM projects WHERE id = ?', projectId);
    const halted = () => this.stopped || !!this.activeExecutions.get(executionId)?.cancelled;
    const infra = (v, stage) => {
      this.db.run('UPDATE agent_executions SET failure_class = ? WHERE id = ?', v.cls.failureClass, executionId);
      this.updateState(executionId, S.INCONCLUSIVE, stage, { failureClass: v.cls.failureClass, runId: v.runId, resultId: v.result?.id ?? null,
        reason: `No verdict was reached (${v.cls.failureClass}): ${v.cls.reason} This is not an application defect; no repair was attempted.` });
    };

    // 1. SPECIFICATION
    this.updateState(executionId, S.SPECIFICATION_READY, 'STEPS_WRITER', { message: 'Generating structured test specifications...' });
    const primarySpec = generateSpecifications({ task: taskDescription, appUrl: effectiveUrl })[0];
    primarySpec.id = saveSpecification(this.db, projectId, primarySpec).id;
    this.db.run('UPDATE agent_executions SET spec_id = ? WHERE id = ?', primarySpec.id, executionId);
    this.emitProgress(executionId, 'specification_generated', { spec: primarySpec });

    // 2. SECURITY
    if (halted()) return;
    this.updateState(executionId, S.SECURITY_CHECK, 'GATEKEEPER', { message: 'Running Gatekeeper preflight security analysis...' });
    const secScan = scanSecurity({ workspaceDir: this.workspaceDir });
    const scanId = recordSecurityScan(this.db, projectId, secScan);
    this.db.run('UPDATE agent_executions SET scan_id = ? WHERE id = ?', scanId, executionId);
    this.emitProgress(executionId, 'security_scanned', { scan: secScan });
    if (secScan.verdict === SEC_VERDICTS.BLOCKED) return this.updateState(executionId, S.BLOCKED, 'SECURITY_GATE_FAILED', { reason: secScan.summary, findings: secScan.findings });

    // 3. VERIFY (the first real execution)
    if (halted()) return;
    let criterion = this.db.get('SELECT * FROM criteria WHERE project_id = ? AND archived = 0 ORDER BY id DESC LIMIT 1', projectId);
    if (!criterion) {
      const cid = Number(this.db.run('INSERT INTO criteria (project_id, key, text, category, mandatory, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
        projectId, 'AC-001', primarySpec.objective, primarySpec.category || 'functional', now(), now()).lastInsertRowid);
      try { writeVersion(this.db, cid); } catch {}
      criterion = this.db.get('SELECT * FROM criteria WHERE id = ?', cid);
    }
    this.db.run('UPDATE agent_executions SET criterion_id = ? WHERE id = ?', criterion.id, executionId);
    this.updateState(executionId, S.VERIFYING, 'KANE_CLI_VERIFICATION', { message: 'Executing browser verification...', criterionKey: criterion.key });
    let v = await this.verify({ executionId, projectId, criterion, trigger: 'agent_loop', note: `Autonomous run for execution #${executionId}` });
    if (v.halted || halted()) return;
    const firstRunId = v.runId;
    let repaired = false;

    if (v.cls.failureClass !== 'none') {
      if (!v.cls.applicationDefect) return infra(v, 'VERIFICATION_NO_VERDICT');

      // 4. ANALYSE: independent replay, executed and persisted
      this.db.run('UPDATE agent_executions SET failure_class = ? WHERE id = ?', v.cls.failureClass, executionId);
      this.updateState(executionId, S.ANALYSING_FAILURE, 'PLAYTEST_REPLAY', { message: 'Replaying the failed check independently...', failedResultId: v.result.id });
      const investigation = await investigateFailure({ project, result: v.result, run: this.db.get('SELECT * FROM runs WHERE id = ?', v.runId),
        evidenceFiles: this.db.all('SELECT * FROM evidence WHERE result_id = ?', v.result.id),
        replay: queueReplay({ db: this.db, runner: this.runner, timeoutMs: ((this.config.timeout || 240) + 90) * 1000 * (this.runner.state().queued + 2) }) });
      if (this.stopped) return;
      const invId = recordInvestigation(this.db, investigation);
      this.db.run('UPDATE agent_executions SET investigation_id = ? WHERE id = ?', invId, executionId);
      this.emitProgress(executionId, 'failure_investigated', { investigationId: invId, defectStatus: investigation.defectStatus, replayRunId: investigation.replayRunId });
      if (halted()) return;
      if (investigation.defectStatus === DEFECT_STATUSES.INCONCLUSIVE)
        return this.updateState(executionId, S.INCONCLUSIVE, 'REPLAY_INCONCLUSIVE', { investigationId: invId, reason: 'The failure could not be independently replayed to a verdict; it is neither confirmed nor repaired.' });
      if (investigation.defectStatus === DEFECT_STATUSES.CONFIRMED_DEFECT) {
        if (!autoRepair) return this.updateState(executionId, S.FAILED, 'UNREPAIRED_FAILURE', { investigationId: invId, reason: 'Confirmed application defect; auto-repair was not requested.' });

        // 5. REPAIR → REVERIFY, bounded
        let source = this.db.get('SELECT * FROM results WHERE id = ?', investigation.replayResultId);
        for (let attempt = 1; ; attempt++) {
          if (halted()) return;
          if (attempt > MAX_REPAIR_ATTEMPTS) return this.updateState(executionId, S.NEEDS_HUMAN_APPROVAL, 'REPAIR_LIMIT_REACHED', { reason: `Still failing after ${MAX_REPAIR_ATTEMPTS} repair attempts.` });
          this.updateState(executionId, S.REPAIRING, 'CODING_AGENT_REPAIR', { message: `Repair attempt ${attempt}`, attempt });
          const dossier = buildFailureDossier({ task: { id: executionId, description: taskDescription }, specification: primarySpec, failedResult: source, playtestInvestigation: investigation });
          const rep = await executeRepair({ db: this.db, executionId, attemptNumber: attempt, workspaceDir: this.workspaceDir, dossier, repairFn: this.repairFn, mutationAuthorized, sourceResultId: source.id });
          if (this.stopped) return;
          this.db.run('UPDATE agent_executions SET retry_count = ? WHERE id = ?', attempt, executionId);
          this.emitProgress(executionId, 'repair_attempted', { repairAttempt: rep });
          if (rep.status !== 'applied') {
            this.db.run(`UPDATE agent_repair_attempts SET outcome = 'no_change' WHERE id = ?`, rep.attemptId);
            return this.updateState(executionId, S.NEEDS_HUMAN_APPROVAL, 'NO_REPAIR_APPLIED', { attempt, reason: rep.patchSummary });
          }
          this.updateState(executionId, S.REVERIFYING, 'KANE_CLI_REVERIFY', { message: `Re-verifying after repair attempt ${attempt}...`, attempt });
          v = await this.verify({ executionId, projectId, criterion, trigger: 'repair_verify', parentRunId: firstRunId, note: `Re-verification after repair attempt ${attempt} for #${executionId}` });
          if (v.halted) return;
          this.db.run('UPDATE agent_repair_attempts SET verify_run_id = ?, outcome = ? WHERE id = ?', v.runId, v.cls.failureClass === 'none' ? 'verified' : v.cls.applicationDefect ? 'still_failing' : 'no_verdict', rep.attemptId);
          if (v.cls.failureClass === 'none') { repaired = true; break; }
          if (!v.cls.applicationDefect) return infra(v, 'REVERIFICATION_NO_VERDICT');
          source = v.result;
        }
      }
      // UNCONFIRMED_TRANSIENT: the replay passed. No repair; the decision engine judges the evidence as it stands.
    }

    // 6. RELEASE DECISION — the only authority
    if (halted()) return;
    const first = this.conclude(executionId, projectId);
    if (!first.releaseAllowed) return this.updateState(executionId, S.NOT_RELEASE_READY, 'RELEASE_DECISION_BLOCKED', this.decisionData(first));
    this.updateState(executionId, S.VERIFIED, 'RELEASE_DECISION_VERIFIED', this.decisionData(first));

    // 7. REGRESSION — executed for real after a repair, in an isolated copy
    if (repaired) {
      this.updateState(executionId, S.REGRESSION_CHECK, 'REGRESSION_TRIAL', { message: 'Reintroducing the defect in an isolated copy and re-running verification...' });
      const trial = await runRegressionTrial({ db: this.db, runner: this.runner, workspaceDir: this.workspaceDir, dataDir: this.dataDir, project, criterion, executionId });
      if (this.stopped) return;
      this.db.run('UPDATE agent_executions SET regression_status = ?, regression_trial_id = ? WHERE id = ?', trial.outcome, trial.id, executionId);
      this.emitProgress(executionId, 'regression_trial', { trialId: trial.id, outcome: trial.outcome, reason: trial.reason });
      if (halted()) return;
      if (trial.outcome === 'missed') return this.updateState(executionId, S.NOT_RELEASE_READY, 'REGRESSION_NOT_DETECTED', { trialId: trial.id, reason: trial.reason });
    } else this.db.run(`UPDATE agent_executions SET regression_status = 'not_run' WHERE id = ?`, executionId);

    // Re-decide: evidence may have changed while the trial ran, and nothing may be pending.
    const final = this.conclude(executionId, projectId);
    if (!final.releaseAllowed) return this.updateState(executionId, S.NOT_RELEASE_READY, 'RELEASE_DECISION_BLOCKED', this.decisionData(final));
    this.updateState(executionId, S.RELEASE_READY, 'COMPLETED', this.decisionData(final));
  }

  /** Ask the release-decision engine, persist its answer, and add the "no pending verification" condition. */
  conclude(executionId, projectId) {
    const project = this.db.get('SELECT * FROM projects WHERE id = ?', projectId);
    const decision = this.decide(project);
    const pending = this.db.get(`SELECT id FROM runs WHERE project_id = ? AND status IN ('queued','running') LIMIT 1`, projectId)?.id ?? null;
    const decisionId = persistDecision(this.db, project, decision, 'autonomous_orchestrator');
    this.db.run('UPDATE agent_executions SET decision_id = ? WHERE id = ?', decisionId, executionId);
    return { decisionId, verdict: decision.verdict, releaseAllowed: decision.releaseAllowed === true && !pending, pendingRunId: pending,
      blocking: [...decision.blocking.map((b) => ({ code: b.code, criterionKey: b.criterionKey, message: b.message })),
        ...(pending ? [{ code: 'PENDING_VERIFICATION', message: `Run #${pending} has not finished.` }] : [])], build: decision.build };
  }
  decisionData(d) { return { decisionId: d.decisionId, verdict: d.verdict, releaseAllowed: d.releaseAllowed, blocking: d.blocking, build: d.build }; }

  /** Persist a transition + its event. */
  record(executionId, status, stage, data = {}) {
    const ts = now();
    this.db.tx(() => {
      this.db.run('UPDATE agent_executions SET status = ?, current_stage = ?, reason = ?, updated_at = ? WHERE id = ?', status, stage, data.reason ?? data.error ?? null, ts, executionId);
      this.db.run('INSERT INTO agent_execution_events (execution_id, ts, status, stage, data_json) VALUES (?, ?, ?, ?, ?)', executionId, ts, status, stage, JSON.stringify(data));
    });
    return ts;
  }

  updateState(executionId, status, stage, data = {}) {
    if (this.stopped) return; // after stop() the workflow is already recorded as interrupted
    const cur = this.db.get('SELECT status FROM agent_executions WHERE id = ?', executionId);
    if (!cur || TERMINAL_STATES.has(cur.status)) return; // a finished workflow cannot be advanced
    const ts = this.record(executionId, status, stage, data);
    this.emit('state_change', { executionId, status, stage, data, ts });
  }

  emitProgress(executionId, eventName, payload) { this.emit('progress', { executionId, eventName, payload, ts: now() }); }

  cancelWorkflow(executionId) {
    const active = this.activeExecutions.get(executionId);
    if (!active) return false;
    active.cancelled = true;
    const runId = this.db.get('SELECT active_run_id r FROM agent_executions WHERE id = ?', executionId)?.r;
    this.updateState(executionId, S.CANCELLED, 'CANCELLED_BY_USER', {});
    if (runId) this.runner.cancel(runId);
    return true;
  }

  /** Called before the runner and database shut down. In-flight workflows are recorded as interrupted. */
  stop() {
    for (const id of this.activeExecutions.keys()) {
      const cur = this.db.get('SELECT status, current_stage FROM agent_executions WHERE id = ?', id);
      if (cur && !TERMINAL_STATES.has(cur.status)) this.record(id, S.INTERRUPTED, `INTERRUPTED_DURING_${cur.status}`, { reason: `Server stopped while this workflow was in ${cur.status}.`, previousStatus: cur.status });
    }
    this.stopped = true;
  }

  /** The stored label is never trusted for release: RELEASE_READY is re-checked against the decision engine on every read. */
  effective(row) {
    if (row.status !== S.RELEASE_READY) return { status: row.status, release: null };
    const project = this.db.get('SELECT * FROM projects WHERE id = ?', row.project_id);
    const d = this.decide(project);
    const pending = this.db.get(`SELECT id FROM runs WHERE project_id = ? AND status IN ('queued','running') LIMIT 1`, row.project_id);
    const allowed = d.releaseAllowed === true && !pending && !!row.decision_id;
    return { status: allowed ? S.RELEASE_READY : S.NOT_RELEASE_READY,
      release: { allowed, verdict: d.verdict, blocking: [...d.blocking.map((b) => b.code), ...(row.decision_id ? [] : ['NO_RECORDED_DECISION']), ...(pending ? ['PENDING_VERIFICATION'] : [])] } };
  }

  getExecution(executionId) {
    const row = this.db.get('SELECT * FROM agent_executions WHERE id = ?', executionId);
    if (!row) return null;
    const eff = this.effective(row);
    return {
      id: row.id, projectId: row.project_id, taskDescription: row.task_description, status: eff.status, storedStatus: row.status, release: eff.release,
      currentStage: row.current_stage, reason: row.reason, failureClass: row.failure_class, retryCount: row.retry_count, maxRetries: row.max_retries,
      activeRunId: row.active_run_id, specId: row.spec_id, scanId: row.scan_id, investigationId: row.investigation_id, criterionId: row.criterion_id, decisionId: row.decision_id,
      regression: row.regression_trial_id ? getTrial(this.db, row.regression_trial_id) : row.regression_status ? { outcome: row.regression_status } : null,
      repairs: this.db.all('SELECT * FROM agent_repair_attempts WHERE execution_id = ? ORDER BY attempt_number', executionId).map((r) => ({
        id: r.id, attemptNumber: r.attempt_number, patchSummary: r.patch_summary, changedFiles: JSON.parse(r.changed_files_json || '[]'), fileHashes: JSON.parse(r.file_hashes_json || '[]'),
        status: r.status, outcome: r.outcome, sourceResultId: r.source_result_id, verifyRunId: r.verify_run_id, createdAt: r.created_at })),
      events: this.db.all('SELECT ts, status, stage, data_json FROM agent_execution_events WHERE execution_id = ? ORDER BY id', executionId).map((e) => ({ ts: e.ts, status: e.status, stage: e.stage, data: JSON.parse(e.data_json) })),
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  listExecutions(projectId) {
    return this.db.all('SELECT * FROM agent_executions WHERE project_id = ? ORDER BY id DESC', projectId).map((r) => ({
      id: r.id, projectId: r.project_id, taskDescription: r.task_description, status: this.effective(r).status, currentStage: r.current_stage, retryCount: r.retry_count, createdAt: r.created_at, updatedAt: r.updated_at }));
  }
}
