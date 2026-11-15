// Session lifecycle and the voice bridge: connects a browser call to the voice provider, turns provider events into
// transcript + engineer work, and speaks the engineer's results. Also owns cleanup: idle reaping, hang-up, shutdown.
import crypto from 'node:crypto';
import { VOICE_INSTRUCTIONS } from './prompts.js';
import { tierAllows } from './config.js';
import { buildReport } from './report.js';

const STOP = /^\s*(stop|cancel|abort|hold on|hang on|wait)\b[\s.!,]*(that|it|there|please|a (sec|second|minute))?[\s.!]*$/i;
export class SessionError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }

export function createSessionManager({ store, cfg, voice, engineer, roleFor, keys, log = () => {} }) {
  const live = new Map(); // sessionId -> { control, bubbles, pendingUser, context, delegationTimer, unsub, connects }
  const state = (id) => { if (!live.has(id)) live.set(id, { control: null, bubbles: { user: null, agent: null }, pendingUser: [], context: [], unsub: null, connects: 0, sse: 0 }); return live.get(id); };

  // Recovery: nothing survives a restart silently. Sessions end, open incidents are recorded as interrupted.
  for (const s of store.sessions.allActive()) store.sessions.set(s.id, { status: 'ended', voice_state: 'closed', end_reason: 'server_restart', ended_at: new Date().toISOString() });
  store.db.run(`UPDATE oncall_incidents SET status = 'interrupted', outcome = 'interrupted', summary = COALESCE(summary, 'The server stopped before this incident was closed.'), closed_at = ?, updated_at = ? WHERE status = 'open'`, new Date().toISOString(), new Date().toISOString());

  function create(user, { projectId = null, permissionLevel = 'read_only', mode = 'voice', consentProviderStore = false } = {}) {
    const role = roleFor(user);
    if (!cfg.enabled || !role) throw new SessionError(403, 'The on-call agent is not enabled for your account.', 'not_enabled');
    if (!['read_only', 'engineering'].includes(permissionLevel)) throw new SessionError(400, 'Unknown permission level');
    if (!tierAllows(role, permissionLevel)) throw new SessionError(403, 'Your account is not authorized for engineering autonomy.', 'permission_denied');
    if (projectId != null && !store.db.get('SELECT 1 FROM projects WHERE id = ? AND user_id = ?', projectId, user.id)) throw new SessionError(404, 'Project not found');
    if (mode === 'voice' && !voice.configured()) mode = 'text';
    for (const old of store.sessions.activeFor(user.id)) end(old, 'replaced'); // one live session per account
    const s = store.sessions.create({ userId: user.id, projectId, mode, permissionLevel, voiceProvider: mode === 'voice' ? voice.id : null,
      providerStore: consentProviderStore && cfg.voice.allowProviderStore }); // provider-side storage needs operator opt-in AND explicit user consent
    store.emit(s.id, 'session.started', { mode, permissionLevel, projectId });
    const st = state(s.id);
    // Keep the voice model's quiet context current so it can answer "what are you doing?" between spoken updates.
    st.unsub = store.events.subscribe(s.id, (ev) => {
      const c = st.control; if (!c || !ev.id) return; const p = ev.payload;
      const note = ev.kind === 'incident.stage' ? `Engineer progress: now in the ${p.stage} stage.` : ev.kind === 'check.started' ? `Engineer progress: running ${p.kind} check${p.phase ? ` (${p.phase})` : ''}. No result yet.`
        : ev.kind === 'check.finished' ? `Check result: ${p.kind} ${p.status}.` : ev.kind === 'git.push' ? `The repair branch ${p.branch} has been pushed.` : ev.kind === 'git.pr' ? `Pull request number ${p.number} is open; the link is on the caller's screen.`
        : ev.kind === 'authorization.requested' ? 'A production action is waiting for approval on the call screen. It cannot be approved by voice.' : null;
      if (note) c.note(note, st.delegationId ?? null);
    });
    return s;
  }

  // ---------- voice ----------
  const flush = (s, speaker) => {
    const st = state(s.id), b = st.bubbles[speaker]; if (!b) return null;
    clearTimeout(b.timer); st.bubbles[speaker] = null;
    const row = store.transcript.add(s.id, speaker, 'voice', b.text, store.incidents.current(s.id)?.id ?? null);
    if (row) { st.context.push(`${speaker === 'user' ? 'caller' : 'voice'}: ${row.text}`); if (st.context.length > 12) st.context.shift(); if (speaker === 'user') st.pendingUser.push(row.text); }
    return row;
  };
  function onTranscript(s, { speaker, delta, startMs }) {
    const st = state(s.id); let b = st.bubbles[speaker];
    // Transcript deltas carry no turn boundaries: a pause of ~1.5 s (or a long gap on the session timeline) ends a bubble.
    if (b && startMs != null && b.lastMs != null && startMs - b.lastMs > 2500) { flush(s, speaker); b = null; }
    if (!b) b = st.bubbles[speaker] = { text: '', timer: null, lastMs: null };
    b.text += delta; b.lastMs = startMs ?? b.lastMs;
    clearTimeout(b.timer); b.timer = setTimeout(() => flush(s, speaker), 1500);
    store.ephemeral(s.id, 'caption', { speaker, text: b.text });
  }
  function onDelegation(s, user, { id }) {
    const st = state(s.id); st.delegationId = id;
    // The delegation event has no task text. Give trailing transcript fragments a moment to arrive, then hand the
    // caller's words (plus any small talk the engineer has not seen) to the engineer.
    clearTimeout(st.delegationTimer);
    st.delegationTimer = setTimeout(() => {
      flush(s, 'user');
      const said = st.pendingUser.splice(0).join(' ').trim();
      const ctxLines = st.context.splice(0).filter((l) => !said || !l.endsWith(said));
      if (!said) { st.control?.note('The request could not be made out from the transcript. Ask the caller to repeat it.', id); return; }
      if (STOP.test(said) && engineer.interrupt(s.id, 'The caller said to stop')) { store.emit(s.id, 'agent.interrupted', { by: 'voice' }); return; }
      const msg = ctxLines.length > 1 ? `[earlier in the call]\n${ctxLines.slice(0, -1).join('\n')}\n\n[the caller now says]\n${said}` : said;
      engineer.submit(store.sessions.byId(s.id), user, msg, { source: 'voice', delegationId: id });
    }, 450);
  }

  async function connectVoice(s, user, sdp) {
    if (s.status !== 'active') throw new SessionError(409, 'This session has ended');
    if (!voice.configured()) throw new SessionError(503, 'Voice is not configured on this server (no provider credentials). You can still type to the engineer.', 'voice_not_configured');
    if (typeof sdp !== 'string' || !/^v=0/.test(sdp.trim()) || sdp.length > 60000) throw new SessionError(400, 'A valid SDP offer is required');
    const st = state(s.id);
    if (++st.connects > 8) throw new SessionError(429, 'Too many connection attempts for this session');
    const reconnect = !!s.provider_session_id;
    store.sessions.set(s.id, { voice_state: reconnect ? 'reconnecting' : 'connecting', mode: 'voice', voice_provider: voice.id });
    // Context continuity: a (re)connected voice session is seeded from the server-side transcript and incident state.
    const history = store.transcript.list(s.id, 60).filter((t) => t.speaker !== 'system').map((t) => ({ role: t.speaker === 'user' ? 'user' : 'assistant', text: t.text }));
    const inc = store.incidents.current(s.id);
    history.push({ role: 'developer', text: reconnect
      ? `The connection dropped and has been re-established. ${inc ? `The open incident is "${inc.title}", currently in the ${inc.stage} stage.` : 'No incident is open.'} Tell the caller briefly that you are back on the line, then listen.`
      : 'Greet the caller now in English in one short sentence as the on-call engineer and ask what is going on. Then listen.' });
    let call;
    try { call = await voice.startCall({ sdp, instructions: VOICE_INSTRUCTIONS, history, store: !!s.provider_store, safetyId: crypto.createHash('sha256').update(`shipproof-user-${user.id}`).digest('hex').slice(0, 32) }); }
    catch (e) { store.sessions.set(s.id, { voice_state: 'failed' }); store.emit(s.id, 'voice.failed', { message: e.message, code: e.code || null }); log('error', 'oncall.voice.start_failed', { session: s.uid, code: e.code, detail: e.providerMessage }); throw new SessionError(e.status || 502, e.message, e.code); }
    st.control?.detach(); // an earlier provider session (before a reconnect) is abandoned; the provider ends it when its media drops
    store.sessions.set(s.id, { provider_session_id: call.providerSessionId, voice_state: 'live' });
    st.control = voice.attach(call.providerSessionId, {
      onTranscript: (t) => onTranscript(s, t), onDelegation: (d) => onDelegation(s, user, d),
      onUsage: ({ seconds }) => store.sessions.set(s.id, { voice_seconds: seconds }),
      onMuted: (m) => store.ephemeral(s.id, 'voice.muted', { muted: m }),
      onState: (v) => store.ephemeral(s.id, 'voice.control', { state: v }),
      onError: (e) => { store.emit(s.id, 'voice.error', e); log('error', 'oncall.voice.error', { session: s.uid, ...e }); },
      onClosed: ({ reason, seconds }) => {
        const cur = store.sessions.byId(s.id); if (!cur || cur.provider_session_id !== call.providerSessionId) return;
        flush(s, 'user'); flush(s, 'agent'); st.control = null;
        store.sessions.set(s.id, { voice_state: 'closed', ...(seconds != null ? { voice_seconds: seconds } : {}) });
        store.emit(s.id, 'voice.closed', { reason });
        // The provider ending the call (expiry, moderation, hang-up) ends the voice leg only; the session stays usable by text until it is closed or reaped.
      },
    });
    st.control.say(history.at(-1).text, null);
    store.emit(s.id, reconnect ? 'voice.reconnected' : 'voice.connected', { provider: voice.id });
    return { sdp: call.sdp, dataChannelLabel: voice.dataChannelLabel };
  }

  /** Called by the engineer for everything it says. Voice speaks it; without voice it becomes a transcript line. */
  function speak(s, text, { delegationId }) {
    const st = live.get(s.id);
    if (st?.control && s.voice_state === 'live') st.control.say(text, delegationId ?? st.delegationId ?? null);
    else store.transcript.add(s.id, 'agent', 'engineer', text, store.incidents.current(s.id)?.id ?? null);
  }
  function message(s, user, textIn) {
    if (s.status !== 'active') throw new SessionError(409, 'This session has ended');
    const t = String(textIn || '').trim();
    if (!t) throw new SessionError(400, 'Message text is required');
    if (t.length > 4000) throw new SessionError(400, 'Message is too long (max 4000 characters)');
    const row = store.transcript.add(s.id, 'user', 'text', t, store.incidents.current(s.id)?.id ?? null);
    const st = state(s.id);
    st.control?.note(`The caller typed this on screen (the engineer has it): ${row.text}`, null);
    return engineer.submit(s, user, row.text, { source: 'text' });
  }
  function setPermission(s, user, level) {
    if (!['read_only', 'engineering'].includes(level)) throw new SessionError(400, 'Unknown permission level');
    if (!tierAllows(roleFor(user), level)) throw new SessionError(403, 'Your account is not authorized for engineering autonomy.', 'permission_denied');
    if (s.permission_level === level) return s;
    const next = store.sessions.set(s.id, { permission_level: level });
    store.emit(s.id, 'session.permission', { level, by: user.id });
    engineer.submit(next, user, `The caller changed this session's permission level on the call screen to ${level === 'engineering' ? 'engineering autonomy' : 'read-only'}.`, { source: 'notice' });
    return next;
  }
  function decide(s, user, authId, approve) {
    if (roleFor(user) !== 'production') throw new SessionError(403, 'Only an approver can decide production actions.', 'permission_denied');
    const a = store.authorizations.decide(Number(authId), s.id, user.id, !!approve);
    if (!a) throw new SessionError(409, 'This request is no longer pending (already decided or expired).');
    store.emit(s.id, 'authorization.decided', { authorization: a, by: user.id });
    engineer.submit(s, user, approve ? `An approver approved the production action "${a.action}" on the call screen. It may be executed once, now.` : `An approver DENIED the production action "${a.action}". Do not attempt it; tell the caller and continue without it.`, { source: 'notice' });
    return a;
  }
  const mute = (s, on) => { state(s.id).control?.mute(!!on); store.emit(s.id, 'voice.mute', { muted: !!on }); };

  async function end(s, reason = 'ended_by_user') {
    const cur = store.sessions.byId(s.id);
    if (!cur || cur.status !== 'active') return cur;
    const st = live.get(s.id);
    engineer.interrupt(s.id, 'The call ended');
    if (st) { clearTimeout(st.delegationTimer); flush(s, 'user'); flush(s, 'agent'); st.unsub?.(); }
    store.sessions.set(s.id, { status: 'ended', end_reason: reason, ended_at: new Date().toISOString(), voice_state: cur.voice_state === 'idle' ? 'idle' : 'closed' });
    // An incident still open when the call ends is closed honestly, with a report of exactly how far it got.
    const inc = store.incidents.current(s.id);
    if (inc) {
      let closed = store.incidents.set(inc.id, { status: 'interrupted', outcome: 'interrupted', summary: inc.summary || `The session ended (${reason}) before this incident was closed. Work stopped at the ${inc.stage} stage.`, closed_at: new Date().toISOString() });
      try { const user = store.db.get('SELECT id, name, email FROM users WHERE id = ?', s.user_id); const r = await buildReport({ store, inc: closed, repoDir: cfg.repoDir, keys, user }); closed = store.incidents.set(inc.id, { report_json: JSON.stringify(r.json), report_md: r.md }); } catch (e) { log('error', 'oncall.report_failed', { error: e.message }); }
      store.emit(s.id, 'incident.closed', { incident: store.incidents.view(closed), verification: 'interrupted' }, inc.id);
    }
    store.emit(s.id, 'session.ended', { reason });
    const closing = st?.control?.close(); if (st) st.control = null;
    engineer.drop(s.id);
    if (closing) await closing.catch(() => {});
    live.delete(s.id);
    return store.sessions.byId(s.id);
  }

  // Idle reaping: a session whose browser went away, or that outlived its limit, is ended and its voice leg closed.
  const reaper = setInterval(() => {
    for (const s of store.sessions.allActive()) {
      const age = Date.now() - Date.parse(s.created_at), quiet = Date.now() - Date.parse(s.last_seen_at);
      if (age > cfg.maxSessionMs) end(s, 'max_duration').catch(() => {});
      else if (quiet > cfg.idleMs && !(live.get(s.id)?.sse > 0)) end(s, 'client_lost').catch(() => {});
    }
    try { store.transcript.sweep(); } catch {}
  }, 15000);
  reaper.unref();

  return { create, connectVoice, speak, message, setPermission, decide, mute, end,
    attachStream: (s) => { const st = state(s.id); st.sse++; store.sessions.touch(s.id); return () => { st.sse = Math.max(0, st.sse - 1); store.sessions.touch(s.id); }; },
    voiceFailed: (s, detail) => { store.sessions.set(s.id, { voice_state: 'failed' }); store.emit(s.id, 'voice.failed', { message: String(detail || 'The media connection failed').slice(0, 300), code: 'media_failed' }); },
    liveState: (id) => ({ hasControl: !!live.get(id)?.control }),
    async shutdown() { clearInterval(reaper); await Promise.all(store.sessions.allActive().map((s) => end(s, 'server_shutdown').catch(() => {}))); } };
}
