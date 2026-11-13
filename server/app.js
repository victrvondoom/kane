import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, now, audit } from './db.js';
import { checkTarget } from './netpolicy.js';
import { hashPassword, verifyPassword, createSession, destroySession, currentUser, rateLimit, hashToken } from './auth.js';
import { decompose, categorize, formatKey, textHash } from './requirements.js';
import { criteriaStatus, releaseGate, repairTaskView, explainError } from './gate.js';
import { createRunner } from './runner.js';
import { kaneStatus, kaneConfig } from './kane.js';
import { DEMO_TEMPLATE } from './demo-template.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATEGORIES = ['functional', 'visual', 'persistence'];

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = (m) => new HttpError(400, m);
const str = (v, max, name) => {
  if (typeof v !== 'string' || !v.trim()) throw bad(`${name} is required`);
  if (v.length > max) throw bad(`${name} is too long (max ${max})`);
  return v.trim();
};
const ACTIVE = `('queued','starting','running')`;
const log = (level, msg, fields = {}) => { if (process.env.LOG_LEVEL !== 'silent') console.log(JSON.stringify({ ts: now(), level, msg, ...fields })); };

export function createApp({ dataDir = path.resolve(process.env.DATA_DIR || './data'), config = kaneConfig() } = {}) {
  const db = openDb(dataDir);
  const runner = createRunner({ db, dataDir, config });
  const evidenceRoot = path.join(dataDir, 'evidence');
  const validUrl = async (v) => {
    const r = await checkTarget(str(v, 500, 'Application URL'), { allowPrivate: config.allowPrivateTargets });
    if (!r.ok) throw bad(r.reason);
    return r.url;
  };
  db.run('DELETE FROM sessions WHERE expires_at < ?', now());
  const app = express();
  app.disable('x-powered-by');
  // Behind a reverse proxy set TRUST_PROXY (e.g. "1") so client IPs and https are detected correctly.
  if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);
  // No CORS headers are sent: the API is same-origin only. Coding agents use the Bearer-key API server-to-server.
  app.use((req, res, next) => {
    req.id = crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    const t0 = Date.now();
    res.on('finish', () => { if (req.path.startsWith('/api') && !req.path.endsWith('/stream')) log(res.statusCode >= 500 ? 'error' : 'info', 'request', { requestId: req.id, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t0, userId: req.user?.id }); });
    next();
  });
  // Liveness: the process is up. Readiness: it can actually serve (DB answers, data dir writable, not draining).
  let draining = false;
  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', async (req, res) => {
    const checks = { database: false, storage: false, accepting: !draining };
    try { checks.database = db.get('SELECT 1 ok').ok === 1; } catch {}
    try { fs.accessSync(dataDir, fs.constants.W_OK); checks.storage = true; } catch {}
    const k = await kaneStatus(config).catch(() => null);
    const ok = checks.database && checks.storage && checks.accepting;
    res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'not_ready', checks, engine: k ? { state: k.state, version: k.version } : null });
  });
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    next();
  });
  app.use(express.json({ limit: '200kb' }));
  // CSRF hardening: state-changing API calls must be JSON (cross-site forms cannot send that) — cookie is SameSite=Lax as well.
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) && !req.is('application/json') && Number(req.headers['content-length'] || 0) > 0)
      return res.status(415).json({ error: 'JSON body required' });
    next();
  });

  const api = express.Router();
  const h = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  const auth = (req, res, next) => {
    req.user = currentUser(db, req);
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    next();
  };
  const project = (req) => {
    const p = db.get('SELECT * FROM projects WHERE id = ? AND user_id = ?', Number(req.params.pid), req.user.id);
    if (!p) throw new HttpError(404, 'Project not found');
    return p;
  };
  const baseUrl = (req) => `${req.protocol}://${req.get('host')}`;
  const record = (req, action, extra = {}) => audit(db, { userId: req.user?.id ?? null, actor: req.project && !req.user ? 'agent' : 'user', requestId: req.id, action, ...extra });

  // ---------- auth ----------
  api.post('/auth/signup', h((req, res) => {
    if (!rateLimit('signup:' + req.ip)) throw new HttpError(429, 'Too many attempts, try again in a minute');
    const email = str(req.body.email, 200, 'Email').toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Enter a valid email address');
    const name = str(req.body.name, 80, 'Name');
    const pw = String(req.body.password || '');
    if (pw.length < 8) throw bad('Password must be at least 8 characters');
    if (db.get('SELECT 1 FROM users WHERE email = ?', email)) throw new HttpError(409, 'An account with this email already exists');
    const r = db.run('INSERT INTO users (email, name, pass_hash, created_at) VALUES (?, ?, ?, ?)', email, name, hashPassword(pw), now());
    createSession(db, res, Number(r.lastInsertRowid));
    res.json({ user: { id: Number(r.lastInsertRowid), email, name } });
  }));
  api.post('/auth/login', h((req, res) => {
    if (!rateLimit('login:' + req.ip)) throw new HttpError(429, 'Too many attempts, try again in a minute');
    const email = String(req.body.email || '').toLowerCase().trim();
    const u = db.get('SELECT * FROM users WHERE email = ?', email);
    if (!u || !verifyPassword(String(req.body.password || ''), u.pass_hash)) throw new HttpError(401, 'Incorrect email or password');
    createSession(db, res, u.id); // always a fresh token — no session fixation
    audit(db, { userId: u.id, action: 'auth.login', requestId: req.id });
    res.json({ user: { id: u.id, email: u.email, name: u.name } });
  }));
  api.post('/auth/logout', h((req, res) => { destroySession(db, req, res); res.json({ ok: true }); }));
  api.get('/auth/me', h((req, res) => res.json({ user: currentUser(db, req) })));

  // ---------- system ----------
  api.get('/system', auth, h(async (req, res) => res.json({ kane: await kaneStatus(config, { fresh: req.query.fresh === '1' }), runner: runner.state() })));
  api.get('/demo-template', auth, h(async (req, res) => {
    let reachable = false;
    try { const r = await fetch(DEMO_TEMPLATE.appUrl, { signal: AbortSignal.timeout(1500) }); reachable = r.ok; } catch {}
    res.json({ ...DEMO_TEMPLATE, reachable });
  }));
  api.post('/decompose', auth, h((req, res) => res.json({ criteria: decompose(str(req.body.text, 20000, 'Requirement text')) })));

  // ---------- projects ----------
  const projectSummary = (p) => {
    const criteria = criteriaStatus(db, p.id);
    const gate = releaseGate(criteria);
    const lastRun = db.get('SELECT id, status, trigger, created_at, started_at, finished_at FROM runs WHERE project_id = ? ORDER BY id DESC LIMIT 1', p.id);
    const shareActive = !!p.share_token_hash && (!p.share_expires_at || p.share_expires_at > now());
    return { id: p.id, name: p.name, appUrl: p.app_url, context: p.context, createdAt: p.created_at,
      share: { active: shareActive, expired: !!p.share_token_hash && !shareActive, createdAt: p.share_created_at, expiresAt: p.share_expires_at },
      hasApiKey: !!p.api_key_hash, gate, lastRun: lastRun ? runView(lastRun) : null };
  };
  const runView = (r) => {
    const c = db.all('SELECT status, COUNT(*) n FROM results WHERE run_id = ? GROUP BY status', r.id);
    const counts = Object.fromEntries(c.map((x) => [x.status, x.n]));
    const durationMs = r.started_at ? (r.finished_at ? Date.parse(r.finished_at) : Date.now()) - Date.parse(r.started_at) : null;
    return { id: r.id, projectId: r.project_id, parentRunId: r.parent_run_id, trigger: r.trigger, status: r.status, note: r.note,
      createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at, durationMs, counts,
      total: c.reduce((a, x) => a + x.n, 0) };
  };

  api.get('/projects', auth, h((req, res) => {
    const ps = db.all('SELECT * FROM projects WHERE user_id = ? ORDER BY id DESC', req.user.id).map(projectSummary);
    const recentRuns = db.all(`SELECT r.*, p.name project_name FROM runs r JOIN projects p ON p.id = r.project_id
                               WHERE p.user_id = ? ORDER BY r.id DESC LIMIT 8`, req.user.id).map((r) => ({ ...runView(r), projectName: r.project_name }));
    // Workspace metrics, computed from execution rows on every request.
    const ex = db.get(`SELECT COUNT(*) total, SUM(x.status = 'passed') passed, SUM(x.status = 'failed') failed, SUM(x.status IN ('error','timeout')) no_verdict
      FROM results x JOIN runs r ON r.id = x.run_id JOIN projects p ON p.id = r.project_id WHERE p.user_id = ? AND x.status IN ('passed','failed','error','timeout')`, req.user.id);
    const runCounts = db.get(`SELECT COUNT(*) total, SUM(r.status = 'completed') completed FROM runs r JOIN projects p ON p.id = r.project_id WHERE p.user_id = ?`, req.user.id);
    const decided = (ex.passed || 0) + (ex.failed || 0);
    res.json({ projects: ps, recentRuns, metrics: {
      projects: ps.length, releaseReady: ps.filter((p) => p.gate.verdict === 'verified').length,
      runs: runCounts.total, completedRuns: runCounts.completed || 0,
      executions: { passed: ex.passed || 0, failed: ex.failed || 0, noVerdict: ex.no_verdict || 0 },
      // pass rate over executions that reached a verdict; null until one exists
      passRate: decided ? (ex.passed || 0) / decided : null } });
  }));
  api.post('/projects', auth, h(async (req, res) => {
    const name = str(req.body.name, 100, 'Project name');
    const url = await validUrl(req.body.appUrl);
    const context = typeof req.body.context === 'string' ? req.body.context.slice(0, 2000) : '';
    const r = db.run('INSERT INTO projects (user_id, name, app_url, context, created_at) VALUES (?, ?, ?, ?, ?)', req.user.id, name, url, context, now());
    record(req, 'project.created', { projectId: Number(r.lastInsertRowid), entity: 'project', entityId: Number(r.lastInsertRowid), detail: { name, appUrl: url } });
    res.status(201).json({ project: projectSummary(db.get('SELECT * FROM projects WHERE id = ?', Number(r.lastInsertRowid))) });
  }));
  api.get('/projects/:pid', auth, h((req, res) => {
    const p = project(req);
    res.json({
      project: projectSummary(p),
      criteria: criteriaStatus(db, p.id),
      requirements: db.all('SELECT id, text, created_at FROM requirements WHERE project_id = ? ORDER BY id', p.id),
      runs: db.all('SELECT * FROM runs WHERE project_id = ? ORDER BY id DESC LIMIT 12', p.id).map(runView),
      runCount: db.get('SELECT COUNT(*) n FROM runs WHERE project_id = ?', p.id).n,
      variables: db.all('SELECT key, value, secret FROM project_variables WHERE project_id = ? ORDER BY key', p.id)
        .map((v) => ({ key: v.key, secret: !!v.secret, value: v.secret ? null : v.value })),
      repairTasks: db.all('SELECT * FROM repair_tasks WHERE project_id = ? ORDER BY id DESC', p.id).map((t) => repairTaskView(db, t, baseUrl(req))),
    });
  }));
  api.patch('/projects/:pid', auth, h(async (req, res) => {
    const p = project(req);
    const name = req.body.name !== undefined ? str(req.body.name, 100, 'Project name') : p.name;
    const url = req.body.appUrl !== undefined ? await validUrl(req.body.appUrl) : p.app_url;
    const context = req.body.context !== undefined ? String(req.body.context).slice(0, 2000) : p.context;
    db.run('UPDATE projects SET name = ?, app_url = ?, context = ? WHERE id = ?', name, url, context, p.id);
    record(req, 'project.updated', { projectId: p.id, entity: 'project', entityId: p.id, detail: { name, appUrl: url } });
    res.json({ project: projectSummary(db.get('SELECT * FROM projects WHERE id = ?', p.id)) });
  }));
  api.delete('/projects/:pid', auth, h((req, res) => {
    const p = project(req);
    if (runner.activeRunFor(p.id)) throw new HttpError(409, 'A run is in progress for this project. Cancel it first.');
    db.run('DELETE FROM projects WHERE id = ?', p.id);
    fs.rm(path.join(evidenceRoot, `project-${p.id}`), { recursive: true, force: true }, () => {});
    audit(db, { userId: req.user.id, action: 'project.deleted', detail: { id: p.id, name: p.name }, requestId: req.id });
    res.json({ ok: true });
  }));

  // variables (test accounts etc.) — secret values are write-only
  api.put('/projects/:pid/variables/:key', auth, h((req, res) => {
    const p = project(req);
    const key = req.params.key;
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,40}$/.test(key)) throw bad('Variable names use letters, digits and underscores');
    const value = str(String(req.body.value ?? ''), 500, 'Value');
    db.run(`INSERT INTO project_variables VALUES (?, ?, ?, ?) ON CONFLICT (project_id, key) DO UPDATE SET value = excluded.value, secret = excluded.secret`,
      p.id, key, value, req.body.secret ? 1 : 0);
    res.json({ ok: true });
  }));
  api.delete('/projects/:pid/variables/:key', auth, h((req, res) => {
    db.run('DELETE FROM project_variables WHERE project_id = ? AND key = ?', project(req).id, req.params.key);
    res.json({ ok: true });
  }));

  // ---------- requirements & criteria ----------
  const addCriterion = (p, requirementId, c) => {
    const text = str(c.text, 600, 'Criterion text');
    const category = CATEGORIES.includes(c.category) ? c.category : categorize(text);
    const seq = db.get('UPDATE projects SET criteria_seq = criteria_seq + 1 WHERE id = ? RETURNING criteria_seq', p.id).criteria_seq;
    db.run('INSERT INTO criteria (project_id, requirement_id, key, text, category, mandatory, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      p.id, requirementId, formatKey(seq), text, category, c.mandatory === false ? 0 : 1, now(), now());
  };
  api.post('/projects/:pid/requirements', auth, h((req, res) => {
    const p = project(req);
    const text = str(req.body.text, 20000, 'Requirement text');
    const list = Array.isArray(req.body.criteria) ? req.body.criteria : decompose(text);
    if (!list.length) throw bad('No acceptance criteria could be derived from this text');
    if (list.length > 100) throw bad('Too many criteria in one requirement (max 100)');
    db.tx(() => {
      const rid = Number(db.run('INSERT INTO requirements (project_id, text, created_at) VALUES (?, ?, ?)', p.id, text, now()).lastInsertRowid);
      for (const c of list) addCriterion(p, rid, c);
    });
    res.status(201).json({ criteria: criteriaStatus(db, p.id) });
  }));
  api.post('/projects/:pid/criteria', auth, h((req, res) => {
    const p = project(req);
    db.tx(() => addCriterion(p, null, req.body));
    res.status(201).json({ criteria: criteriaStatus(db, p.id) });
  }));
  const criterion = (req, p) => {
    const c = db.get('SELECT * FROM criteria WHERE id = ? AND project_id = ? AND archived = 0', Number(req.params.cid), p.id);
    if (!c) throw new HttpError(404, 'Criterion not found');
    return c;
  };
  const guardOpenRepair = (c, action) => {
    if (db.get(`SELECT 1 FROM repair_tasks WHERE criterion_id = ? AND status != 'verified'`, c.id))
      throw new HttpError(409, `${c.key} has an open repair task from a real failure. Fix the application and re-verify — you cannot ${action} a failing criterion.`);
  };
  api.patch('/projects/:pid/criteria/:cid', auth, h((req, res) => {
    const p = project(req); const c = criterion(req, p);
    const text = req.body.text !== undefined ? str(req.body.text, 600, 'Criterion text') : c.text;
    const category = req.body.category !== undefined ? req.body.category : c.category;
    if (!CATEGORIES.includes(category)) throw bad('Unknown category');
    const mandatory = req.body.mandatory !== undefined ? (req.body.mandatory ? 1 : 0) : c.mandatory;
    if (textHash(text) !== textHash(c.text)) guardOpenRepair(c, 'reword');
    if (c.mandatory && !mandatory) guardOpenRepair(c, 'make optional');
    db.run('UPDATE criteria SET text = ?, category = ?, mandatory = ?, updated_at = ? WHERE id = ?', text, category, mandatory, now(), c.id);
    if (text !== c.text || mandatory !== c.mandatory) record(req, 'criterion.updated', { projectId: p.id, entity: 'criterion', entityId: c.id, detail: { key: c.key, textChanged: text !== c.text, mandatory: !!mandatory } });
    res.json({ criteria: criteriaStatus(db, p.id) });
  }));
  api.delete('/projects/:pid/criteria/:cid', auth, h((req, res) => {
    const p = project(req); const c = criterion(req, p);
    guardOpenRepair(c, 'delete');
    db.run('UPDATE criteria SET archived = 1, updated_at = ? WHERE id = ?', now(), c.id); // history is preserved
    record(req, 'criterion.archived', { projectId: p.id, entity: 'criterion', entityId: c.id, detail: { key: c.key } });
    res.json({ criteria: criteriaStatus(db, p.id) });
  }));
  api.get('/projects/:pid/criteria/:cid/history', auth, h((req, res) => {
    const p = project(req); const c = criterion(req, p);
    res.json({ history: db.all(`SELECT id, run_id, status, error_kind, exit_code, criterion_text, summary, reason, started_at, finished_at, duration_ms
                                FROM results WHERE criterion_id = ? ORDER BY id DESC LIMIT 100`, c.id) });
  }));

  // ---------- runs ----------
  const startRun = (p, body) => {
    // One run per project at a time: prevents duplicate submissions racing each other.
    const busy = runner.activeRunFor(p.id);
    if (busy) throw Object.assign(new HttpError(409, `Run #${busy} is already in progress for this project`), { activeRunId: busy });
    const all = criteriaStatus(db, p.id);
    let ids, trigger = 'full', parent = null;
    if (body.mode === 'failed') {
      ids = all.filter((c) => c.status === 'failed' || c.status === 'blocked').map((c) => c.id);
      trigger = 'rerun_failed';
      parent = db.get('SELECT id FROM runs WHERE project_id = ? ORDER BY id DESC LIMIT 1', p.id)?.id ?? null;
      if (!ids.length) throw bad('There are no failed or blocked criteria to re-run');
    } else if (body.mode === 'untested') {
      ids = all.filter((c) => c.status === 'untested').map((c) => c.id); trigger = 'untested';
      if (!ids.length) throw bad('Every criterion already has an execution result');
    } else if (Array.isArray(body.criterionIds) && body.criterionIds.length) {
      const allowed = new Set(all.map((c) => c.id));
      ids = body.criterionIds.map(Number).filter((id) => allowed.has(id)); trigger = 'selected';
      parent = db.get('SELECT id FROM runs WHERE project_id = ? ORDER BY id DESC LIMIT 1', p.id)?.id ?? null;
      if (!ids.length) throw bad('No valid criteria selected');
    } else {
      ids = all.map((c) => c.id);
      if (!ids.length) throw bad('Add at least one acceptance criterion before starting a verification');
    }
    return runner.enqueue({ projectId: p.id, criterionIds: ids, trigger, parentRunId: parent, note: typeof body.note === 'string' ? body.note.slice(0, 300) : '' });
  };
  // Paginated, filterable history (newest first; `before` is a run-id cursor).
  const listRuns = (where, params, q) => {
    const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 100);
    const RUN_STATUS = ['queued', 'running', 'completed', 'cancelled', 'interrupted'];
    if (q.status !== undefined && !RUN_STATUS.includes(q.status)) throw bad('Unknown run status filter');
    const sql = [where, q.status ? 'r.status = ?' : null, Number(q.before) ? 'r.id < ?' : null].filter(Boolean).join(' AND ');
    const args = [...params, ...(q.status ? [q.status] : []), ...(Number(q.before) ? [Number(q.before)] : [])];
    const rows = db.all(`SELECT r.*, p.name project_name FROM runs r JOIN projects p ON p.id = r.project_id WHERE ${sql} ORDER BY r.id DESC LIMIT ?`, ...args, limit + 1);
    const page = rows.slice(0, limit);
    return { runs: page.map((r) => ({ ...runView(r), projectName: r.project_name })), nextBefore: rows.length > limit ? page.at(-1).id : null,
      total: db.get(`SELECT COUNT(*) n FROM runs r JOIN projects p ON p.id = r.project_id WHERE ${[where, q.status ? 'r.status = ?' : null].filter(Boolean).join(' AND ')}`, ...params, ...(q.status ? [q.status] : [])).n };
  };
  api.get('/projects/:pid/runs', auth, h((req, res) => res.json(listRuns('r.project_id = ?', [project(req).id], req.query))));
  api.get('/runs', auth, h((req, res) => {
    if (req.query.project !== undefined) { req.params.pid = req.query.project; return res.json(listRuns('r.project_id = ?', [project(req).id], req.query)); }
    res.json(listRuns('p.user_id = ?', [req.user.id], req.query));
  }));
  api.post('/projects/:pid/runs', auth, h((req, res) => {
    const p = project(req);
    const id = startRun(p, req.body || {});
    record(req, 'run.started', { projectId: p.id, entity: 'run', entityId: id, detail: { mode: req.body?.mode || (req.body?.criterionIds ? 'selected' : 'full') } });
    res.status(202).json({ run: runView(db.get('SELECT * FROM runs WHERE id = ?', id)) });
  }));
  const ownedRun = (req) => {
    const r = db.get(`SELECT r.* FROM runs r JOIN projects p ON p.id = r.project_id WHERE r.id = ? AND p.user_id = ?`, Number(req.params.rid), req.user.id);
    if (!r) throw new HttpError(404, 'Run not found');
    return r;
  };
  const resultView = (r, full) => ({
    id: r.id, runId: r.run_id, criterionId: r.criterion_id, criterionKey: r.criterion_key, criterionText: r.criterion_text,
    status: r.status, errorKind: r.error_kind, errorExplanation: ['error', 'timeout'].includes(r.status) ? explainError(r.error_kind) : null,
    exitCode: r.exit_code, signal: r.signal, kaneStatus: r.kane_status, summary: r.summary, oneLiner: r.one_liner, reason: r.reason,
    finalState: r.final_state ? JSON.parse(r.final_state) : null, failingStep: r.failing_step ? JSON.parse(r.failing_step) : null,
    testUrl: r.test_url, credits: r.credits, startedAt: r.started_at, finishedAt: r.finished_at, durationMs: r.duration_ms,
    engine: r.engine, isFixture: /fixture/i.test(r.engine || ''),
    evidence: db.all('SELECT uid id, kind, name, url, mime, size FROM evidence WHERE result_id = ? ORDER BY id', r.id),
    ...(full ? { objective: r.objective, command: r.command, stdout: r.stdout, stderr: r.stderr } : {}),
  });
  api.get('/runs/:rid', auth, h((req, res) => {
    const r = ownedRun(req);
    const p = db.get('SELECT id, name, app_url FROM projects WHERE id = ?', r.project_id);
    res.json({ run: runView(r), project: { id: p.id, name: p.name, appUrl: p.app_url },
      results: db.all('SELECT * FROM results WHERE run_id = ? ORDER BY id', r.id).map((x) => resultView(x, false)) });
  }));
  api.get('/runs/:rid/results/:resid', auth, h((req, res) => {
    const r = ownedRun(req);
    const x = db.get('SELECT * FROM results WHERE id = ? AND run_id = ?', Number(req.params.resid), r.id);
    if (!x) throw new HttpError(404, 'Result not found');
    res.json({ result: resultView(x, true) });
  }));
  api.post('/runs/:rid/cancel', auth, h((req, res) => {
    const r = ownedRun(req);
    if (!runner.cancel(r.id)) throw new HttpError(409, 'Run is not active');
    record(req, 'run.cancelled', { projectId: r.project_id, entity: 'run', entityId: r.id });
    res.json({ ok: true });
  }));
  api.get('/runs/:rid/events', auth, h((req, res) => {
    const r = ownedRun(req);
    const after = Number(req.query.after) || 0;
    res.json({ events: db.all('SELECT id, result_id, ts, kind, payload FROM run_events WHERE run_id = ? AND id > ? ORDER BY id LIMIT 2000', r.id, after)
      .map((e) => ({ ...e, payload: JSON.parse(e.payload) })) });
  }));
  // Live stream: replays persisted events, then follows the run in real time.
  api.get('/runs/:rid/stream', auth, h((req, res) => {
    const r = ownedRun(req);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    // Cursor: the browser re-sends Last-Event-ID on reconnect, so nothing is lost or repeated.
    let last = Number(req.headers['last-event-id']) || Number(req.query.after) || 0;
    const send = (e) => {
      if (e.id <= last || res.writableEnded) return;
      last = e.id;
      res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
      // Slow client: drop the connection instead of buffering without bound; it resumes from its cursor.
      if (res.writableLength > 1_000_000) res.end();
    };
    const pending = []; let replayed = false;
    const onEvent = (e) => {
      if (e.kind === 'end') { if (!res.writableEnded) res.write('event: end\ndata: {}\n\n'); return; }
      replayed ? send(e) : pending.push(e);
    };
    runner.bus.on(`run:${r.id}`, onEvent);
    for (const e of db.all('SELECT id, result_id, ts, kind, payload FROM run_events WHERE run_id = ? AND id > ? ORDER BY id', r.id, last))
      send({ ...e, payload: JSON.parse(e.payload) });
    replayed = true; pending.forEach(send);
    const cur = db.get('SELECT status FROM runs WHERE id = ?', r.id);
    if (!['queued', 'running'].includes(cur.status)) res.write('event: end\ndata: {}\n\n');
    const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 20000);
    req.on('close', () => { clearInterval(ping); runner.bus.off(`run:${r.id}`, onEvent); });
  }));

  // ---------- evidence ----------
  const sendEvidence = (res, ev) => {
    if (!ev || !ev.rel_path) throw new HttpError(404, 'Evidence file not found');
    const file = path.resolve(evidenceRoot, ev.rel_path);
    if (!file.startsWith(evidenceRoot + path.sep) || !fs.existsSync(file)) throw new HttpError(404, 'Evidence file not found');
    const inline = /^(image|video)\//.test(ev.mime || '');
    res.setHeader('Content-Type', inline ? ev.mime : ev.mime === 'application/json' ? 'application/json' : /^text\//.test(ev.mime || '') && ev.mime !== 'text/html' ? 'text/plain; charset=utf-8' : 'application/octet-stream');
    res.setHeader('Content-Disposition', `${inline || /json|text\/(plain|markdown|yaml)/.test(ev.mime || '') ? 'inline' : 'attachment'}; filename="${path.basename(ev.name).replace(/[^\w.-]/g, '_')}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(file).pipe(res);
  };
  api.get('/evidence/:eid/file', auth, h((req, res) => {
    sendEvidence(res, db.get(`SELECT e.* FROM evidence e JOIN results r ON r.id = e.result_id JOIN runs n ON n.id = r.run_id
      JOIN projects p ON p.id = n.project_id WHERE e.uid = ? AND p.user_id = ?`, String(req.params.eid), req.user.id));
  }));

  // ---------- repair loop ----------
  const ownedTask = (req) => {
    const t = db.get(`SELECT t.* FROM repair_tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ? AND p.user_id = ?`, Number(req.params.tid), req.user.id);
    if (!t) throw new HttpError(404, 'Repair task not found');
    return t;
  };
  const markFixed = (t, body, req, by) => {
    if (t.status === 'verified') throw new HttpError(409, 'This repair task is already verified by a passing run');
    const busy = runner.activeRunFor(t.project_id);
    if (busy) throw new HttpError(409, `Run #${busy} is already in progress for this project. Wait for it to finish before re-verifying.`);
    const note = typeof body.note === 'string' ? body.note.slice(0, 1000) : null;
    // A claimed fix proves nothing: the declaration only queues a Kane CLI re-run of this criterion.
    const runId = runner.enqueue({ projectId: t.project_id, criterionIds: [t.criterion_id], trigger: 'repair_verify',
      parentRunId: db.get('SELECT run_id FROM results WHERE id = ?', t.source_result_id).run_id, note: `Re-verification of RT-${t.id}` });
    db.run(`UPDATE repair_tasks SET status = 'fix_applied', fix_note = ?, fix_declared_at = ?, fix_declared_by = ?, verify_run_id = ?, updated_at = ? WHERE id = ?`,
      note, now(), by, runId, now(), t.id);
    audit(db, { userId: req.user?.id ?? null, projectId: t.project_id, actor: by, action: 'repair_task.fix_declared', entity: 'repair_task', entityId: t.id, detail: { note, verifyRunId: runId }, requestId: req.id });
    return runView(db.get('SELECT * FROM runs WHERE id = ?', runId));
  };
  api.get('/repair-tasks/:tid', auth, h((req, res) => res.json({ task: repairTaskView(db, ownedTask(req), baseUrl(req)) })));
  api.post('/repair-tasks/:tid/fix-applied', auth, h((req, res) => res.status(202).json({ run: markFixed(ownedTask(req), req.body || {}, req, 'user') })));

  // ---------- report ----------
  const buildReport = (p) => {
    const criteria = criteriaStatus(db, p.id);
    const gate = releaseGate(criteria);
    const runs = db.all('SELECT * FROM runs WHERE project_id = ? ORDER BY id', p.id).map(runView);
    const firstRun = runs[0], lastRun = runs.at(-1);
    return {
      generatedAt: now(), project: { id: p.id, name: p.name, appUrl: p.app_url }, gate,
      engine: 'Kane CLI (@testmuai/kane-cli)',
      criteria: criteria.map((c) => ({
        key: c.key, text: c.text, category: c.category, mandatory: c.mandatory, status: c.status, evidenceCount: c.evidenceCount,
        latest: c.latest ? { resultId: c.latest.id, runId: c.latest.run_id, status: c.latest.status, errorKind: c.latest.error_kind, exitCode: c.latest.exit_code,
          summary: c.latest.summary, reason: c.latest.reason, testUrl: c.latest.test_url, finishedAt: c.latest.finished_at, durationMs: c.latest.duration_ms } : null,
        trail: db.all(`SELECT id resultId, run_id runId, status, exit_code exitCode, finished_at finishedAt FROM results
                       WHERE criterion_id = ? AND status IN ('passed','failed','error','timeout') ORDER BY id`, c.id),
        engine: c.latest ? db.get('SELECT engine FROM results WHERE id = ?', c.latest.id).engine : null,
        screenshots: c.latest ? db.all(`SELECT uid id, name FROM evidence WHERE result_id = ? AND kind = 'screenshot' ORDER BY id DESC LIMIT 3`, c.latest.id) : [],
      })),
      repairs: db.all('SELECT * FROM repair_tasks WHERE project_id = ? ORDER BY id', p.id).map((t) => {
        const v = repairTaskView(db, t);
        return { id: v.id, status: v.status, criterionKey: v.criterionKey, observed: v.observed, failures: v.failures, fixNote: v.fixNote,
          failedRunId: v.sourceResult.run_id, verifiedRunId: v.verifiedBy?.run_id ?? null, createdAt: v.createdAt, updatedAt: v.updatedAt };
      }),
      runs, window: { firstRunAt: firstRun?.createdAt ?? null, lastRunAt: lastRun?.finishedAt ?? lastRun?.createdAt ?? null },
    };
  };
  api.get('/projects/:pid/report', auth, h((req, res) => res.json({ report: buildReport(project(req)) })));
  api.post('/projects/:pid/share', auth, h((req, res) => {
    const p = project(req);
    // Only the hash is stored; the link is shown once. Creating a new link replaces (revokes) the old one.
    const days = req.body?.expiresInDays;
    if (days !== undefined && days !== null && !(Number.isInteger(days) && days >= 1 && days <= 365)) throw bad('expiresInDays must be a whole number between 1 and 365');
    const token = crypto.randomBytes(24).toString('base64url');
    const expires = days ? new Date(Date.now() + days * 86400000).toISOString() : null;
    db.run('UPDATE projects SET share_token_hash = ?, share_created_at = ?, share_expires_at = ? WHERE id = ?', hashToken(token), now(), expires, p.id);
    record(req, 'share.created', { projectId: p.id, entity: 'project', entityId: p.id, detail: { expiresAt: expires } });
    res.json({ shareToken: token, url: `${baseUrl(req)}/r/${token}`, expiresAt: expires });
  }));
  api.delete('/projects/:pid/share', auth, h((req, res) => {
    const p = project(req);
    db.run('UPDATE projects SET share_token_hash = NULL, share_created_at = NULL, share_expires_at = NULL WHERE id = ?', p.id);
    record(req, 'share.revoked', { projectId: p.id, entity: 'project', entityId: p.id });
    res.json({ ok: true });
  }));
  const shared = (req) => {
    const p = /^[\w-]{16,64}$/.test(req.params.token) ? db.get('SELECT * FROM projects WHERE share_token_hash = ?', hashToken(req.params.token)) : null;
    if (!p) throw new HttpError(404, 'This report link is invalid or has been revoked');
    if (p.share_expires_at && p.share_expires_at <= now()) throw new HttpError(410, 'This report link has expired');
    return p;
  };
  api.get('/public/report/:token', h((req, res) => res.json({ report: buildReport(shared(req)) })));
  api.get('/public/report/:token/evidence/:eid', h((req, res) => {
    const p = shared(req);
    sendEvidence(res, db.get(`SELECT e.* FROM evidence e JOIN results r ON r.id = e.result_id JOIN runs n ON n.id = r.run_id
      WHERE e.uid = ? AND n.project_id = ? AND e.kind = 'screenshot'`, String(req.params.eid), p.id));
  }));

  // ---------- coding-agent API (project API key, Bearer) ----------
  api.post('/projects/:pid/api-key', auth, h((req, res) => {
    const p = project(req);
    const key = 'spk_' + crypto.randomBytes(24).toString('base64url');
    db.run('UPDATE projects SET api_key_hash = ? WHERE id = ?', hashToken(key), p.id);
    record(req, p.api_key_hash ? 'api_key.rotated' : 'api_key.created', { projectId: p.id, entity: 'project', entityId: p.id });
    res.json({ apiKey: key, note: 'Shown once. Store it in your coding agent\'s secret store.' });
  }));
  api.delete('/projects/:pid/api-key', auth, h((req, res) => {
    const p = project(req);
    db.run('UPDATE projects SET api_key_hash = NULL WHERE id = ?', p.id);
    record(req, 'api_key.revoked', { projectId: p.id, entity: 'project', entityId: p.id });
    res.json({ ok: true });
  }));
  api.get('/projects/:pid/audit', auth, h((req, res) => {
    const p = project(req);
    res.json({ events: db.all('SELECT id, ts, actor, action, entity, entity_id, detail FROM audit_events WHERE project_id = ? ORDER BY id DESC LIMIT 100', p.id)
      .map((e) => ({ ...e, detail: JSON.parse(e.detail) })) });
  }));
  const agent = (req, res, next) => {
    const m = /^Bearer (spk_[\w-]{20,})$/.exec(req.headers.authorization || '');
    const p = m ? db.get('SELECT * FROM projects WHERE api_key_hash = ?', hashToken(m[1])) : null;
    if (!p) return res.status(401).json({ error: 'Invalid or missing project API key' });
    req.project = p; next();
  };
  api.get('/agent/gate', agent, h((req, res) => {
    const criteria = criteriaStatus(db, req.project.id);
    res.json({ project: req.project.name, appUrl: req.project.app_url, gate: releaseGate(criteria),
      criteria: criteria.map((c) => ({ key: c.key, text: c.text, status: c.status, mandatory: c.mandatory })), runner: runner.state() });
  }));
  api.get('/agent/repair-tasks', agent, h((req, res) => {
    const tasks = db.all(`SELECT * FROM repair_tasks WHERE project_id = ? AND status != 'verified' ORDER BY id`, req.project.id)
      .map((t) => { const v = repairTaskView(db, t, baseUrl(req)); return { id: v.id, status: v.status, criterionKey: v.criterionKey, criterion: v.criterionText,
        expected: v.expected, observed: v.observed, diagnosis: v.diagnosis, failures: v.failures, prompt: v.prompt }; });
    res.json({ tasks });
  }));
  api.post('/agent/repair-tasks/:tid/fix-applied', agent, h((req, res) => {
    const t = db.get('SELECT * FROM repair_tasks WHERE id = ? AND project_id = ?', Number(req.params.tid), req.project.id);
    if (!t) throw new HttpError(404, 'Repair task not found');
    res.status(202).json({ run: markFixed(t, req.body || {}, req, 'agent'), message: 'Re-verification queued. Poll GET /api/agent/gate for the outcome.' });
  }));
  api.post('/agent/runs', agent, h((req, res) => {
    const id = startRun(req.project, req.body || {});
    audit(db, { projectId: req.project.id, actor: 'agent', action: 'run.started', entity: 'run', entityId: id, requestId: req.id });
    res.status(202).json({ run: runView(db.get('SELECT * FROM runs WHERE id = ?', id)) });
  }));

  api.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/api', api);
  app.use('/api', (err, req, res, _next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status === 500) log('error', 'unhandled', { requestId: req.id, path: req.path, error: err.message, stack: err.stack?.split('\n').slice(0, 4).join(' | ') });
    res.status(status).json({ error: status === 500 ? 'Internal server error' : err.message, requestId: req.id, ...(err.activeRunId ? { activeRunId: err.activeRunId } : {}) });
  });

  app.use(express.static(path.join(ROOT, 'public'), { index: false, maxAge: 0 }));
  app.get('*', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));
  /** Graceful shutdown: stop taking work, stop the browser, flush state, close the DB. */
  const shutdown = async () => { draining = true; await runner.shutdown(); try { db.close(); } catch {} };
  return { app, db, runner, shutdown };
}
