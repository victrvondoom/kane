// Asynchronous execution queue. API requests enqueue runs and return immediately;
// one Kane CLI browser session runs at a time and every event is persisted + broadcast (SSE).
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import { now } from './db.js';
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
  db.run(`UPDATE results SET status = 'error', error_kind = 'interrupted', reason = 'Server restarted before this check finished.', finished_at = ?
          WHERE status IN ('queued','running')`, now());
  db.run(`UPDATE runs SET status = 'interrupted', finished_at = ? WHERE status IN ('queued','running')`, now());

  function enqueue({ projectId, criterionIds, trigger, parentRunId = null, note = '' }) {
    const runId = db.tx(() => {
      const r = db.run('INSERT INTO runs (project_id, parent_run_id, trigger, status, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        projectId, parentRunId, trigger, 'queued', note, now());
      const id = Number(r.lastInsertRowid);
      for (const cid of criterionIds) {
        const c = db.get('SELECT * FROM criteria WHERE id = ? AND project_id = ? AND archived = 0', cid, projectId);
        if (!c) continue;
        db.run(`INSERT INTO results (run_id, criterion_id, criterion_key, criterion_text, text_hash, status) VALUES (?, ?, ?, ?, ?, 'queued')`,
          id, c.id, c.key, c.text, textHash(c.text));
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
    const runId = queue.shift();
    active = { runId, handle: null, cancelled: false };
    try { await execute(runId); } catch (e) {
      emit(runId, null, 'system', { level: 'error', message: `Runner error: ${e.message}` });
      db.run(`UPDATE results SET status = 'error', error_kind = 'runner', reason = ?, finished_at = ? WHERE run_id = ? AND status IN ('queued','running')`, e.message, now(), runId);
      db.run(`UPDATE runs SET status = 'completed', finished_at = ? WHERE id = ?`, now(), runId);
    }
    bus.emit(`run:${runId}`, { kind: 'end' });
    active = null;
    setImmediate(pump);
  }

  async function execute(runId) {
    const run = db.get('SELECT * FROM runs WHERE id = ?', runId);
    if (!run || run.status !== 'queued') return;
    const project = db.get('SELECT * FROM projects WHERE id = ?', run.project_id);
    const variables = db.all('SELECT key, value, secret FROM project_variables WHERE project_id = ?', project.id);
    db.run(`UPDATE runs SET status = 'running', started_at = ? WHERE id = ?`, now(), runId);
    emit(runId, null, 'system', { level: 'info', message: `Run #${runId} started against ${project.app_url}` });
    const results = db.all('SELECT * FROM results WHERE run_id = ? ORDER BY id', runId);
    for (const res of results) {
      if (active.cancelled) {
        db.run(`UPDATE results SET status = 'cancelled', error_kind = 'cancelled', reason = 'Run cancelled before this check started.', finished_at = ? WHERE id = ?`, now(), res.id);
        continue;
      }
      const objective = buildObjective({ appUrl: project.app_url, context: project.context, criterionText: res.criterion_text });
      const workDir = path.join(dataDir, 'work', `result-${res.id}`);
      db.run(`UPDATE results SET status = 'running', started_at = ?, objective = ? WHERE id = ?`, now(), objective, res.id);
      emit(runId, res.id, 'system', { level: 'info', message: `${res.criterion_key}: launching Kane CLI`, phase: 'start' });
      const outcome = await runKane({ objective, url: project.app_url, workDir, variables, config,
        onEvent: (e) => emit(runId, res.id, e.kind, e.payload), onSpawn: (h) => { active.handle = h; } });
      active.handle = null;
      const verdict = classify(outcome);
      const end = outcome.runEnd || {};
      const step = verdict.status === 'passed' ? null : failingStep(outcome.events);
      let files = [];
      try { files = collectEvidence({ outcome, workDir, destDir: path.join(dataDir, 'evidence', `result-${res.id}`) }); }
      catch (e) { emit(runId, res.id, 'system', { level: 'warn', message: `Evidence collection failed: ${e.message}` }); }
      db.tx(() => {
        db.run(`UPDATE results SET status = ?, error_kind = ?, exit_code = ?, signal = ?, command = ?, kane_status = ?, summary = ?, one_liner = ?,
                reason = ?, final_state = ?, failing_step = ?, test_url = ?, session_dir = ?, credits = ?, stdout = ?, stderr = ?, finished_at = ?, duration_ms = ?
                WHERE id = ?`,
          verdict.status, verdict.errorKind, outcome.exitCode, outcome.signal, outcome.command, end.status != null ? String(end.status) : null,
          end.summary ?? null, end.one_liner ?? null, verdict.reason ?? end.reason ?? null,
          end.final_state ? JSON.stringify(end.final_state) : null, step ? JSON.stringify(step) : null,
          typeof end.test_url === 'string' ? end.test_url : null, end.session_dir ?? null,
          Number.isFinite(Number(end.credits_consumed)) ? Number(end.credits_consumed) : null,
          outcome.stdout, outcome.stderr, now(), outcome.durationMs, res.id);
        for (const f of files) db.run('INSERT INTO evidence (result_id, kind, name, rel_path, mime, size) VALUES (?, ?, ?, ?, ?, ?)',
          res.id, f.kind, f.name, path.join(`result-${res.id}`, f.relPath), f.mime, f.size);
        if (typeof end.test_url === 'string' && /^https?:\/\//.test(end.test_url))
          db.run(`INSERT INTO evidence (result_id, kind, name, url) VALUES (?, 'test_manager', 'Kane Test Manager test case', ?)`, res.id, end.test_url);
        syncRepairTask(db, db.get('SELECT * FROM results WHERE id = ?', res.id), project);
      });
      fs.rm(workDir, { recursive: true, force: true }, () => {});
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

  return { enqueue, cancel, bus, idle: () => (!active && !queue.length ? Promise.resolve() : new Promise((r) => idleResolvers.push(r))),
    state: () => ({ activeRunId: active?.runId ?? null, queued: queue.length }) };
}
