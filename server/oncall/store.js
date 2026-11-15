// Persistence for on-call sessions, incidents, the evidence ledger and the session activity stream.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { now, newUid } from '../db.js';

export const STAGES = ['understand', 'investigate', 'diagnose', 'repair', 'verify', 'deliver', 'closed'];
const j = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

export function createStore({ db, redactor, retentionDays }) {
  const bus = new EventEmitter(); bus.setMaxListeners(0);
  const keepTranscript = retentionDays !== 0;

  /** Append to the session's activity stream. Payloads are redacted here, once, for every consumer. */
  function emit(sessionId, kind, payload = {}, incidentId = null) {
    const ts = now(), clean = redactor.deep(payload);
    const id = Number(db.run('INSERT INTO oncall_events (session_id, incident_id, ts, kind, payload) VALUES (?, ?, ?, ?, ?)', sessionId, incidentId, ts, kind, JSON.stringify(clean)).lastInsertRowid);
    const ev = { id, sessionId, incidentId, ts, kind, payload: clean };
    bus.emit(`s:${sessionId}`, ev);
    return ev;
  }
  /** Not persisted: live captions and audio-state hints. */
  const ephemeral = (sessionId, kind, payload) => bus.emit(`s:${sessionId}`, { id: null, sessionId, ts: now(), kind, payload: redactor.deep(payload) });

  const sessionView = (s) => s && ({ id: s.uid, mode: s.mode, permissionLevel: s.permission_level, status: s.status, projectId: s.project_id, voiceProvider: s.voice_provider, voiceState: s.voice_state,
    voiceSeconds: s.voice_seconds, providerStore: !!s.provider_store, endReason: s.end_reason, createdAt: s.created_at, endedAt: s.ended_at });
  const sessions = {
    create({ userId, projectId, mode, permissionLevel, voiceProvider, providerStore }) {
      const uid = newUid(), t = now();
      const id = Number(db.run(`INSERT INTO oncall_sessions (uid, user_id, project_id, mode, permission_level, status, voice_provider, provider_store, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
        uid, userId, projectId, mode, permissionLevel, voiceProvider, providerStore ? 1 : 0, t, t).lastInsertRowid);
      return sessions.byId(id);
    },
    byId: (id) => db.get('SELECT * FROM oncall_sessions WHERE id = ?', id),
    /** Session isolation: a session is only ever resolved together with the account that owns it. */
    owned: (uid, userId) => db.get('SELECT * FROM oncall_sessions WHERE uid = ? AND user_id = ?', String(uid), userId),
    activeFor: (userId) => db.all(`SELECT * FROM oncall_sessions WHERE user_id = ? AND status = 'active' ORDER BY id`, userId),
    allActive: () => db.all(`SELECT * FROM oncall_sessions WHERE status = 'active'`),
    touch: (id) => db.run('UPDATE oncall_sessions SET last_seen_at = ? WHERE id = ?', now(), id),
    set(id, fields) { const k = Object.keys(fields); if (k.length) db.run(`UPDATE oncall_sessions SET ${k.map((x) => `${x} = ?`).join(', ')} WHERE id = ?`, ...k.map((x) => fields[x]), id); return sessions.byId(id); },
    view: sessionView,
  };

  const transcript = {
    add(sessionId, speaker, source, text, incidentId = null) {
      const clean = redactor.text(text).trim();
      if (!clean) return null;
      const row = { sessionId, speaker, source, text: clean, createdAt: now() };
      if (keepTranscript) row.id = Number(db.run('INSERT INTO oncall_transcript (session_id, incident_id, speaker, source, text, created_at) VALUES (?, ?, ?, ?, ?, ?)', sessionId, incidentId, speaker, source, clean, row.createdAt).lastInsertRowid);
      ephemeral(sessionId, 'transcript', row);
      return row;
    },
    list: (sessionId, limit = 400) => db.all('SELECT id, speaker, source, text, created_at FROM oncall_transcript WHERE session_id = ? ORDER BY id DESC LIMIT ?', sessionId, limit).reverse()
      .map((r) => ({ id: r.id, speaker: r.speaker, source: r.source, text: r.text, createdAt: r.created_at })),
    /** Configurable retention: transcript text older than the window is deleted; incident records stay. */
    sweep() { if (retentionDays > 0) return db.run('DELETE FROM oncall_transcript WHERE created_at < ?', new Date(Date.now() - retentionDays * 86400000).toISOString()).changes; return 0; },
  };

  const evidence = {
    add({ sessionId, incidentId, tool, tier, input, ok, summary, output, durationMs }) {
      const seq = db.get('UPDATE oncall_sessions SET evidence_seq = evidence_seq + 1 WHERE id = ? RETURNING evidence_seq', sessionId).evidence_seq;
      const ref = `E-${seq}`, text = redactor.text(typeof output === 'string' ? output : JSON.stringify(output, null, 1)).slice(0, 60000);
      const sha = crypto.createHash('sha256').update(text).digest('hex');
      db.run('INSERT INTO oncall_evidence (session_id, incident_id, ref, tool, tier, input_json, ok, summary, output, sha256, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        sessionId, incidentId, ref, tool, tier, JSON.stringify(redactor.deep(input)).slice(0, 4000), ok ? 1 : 0, redactor.text(summary).slice(0, 400), text, sha, durationMs ?? null, now());
      return { ref, sha256: sha };
    },
    /** Evidence gathered before the incident was opened in the same session becomes part of it. */
    adopt: (sessionId, incidentId) => db.run('UPDATE oncall_evidence SET incident_id = ? WHERE session_id = ? AND incident_id IS NULL', incidentId, sessionId),
    known(sessionId, refs) { const have = new Set(db.all('SELECT ref FROM oncall_evidence WHERE session_id = ?', sessionId).map((r) => r.ref)); return refs.filter((r) => !have.has(r)); },
    get: (sessionId, ref) => db.get('SELECT * FROM oncall_evidence WHERE session_id = ? AND ref = ?', sessionId, ref),
    forIncident: (incidentId) => db.all('SELECT ref, tool, tier, input_json, ok, summary, sha256, duration_ms, created_at FROM oncall_evidence WHERE incident_id = ? ORDER BY id', incidentId)
      .map((e) => ({ ref: e.ref, tool: e.tool, tier: e.tier, input: j(e.input_json, {}), ok: !!e.ok, summary: e.summary, sha256: e.sha256, durationMs: e.duration_ms, at: e.created_at })),
  };

  const incidents = {
    open({ userId, sessionId, projectId, title, description, fields = {} }) {
      const uid = newUid(), t = now();
      const id = Number(db.run(`INSERT INTO oncall_incidents (uid, user_id, session_id, project_id, title, description, environment, symptoms, impact, timeframe, expected_outcome, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        uid, userId, sessionId, projectId ?? null, title, description, fields.environment ?? null, fields.symptoms ?? null, fields.impact ?? null, fields.timeframe ?? null, fields.expected_outcome ?? null, t, t).lastInsertRowid);
      evidence.adopt(sessionId, id);
      return incidents.byId(id);
    },
    byId: (id) => db.get('SELECT * FROM oncall_incidents WHERE id = ?', id),
    owned: (uid, userId) => db.get('SELECT * FROM oncall_incidents WHERE uid = ? AND user_id = ?', String(uid), userId),
    current: (sessionId) => db.get(`SELECT * FROM oncall_incidents WHERE session_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`, sessionId),
    list: (userId, limit = 50) => db.all('SELECT * FROM oncall_incidents WHERE user_id = ? ORDER BY id DESC LIMIT ?', userId, limit),
    set(id, fields) { const f = { ...fields, updated_at: now() }, k = Object.keys(f); db.run(`UPDATE oncall_incidents SET ${k.map((x) => `${x} = ?`).join(', ')} WHERE id = ?`, ...k.map((x) => f[x]), id); return incidents.byId(id); },
    /** Stages only move forward, and only because a recorded action put the incident there. */
    advance(inc, stage) { if (STAGES.indexOf(stage) > STAGES.indexOf(inc.stage)) { const next = incidents.set(inc.id, { stage }); emit(inc.session_id, 'incident.stage', { stage, from: inc.stage }, inc.id); return next; } return inc; },
    findings: (id) => db.all('SELECT * FROM oncall_findings WHERE incident_id = ? ORDER BY id', id).map((f) => ({ id: f.id, kind: f.kind, status: f.status, statement: f.statement, evidence: j(f.evidence_refs, []), at: f.created_at })),
    timeline: (id) => db.all('SELECT * FROM oncall_timeline WHERE incident_id = ? ORDER BY at, id', id).map((t) => ({ id: t.id, at: t.at, description: t.description, evidence: j(t.evidence_refs, []) })),
    checks: (id) => db.all('SELECT * FROM oncall_checks WHERE incident_id = ? ORDER BY id', id).map((c) => ({ id: c.id, phase: c.phase, kind: c.kind, target: c.target, command: c.command, status: c.status, exitCode: c.exit_code,
      treeSha: c.tree_sha, evidence: c.evidence_ref, outputTail: c.output_tail, durationMs: c.duration_ms, at: c.created_at })),
    view(inc, { full = false } = {}) {
      if (!inc) return null;
      const base = { id: inc.uid, title: inc.title, description: inc.description, projectId: inc.project_id, environment: inc.environment, symptoms: inc.symptoms, impact: inc.impact, timeframe: inc.timeframe,
        expectedOutcome: inc.expected_outcome, stage: inc.stage, status: inc.status, branch: inc.branch, baseBranch: inc.base_branch, baseSha: inc.base_sha, headSha: inc.head_sha, pushedSha: inc.pushed_sha,
        prUrl: inc.pr_url, prNumber: inc.pr_number, outcome: inc.outcome, summary: inc.summary, createdAt: inc.created_at, updatedAt: inc.updated_at, closedAt: inc.closed_at, hasReport: !!inc.report_md };
      if (!full) return base;
      return { ...base, diagnosis: j(inc.diagnosis_json, null), plan: j(inc.plan_json, null), findings: incidents.findings(inc.id), timeline: incidents.timeline(inc.id), checks: incidents.checks(inc.id),
        evidence: evidence.forIncident(inc.id), authorizations: authorizations.forIncident(inc.id) };
    },
  };

  const authView = (a) => ({ id: a.id, action: a.action, detail: j(a.detail_json, {}), reason: a.reason, status: a.status, requestedAt: a.requested_at, expiresAt: a.expires_at, decidedAt: a.decided_at });
  const authorizations = {
    hash: (action, params) => crypto.createHash('sha256').update(JSON.stringify([action, params])).digest('hex'),
    expire: () => db.run(`UPDATE oncall_authorizations SET status = 'expired' WHERE status IN ('pending','approved') AND expires_at < ?`, now()),
    request({ sessionId, incidentId, action, params, reason, ttlMs }) {
      authorizations.expire();
      const h = authorizations.hash(action, params);
      const open = db.get(`SELECT * FROM oncall_authorizations WHERE session_id = ? AND params_hash = ? AND status IN ('pending','approved')`, sessionId, h);
      if (open) return authView(open);
      const id = Number(db.run('INSERT INTO oncall_authorizations (session_id, incident_id, action, params_hash, detail_json, reason, requested_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        sessionId, incidentId, action, h, JSON.stringify(params), redactor.text(reason).slice(0, 600), now(), new Date(Date.now() + ttlMs).toISOString()).lastInsertRowid);
      return authView(db.get('SELECT * FROM oncall_authorizations WHERE id = ?', id));
    },
    /** An approval is consumed by exactly one execution of exactly the approved action and parameters. */
    consume(sessionId, action, params) {
      authorizations.expire();
      return db.run(`UPDATE oncall_authorizations SET status = 'used' WHERE id = (SELECT id FROM oncall_authorizations WHERE session_id = ? AND params_hash = ? AND status = 'approved' ORDER BY id LIMIT 1)`,
        sessionId, authorizations.hash(action, params)).changes === 1;
    },
    decide(id, sessionId, userId, approve) {
      authorizations.expire();
      const ok = db.run(`UPDATE oncall_authorizations SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND session_id = ? AND status = 'pending'`, approve ? 'approved' : 'denied', now(), userId, id, sessionId).changes === 1;
      return ok ? authView(db.get('SELECT * FROM oncall_authorizations WHERE id = ?', id)) : null;
    },
    forSession: (sessionId) => { authorizations.expire(); return db.all('SELECT * FROM oncall_authorizations WHERE session_id = ? ORDER BY id', sessionId).map(authView); },
    forIncident: (incidentId) => db.all('SELECT * FROM oncall_authorizations WHERE incident_id = ? ORDER BY id', incidentId).map(authView),
  };

  const events = {
    after: (sessionId, afterId = 0, limit = 1000) => db.all('SELECT * FROM oncall_events WHERE session_id = ? AND id > ? ORDER BY id LIMIT ?', sessionId, afterId, limit)
      .map((e) => ({ id: e.id, sessionId: e.session_id, incidentId: e.incident_id, ts: e.ts, kind: e.kind, payload: j(e.payload, {}) })),
    subscribe(sessionId, fn) { bus.on(`s:${sessionId}`, fn); return () => bus.off(`s:${sessionId}`, fn); },
  };
  return { emit, ephemeral, sessions, transcript, evidence, incidents, authorizations, events, db };
}
