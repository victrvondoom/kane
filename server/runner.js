// Asynchronous execution queue. API requests enqueue runs and return immediately;
// one Kane CLI browser session runs at a time and every event is persisted + broadcast (SSE).
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import { now, newUid, audit } from './db.js';
import { checkTarget } from './netpolicy.js';
import { runKane, classify, buildObjective, collectEvidence, failingStep, kaneConfig } from './kane.js';
import { syncRepairTask } from './gate.js';
import { textHash } from './requirements.js';

export function createRunner({ db, dataDir, config = kaneConfig() }) {
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  const queue = [];
  let active = null; // { runId, handle, cancelled }
  let idleResolvers = [];

  const emit = (runId, resultId, kind, payload) => {
    const ts = now();
    const r = db.run('INSERT INTO run_events (run_id, result_id, ts, kind, payload) VALUES (?, ?, ?, ?, ?)', runId, resultId, ts, kind, JSON.stringify(payload));
    bus.emit(`run:${runId}`, { id: Number(r.lastInsertRowid), run_id: runId, result_id: resultId, ts, kind, payload });
  };

  // Anything left mid-flight by a crash/restart is recorded as interrupted — never silently dropped or passed.
  db.run(`UPDATE results SET status = 'error', error_kind = 'interrupted', reason = 'Server stopped before this check finished.', finished_at = ?
          WHERE status IN ('queued','starting','running')`, now());
  db.run(`UPDATE runs SET status = 'interrupted', finished_at = ? WHERE status IN ('queued','running')`, now());
  let stopping = false;

  const activeRunFor = (projectId) => db.get(`SELECT id FROM runs WHERE project_id = ? AND status IN ('queued','running') ORDER BY id LIMIT 1`, projectId)?.id ?? null;

  function enqueue({ projectId, criterionIds, trigger, parentRunId = null, note = '', buildId = null }) {
    if (stopping) throw Object.assign(new Error('Server is shutting down; try again shortly'), { status: 503 });
    const runId = db.tx(() => {
      // Every execution is pinned to the build, criterion version and policy version it ran against.
      const build = buildId ? db.get('SELECT id, environment FROM builds WHERE id = ? AND project_id = ?', buildId, projectId) : db.get('SELECT id, environment FROM builds WHERE project_id = ? ORDER BY id DESC LIMIT 1', projectId);
      const policyVersion = db.get('SELECT MAX(version) v FROM policy_versions WHERE project_id = ?', projectId).v || 1;
      const r = db.run('INSERT INTO runs (project_id, parent_run_id, trigger, status, note, created_at, build_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        projectId, parentRunId, trigger, 'queued', note, now(), build?.id ?? null);
      const id = Number(r.lastInsertRowid);
      for (const cid of criterionIds) {
        const c = db.get('SELECT * FROM criteria WHERE id = ? AND project_id = ? AND archived = 0', cid, projectId);
        if (!c) continue;
        db.run(`INSERT INTO results (run_id, criterion_id, criterion_key, criterion_text, text_hash, status, criterion_version_id, build_id, environment, policy_version) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
          id, c.id, c.key, c.text, textHash(c.text), c.version_id, build?.id ?? null, build?.environment ?? null, policyVersion);
      }
      return id;
    });
    queue.push(runId);
    setImmediate(pump);
    return runId;
  }

  async function pump() {
    if (active || !queue.length) {
      if (!active && !queue.length) { idleResolvers.forEach((r) => r()); idleResolvers = []; }
      return;
    }
    const item = queue.shift();
    if (typeof item === 'object') { // isolated job (regression trial): same single-flight queue, no `results` rows
      active = { runId: null, handle: null, cancelled: false, isolated: true };
      try { item.resolve(await item.fn()); } catch (e) { item.resolve({ status: 'error', errorKind: 'runner', reason: e.message, files: [] }); }
      active = null;
      setImmediate(pump);
      return;
    }
    const runId = item;
    active = { runId, handle: null, cancelled: false };
    try { await execute(runId); } catch (e) {
      emit(runId, null, 'system', { level: 'error', message: `Runner error: ${e.message}` });
      db.run(`UPDATE results SET status = 'error', error_kind = 'runner', reason = ?, finished_at = ? WHERE run_id = ? AND status IN ('queued','starting','running')`, e.message, now(), runId);
      db.run(`UPDATE runs SET status = 'completed', finished_at = ? WHERE id = ?`, now(), runId);
    }
    bus.emit(`run:${runId}`, { kind: 'end' });
    active = null;
    setImmediate(pump);
  }

  /** One engine execution + conservative classification + evidence collection. Shared by runs and isolated trials. */
  async function runObjective({ objective, url, variables = [], workDir, destDir, onEvent = () => {}, onWarn = () => {} }) {
    const outcome = await runKane({ objective, url, workDir, variables, config, onEvent, onSpawn: (h) => { if (active) active.handle = h; } });
    if (active) active.handle = null;
    let verdict = classify(outcome);
    const end = outcome.runEnd || {};
    const step = verdict.status === 'passed' ? null : failingStep(outcome.events);
    let files = [];
    try { files = collectEvidence({ outcome, workDir, destDir }); }
    catch (e) { onWarn(`Evidence collection failed: ${e.message}`); }
    const hasLink = typeof end.test_url === 'string' && /^https?:\/\//.test(end.test_url);
    if (verdict.status === 'passed' && config.requireEvidence && !files.length && !hasLink) {
      verdict = { status: 'error', errorKind: 'no_evidence',
        reason: 'Kane CLI reported a pass but no evidence artifact (screenshot, log, evidence pack or Test Manager link) could be collected. A pass without evidence is treated as unverified.' };
    }
    fs.rm(workDir, { recursive: true, force: true }, () => {});
    return { outcome, verdict, end, step, files, hasLink };
  }

  /**
   * Execute an objective against an isolated target (e.g. a regression trial copy) through the same engine path
   * and the same single-flight queue, WITHOUT creating `results` rows — so it can never count as release evidence.
   */
  function runIsolated({ objective, url, variables = [], label }) {
    if (stopping) return Promise.resolve({ status: 'error', errorKind: 'interrupted', reason: 'Server is shutting down.', files: [] });
    return new Promise((resolve) => {
      queue.push({ resolve, fn: async () => {
        const target = await checkTarget(url, { allowPrivate: config.allowPrivateTargets });
        if (!target.ok) return { status: 'error', errorKind: 'target_blocked', reason: target.reason, files: [] };
        const startedAt = now();
        const rel = path.join('isolated', label);
        const r = await runObjective({ objective, url, variables, workDir: path.join(dataDir, 'work', label), destDir: path.join(dataDir, 'evidence', rel) });
        const end = r.end;
        return { status: active?.cancelled ? 'error' : r.verdict.status, errorKind: active?.cancelled ? 'interrupted' : r.verdict.errorKind,
          reason: r.verdict.reason ?? end.reason ?? null, exitCode: r.outcome.exitCode, command: r.outcome.command, summary: end.summary ?? null,
          engine: r.outcome.engine, durationMs: r.outcome.durationMs, startedAt, finishedAt: now(),
          credits: Number.isFinite(Number(end.credits_consumed)) ? Number(end.credits_consumed) : null,
          files: r.files.map((f) => ({ ...f, relPath: path.join(rel, f.relPath) })), testUrl: r.hasLink ? end.test_url : null };
      } });
      setImmediate(pump);
    });
  }

  const RUN_DONE = ['completed', 'cancelled', 'interrupted'];
  /** Resolves when THIS run reaches a terminal state — never on unrelated queue activity. Returns the run row, or null on timeout. */
  function waitForRun(runId, timeoutMs = 0) {
    const get = () => db.get('SELECT * FROM runs WHERE id = ?', runId);
    return new Promise((resolve) => {
      const first = get();
      if (!first || RUN_DONE.includes(first.status)) return resolve(first || null);
      let timer = null;
      const done = (v) => { bus.off(`run:${runId}`, on); clearTimeout(timer); resolve(v); };
      const on = (ev) => { if (ev.kind !== 'end') return; setImmediate(() => { let r = null; try { r = get(); } catch {} done(r); }); };
      bus.on(`run:${runId}`, on);
      if (timeoutMs > 0) { timer = setTimeout(() => done(null), timeoutMs); timer.unref?.(); }
    });
  }

  async function execute(runId) {
    const run = db.get('SELECT * FROM runs WHERE id = ?', runId);
    if (!run || run.status !== 'queued') return;
    const project = db.get('SELECT * FROM projects WHERE id = ?', run.project_id);
    // A build may carry its own deployment URL (preview/staging); it is subject to the same target policy.
    const buildUrl = run.build_id ? db.get('SELECT app_url FROM builds WHERE id = ?', run.build_id)?.app_url : null;
    if (buildUrl) project.app_url = buildUrl;
    const variables = db.all('SELECT key, value, secret FROM project_variables WHERE project_id = ?', project.id);
    db.run(`UPDATE runs SET status = 'running', started_at = ? WHERE id = ?`, now(), runId);
    emit(runId, null, 'system', { level: 'info', message: `Run #${runId} started against ${project.app_url}` });
    const results = db.all('SELECT * FROM results WHERE run_id = ? ORDER BY id', runId);
    // Re-check the target at execution time (DNS may have changed since the project was saved).
    const target = await checkTarget(project.app_url, { allowPrivate: config.allowPrivateTargets });
    if (!target.ok) {
      db.run(`UPDATE results SET status = 'error', error_kind = 'target_blocked', reason = ?, started_at = ?, finished_at = ?, duration_ms = 0 WHERE run_id = ?`, target.reason, now(), now(), runId);
      emit(runId, null, 'system', { level: 'error', message: `Target refused by server policy — Kane CLI was not started. ${target.reason}` });
      db.run(`UPDATE runs SET status = 'completed', finished_at = ? WHERE id = ?`, now(), runId);
      return;
    }
    for (const res of results) {
      if (active.cancelled) {
        db.run(`UPDATE results SET status = 'cancelled', error_kind = 'cancelled', reason = 'Run cancelled before this check started.', finished_at = ? WHERE id = ?`, now(), res.id);
        continue;
      }
      const objective = buildObjective({ appUrl: project.app_url, context: project.context, criterionText: res.criterion_text });
      const workDir = path.join(dataDir, 'work', `result-${res.id}`);
      // starting = process launched, no output yet; running = the CLI has produced its first event.
      db.run(`UPDATE results SET status = 'starting', started_at = ?, objective = ? WHERE id = ?`, now(), objective, res.id);
      emit(runId, res.id, 'system', { level: 'info', message: `${res.criterion_key}: launching Kane CLI`, phase: 'starting' });
      let live = false;
      const { outcome, verdict, end, step, files, hasLink } = await runObjective({ objective, url: project.app_url, variables, workDir,
        destDir: path.join(dataDir, 'evidence', `result-${res.id}`),
        onWarn: (m) => emit(runId, res.id, 'system', { level: 'warn', message: m }),
        onEvent: (e) => {
          if (!live && e.kind === 'kane') {
            live = true;
            db.run(`UPDATE results SET status = 'running' WHERE id = ? AND status = 'starting'`, res.id);
            emit(runId, res.id, 'system', { level: 'info', message: `${res.criterion_key}: Kane CLI is running`, phase: 'running' });
          }
          emit(runId, res.id, e.kind, e.payload);
        } });
      db.tx(() => {
        db.run(`UPDATE results SET status = ?, error_kind = ?, exit_code = ?, signal = ?, command = ?, kane_status = ?, summary = ?, one_liner = ?,
                reason = ?, final_state = ?, failing_step = ?, test_url = ?, session_dir = ?, credits = ?, stdout = ?, stderr = ?, finished_at = ?, duration_ms = ?, engine = ?
                WHERE id = ?`,
          verdict.status, verdict.errorKind, outcome.exitCode, outcome.signal, outcome.command, end.status != null ? String(end.status) : null,
          end.summary ?? null, end.one_liner ?? null, verdict.reason ?? end.reason ?? null,
          end.final_state ? JSON.stringify(end.final_state) : null, step ? JSON.stringify(step) : null,
          typeof end.test_url === 'string' ? end.test_url : null, end.session_dir ?? null,
          Number.isFinite(Number(end.credits_consumed)) ? Number(end.credits_consumed) : null,
          outcome.stdout, outcome.stderr, now(), outcome.durationMs, outcome.engine, res.id);
        for (const f of files) db.run('INSERT INTO evidence (uid, result_id, kind, name, rel_path, mime, size, sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          newUid(), res.id, f.kind, f.name, path.join(`result-${res.id}`, f.relPath), f.mime, f.size, f.sha256);
        if (hasLink)
          db.run(`INSERT INTO evidence (uid, result_id, kind, name, url) VALUES (?, ?, 'test_manager', 'Kane Test Manager test case', ?)`, newUid(), res.id, end.test_url);
        syncRepairTask(db, db.get('SELECT * FROM results WHERE id = ?', res.id), project);
      });
      emit(runId, res.id, 'system', { level: verdict.status === 'passed' ? 'ok' : 'error', phase: 'end', status: verdict.status,
        message: `${res.criterion_key}: ${verdict.status.toUpperCase()} (exit ${outcome.exitCode ?? 'n/a'}, ${Math.round(outcome.durationMs / 100) / 10}s, ${files.length} evidence file(s))${verdict.reason ? ' — ' + verdict.reason : ''}` });
    }
    db.run(`UPDATE runs SET status = ?, finished_at = ? WHERE id = ?`, active.cancelled ? 'cancelled' : 'completed', now(), runId);
    emit(runId, null, 'system', { level: 'info', message: `Run #${runId} ${active.cancelled ? 'cancelled' : 'finished'}` });
  }

  function cancel(runId) {
    const i = queue.indexOf(runId);
    if (i >= 0) {
      queue.splice(i, 1);
      db.run(`UPDATE results SET status = 'cancelled', error_kind = 'cancelled', reason = 'Run cancelled while queued.', finished_at = ? WHERE run_id = ?`, now(), runId);
      db.run(`UPDATE runs SET status = 'cancelled', finished_at = ? WHERE id = ?`, now(), runId);
      bus.emit(`run:${runId}`, { kind: 'end' });
      return true;
    }
    if (active && active.runId === runId) { active.cancelled = true; active.handle?.cancel(); return true; }
    return false;
  }

  /** Graceful shutdown: stop accepting work, stop the browser, record what was interrupted. */
  async function shutdown() {
    stopping = true;
    for (const id of queue.splice(0)) {
      if (typeof id === 'object') { id.resolve({ status: 'error', errorKind: 'interrupted', reason: 'Server stopped before this trial started.', files: [] }); continue; }
      db.run(`UPDATE results SET status = 'error', error_kind = 'interrupted', reason = 'Server stopped before this check started.', finished_at = ? WHERE run_id = ? AND status = 'queued'`, now(), id);
      db.run(`UPDATE runs SET status = 'interrupted', finished_at = ? WHERE id = ?`, now(), id);
      bus.emit(`run:${id}`, { kind: 'end' });
    }
    if (active) {
      const id = active.runId;
      active.cancelled = true; active.handle?.cancel();
      if (id == null) { await Promise.race([new Promise((r) => idleResolvers.push(r)), new Promise((r) => setTimeout(r, 6000))]); return; }
      await Promise.race([new Promise((r) => idleResolvers.push(r)), new Promise((r) => setTimeout(r, 6000))]);
      db.run(`UPDATE results SET error_kind = 'interrupted', status = 'error', reason = 'Server stopped before this check finished.' WHERE run_id = ? AND status = 'cancelled'`, id);
      db.run(`UPDATE runs SET status = 'interrupted' WHERE id = ? AND status = 'cancelled'`, id);
    }
  }

  return { enqueue, cancel, shutdown, activeRunFor, waitForRun, runIsolated, bus, idle: () => (!active && !queue.length ? Promise.resolve() : new Promise((r) => idleResolvers.push(r))),
    state: () => ({ activeRunId: active?.runId ?? null, queued: queue.length }) };
}
