// HTTP API for the on-call agent. Every route requires a signed-in user, and every session or incident is resolved
// together with that user's id — one account can never read or steer another account's session.
import { rateLimit } from '../auth.js';
import { audit } from '../db.js';
import { SessionError } from './sessions.js';
import { verificationOf, VERIFICATION_LABEL } from './report.js';

export function registerOncallRoutes(api, { auth, h, HttpError, db, cfg, store, registry, engineer, sessions, status, roleFor }) {
  const wrap = (fn) => h(async (req, res) => { try { await fn(req, res); } catch (e) { if (e instanceof SessionError) throw Object.assign(new HttpError(e.status, e.message), { code: e.code }); throw e; } });
  const enabled = (req, res, next) => { if (!cfg.enabled || !roleFor(req.user)) return res.status(403).json({ error: 'The on-call agent is not enabled for your account.', code: 'not_enabled' }); next(); };
  const limit = (key, max, windowMs = 60000) => (req, res, next) => (rateLimit(`oncall:${key}:${req.user.id}`, max, windowMs) ? next() : res.status(429).json({ error: 'Too many requests — slow down.' }));
  const session = (req) => { const s = store.sessions.owned(req.params.sid, req.user.id); if (!s) throw new HttpError(404, 'Session not found'); return s; };
  const incident = (req) => { const i = store.incidents.owned(req.params.iid, req.user.id); if (!i) throw new HttpError(404, 'Incident not found'); return i; };
  const record = (req, action, s, detail = {}) => audit(db, { userId: req.user.id, projectId: s.project_id ?? null, action, entity: 'oncall_session', entityId: s.id, detail: { session: s.uid, ...detail }, requestId: req.id });
  const snapshot = async (s) => {
    const inc = store.incidents.current(s.id) || db.get('SELECT * FROM oncall_incidents WHERE session_id = ? ORDER BY id DESC LIMIT 1', s.id);
    return { session: store.sessions.view(s), transcript: store.transcript.list(s.id), engineer: engineer.status(s.id),
      incident: inc ? { ...store.incidents.view(inc, { full: true }), verification: await verificationOf(store, inc, cfg.repoDir).then((v) => ({ ...v, statement: VERIFICATION_LABEL[v.level] })) } : null,
      authorizations: store.authorizations.forSession(s.id), lastEventId: db.get('SELECT MAX(id) m FROM oncall_events WHERE session_id = ?', s.id).m || 0 };
  };

  api.get('/oncall/status', auth, h(async (req, res) => {
    const st = await status(req.user), active = st.enabled ? store.sessions.activeFor(req.user.id).at(-1) : null;
    res.json({ ...st, activeSession: active ? store.sessions.view(active) : null });
  }));

  api.post('/oncall/sessions', auth, enabled, limit('create', 12), wrap(async (req, res) => {
    const b = req.body || {};
    const s = sessions.create(req.user, { projectId: b.projectId != null ? Number(b.projectId) : null, permissionLevel: b.permissionLevel || 'read_only', mode: b.mode === 'text' ? 'text' : 'voice', consentProviderStore: b.consentProviderStore === true });
    record(req, 'oncall.session.started', s, { mode: s.mode, permissionLevel: s.permission_level });
    res.status(201).json(await snapshot(s));
  }));
  api.get('/oncall/sessions/:sid', auth, enabled, wrap(async (req, res) => res.json(await snapshot(session(req)))));

  // WebRTC signalling: the browser's SDP offer is exchanged with the voice provider here, using the server's key.
  api.post('/oncall/sessions/:sid/voice/connect', auth, enabled, limit('connect', 10), wrap(async (req, res) => {
    const s = session(req); const out = await sessions.connectVoice(s, req.user, req.body?.sdp);
    record(req, 'oncall.voice.connected', s); res.json(out);
  }));
  api.post('/oncall/sessions/:sid/voice/failed', auth, enabled, wrap(async (req, res) => { sessions.voiceFailed(session(req), req.body?.detail); res.json({ ok: true }); }));
  api.post('/oncall/sessions/:sid/mute', auth, enabled, wrap(async (req, res) => { sessions.mute(session(req), req.body?.muted === true); res.json({ ok: true }); }));
  api.post('/oncall/sessions/:sid/message', auth, enabled, limit('message', 30), wrap(async (req, res) => res.status(202).json(sessions.message(session(req), req.user, req.body?.text))));
  api.post('/oncall/sessions/:sid/interrupt', auth, enabled, wrap(async (req, res) => { const s = session(req); const stopped = engineer.interrupt(s.id, 'The caller pressed stop'); if (stopped) store.emit(s.id, 'agent.interrupted', { by: 'button' }); res.json({ stopped }); }));
  api.post('/oncall/sessions/:sid/permission', auth, enabled, wrap(async (req, res) => {
    const s = session(req); const next = sessions.setPermission(s, req.user, req.body?.level);
    record(req, 'oncall.session.permission', s, { level: next.permission_level }); res.json({ session: store.sessions.view(next) });
  }));
  api.post('/oncall/sessions/:sid/authorizations/:aid', auth, enabled, wrap(async (req, res) => {
    const s = session(req); const a = sessions.decide(s, req.user, req.params.aid, req.body?.approve === true);
    record(req, a.status === 'approved' ? 'oncall.authorization.approved' : 'oncall.authorization.denied', s, { action: a.action, authorizationId: a.id, detail: a.detail }); res.json({ authorization: a });
  }));
  api.post('/oncall/sessions/:sid/heartbeat', auth, enabled, wrap(async (req, res) => { const s = session(req); store.sessions.touch(s.id); res.json({ status: s.status }); }));
  api.post('/oncall/sessions/:sid/end', auth, enabled, wrap(async (req, res) => {
    const s = session(req); const ended = await sessions.end(s, 'ended_by_user');
    record(req, 'oncall.session.ended', s, { voiceSeconds: ended?.voice_seconds ?? 0 }); res.json({ session: store.sessions.view(ended) });
  }));

  // Activity stream (Server-Sent Events): replays persisted events after `Last-Event-ID`, then follows live.
  api.get('/oncall/sessions/:sid/stream', auth, enabled, wrap(async (req, res) => {
    const s = session(req);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    let last = Number(req.headers['last-event-id'] || req.query.after || 0) || 0;
    const write = (ev) => { if (ev.id) { if (ev.id <= last) return; last = ev.id; res.write(`id: ${ev.id}\n`); } res.write(`event: ${ev.id ? 'activity' : 'live'}\ndata: ${JSON.stringify(ev)}\n\n`); };
    const off = store.events.subscribe(s.id, write), detach = sessions.attachStream(s);
    for (const ev of store.events.after(s.id, last)) write(ev);
    const ping = setInterval(() => { res.write(': ping\n\n'); store.sessions.touch(s.id); }, 15000);
    req.on('close', () => { clearInterval(ping); off(); detach(); });
  }));

  // ---------- incident history ----------
  api.get('/oncall/incidents', auth, enabled, wrap(async (req, res) => res.json({ incidents: store.incidents.list(req.user.id).map((i) => store.incidents.view(i)) })));
  api.get('/oncall/incidents/:iid', auth, enabled, wrap(async (req, res) => {
    const i = incident(req), v = await verificationOf(store, i, cfg.repoDir);
    res.json({ incident: { ...store.incidents.view(i, { full: true }), verification: { ...v, statement: VERIFICATION_LABEL[v.level] } }, reportMarkdown: i.report_md || null,
      transcript: i.session_id ? db.all('SELECT speaker, source, text, created_at FROM oncall_transcript WHERE session_id = ? ORDER BY id', i.session_id).map((t) => ({ speaker: t.speaker, source: t.source, text: t.text, createdAt: t.created_at })) : [] });
  }));
  api.get('/oncall/incidents/:iid/report', auth, enabled, wrap(async (req, res) => {
    const i = incident(req);
    if (!i.report_json) throw new HttpError(404, 'This incident has no report yet (it is still open).');
    if (req.query.format === 'md') return res.type('text/markdown').send(i.report_md);
    res.setHeader('Content-Disposition', `attachment; filename="incident-${i.uid}.json"`); res.type('application/json').send(i.report_json);
  }));
  api.get('/oncall/incidents/:iid/evidence/:ref', auth, enabled, wrap(async (req, res) => {
    const i = incident(req), e = db.get('SELECT * FROM oncall_evidence WHERE incident_id = ? AND ref = ?', i.id, String(req.params.ref));
    if (!e) throw new HttpError(404, 'Evidence not found');
    res.json({ evidence: { ref: e.ref, tool: e.tool, tier: e.tier, ok: !!e.ok, summary: e.summary, input: JSON.parse(e.input_json), output: e.output, sha256: e.sha256, durationMs: e.duration_ms, at: e.created_at } });
  }));
  // Evidence gathered in a session before (or without) an incident.
  api.get('/oncall/sessions/:sid/evidence/:ref', auth, enabled, wrap(async (req, res) => {
    const e = store.evidence.get(session(req).id, String(req.params.ref));
    if (!e) throw new HttpError(404, 'Evidence not found');
    res.json({ evidence: { ref: e.ref, tool: e.tool, tier: e.tier, ok: !!e.ok, summary: e.summary, input: JSON.parse(e.input_json), output: e.output, sha256: e.sha256, durationMs: e.duration_ms, at: e.created_at } });
  }));
}
