// Runtime and SHIPPROOF intelligence (read-only, plus one engineering tool that starts a real verification run).
// SHIPPROOF data is always scoped to projects the signed-in user owns; nothing here writes results, evidence or decisions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkTarget } from '../../netpolicy.js';
import { criteriaStatus, explainError } from '../../gate.js';
import { ToolError } from './registry.js';

const S = (o = {}) => ({ type: 'string', ...o });
const I = (o = {}) => ({ type: 'integer', ...o });
const tail = (s, n = 2500) => { const t = String(s || ''); return t.length > n ? `…${t.slice(-n)}` : t; };
const J = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

export function registerRuntimeTools(reg, { cfg, deps }) {
  const { db, runner, orchestrator, logBuffer, dataDir, kaneStatus, kaneCfg, decide, startRun } = deps;
  const ownProject = (ctx, id) => {
    const pid = id ?? ctx.incident?.project_id ?? ctx.session.project_id;
    if (!pid) throw new ToolError('project_required', 'No SHIPPROOF project is linked to this session. List projects with shipproof_projects and pass project_id.');
    const p = db.get('SELECT * FROM projects WHERE id = ? AND user_id = ?', pid, ctx.user.id);
    if (!p) throw new ToolError('not_found', `Project ${pid} was not found for this account.`);
    return p;
  };
  const started = Date.now();

  reg.define({ name: 'runtime_health', tier: 'read_only', description: 'Live health of the SHIPPROOF service: database, storage, the Kane CLI engine, the run queue — and, for a project, whether its application URL actually responds right now.',
    input: { type: 'object', properties: { project_id: I({ minimum: 1 }) } },
    async handler(ctx, { project_id }) {
      const checks = { database: false, storage: false };
      try { checks.database = db.get('SELECT 1 ok').ok === 1; } catch (e) { checks.databaseError = e.message; }
      try { fs.accessSync(dataDir, fs.constants.W_OK); checks.storage = true; } catch (e) { checks.storageError = e.message; }
      const k = await kaneStatus(kaneCfg, { fresh: true }).catch((e) => ({ state: 'unknown', detail: e.message }));
      const data = { checkedAt: new Date().toISOString(), service: { ...checks, uptimeSeconds: Math.round((Date.now() - started) / 1000) },
        engine: { state: k.state, version: k.version ?? null, auth: k.auth ?? null, detail: k.detail }, queue: runner.state() };
      const pid = project_id ?? ctx.incident?.project_id ?? ctx.session.project_id;
      if (pid) {
        const p = ownProject(ctx, pid), t0 = Date.now();
        const target = await checkTarget(p.app_url, { allowPrivate: !!kaneCfg.allowPrivateTargets });
        if (!target.ok) data.application = { url: p.app_url, reachable: false, blockedByPolicy: true, reason: target.reason };
        else try { const r = await fetch(target.url, { redirect: 'manual', signal: AbortSignal.timeout(6000) }); data.application = { url: p.app_url, reachable: true, httpStatus: r.status, healthy: r.status < 500, responseMs: Date.now() - t0 }; }
        catch (e) { data.application = { url: p.app_url, reachable: false, error: e.cause?.code || e.name, detail: e.cause?.message || e.message, responseMs: Date.now() - t0 }; }
      }
      const bad = [!checks.database && 'database', !checks.storage && 'storage', k.state !== 'ready' && `engine ${k.state}`, data.application && !data.application.reachable && 'application unreachable', data.application?.httpStatus >= 500 && `application HTTP ${data.application.httpStatus}`].filter(Boolean);
      return { summary: bad.length ? `Unhealthy: ${bad.join(', ')}` : 'All checked components are healthy', data };
    } });

  reg.define({ name: 'runtime_logs', tier: 'read_only', description: 'Recent structured log lines from this SHIPPROOF server process (requests, errors with stack heads). Filter by level, text, request path, minimum HTTP status or age.',
    input: { type: 'object', properties: { level: S({ enum: ['info', 'error'] }), contains: S({ maxLength: 120 }), path: S({ maxLength: 200 }), min_status: I({ minimum: 100, maximum: 599 }), since_minutes: I({ minimum: 1, maximum: 1440 }), limit: I({ minimum: 1, maximum: 200 }) } },
    async handler(ctx, { level, contains, path: p, min_status, since_minutes, limit = 60 }) {
      const r = logBuffer.query({ level, contains, path: p, minStatus: min_status, sinceMs: since_minutes ? since_minutes * 60000 : 0, limit });
      // Request lines of other accounts are not this user's to read: keep system lines and the caller's own requests.
      const mine = r.lines.filter((l) => l.userId == null || l.userId === ctx.user.id);
      return { summary: `${mine.length} log line(s)${level ? ` at ${level}` : ''} (buffer holds ${logBuffer.size()})`, data: { matched: r.total, returned: mine.length, lines: mine } };
    } });

  reg.define({ name: 'runtime_api_failures', tier: 'read_only', description: 'API failures seen by this server: failing endpoints grouped by route and status, plus unhandled errors with their stack heads.',
    input: { type: 'object', properties: { since_minutes: I({ minimum: 1, maximum: 1440 }) } },
    async handler(ctx, { since_minutes = 120 }) {
      const sinceMs = since_minutes * 60000;
      const reqs = logBuffer.query({ sinceMs, minStatus: 400, limit: 500 }).lines.filter((l) => l.msg === 'request' && (l.userId == null || l.userId === ctx.user.id));
      const groups = new Map();
      for (const l of reqs) { const key = `${l.method} ${String(l.path).replace(/\/\d+(?=\/|$)/g, '/:id').replace(/\/[A-Za-z0-9_-]{16,}(?=\/|$)/g, '/:uid')} → ${l.status}`; const g = groups.get(key) || { route: key, count: 0, last: null, slowestMs: 0 }; g.count++; g.last = l.ts; g.slowestMs = Math.max(g.slowestMs, l.ms || 0); groups.set(key, g); }
      const unhandled = logBuffer.query({ sinceMs, level: 'error', limit: 500 }).lines.filter((l) => l.msg !== 'request').slice(-15);
      const total = logBuffer.query({ sinceMs, limit: 500 }).lines.filter((l) => l.msg === 'request').length;
      return { summary: `${reqs.length} failing request(s) of ${total} in the last ${since_minutes} min; ${reqs.filter((l) => l.status >= 500).length} server error(s), ${unhandled.length} unhandled`,
        data: { windowMinutes: since_minutes, requests: total, failing: [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 30), unhandledErrors: unhandled } };
    } });

  reg.define({ name: 'runtime_background_tasks', tier: 'read_only', description: 'State of background work: the verification queue, active and interrupted/timed-out runs, autonomous-loop executions and continuous-watch checks for your projects.',
    async handler(ctx) {
      const u = ctx.user.id, day = new Date(Date.now() - 86400000).toISOString();
      const runs = (where, ...a) => db.all(`SELECT r.id, r.project_id, p.name project, r.trigger, r.status, r.note, r.created_at, r.started_at, r.finished_at FROM runs r JOIN projects p ON p.id = r.project_id WHERE p.user_id = ? AND ${where} ORDER BY r.id DESC LIMIT 25`, u, ...a);
      const data = { queue: runner.state(), activeRuns: runs(`r.status IN ('queued','running')`), interruptedRuns24h: runs(`r.status = 'interrupted' AND r.created_at > ?`, day),
        timedOutOrErroredChecks24h: db.all(`SELECT x.id result_id, x.run_id, x.criterion_key, x.status, x.error_kind, x.reason, x.finished_at FROM results x JOIN runs r ON r.id = x.run_id JOIN projects p ON p.id = r.project_id
          WHERE p.user_id = ? AND x.status IN ('timeout','error') AND x.finished_at > ? ORDER BY x.id DESC LIMIT 25`, u, day).map((x) => ({ ...x, explanation: explainError(x.error_kind) })),
        autonomousExecutions: db.all(`SELECT e.id, e.project_id, e.status, e.current_stage, e.retry_count, e.reason, e.updated_at FROM agent_executions e JOIN projects p ON p.id = e.project_id WHERE p.user_id = ? ORDER BY e.id DESC LIMIT 10`, u),
        watch: db.all(`SELECT w.project_id, w.enabled, w.interval_minutes, w.next_due_at, (SELECT health FROM watch_checks c WHERE c.project_id = w.project_id ORDER BY c.id DESC LIMIT 1) last_health,
          (SELECT COUNT(*) FROM watch_findings f WHERE f.project_id = w.project_id AND f.status = 'open') open_findings FROM watch_config w JOIN projects p ON p.id = w.project_id WHERE p.user_id = ?`, u) };
      const stuck = data.activeRuns.filter((r) => r.started_at && Date.now() - Date.parse(r.started_at) > 30 * 60000);
      return { summary: `${data.activeRuns.length} active run(s), ${data.interruptedRuns24h.length} interrupted and ${data.timedOutOrErroredChecks24h.length} errored/timed-out check(s) in 24 h${stuck.length ? `, ${stuck.length} running for over 30 min` : ''}`, data };
    } });

  reg.define({ name: 'runtime_database', tier: 'read_only', description: 'Database health: integrity check, applied migrations, file sizes, row counts of the core tables and recent database errors from the log. Runs no writes.',
    async handler() {
      const data = {};
      try { data.quickCheck = db.all('PRAGMA quick_check').map((r) => Object.values(r)[0]); } catch (e) { data.quickCheckError = e.message; }
      try { data.foreignKeyViolations = db.all('PRAGMA foreign_key_check').length; } catch (e) { data.foreignKeyError = e.message; }
      data.journalMode = db.get('PRAGMA journal_mode')?.journal_mode;
      data.migrations = db.all('SELECT name, applied_at FROM _migrations ORDER BY name');
      const pending = fs.readdirSync(path.join(deps.rootDir, 'migrations')).filter((f) => f.endsWith('.sql') && !data.migrations.some((m) => m.name === f));
      data.pendingMigrations = pending;
      const size = (f) => { try { return fs.statSync(path.join(dataDir, f)).size; } catch { return null; } };
      data.files = { dbBytes: size('shipproof.db'), walBytes: size('shipproof.db-wal') };
      data.rows = Object.fromEntries(['users', 'projects', 'criteria', 'runs', 'results', 'evidence', 'repair_tasks', 'builds', 'release_decisions', 'dossiers', 'audit_events'].map((t) => [t, db.get(`SELECT COUNT(*) n FROM ${t}`).n]));
      data.recentDatabaseErrors = logBuffer.query({ level: 'error', contains: 'sqlite', limit: 10 }).lines.concat(logBuffer.query({ level: 'error', contains: 'database', limit: 10 }).lines).slice(-10);
      const ok = data.quickCheck?.[0] === 'ok' && !data.foreignKeyViolations && !pending.length;
      return { summary: ok ? `Database healthy (${data.migrations.length} migrations applied, integrity ok)` : `Database needs attention: ${[data.quickCheck?.[0] !== 'ok' && 'integrity', data.foreignKeyViolations && 'foreign keys', pending.length && `${pending.length} pending migration(s)`].filter(Boolean).join(', ')}`, data };
    } });

  reg.define({ name: 'runtime_process', tier: 'read_only', description: 'The server process itself: uptime, memory, event-loop delay, CPU load, free disk on the data volume, Node version.',
    async handler() {
      const t0 = performance.now(); await new Promise((r) => setImmediate(r)); const lag = performance.now() - t0;
      const m = process.memoryUsage(); let disk = null;
      try { const s = fs.statfsSync(dataDir); disk = { freeMb: Math.round((s.bavail * s.bsize) / 1048576), totalMb: Math.round((s.blocks * s.bsize) / 1048576) }; } catch {}
      const data = { pid: process.pid, node: process.version, uptimeSeconds: Math.round(process.uptime()), rssMb: Math.round(m.rss / 1048576), heapUsedMb: Math.round(m.heapUsed / 1048576), eventLoopDelayMs: Number(lag.toFixed(2)),
        loadAverage: os.loadavg().map((n) => Number(n.toFixed(2))), cpus: os.cpus().length, disk, env: { NODE_ENV: process.env.NODE_ENV || null } };
      return { summary: `pid ${data.pid}, up ${data.uptimeSeconds}s, RSS ${data.rssMb} MB, loop delay ${data.eventLoopDelayMs} ms${disk ? `, ${disk.freeMb} MB disk free` : ''}`, data };
    } });

  // ---------------- SHIPPROOF ----------------
  reg.define({ name: 'shipproof_projects', tier: 'read_only', description: 'Your SHIPPROOF projects with their current release-gate verdict and blocking reasons.',
    async handler(ctx) {
      const ps = db.all('SELECT * FROM projects WHERE user_id = ? ORDER BY id DESC', ctx.user.id).map((p) => { const d = decide(p); return { id: p.id, name: p.name, appUrl: p.app_url, verdict: d.verdict, blocking: d.blocking.map((b) => b.message).slice(0, 5), freshness: d.freshness,
        lastRun: db.get('SELECT id, status, trigger, created_at FROM runs WHERE project_id = ? ORDER BY id DESC LIMIT 1', p.id) || null }; });
      return { summary: `${ps.length} project(s): ${ps.map((p) => `${p.name} = ${p.verdict}`).join('; ') || 'none'}`, data: { linkedProjectId: ctx.session.project_id, projects: ps } };
    } });

  reg.define({ name: 'shipproof_project', tier: 'read_only', description: 'Full verification picture of one project: release decision (computed by the gate, not by you), every acceptance criterion with status and evidence freshness, requirements, current build, open repair tasks.',
    input: { type: 'object', properties: { project_id: I({ minimum: 1 }) } },
    async handler(ctx, { project_id }) {
      const p = ownProject(ctx, project_id), d = decide(p), base = new Map(criteriaStatus(db, p.id).map((c) => [c.id, c]));
      const criteria = d.criteria.map((c) => { const b = base.get(c.id); return { id: c.id, key: c.key, text: c.text, mandatory: !!c.mandatory, criticality: c.criticality, status: c.status, freshness: c.freshness.state, freshnessReasons: c.freshness.reasons.map((r) => r.message),
        stability: c.stability.classification, attempts: b?.attempts, evidenceCount: b?.evidenceCount, latestResultId: b?.latest?.id ?? null, latestRunId: b?.latest?.run_id ?? null, latestReason: b?.latest?.reason || b?.latest?.summary || null, paths: c.paths }; });
      const data = { project: { id: p.id, name: p.name, appUrl: p.app_url, context: p.context }, decision: { verdict: d.verdict, releaseAllowed: d.releaseAllowed, blocking: d.blocking, policyVersion: d.policy.version, invariants: d.policy.invariants, build: d.build, freshness: d.freshness },
        criteria, requirements: db.all('SELECT id, text, created_at FROM requirements WHERE project_id = ? ORDER BY id', p.id).map((r) => ({ ...r, text: r.text.slice(0, 600) })),
        openRepairTasks: db.all(`SELECT t.id, c.key criterion, t.status, t.expected, t.observed, t.diagnosis, t.failures, t.source_result_id FROM repair_tasks t JOIN criteria c ON c.id = t.criterion_id WHERE t.project_id = ? AND t.status != 'verified' ORDER BY t.id DESC`, p.id) };
      return { summary: `${p.name}: gate ${d.verdict.toUpperCase()} — ${d.blocking.length ? d.blocking.map((b) => b.message).slice(0, 3).join(' | ') : 'no blocking reasons'}`, data };
    }, maxOutput: 24000 });

  reg.define({ name: 'shipproof_runs', tier: 'read_only', description: 'Verification execution history for a project (newest first), with per-status counts. Filter by status to find interrupted or failed runs.',
    input: { type: 'object', properties: { project_id: I({ minimum: 1 }), status: S({ enum: ['queued', 'running', 'completed', 'cancelled', 'interrupted'] }), limit: I({ minimum: 1, maximum: 40 }) } },
    async handler(ctx, { project_id, status, limit = 12 }) {
      const p = ownProject(ctx, project_id);
      const rows = db.all(`SELECT * FROM runs WHERE project_id = ? ${status ? 'AND status = ?' : ''} ORDER BY id DESC LIMIT ?`, ...[p.id, ...(status ? [status] : []), limit]);
      const runs = rows.map((r) => ({ id: r.id, trigger: r.trigger, status: r.status, note: r.note, createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at, buildId: r.build_id,
        counts: Object.fromEntries(db.all('SELECT status, COUNT(*) n FROM results WHERE run_id = ? GROUP BY status', r.id).map((x) => [x.status, x.n])) }));
      return { summary: `${runs.length} run(s) for ${p.name}${runs[0] ? `; latest #${runs[0].id} ${runs[0].status} ${JSON.stringify(runs[0].counts)}` : ''}`, data: { runs } };
    } });

  reg.define({ name: 'shipproof_run', tier: 'read_only', description: 'One verification run with every criterion result in it (status, error kind, reason, duration). Use to poll a run you started.',
    input: { type: 'object', required: ['run_id'], properties: { run_id: I({ minimum: 1 }) } },
    async handler(ctx, { run_id }) {
      const r = db.get('SELECT r.* FROM runs r JOIN projects p ON p.id = r.project_id WHERE r.id = ? AND p.user_id = ?', run_id, ctx.user.id);
      if (!r) throw new ToolError('not_found', `Run ${run_id} was not found for this account.`);
      const results = db.all('SELECT id, criterion_key, criterion_text, status, error_kind, exit_code, one_liner, reason, duration_ms, engine FROM results WHERE run_id = ? ORDER BY id', r.id)
        .map((x) => ({ resultId: x.id, criterion: x.criterion_key, text: x.criterion_text, status: x.status, errorKind: x.error_kind, explanation: ['error', 'timeout'].includes(x.status) ? explainError(x.error_kind) : null, exitCode: x.exit_code, reason: x.reason || x.one_liner, durationMs: x.duration_ms, engine: x.engine,
          evidenceArtifacts: db.get('SELECT COUNT(*) n FROM evidence WHERE result_id = ?', x.id).n }));
      const c = {}; for (const x of results) c[x.status] = (c[x.status] || 0) + 1;
      return { summary: `Run #${r.id} ${r.status}: ${Object.entries(c).map(([k, v]) => `${v} ${k}`).join(', ') || 'no results yet'}`, data: { run: { id: r.id, projectId: r.project_id, trigger: r.trigger, status: r.status, note: r.note, createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at }, results } };
    } });

  reg.define({ name: 'shipproof_result', tier: 'read_only', description: 'One Kane CLI execution in full: verdict, error classification, exit code and signal, the objective, the failing step, the tail of stdout/stderr and the evidence artifacts collected.',
    input: { type: 'object', required: ['result_id'], properties: { result_id: I({ minimum: 1 }) } },
    async handler(ctx, { result_id }) {
      const x = db.get('SELECT x.*, r.project_id FROM results x JOIN runs r ON r.id = x.run_id JOIN projects p ON p.id = r.project_id WHERE x.id = ? AND p.user_id = ?', result_id, ctx.user.id);
      if (!x) throw new ToolError('not_found', `Result ${result_id} was not found for this account.`);
      const ev = db.all('SELECT kind, name, mime, size, sha256 FROM evidence WHERE result_id = ?', x.id);
      const data = { resultId: x.id, runId: x.run_id, projectId: x.project_id, criterion: x.criterion_key, criterionText: x.criterion_text, status: x.status, errorKind: x.error_kind, explanation: ['error', 'timeout'].includes(x.status) ? explainError(x.error_kind) : null,
        exitCode: x.exit_code, signal: x.signal, engine: x.engine, kaneStatus: x.kane_status, summary: x.summary, reason: x.reason, finalState: x.final_state, failingStep: J(x.failing_step, null), objective: x.objective,
        startedAt: x.started_at, finishedAt: x.finished_at, durationMs: x.duration_ms, buildId: x.build_id, environment: x.environment, evidence: ev, stderrTail: tail(x.stderr), stdoutTail: tail(x.stdout, 3500) };
      return { summary: `${x.criterion_key} ${x.status}${x.error_kind ? ` (${x.error_kind})` : ''}: ${(x.reason || x.summary || x.one_liner || 'no reason recorded').slice(0, 200)} — ${ev.length} evidence artifact(s)`, data };
    }, maxOutput: 20000 });

  reg.define({ name: 'shipproof_history', tier: 'read_only', description: 'Release history of a project: registered builds (deployments), release decisions and proof dossiers, newest first.',
    input: { type: 'object', properties: { project_id: I({ minimum: 1 }) } },
    async handler(ctx, { project_id }) {
      const p = ownProject(ctx, project_id);
      const data = { builds: db.all('SELECT id, commit_sha, branch, environment, source, message, changed_paths, paths_known, created_at FROM builds WHERE project_id = ? ORDER BY id DESC LIMIT 15', p.id).map((b) => ({ ...b, changed_paths: J(b.changed_paths, []).slice(0, 30) })),
        decisions: db.all('SELECT id, build_id, policy_version, verdict, requested_by, created_at FROM release_decisions WHERE project_id = ? ORDER BY id DESC LIMIT 10', p.id),
        dossiers: db.all('SELECT uid, build_id, verdict, payload_sha256, created_at FROM dossiers WHERE project_id = ? ORDER BY id DESC LIMIT 10', p.id) };
      return { summary: `${p.name}: ${data.builds.length} build(s), ${data.decisions.length} decision(s), ${data.dossiers.length} dossier(s)${data.builds[0] ? `; latest build ${data.builds[0].commit_sha.slice(0, 7)} (${data.builds[0].environment})` : ''}`, data };
    } });

  reg.define({ name: 'shipproof_start_verification', tier: 'engineering', needs: 'incident', description: 'Start a REAL Kane CLI verification run for a project (spends engine credits). Modes: full, failed (re-run failed/blocked), untested, plan (change-impact plan for the latest build). Returns a run id — poll it with shipproof_run. The release gate decides the verdict; you cannot set it.',
    input: { type: 'object', required: ['mode'], properties: { project_id: I({ minimum: 1 }), mode: S({ enum: ['full', 'failed', 'untested', 'plan'] }) } },
    async handler(ctx, { project_id, mode }) {
      const p = ownProject(ctx, project_id);
      const k = await kaneStatus(kaneCfg, { fresh: true });
      if (!k.ready && k.state !== 'test_fixture') throw new ToolError('engine_unavailable', `Kane CLI is not ready (${k.state}): ${k.detail} A run now would only record execution errors, so none was started.`);
      let id; try { id = startRun(p, { mode: mode === 'full' ? undefined : mode, note: `On-call incident ${ctx.incident.uid}` }); } catch (e) { throw new ToolError('run_not_started', e.message); }
      return { summary: `Started verification run #${id} (${mode}) for ${p.name}`, data: { runId: id, engine: k.state, note: 'The run executes in the background. Poll shipproof_run until its status is completed.' }, meta: { runId: id } };
    } });
}
