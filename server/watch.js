// Continuous watch. On a schedule (or on demand) it measures a project's verification system from live,
// persisted data, turns each abnormal variable into a finding (variable → scenario → cause), tracks findings
// across checks (new / persisting / resolved) and derives the next workflow from what it found.
// Nothing here is a fixed script: probes read current rows, thresholds are per-project, and the plan is
// computed from the findings of the check that produced it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { now, audit } from './db.js';
import { checkTarget } from './netpolicy.js';
import { kaneStatus } from './kane.js';
import { classifyFailure } from './gate.js';

export const DEFAULT_THRESHOLDS = {
  window: 20,                 // most recent finished executions considered
  infraErrorRate: 0.3,        // share of executions without a verdict that marks the harness unstable
  minSample: 3,               // executions needed before a rate is judged
  consecutiveFailures: 2,     // failures in a row that make a failure "recurring"
  repairTaskAgeHours: 24,     // an open repair task older than this is stale
  queuedMinutes: 15,          // a run queued/running longer than this is stuck
  durationFactor: 3,          // latest duration vs the criterion's median
  evidenceSample: 25,         // evidence files re-hashed per check
  reachTimeoutMs: 5000,
};
const LIMITS = { window: [1, 500], infraErrorRate: [0, 1], minSample: [1, 100], consecutiveFailures: [1, 50], repairTaskAgeHours: [0, 8760],
  queuedMinutes: [1, 1440], durationFactor: [1, 100], evidenceSample: [0, 500], reachTimeoutMs: [200, 30000] };
export function cleanThresholds(input = {}) {
  const out = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (!(k in LIMITS)) throw Object.assign(new Error(`Unknown threshold "${k}". Known: ${Object.keys(LIMITS).join(', ')}`), { status: 400 });
    const n = Number(v), [lo, hi] = LIMITS[k];
    if (!Number.isFinite(n) || n < lo || n > hi) throw Object.assign(new Error(`${k} must be between ${lo} and ${hi}`), { status: 400 });
    out[k] = n;
  }
  return out;
}

export function getConfig(db, projectId) {
  const r = db.get('SELECT * FROM watch_config WHERE project_id = ?', projectId);
  const custom = r ? JSON.parse(r.thresholds_json || '{}') : {};
  return { enabled: !!r?.enabled, intervalMinutes: r?.interval_minutes ?? 60, autoRun: !!r?.auto_run, nextDueAt: r?.next_due_at ?? null,
    thresholds: { ...DEFAULT_THRESHOLDS, ...custom }, customThresholds: custom };
}
export function setConfig(db, projectId, body = {}) {
  const cur = getConfig(db, projectId);
  const enabled = body.enabled === undefined ? cur.enabled : !!body.enabled;
  const interval = body.intervalMinutes === undefined ? cur.intervalMinutes : Number(body.intervalMinutes);
  if (!Number.isInteger(interval) || interval < 1 || interval > 10080) throw Object.assign(new Error('intervalMinutes must be an integer between 1 and 10080'), { status: 400 });
  const autoRun = body.autoRun === undefined ? cur.autoRun : !!body.autoRun;
  const thresholds = body.thresholds === undefined ? cur.customThresholds : cleanThresholds(body.thresholds);
  const due = enabled ? new Date(Date.now() + interval * 60000).toISOString() : null;
  db.run(`INSERT INTO watch_config (project_id, enabled, interval_minutes, auto_run, thresholds_json, next_due_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id) DO UPDATE SET enabled = excluded.enabled, interval_minutes = excluded.interval_minutes, auto_run = excluded.auto_run,
            thresholds_json = excluded.thresholds_json, next_due_at = excluded.next_due_at, updated_at = excluded.updated_at`,
    projectId, enabled ? 1 : 0, interval, autoRun ? 1 : 0, JSON.stringify(thresholds), due, now());
  return getConfig(db, projectId);
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const hoursSince = (iso) => (Date.now() - Date.parse(iso)) / 3600000;
const F = (variable, scenario, cause, origin, severity, value, extra = {}) => ({ variable, scenario, cause, origin, severity, value, ...extra });

// ---- probes: each measures variables from live state and returns { variables, findings } -------------------
// origin: harness (the checking system itself) | environment | application | evidence | process
export const PROBES = {
  async engine({ config, engineStatus }) {
    const k = await engineStatus(config);
    const variables = { 'engine.state': k.state, 'engine.version': k.version, 'engine.auth': k.auth };
    const sev = { unavailable: 'blocking', not_authenticated: 'blocking', incompatible: 'blocking', test_fixture: config.acceptFixtureEngine ? 'info' : 'blocking' }[k.state];
    return { variables, findings: sev ? [F('engine.state', `Verification engine is "${k.state}"`, k.detail, 'harness', sev, k.state, { key: k.state,
      action: { type: 'fix_harness', hint: k.detail } })] : [] };
  },
  async target({ project, config, reach, t }) {
    const pol = await checkTarget(project.app_url, { allowPrivate: config.allowPrivateTargets });
    if (!pol.ok) return { variables: { 'target.policy': 'refused' }, findings: [F('target.policy', 'Application URL is refused by the target policy', pol.reason, 'environment', 'blocking', 'refused', { action: { type: 'fix_environment', hint: pol.reason } })] };
    const r = await reach(project.app_url, t.reachTimeoutMs);
    const variables = { 'target.policy': 'allowed', 'target.reachable': r.ok, 'target.httpStatus': r.status ?? null, 'target.latencyMs': r.ms ?? null };
    return { variables, findings: r.ok ? [] : [F('target.reachable', 'Application under test is not reachable from the verification server', r.error || `HTTP ${r.status}`, 'environment', 'blocking', false,
      { action: { type: 'fix_environment', hint: `Start or redeploy the application at ${project.app_url}.` } })] };
  },
  executions({ db, project, t }) {
    const rows = db.all(`SELECT r.* FROM results r JOIN runs n ON n.id = r.run_id WHERE n.project_id = ? AND r.status IN ('passed','failed','error','timeout','cancelled') ORDER BY r.id DESC LIMIT ?`, project.id, t.window);
    const byClass = {};
    for (const r of rows) { const c = classifyFailure(r).failureClass; byClass[c] = (byClass[c] || 0) + 1; }
    const noVerdict = rows.length - (byClass.none || 0) - (byClass.application_defect || 0);
    const rate = rows.length ? noVerdict / rows.length : null;
    const variables = { 'executions.sample': rows.length, 'executions.noVerdictRate': rate, 'executions.byClass': byClass };
    const findings = [];
    if (rows.length >= t.minSample && rate >= t.infraErrorRate && noVerdict > 0) {
      const [top, n] = Object.entries(byClass).filter(([c]) => c !== 'none' && c !== 'application_defect').sort((a, b) => b[1] - a[1])[0];
      findings.push(F('executions.noVerdictRate', `${noVerdict} of the last ${rows.length} executions ended without a verdict`, `Most frequent cause: ${top} (${n}). Example: ${rows.find((r) => classifyFailure(r).failureClass === top)?.reason || 'n/a'}`,
        'harness', 'high', rate, { key: top, threshold: t.infraErrorRate, action: { type: 'fix_harness', hint: `Resolve the ${top} problem before trusting or re-running checks.` } }));
    }
    return { variables, findings };
  },
  criteria({ db, project, t, decision }) {
    const findings = [], variables = { 'criteria.total': decision.criteria.length, 'release.verdict': decision.verdict, 'release.blocking': decision.blocking.map((b) => b.code) };
    for (const c of decision.criteria) {
      const hist = db.all(`SELECT status, error_kind, duration_ms, reason, summary, id FROM results WHERE criterion_id = ? AND status IN ('passed','failed') AND error_kind IS NULL ORDER BY id DESC LIMIT ?`, c.id, t.window);
      let streak = 0; for (const h of hist) { if (h.status === 'failed') streak++; else break; }
      if (streak >= t.consecutiveFailures) findings.push(F(`criterion.${c.key}.failureStreak`, `${c.key} has failed ${streak} times in a row`, hist[0].summary || hist[0].reason || 'Expected outcome not observed.', 'application', c.mandatory ? 'high' : 'medium', streak,
        { key: c.key, criterionId: c.id, threshold: t.consecutiveFailures, resultId: hist[0].id, action: { type: 'repair', criterionId: c.id } }));
      else if (c.freshness.state === 'FAILED') findings.push(F(`criterion.${c.key}.state`, `${c.key} is failing`, c.freshness.reasons[0]?.message || 'Latest execution failed.', 'application', c.mandatory ? 'high' : 'medium', 'FAILED',
        { key: c.key, criterionId: c.id, action: { type: 'replay', criterionId: c.id } }));
      if (['STALE', 'UNVERIFIED', 'BLOCKED'].includes(c.freshness.state)) findings.push(F(`criterion.${c.key}.state`, `${c.key} has no current evidence (${c.freshness.state})`, c.freshness.reasons.map((r) => r.message).join(' ') || 'No valid execution.', 'evidence',
        c.mandatory ? 'medium' : 'low', c.freshness.state, { key: c.key, criterionId: c.id, action: { type: 'verify', criterionId: c.id } }));
      if (c.stability.classification === 'intermittent') findings.push(F(`criterion.${c.key}.stability`, `${c.key} is intermittent`, `${c.stability.failures} of ${c.stability.sample} recent outcomes failed with ${c.stability.flips} pass/fail flips.`, 'application', 'medium', c.stability.failureRate,
        { key: c.key, criterionId: c.id, action: { type: 'investigate', criterionId: c.id } }));
      const durs = hist.map((h) => h.duration_ms).filter((d) => d > 0);
      if (durs.length >= t.minSample + 1) { const med = median(durs.slice(1));
        if (med > 0 && durs[0] > med * t.durationFactor) findings.push(F(`criterion.${c.key}.durationMs`, `${c.key} took ${durs[0]} ms, ${(durs[0] / med).toFixed(1)}× its median`, `Median of earlier executions is ${med} ms; the application or the engine has slowed down.`, 'environment', 'low', durs[0],
          { key: c.key, criterionId: c.id, threshold: med * t.durationFactor, action: { type: 'investigate', criterionId: c.id } })); }
    }
    return { variables, findings };
  },
  process({ db, project, t }) {
    const findings = [];
    const stuck = db.all(`SELECT id, status, created_at FROM runs WHERE project_id = ? AND status IN ('queued','running')`, project.id).filter((r) => hoursSince(r.created_at) * 60 > t.queuedMinutes);
    for (const r of stuck) findings.push(F('runs.stuck', `Run #${r.id} has been ${r.status} for ${Math.round(hoursSince(r.created_at) * 60)} minutes`, 'The queue is blocked or the engine process is hanging.', 'harness', 'high', r.id, { key: String(r.id), action: { type: 'cancel_run', runId: r.id } }));
    const tasks = db.all(`SELECT t.id, t.status, t.created_at, t.failures, c.key FROM repair_tasks t JOIN criteria c ON c.id = t.criterion_id WHERE t.project_id = ? AND t.status != 'verified'`, project.id);
    for (const k of tasks.filter((x) => hoursSince(x.created_at) > t.repairTaskAgeHours)) findings.push(F('repairTasks.stale', `Repair task RT-${k.id} for ${k.key} has been ${k.status} for ${Math.round(hoursSince(k.created_at))} h`, `${k.failures} failed verification(s) and no verified fix.`, 'process', 'medium', k.id, { key: String(k.id), action: { type: 'repair', repairTaskId: k.id } }));
    const wf = db.get('SELECT id, status, current_stage, reason FROM agent_executions WHERE project_id = ? ORDER BY id DESC LIMIT 1', project.id);
    if (wf && ['INTERRUPTED', 'ERROR', 'INCONCLUSIVE'].includes(wf.status)) findings.push(F('workflow.last', `Latest autonomous workflow #${wf.id} ended ${wf.status}`, wf.reason || wf.current_stage, wf.status === 'INCONCLUSIVE' ? 'harness' : 'process', 'medium', wf.status, { key: wf.status, action: { type: 'restart_workflow', executionId: wf.id } }));
    const trial = db.get(`SELECT id, outcome, reason FROM regression_trials WHERE project_id = ? AND outcome != 'pending' ORDER BY id DESC LIMIT 1`, project.id);
    if (trial?.outcome === 'missed') findings.push(F('regression.last', 'The latest regression trial did not detect a reintroduced defect', trial.reason, 'harness', 'high', 'missed', { action: { type: 'investigate', trialId: trial.id } }));
    return { variables: { 'runs.stuck': stuck.length, 'repairTasks.open': tasks.length, 'workflow.last': wf?.status ?? null, 'regression.last': trial?.outcome ?? null }, findings };
  },
  evidence({ db, project, t, evidenceRoot }) {
    const rows = t.evidenceSample ? db.all(`SELECT e.id, e.uid, e.name, e.rel_path, e.sha256 FROM evidence e JOIN results r ON r.id = e.result_id JOIN runs n ON n.id = r.run_id WHERE n.project_id = ? AND e.rel_path IS NOT NULL ORDER BY e.id DESC LIMIT ?`, project.id, t.evidenceSample) : [];
    let missing = 0, tampered = 0; const bad = [];
    for (const e of rows) {
      const f = path.resolve(evidenceRoot, e.rel_path);
      if (!f.startsWith(evidenceRoot + path.sep) || !fs.existsSync(f)) { missing++; bad.push({ id: e.uid, name: e.name, problem: 'missing' }); continue; }
      if (e.sha256 && crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') !== e.sha256) { tampered++; bad.push({ id: e.uid, name: e.name, problem: 'hash_mismatch' }); }
    }
    const findings = [];
    if (tampered) findings.push(F('evidence.tampered', `${tampered} evidence file(s) no longer match their recorded SHA-256`, 'Files were modified after collection.', 'evidence', 'blocking', tampered, { files: bad.filter((b) => b.problem === 'hash_mismatch'), action: { type: 'investigate' } }));
    if (missing) findings.push(F('evidence.missing', `${missing} evidence file(s) are missing from storage`, 'Files were deleted or storage was not restored with the database.', 'evidence', 'high', missing, { files: bad.filter((b) => b.problem === 'missing'), action: { type: 'verify_all' } }));
    return { variables: { 'evidence.checked': rows.length, 'evidence.missing': missing, 'evidence.tampered': tampered }, findings };
  },
};

const fingerprint = (f) => crypto.createHash('sha256').update(`${f.variable}|${f.key ?? ''}`).digest('hex').slice(0, 24);
const SEV = ['blocking', 'high', 'medium', 'low', 'info'];

/** Workflow derived from this check's findings. Harness/environment problems come first and gate everything else. */
export function buildPlan(findings) {
  const open = findings.filter((f) => f.severity !== 'info');
  const gate = open.filter((f) => f.severity === 'blocking' || (f.origin === 'harness' && f.severity === 'high'));
  const steps = [];
  const add = (type, why, extra = {}) => steps.push({ order: steps.length + 1, type, why, ...extra });
  for (const f of gate) add(f.action?.type || 'investigate', f.scenario, { hint: f.action?.hint ?? f.cause, runId: f.action?.runId, automatic: false, finding: f.fingerprint });
  const ids = (type) => [...new Set(open.filter((f) => f.action?.type === type && f.criterionId).map((f) => f.criterionId))];
  const verify = [...new Set([...ids('verify'), ...ids('replay')])];
  if (open.some((f) => f.action?.type === 'verify_all')) add('verify', 'Evidence files are missing; re-collect evidence for every criterion.', { all: true, automatic: !gate.length, blockedBy: gate.map((g) => g.fingerprint) });
  else if (verify.length) add('verify', `${verify.length} criterion/criteria need a current execution.`, { criterionIds: verify, automatic: !gate.length, blockedBy: gate.map((g) => g.fingerprint) });
  for (const id of ids('repair')) add('repair', 'Recurring failure: fix the application, then re-verify.', { criterionId: id, automatic: false });
  for (const f of open.filter((x) => !gate.includes(x) && ['investigate', 'restart_workflow', 'repair'].includes(x.action?.type) && !x.criterionId)) add(f.action.type, f.scenario, { hint: f.cause, automatic: false, finding: f.fingerprint, ...f.action });
  for (const id of ids('investigate')) add('investigate', 'Unstable or slow criterion.', { criterionId: id, automatic: false });
  return { blocked: gate.length > 0, steps };
}

export function createWatch({ db, runner, config, decide, evidenceRoot, engineStatus = kaneStatus, reach = defaultReach, tickMs = 30000 }) {
  const busy = new Set();
  let timer = null, stopped = false;

  async function runCheck(projectId, trigger = 'manual') {
    if (busy.has(projectId)) throw Object.assign(new Error('A watch check is already running for this project'), { status: 409 });
    busy.add(projectId);
    try {
      const project = db.get('SELECT * FROM projects WHERE id = ?', projectId);
      if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });
      const cfg = getConfig(db, projectId), startedAt = now();
      const ctx = { db, project, config, t: cfg.thresholds, decision: decide(project), evidenceRoot, engineStatus, reach };
      const variables = {}, findings = [], probeErrors = {};
      for (const [name, probe] of Object.entries(PROBES)) {
        try { const r = await probe(ctx); Object.assign(variables, r.variables); findings.push(...r.findings.map((f) => ({ ...f, probe: name }))); }
        catch (e) { probeErrors[name] = e.message; findings.push({ ...F(`probe.${name}`, `Probe "${name}" could not run`, e.message, 'harness', 'medium', 'error', { action: { type: 'investigate' } }), probe: name }); }
      }
      if (stopped) throw Object.assign(new Error('Server is shutting down'), { status: 503 });
      for (const f of findings) f.fingerprint = fingerprint(f);
      findings.sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity));
      const plan = buildPlan(findings);
      const real = findings.filter((f) => f.severity !== 'info');
      const health = plan.blocked ? 'blocked' : real.length ? 'degraded' : 'healthy';
      const out = db.tx(() => {
        const prev = new Map(db.all(`SELECT * FROM watch_findings WHERE project_id = ?`, projectId).map((r) => [r.fingerprint, r]));
        const counts = { new: 0, persisting: 0, resolved: 0, reopened: 0, open: findings.length, bySeverity: {}, byOrigin: {} };
        const checkId = Number(db.run(`INSERT INTO watch_checks (project_id, trigger, health, variables_json, plan_json, counts_json, started_at, finished_at) VALUES (?, ?, ?, ?, ?, '{}', ?, ?)`,
          projectId, trigger, health, JSON.stringify({ ...variables, probeErrors }), JSON.stringify(plan), startedAt, now()).lastInsertRowid);
        for (const f of findings) {
          counts.bySeverity[f.severity] = (counts.bySeverity[f.severity] || 0) + 1; counts.byOrigin[f.origin] = (counts.byOrigin[f.origin] || 0) + 1;
          const p = prev.get(f.fingerprint), detail = JSON.stringify({ value: f.value, threshold: f.threshold, action: f.action, criterionId: f.criterionId, resultId: f.resultId, files: f.files, probe: f.probe });
          if (!p) { counts.new++; f.trend = 'new'; f.occurrences = 1; f.firstSeen = startedAt;
            db.run(`INSERT INTO watch_findings (project_id, fingerprint, variable, scenario, cause, origin, severity, detail_json, first_check_id, last_check_id, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              projectId, f.fingerprint, f.variable, f.scenario, f.cause, f.origin, f.severity, detail, checkId, checkId, startedAt, startedAt); }
          else { const re = p.status === 'resolved'; re ? counts.reopened++ : counts.persisting++; f.trend = re ? 'reopened' : 'persisting'; f.occurrences = p.occurrences + 1; f.firstSeen = p.first_seen;
            db.run(`UPDATE watch_findings SET scenario = ?, cause = ?, severity = ?, detail_json = ?, status = 'open', occurrences = occurrences + 1, last_check_id = ?, last_seen = ?, resolved_at = NULL WHERE id = ?`,
              f.scenario, f.cause, f.severity, detail, checkId, startedAt, p.id); }
        }
        const seen = new Set(findings.map((f) => f.fingerprint)), resolved = [];
        for (const p of prev.values()) if (p.status === 'open' && !seen.has(p.fingerprint)) {
          counts.resolved++; resolved.push({ fingerprint: p.fingerprint, variable: p.variable, scenario: p.scenario, occurrences: p.occurrences, firstSeen: p.first_seen });
          db.run(`UPDATE watch_findings SET status = 'resolved', resolved_at = ? WHERE id = ?`, startedAt, p.id);
        }
        db.run('UPDATE watch_checks SET counts_json = ? WHERE id = ?', JSON.stringify(counts), checkId);
        return { checkId, counts, resolved };
      });
      audit(db, { projectId, actor: 'watch', action: 'watch.checked', entity: 'watch_check', entityId: out.checkId, detail: { trigger, health, counts: out.counts } });
      let started = null;
      if (trigger === 'schedule' && cfg.autoRun) { try { started = executePlan(projectId, out.checkId, 'watch_auto'); } catch (e) { started = { started: false, reason: e.message }; } }
      return { id: out.checkId, projectId, trigger, health, startedAt, variables, findings, resolved: out.resolved, counts: out.counts, plan, execution: started };
    } finally { busy.delete(projectId); }
  }

  /** Carry out the automatic part of a check's plan: start one verification run for the criteria that need it. */
  function executePlan(projectId, checkId, trigger = 'watch_manual') {
    const c = db.get('SELECT * FROM watch_checks WHERE id = ? AND project_id = ?', checkId, projectId);
    if (!c) throw Object.assign(new Error('Watch check not found'), { status: 404 });
    const latest = db.get('SELECT MAX(id) id FROM watch_checks WHERE project_id = ?', projectId).id;
    if (latest !== c.id) throw Object.assign(new Error('This check is no longer the latest; run a new check first'), { status: 409 });
    if (c.started_run_id) throw Object.assign(new Error(`This plan was already executed (run #${c.started_run_id})`), { status: 409 });
    const plan = JSON.parse(c.plan_json);
    if (plan.blocked) return { started: false, reason: 'The plan is blocked by harness or environment findings; verification would not produce a verdict.' };
    const step = plan.steps.find((s) => s.type === 'verify' && s.automatic);
    if (!step) return { started: false, reason: 'The plan has no automatic step.' };
    const active = runner.activeRunFor(projectId);
    if (active) return { started: false, reason: `Run #${active} is already in progress.` };
    const ids = (step.all ? db.all('SELECT id FROM criteria WHERE project_id = ? AND archived = 0', projectId).map((r) => r.id)
      : step.criterionIds.filter((id) => db.get('SELECT 1 FROM criteria WHERE id = ? AND project_id = ? AND archived = 0', id, projectId)));
    if (!ids.length) return { started: false, reason: 'No active criteria to verify.' };
    const runId = runner.enqueue({ projectId, criterionIds: ids, trigger, note: `Watch check #${c.id}` });
    db.run('UPDATE watch_checks SET started_run_id = ? WHERE id = ?', runId, c.id);
    audit(db, { projectId, actor: 'watch', action: 'watch.plan_executed', entity: 'watch_check', entityId: c.id, detail: { runId, criterionIds: ids } });
    return { started: true, runId, criterionIds: ids };
  }

  async function tick() {
    if (stopped) return [];
    const due = db.all(`SELECT project_id, interval_minutes FROM watch_config WHERE enabled = 1 AND (next_due_at IS NULL OR next_due_at <= ?)`, now());
    const done = [];
    for (const d of due) {
      // The next due time is written first, so a crash mid-check cannot cause a tight loop.
      db.run('UPDATE watch_config SET next_due_at = ? WHERE project_id = ?', new Date(Date.now() + d.interval_minutes * 60000).toISOString(), d.project_id);
      try { done.push(await runCheck(d.project_id, 'schedule')); } catch (e) { if (stopped) break; }
    }
    return done;
  }
  function start() { if (!timer && tickMs > 0) { timer = setInterval(() => { tick().catch(() => {}); }, tickMs); timer.unref?.(); } }
  function stop() { stopped = true; clearInterval(timer); timer = null; }

  const checkView = (r) => ({ id: r.id, trigger: r.trigger, health: r.health, counts: JSON.parse(r.counts_json), plan: JSON.parse(r.plan_json), variables: JSON.parse(r.variables_json), startedRunId: r.started_run_id, startedAt: r.started_at, finishedAt: r.finished_at });
  const listChecks = (projectId, limit = 30) => db.all('SELECT * FROM watch_checks WHERE project_id = ? ORDER BY id DESC LIMIT ?', projectId, Math.min(Math.max(Number(limit) || 30, 1), 200)).map(checkView);
  const listFindings = (projectId, status) => db.all(`SELECT * FROM watch_findings WHERE project_id = ? ${status ? 'AND status = ?' : ''} ORDER BY status, last_seen DESC`, ...(status ? [projectId, status] : [projectId]))
    .map((f) => ({ fingerprint: f.fingerprint, variable: f.variable, scenario: f.scenario, cause: f.cause, origin: f.origin, severity: f.severity, status: f.status, occurrences: f.occurrences,
      firstSeen: f.first_seen, lastSeen: f.last_seen, resolvedAt: f.resolved_at, ...JSON.parse(f.detail_json) }));
  /** How each numeric variable moved across recent checks. */
  function trend(projectId, limit = 30) {
    const checks = listChecks(projectId, limit).reverse(), series = {};
    for (const c of checks) for (const [k, v] of Object.entries(c.variables)) if (typeof v === 'number' || typeof v === 'boolean') (series[k] ||= []).push({ at: c.startedAt, value: Number(v) });
    return { checks: checks.map((c) => ({ id: c.id, at: c.startedAt, health: c.health, open: c.counts.open })), series };
  }
  return { runCheck, executePlan, tick, start, stop, listChecks, listFindings, trend };
}

async function defaultReach(url, timeoutMs) {
  const t0 = Date.now();
  try { const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) }); try { await res.body?.cancel(); } catch {}
    return { ok: res.status < 500, status: res.status, ms: Date.now() - t0 }; }
  catch (e) { return { ok: false, error: e.cause?.code || e.name || e.message, ms: Date.now() - t0 }; }
}
