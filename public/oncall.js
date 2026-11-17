// On-call engineer: call console, live transcript, incident workspace and incident history.
// The browser carries audio only (WebRTC). Transcripts, tool activity and incident state come from the server's
// activity stream; no provider credential, tool call or engineering decision ever passes through this file.
import { openAgent } from './agent-workspace.js';
const S = () => window.SP;
const STAGES = [['understand', 'Understand'], ['investigate', 'Investigate'], ['diagnose', 'Diagnose'], ['repair', 'Repair'], ['verify', 'Verify'], ['deliver', 'Deliver']];
const LEVEL_CLASS = { verified: 's-verified', tests_passed: 's-verified', failed: 's-failed', unverified: 's-blocked', no_code_change: 's-untested', interrupted: 's-blocked' };
const OUTCOME_CLASS = { resolved: 's-verified', mitigated: 's-blocked', unresolved: 's-failed', interrupted: 's-blocked', open: 's-running' };
const TIER = { read_only: 'read', engineering: 'eng', production: 'prod' };
const short = (sha) => (sha ? String(sha).slice(0, 7) : '—');
/** replaceChildren that skips empty slots (the DOM method would render null as text). */
const put = (node, ...kids) => node.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
const clock = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ---------------------------------------------------------------- voice transport (browser side, provider-agnostic)
/** Carries microphone audio to the provider and plays its audio back. Signalling goes through our own server. */
function createCall({ sessionId, label, onState, onLevels }) {
  const { api } = S();
  let pc = null, mic = null, audio = null, ctx = null, raf = 0, attempts = 0, closed = false, muted = false, retryTimer = null;
  const meters = {};
  const explain = (e) => e?.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it for this site in the browser’s address bar, then start the call again.'
    : e?.name === 'NotFoundError' ? 'No microphone was found on this device.' : e?.name === 'NotReadableError' ? 'The microphone is in use by another application.' : e?.message || 'The call could not be started.';
  const meter = (name, stream) => { try { ctx ??= new AudioContext(); ctx.resume?.().catch(() => {}); const an = ctx.createAnalyser(); an.fftSize = 512; ctx.createMediaStreamSource(stream).connect(an); meters[name] = { an, buf: new Uint8Array(an.fftSize) }; } catch {} };
  const tick = () => {
    const out = {};
    for (const [k, m] of Object.entries(meters)) { m.an.getByteTimeDomainData(m.buf); let sum = 0; for (const v of m.buf) sum += (v - 128) * (v - 128); out[k] = Math.min(1, Math.sqrt(sum / m.buf.length) / 40); }
    onLevels(out); raf = requestAnimationFrame(tick);
  };
  const drop = () => { try { pc?.close(); } catch {} pc = null; };
  async function negotiate() {
    drop();
    const conn = pc = new RTCPeerConnection();
    conn.ontrack = (e) => { const stream = e.streams[0] || new MediaStream([e.track]); audio.srcObject = stream; audio.play().catch(() => onState('blocked_audio')); meter('agent', stream); };
    for (const t of mic.getAudioTracks()) conn.addTrack(t, mic);
    const dc = conn.createDataChannel(label || 'events'); // created before the offer, as the provider requires
    dc.onmessage = (m) => { try { const ev = JSON.parse(m.data); if (ev.type === 'session.started') { attempts = 0; onState('live'); } } catch {} };
    conn.onconnectionstatechange = () => {
      if (closed || conn !== pc) return;
      if (conn.connectionState === 'connected') { attempts = 0; onState('live'); }
      else if (conn.connectionState === 'disconnected') { onState('reconnecting'); clearTimeout(retryTimer); retryTimer = setTimeout(() => { if (!closed && conn === pc && conn.connectionState !== 'connected') recover('media disconnected'); }, 4000); }
      else if (conn.connectionState === 'failed') recover('media failed');
    };
    await conn.setLocalDescription(await conn.createOffer());
    if (conn.iceGatheringState !== 'complete') await new Promise((resolve) => { const done = () => { if (conn.iceGatheringState === 'complete') { conn.removeEventListener('icegatheringstatechange', done); resolve(); } }; conn.addEventListener('icegatheringstatechange', done); setTimeout(resolve, 8000); });
    const { sdp } = await api('POST', `/oncall/sessions/${sessionId}/voice/connect`, { sdp: conn.localDescription.sdp });
    if (closed || conn !== pc) return;
    await conn.setRemoteDescription({ type: 'answer', sdp });
  }
  async function recover(why) {
    if (closed) return;
    clearTimeout(retryTimer);
    if (++attempts > 3) { onState('failed', 'The voice connection was lost and could not be restored. You can keep working by typing, or start the call again.'); api('POST', `/oncall/sessions/${sessionId}/voice/failed`, { detail: why }).catch(() => {}); drop(); return; }
    onState('reconnecting');
    await api('POST', `/oncall/sessions/${sessionId}/voice/failed`, { detail: why }).catch(() => {});
    retryTimer = setTimeout(() => negotiate().catch((e) => (e.status && e.status < 500 && e.status !== 429 ? onState('failed', e.message) : recover(e.message))), 800 * attempts);
  }
  return {
    async start() {
      onState('connecting');
      if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) throw new Error('This browser does not support voice calls. Use a current browser over HTTPS, or type instead.');
      try { mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); } catch (e) { throw new Error(explain(e)); }
      audio = new Audio(); audio.autoplay = true;
      meter('mic', mic); raf = requestAnimationFrame(tick);
      await negotiate();
    },
    setMuted(on) { muted = on; mic?.getAudioTracks().forEach((t) => (t.enabled = !on)); return muted; }, // the track is disabled locally: nothing leaves the device while muted
    resumeAudio: () => audio?.play().catch(() => {}),
    close() { closed = true; clearTimeout(retryTimer); cancelAnimationFrame(raf); mic?.getTracks().forEach((t) => t.stop()); drop(); if (audio) audio.srcObject = null; ctx?.close().catch(() => {}); },
  };
}

// ---------------------------------------------------------------- shared pieces
const refChip = (ref, open) => S().h('button', { class: 'ref', type: 'button', title: `Open evidence ${ref}`, onclick: () => open(ref) }, ref);
function evidenceDialog(url) {
  const { h, api, act } = S();
  return act(async () => {
    const { evidence: e } = await api('GET', url);
    const d = h('dialog', { class: 'dlg wide' }, h('div', { class: 'stack' },
      h('div', { class: 'row spread' }, h('h2', {}, `${e.ref} · ${e.tool}`), h('span', { class: `tag ${e.ok ? 's-verified' : 's-failed'}` }, e.ok ? 'ok' : 'error')),
      h('p', { class: 'small mute' }, e.summary), h('p', { class: 'small mono mute' }, `input ${JSON.stringify(e.input)}`),
      h('pre', { class: 'out' }, e.output), h('p', { class: 'small mono mute' }, `sha256 ${e.sha256} · ${S().fmtTime(e.at)}${e.durationMs != null ? ` · ${S().fmtDur(e.durationMs)}` : ''}`),
      h('div', { class: 'row', style: { 'justify-content': 'flex-end' } }, h('button', { class: 'btn', onclick: () => d.close() }, 'Close'))));
    d.addEventListener('close', () => d.remove()); document.body.append(d); d.showModal();
  })();
}
function stageRail(stage, status) {
  const { h } = S(), at = STAGES.findIndex(([k]) => k === stage), closed = stage === 'closed';
  return h('ol', { class: 'rail', 'aria-label': 'Incident stage' }, STAGES.map(([k, name], i) =>
    h('li', { class: closed || i < at ? 'done' : i === at ? (status === 'open' ? 'now' : 'done') : '', 'aria-current': i === at && !closed ? 'step' : null }, h('i'), name)));
}
function incidentBody(inc, { openEvidence, approvals = null }) {
  const { h, fmtTime, fmtDur } = S(), v = inc.verification, d = inc.diagnosis;
  const facts = inc.findings.filter((f) => f.kind === 'fact'), hyps = inc.findings.filter((f) => f.kind === 'hypothesis');
  const chips = (refs) => (refs?.length ? h('span', { class: 'refs' }, refs.map((r) => refChip(r, openEvidence))) : null);
  const kv = (k, val) => (val ? h('div', { class: 'kv' }, h('dt', {}, k), h('dd', {}, val)) : null);
  return h('div', { class: 'stack' },
    h('div', { class: 'row spread' }, h('div', { class: 'stack-s grow' }, h('h3', {}, inc.status === 'open' ? 'Current incident' : 'Incident'), h('h2', {}, inc.title)),
      h('span', { class: `tag ${OUTCOME_CLASS[inc.status] || 's-untested'}` }, inc.status === 'open' ? h('i', { class: 'dot live' }) : null, inc.status)),
    stageRail(inc.stage, inc.status),
    v ? h('div', { class: `verdict ${LEVEL_CLASS[v.level] || ''}`, role: 'status' }, h('b', {}, 'Verification'), h('span', {}, v.statement)) : null,
    approvals,
    h('dl', { class: 'kvs' }, kv('Reported', inc.description), kv('Environment', inc.environment), kv('Symptoms', inc.symptoms), kv('Impact', inc.impact), kv('Timeframe', inc.timeframe), kv('Expected', inc.expectedOutcome)),
    inc.branch || inc.prUrl ? h('div', { class: 'gitbox' },
      h('div', {}, h('span', {}, 'Branch'), h('code', { class: 'mono' }, inc.branch || '—')), h('div', {}, h('span', {}, 'Base'), h('code', { class: 'mono' }, inc.baseBranch ? `${inc.baseBranch} @ ${short(inc.baseSha)}` : '—')),
      h('div', {}, h('span', {}, 'Commit'), h('code', { class: 'mono', title: inc.headSha || '' }, inc.headSha && inc.headSha !== inc.baseSha ? short(inc.headSha) : 'none yet')),
      h('div', {}, h('span', {}, 'Pushed'), h('code', { class: 'mono' }, inc.pushedSha && inc.pushedSha === inc.headSha ? 'yes' : 'no')),
      h('div', {}, h('span', {}, 'Pull request'), inc.prUrl ? h('a', { href: inc.prUrl, target: '_blank', rel: 'noopener noreferrer' }, `#${inc.prNumber} ↗`) : h('code', { class: 'mono' }, 'none'))) : null,
    d ? h('section', { class: 'stack-s' }, h('h3', {}, 'Diagnosis'),
      h('p', {}, h('b', {}, 'Root cause. '), d.rootCause, ' ', chips(d.evidence)),
      h('p', { class: 'small mute' }, `Primary failure: ${d.primaryFailure}`),
      h('p', { class: 'small' }, h('span', { class: `tag ${v?.rootCauseReproduced ? 's-verified' : 's-blocked'}` }, v?.rootCauseReproduced ? 'reproduced' : 'not reproduced'), ' ', h('span', { class: 'mute' }, `agent confidence: ${d.confidence}`),
        d.affectedComponents?.length ? h('span', { class: 'mute' }, ` · affects ${d.affectedComponents.join(', ')}`) : null),
      d.contributingFactors?.length ? h('p', { class: 'small mute' }, `Contributing: ${d.contributingFactors.join('; ')}`) : null, d.downstreamImpact ? h('p', { class: 'small mute' }, `Downstream: ${d.downstreamImpact}`) : null) : null,
    facts.length || hyps.length ? h('section', { class: 'grid2' },
      h('div', { class: 'stack-s' }, h('h3', {}, `Observed facts · ${facts.length}`), facts.length ? h('ul', { class: 'finds' }, facts.map((f) => h('li', {}, f.statement, ' ', chips(f.evidence)))) : h('p', { class: 'small mute' }, 'None recorded yet.')),
      h('div', { class: 'stack-s' }, h('h3', {}, `Hypotheses · ${hyps.length}`), hyps.length ? h('ul', { class: 'finds hyp' }, hyps.map((f) => h('li', {}, h('span', { class: `tag ${f.status === 'confirmed' ? 's-verified' : f.status === 'rejected' ? 's-untested' : 's-blocked'}` }, f.status), ' ', f.statement, ' ', chips(f.evidence)))) : h('p', { class: 'small mute' }, 'None recorded.'))) : null,
    inc.timeline?.length ? h('section', { class: 'stack-s' }, h('h3', {}, 'Timeline'), h('ul', { class: 'chain' }, inc.timeline.map((t) => h('li', {}, h('time', {}, fmtTime(t.at)), h('span', {}, t.description, ' ', chips(t.evidence)))))) : null,
    inc.plan ? h('section', { class: 'stack-s' }, h('h3', {}, 'Repair plan'), h('ol', { class: 'reasons' }, inc.plan.steps.map((s) => h('li', {}, s))), inc.plan.regressionRisks?.length ? h('p', { class: 'small mute' }, `Regression risks: ${inc.plan.regressionRisks.join('; ')}`) : null) : null,
    inc.checks?.length ? h('section', { class: 'stack-s' }, h('h3', {}, 'Checks run'), h('div', { class: 'scroll' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ['Result', 'Check', 'Command', 'Time', 'Evidence'].map((x) => h('th', {}, x)))),
      h('tbody', {}, inc.checks.map((c) => h('tr', {},
        h('td', {}, h('span', { class: `tag ${c.status === 'passed' ? 's-passed' : c.status === 'failed' ? 's-failed' : 's-error'}` }, c.status)),
        h('td', {}, { verify: c.kind, proof_red: 'regression test · before fix', proof_green: 'regression test · after fix' }[c.phase] || c.kind, c.phase === 'proof_red' ? h('span', { class: 'small mute' }, c.status === 'failed' ? ' (expected to fail)' : ' (should have failed)') : null),
        h('td', {}, h('code', { class: 'mono' }, c.command)), h('td', { class: 'mono' }, fmtDur(c.durationMs)), h('td', {}, c.evidence ? refChip(c.evidence, openEvidence) : '—'))))))) : null);
}

// ---------------------------------------------------------------- page: call + incident workspace
export async function OnCallPage() {
  const { h, api, act, toast, fmtTime } = S();
  const status = await api('GET', '/oncall/status');
  if (!status.enabled) return h('div', { class: 'page' }, h('div', { class: 'panel empty stack' }, h('h2', {}, 'The on-call engineer is not enabled for your account'),
    h('p', {}, 'An operator grants access per account on the server (ONCALL_READERS, ONCALL_ENGINEERS, ONCALL_APPROVERS). Ask them to add your email address.'), h('div', {}, h('a', { class: 'btn', href: '#/app' }, 'Back to projects'))));
  const [{ projects }, { incidents }] = await Promise.all([api('GET', '/projects'), api('GET', '/oncall/incidents')]);

  let session = null, snap = null, call = null, es = null, lastId = 0, voice = 'idle', voiceNote = '', muted = false, engineer = { state: 'idle' }, t0 = 0, timer = 0, beat = 0, refetch = 0;
  const captions = {}; const feed = [];
  const el = { console: h('div', { class: 'panel stack' }), work: h('div', { class: 'stack' }), log: h('ol', { class: 'tscript', 'aria-live': 'polite', 'aria-label': 'Conversation transcript' }), feed: h('ol', { class: 'feed' }),
    state: h('div', { class: 'callstate', role: 'status' }), mic: h('i'), agent: h('i'), time: h('span', { class: 'mono' }, '00:00') };
  el.micMeter = h('div', { class: 'meter' }, h('span', {}, 'You'), h('b', {}, el.mic)); el.agentMeter = h('div', { class: 'meter agent' }, h('span', {}, 'Engineer'), h('b', {}, el.agent));
  el.meters = h('div', { class: 'meters', 'aria-hidden': 'true' }, el.micMeter, el.agentMeter);
  const openEvidence = (ref) => evidenceDialog(`/oncall/sessions/${session.id}/evidence/${ref}`);
  const stick = (box, fn) => { const near = box.scrollHeight - box.scrollTop - box.clientHeight < 60; fn(); if (near) box.scrollTop = box.scrollHeight; };

  // ----- transcript
  const line = (t) => h('li', { class: `who-${t.speaker}` }, h('span', { class: 'who' }, t.speaker === 'user' ? 'You' : t.speaker === 'agent' ? 'Engineer' : 'System', t.source === 'text' ? h('em', {}, ' typed') : null), h('p', {}, t.text));
  const drawCaption = (speaker) => { const c = captions[speaker]; if (!c) return; c.el.querySelector('p').textContent = c.text; };
  function addLine(t) { stick(el.log, () => { captions[t.speaker]?.el.remove(); delete captions[t.speaker]; el.log.append(line(t)); }); }
  function caption({ speaker, text }) { stick(el.log, () => { if (!captions[speaker]) { captions[speaker] = { el: line({ speaker, text: '', source: 'voice' }), text: '' }; captions[speaker].el.classList.add('live'); el.log.append(captions[speaker].el); } captions[speaker].text = text; drawCaption(speaker); }); }

  // ----- call state line
  function drawState() {
    const live = voice === 'live';
    const label = !session ? '' : session.status !== 'active' ? 'Call ended' : voice === 'connecting' ? 'Connecting…' : voice === 'reconnecting' ? 'Reconnecting…'
      : engineer.state === 'working' ? `Engineer working · ${String(engineer.tool || '').replace(/_/g, ' ')}` : engineer.state === 'thinking' ? 'Engineer thinking…'
      : live ? (muted ? 'Muted — the engineer cannot hear you' : 'Listening') : voice === 'failed' ? 'Voice unavailable — type below' : session.mode === 'text' ? 'Typed session' : 'Voice not connected';
    put(el.state, h('i', { class: `dot ${session?.status !== 'active' ? '' : voice === 'reconnecting' || voice === 'connecting' ? 'warn' : engineer.state !== 'idle' ? 'live' : live && !muted ? 'ok' : voice === 'failed' ? 'bad' : ''}` }), h('b', {}, label), voiceNote ? h('span', { class: 'small mute' }, voiceNote) : null);
  }
  const levels = ({ mic = 0, agent = 0 }) => { el.mic.style.transform = `scaleX(${muted ? 0 : mic.toFixed(3)})`; el.agent.style.transform = `scaleX(${agent.toFixed(3)})`; el.agentMeter.classList.toggle('on', agent > 0.06); el.micMeter.classList.toggle('on', !muted && mic > 0.06); };

  // ----- activity feed (tool calls and milestones)
  function feedItem(ev) {
    const p = ev.payload, time = h('time', {}, new Date(ev.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    if (ev.kind === 'tool') return h('li', { class: p.ok ? '' : 'err' }, time, h('span', { class: `tier t-${TIER[p.tier]}` }, TIER[p.tier]), h('span', { class: 'grow' }, h('code', { class: 'mono' }, p.tool), ' ', h('span', { class: p.ok ? 'mute' : '' }, p.summary)), p.ref ? refChip(p.ref, openEvidence) : null);
    const text = { 'agent.say': `Reported to you: ${p.text}`, 'incident.opened': `Incident opened: ${p.incident?.title}`, 'incident.stage': `Stage → ${p.stage}`, 'incident.closed': `Incident closed as ${p.incident?.status}. ${p.statement || ''}`,
      'git.branch': `Branch ${p.branch} created from ${p.base}`, 'git.commit': `Commit ${short(p.sha)} — ${p.subject}`, 'git.push': `Pushed ${p.branch} @ ${short(p.sha)}`, 'git.pr': `Pull request #${p.number} ${p.existing ? 'already open' : 'opened'}`, 'git.merge': `Pull request #${p.number} merged`,
      'check.proof': `Regression proof ${p.proven ? 'holds' : 'does NOT hold'}: before fix ${p.before}, after fix ${p.after}`, 'authorization.requested': `Approval requested: ${p.authorization?.action}`, 'authorization.decided': `Approval ${p.authorization?.status}: ${p.authorization?.action}`,
      'agent.interrupted': 'Engineer stopped at your request', 'agent.error': `Engineer error: ${p.message}`, 'session.permission': `Permission level set to ${p.level === 'engineering' ? 'engineering autonomy' : 'read-only'}`,
      'voice.connected': 'Voice connected', 'voice.reconnected': 'Voice reconnected', 'voice.failed': `Voice failed: ${p.message}`, 'voice.closed': `Voice ended (${p.reason})`, 'voice.error': `Voice provider: ${p.message}`, 'session.ended': `Session ended (${String(p.reason).replace(/_/g, ' ')})` }[ev.kind];
    return text ? h('li', { class: `note${/error|failed|NOT/.test(text) ? ' err' : ''}${ev.kind === 'agent.say' ? ' said' : ''}` }, time, h('span', { class: 'grow' }, text)) : null;
  }
  function pushFeed(ev) { const item = feedItem(ev); if (!item) return; feed.push(ev); stick(el.feed, () => el.feed.append(item)); }

  // ----- incident workspace
  function approvals() {
    const pending = (snap?.authorizations || []).filter((a) => a.status === 'pending');
    if (!pending.length) return null;
    return h('div', { class: 'stack-s' }, pending.map((a) => h('div', { class: 'approve', role: 'alertdialog', 'aria-label': 'Production action awaiting approval' },
      h('div', { class: 'stack-s grow' }, h('h3', {}, 'Production action — needs approval'),
        h('p', {}, h('b', {}, a.action === 'prod_merge_pull_request' ? `Merge pull request #${a.detail.pullRequest}` : a.action), a.detail.sha ? h('span', { class: 'mute' }, ` at ${short(a.detail.sha)}`) : null),
        h('p', { class: 'small mute' }, `Engineer’s reason: ${a.reason}`), h('p', { class: 'small mute' }, `Valid once, for exactly this action. Expires ${fmtTime(a.expiresAt)}. Approval cannot be given by voice.`)),
      status.canApprove ? h('div', { class: 'row' }, h('button', { class: 'btn', onclick: act(async () => { await api('POST', `/oncall/sessions/${session.id}/authorizations/${a.id}`, { approve: false }); await load(); }) }, 'Deny'),
        h('button', { class: 'btn primary', onclick: act(async () => { await api('POST', `/oncall/sessions/${session.id}/authorizations/${a.id}`, { approve: true }); toast('Approved — the engineer may run it once'); await load(); }) }, 'Approve'))
        : h('p', { class: 'small' }, 'Waiting for an approver. Your account cannot approve production actions.'))));
  }
  function drawWork() {
    const inc = snap?.incident;
    put(el.work, 
      h('div', { class: 'panel' }, inc ? incidentBody(inc, { openEvidence, approvals: approvals() })
        : h('div', { class: 'empty stack-s' }, h('h2', {}, 'No incident yet'), h('p', {}, session ? 'Tell the engineer what is wrong — for example: “The production verification service is not responding. Investigate it.”' : 'Start a call and describe what is wrong. The engineer investigates, fixes it on a separate branch, verifies the fix and opens a pull request.'))),
      h('div', { class: 'panel flush' }, h('div', { class: 'panel-h' }, h('h3', {}, 'Engineering activity'), h('span', { class: 'small mute' }, 'Every tool call is recorded as evidence')), feed.length ? el.feed : h('div', { class: 'empty small' }, 'Nothing has run yet.')));
    el.feed.scrollTop = el.feed.scrollHeight;
  }

  // ----- data
  async function load() { snap = await api('GET', `/oncall/sessions/${session.id}`); session = snap.session; drawWork(); drawConsole(); }
  const soon = () => { clearTimeout(refetch); refetch = setTimeout(() => load().catch(() => {}), 250); };
  function listen() {
    es?.close();
    es = new EventSource(`/api/oncall/sessions/${session.id}/stream?after=${lastId}`);
    es.addEventListener('activity', (m) => { const ev = JSON.parse(m.data); if (ev.id <= lastId) return; lastId = ev.id; pushFeed(ev);
      if (ev.kind === 'voice.failed' && voice !== 'reconnecting') { voice = 'failed'; voiceNote = ev.payload.message; drawState(); }
      if (ev.kind === 'voice.closed') { voice = 'closed'; drawState(); }
      if (ev.kind === 'session.ended') { teardown(false); soon(); return; }
      if (/^(incident|check|git|authorization|session\.permission)/.test(ev.kind) || ev.kind === 'tool') soon(); });
    es.addEventListener('live', (m) => { const ev = JSON.parse(m.data), p = ev.payload;
      if (ev.kind === 'caption') caption(p); else if (ev.kind === 'transcript') addLine(p); else if (ev.kind === 'agent.state') { engineer = p; drawState(); drawButtons(); } });
  }
  function teardown(endRemote) {
    clearInterval(timer); clearInterval(beat); call?.close(); call = null; es?.close(); es = null; voice = 'idle';
    if (endRemote && session?.status === 'active') navigator.sendBeacon?.(`/api/oncall/sessions/${session.id}/end`, new Blob(['{}'], { type: 'application/json' }));
  }
  async function begin(mode, resume) {
    const body = { projectId: el.project.value ? Number(el.project.value) : null, permissionLevel: el.level.value, mode, consentProviderStore: !!el.consent?.checked };
    if (resume) { session = resume; await load(); } else { snap = await api('POST', '/oncall/sessions', body); session = snap.session; }
    lastId = 0; feed.length = 0; el.feed.replaceChildren(); el.log.replaceChildren(...(snap.transcript || []).map(line));
    t0 = Date.parse(session.createdAt); timer = setInterval(() => (el.time.textContent = clock((Date.now() - t0) / 1000)), 1000);
    beat = setInterval(() => api('POST', `/oncall/sessions/${session.id}/heartbeat`, {}).catch(() => {}), 30000);
    listen(); drawWork(); drawConsole();
    if (mode === 'voice' && status.voice.configured) await connectVoice();
  }
  async function connectVoice() {
    voiceNote = '';
    call = createCall({ sessionId: session.id, label: status.voice.dataChannelLabel, onLevels: levels,
      onState: (s, note) => { if (s === 'blocked_audio') { voiceNote = 'Your browser blocked audio playback — press “Enable sound”.'; drawState(); drawButtons(); return; } voice = s; if (note) voiceNote = note; else if (s === 'live') voiceNote = ''; drawState(); drawButtons(); } });
    drawConsole();
    try { await call.start(); } catch (e) { call.close(); call = null; voice = 'failed'; voiceNote = e.message; toast(e.message, true); drawConsole(); }
    drawState(); drawButtons();
  }

  // ----- console
  el.project = h('select', { 'aria-label': 'Project' }, h('option', { value: '' }, 'No project linked'), projects.map((p) => h('option', { value: p.id }, p.name)));
  el.level = h('select', { 'aria-label': 'Permission level' }, status.levels.map((l) => h('option', { value: l, selected: l === 'read_only' }, l === 'engineering' ? 'Engineering autonomy' : 'Read-only')));
  el.consent = status.voice.providerStorageAllowed ? h('input', { type: 'checkbox' }) : null;
  el.buttons = h('div', { class: 'row' });
  el.input = h('input', { placeholder: 'Type to the engineer…', maxLength: 4000, 'aria-label': 'Message to the engineer' });
  function drawButtons() {
    if (!session || session.status !== 'active') return put(el.buttons);
    const live = !!call;
    put(el.buttons, 
      live ? h('button', { class: `btn${muted ? ' danger' : ''}`, 'aria-pressed': String(muted), onclick: act(async () => { muted = call.setMuted(!muted); api('POST', `/oncall/sessions/${session.id}/mute`, { muted }).catch(() => {}); drawState(); drawButtons(); }) }, muted ? 'Unmute' : 'Mute') : null,
      live && /blocked audio/.test(voiceNote) ? h('button', { class: 'btn', onclick: () => { call.resumeAudio(); voiceNote = ''; drawState(); drawButtons(); } }, 'Enable sound') : null,
      !live && status.voice.configured ? h('button', { class: 'btn', onclick: act(connectVoice) }, voice === 'failed' ? 'Retry voice' : 'Connect voice') : null,
      h('button', { class: 'btn', disabled: engineer.state === 'idle', title: 'Stop what the engineer is doing right now', onclick: act(async () => { await api('POST', `/oncall/sessions/${session.id}/interrupt`, {}); }) }, 'Stop work'),
      h('button', { class: 'btn danger', onclick: act(async () => { teardown(false); await api('POST', `/oncall/sessions/${session.id}/end`, {}); await load(); toast('Call ended'); }) }, live ? 'End call' : 'End session'));
  }
  function drawConsole() {
    const active = session?.status === 'active';
    if (!session || !active) {
      const resumable = !session && status.activeSession;
      put(el.console, 
        h('div', { class: 'stack-s' }, h('h3', {}, 'On-call engineer'), h('h2', {}, session ? 'Call ended' : 'Start a call')),
        session ? h('p', { class: 'small mute' }, `Ended ${fmtTime(session.endedAt)} · ${String(session.endReason || '').replace(/_/g, ' ')}${session.voiceSeconds ? ` · ${clock(session.voiceSeconds)} of voice` : ''}`) : null,
        session && el.log.childElementCount ? el.log : null,
        resumable ? h('div', { class: 'callout' }, h('b', {}, 'You have a session in progress. '), h('button', { class: 'linkbtn', onclick: act(() => begin(status.activeSession.mode === 'voice' ? 'voice' : 'text', status.activeSession)) }, 'Rejoin it')) : null,
        h('label', {}, 'Project', el.project), h('label', {}, 'What the engineer may do', el.level),
        h('p', { class: 'small mute' }, el.level.value === 'engineering' ? 'Engineering autonomy: may create a branch, edit files, run tests, commit, push the branch and open a pull request. Never the default branch, never a force-push.' : 'Read-only: may inspect, search and diagnose. It cannot change anything.',
          ' Merging and other production actions always need an on-screen approval.'),
        el.consent ? h('label', { class: 'rule row' }, el.consent, h('span', {}, 'I consent to the voice provider storing this session (off by default).')) : null,
        h('div', { class: 'row' },
          h('button', { class: 'btn primary lg', disabled: !status.voice.configured || !status.reasoning.configured, onclick: act(() => begin('voice')) }, h('i', { class: 'dot ok' }), session ? 'Start a new call' : 'Start call'),
          h('button', { class: 'btn', disabled: !status.reasoning.configured, onclick: act(() => begin('text')) }, 'Type instead')),
        !status.reasoning.configured ? h('div', { class: 'callout bad' }, h('b', {}, 'The engineer is unavailable. '), `No credentials are configured on the server for the reasoning provider (${status.reasoning.provider}).`) : null,
        !status.voice.configured ? h('div', { class: 'callout' }, h('b', {}, 'Voice is unavailable. '), `No credentials are configured on the server for ${status.voice.label}. You can still work with the engineer by typing.`) : null,
        h('ul', { class: 'facts small mute' },
          h('li', {}, `Voice: ${status.voice.label}. Your audio goes to the provider over WebRTC; this server does not record it.`),
          h('li', {}, status.privacy.transcriptRetentionDays ? `Transcripts are redacted for secrets and kept ${status.privacy.transcriptRetentionDays} days.` : 'Transcripts are not stored.'),
          h('li', {}, status.repository.available ? `Repository: ${status.repository.github || status.repository.remote || 'local'} · default branch ${status.repository.defaultBranch}` : `Repository unavailable: ${status.repository.reason}`),
          h('li', {}, status.telephony.available ? 'Phone calls are available.' : 'Browser calls only — phone calls are not available in this release.')));
      el.level.onchange = drawConsole;
      return;
    }
    const levelSel = h('select', { 'aria-label': 'Permission level', onchange: act(async (e) => { try { await api('POST', `/oncall/sessions/${session.id}/permission`, { level: e.target.value }); toast(`Permission level: ${e.target.value === 'engineering' ? 'engineering autonomy' : 'read-only'}`); } finally { await load(); } }) },
      status.levels.map((l) => h('option', { value: l, selected: l === session.permissionLevel }, l === 'engineering' ? 'Engineering autonomy' : 'Read-only')));
    put(el.console, 
      h('div', { class: 'row spread' }, h('h3', {}, session.mode === 'voice' ? 'Live call' : 'Typed session'), el.time),
      el.state,
      call ? el.meters : null,
      el.buttons, h('label', { class: 'inline' }, 'The engineer may', levelSel),
      el.log,
      h('form', { class: 'row say', onsubmit: act(async (e) => { e.preventDefault(); const text = el.input.value.trim(); if (!text) return; el.input.value = ''; await api('POST', `/oncall/sessions/${session.id}/message`, { text }); }) }, h('div', { class: 'grow' }, el.input), h('button', { class: 'btn', type: 'submit' }, 'Send')));
    drawState(); drawButtons(); el.log.scrollTop = el.log.scrollHeight;
  }

  S().onCleanup(() => teardown(false)); // leaving the page drops media; the session can be rejoined until it idles out
  window.addEventListener('pagehide', () => teardown(true), { once: true });
  drawConsole(); drawWork();

  const history = incidents.length ? h('div', { class: 'panel flush' }, h('div', { class: 'panel-h' }, h('h3', {}, 'Incident history'), h('span', { class: 'small mute' }, `${incidents.length} incident${incidents.length === 1 ? '' : 's'}`)),
    h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Outcome', 'Incident', 'Stage reached', 'Branch', 'Pull request', 'Opened'].map((x) => h('th', {}, x)))),
      h('tbody', {}, incidents.map((i) => h('tr', { class: 'click', tabIndex: 0, onclick: () => (location.hash = `#/oncall/i/${i.id}`), onkeydown: (e) => e.key === 'Enter' && (location.hash = `#/oncall/i/${i.id}`) },
        h('td', {}, h('span', { class: `tag ${OUTCOME_CLASS[i.status] || 's-untested'}` }, i.status)), h('td', {}, i.title), h('td', { class: 'mute' }, i.stage), h('td', {}, i.branch ? h('code', { class: 'mono' }, i.branch) : '—'),
        h('td', {}, i.prNumber ? `#${i.prNumber}` : '—'), h('td', { class: 'mute' }, S().ago(i.createdAt)))))))) : null;
  return h('div', { class: 'page stack-l' }, h('div', { class: 'oc' }, el.console, el.work), history);
}

// ---------------------------------------------------------------- page: one incident (history)
export async function OnCallIncidentPage(id) {
  const { h, api, fmtTime } = S();
  const { incident: inc, reportMarkdown, transcript } = await api('GET', `/oncall/incidents/${encodeURIComponent(id)}`);
  const openEvidence = (ref) => evidenceDialog(`/oncall/incidents/${inc.id}/evidence/${ref}`);
  return h('div', { class: 'page stack-l' },
    h('div', { class: 'row spread' }, h('a', { class: 'small mute', href: '#/oncall' }, '← On-call'), h('span', { class: 'small mute' }, `Opened ${fmtTime(inc.createdAt)}${inc.closedAt ? ` · closed ${fmtTime(inc.closedAt)}` : ''}`)),
    h('div', { class: 'panel stack-s' }, h('div', { class: 'row spread' }, h('span', { class: 'small mute' }, 'Ask about this incident, its evidence or its fix.'),
      h('button', { class: 'btn', onclick: () => openAgent({ context: { kind: 'incident', title: `#${inc.id} ${inc.title}`, fields: { status: inc.status, stage: inc.stage, description: inc.description, verification: inc.verification?.statement, branch: inc.branch, 'pull request': inc.prNumber ? `#${inc.prNumber}` : null, environment: inc.environment } } }) }, 'Ask the engineer about this')),
      incidentBody(inc, { openEvidence })),
    inc.summary ? h('div', { class: 'panel stack-s' }, h('h3', {}, 'Summary'), h('p', { style: { 'white-space': 'pre-wrap' } }, inc.summary)) : null,
    h('div', { class: 'panel flush' }, h('div', { class: 'panel-h' }, h('h3', {}, `Evidence ledger · ${inc.evidence.length}`), h('span', { class: 'small mute' }, 'Every tool execution, hashed')),
      h('ol', { class: 'feed tall' }, inc.evidence.map((e) => h('li', { class: e.ok ? '' : 'err' }, h('time', {}, new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })), h('span', { class: `tier t-${TIER[e.tier]}` }, TIER[e.tier]),
        h('span', { class: 'grow' }, h('code', { class: 'mono' }, e.tool), ' ', h('span', { class: 'mute' }, e.summary)), refChip(e.ref, openEvidence))))),
    reportMarkdown ? h('div', { class: 'panel stack' }, h('div', { class: 'row spread' }, h('h3', {}, 'Signed incident report'),
      h('div', { class: 'row' }, h('a', { class: 'btn sm', href: `/api/oncall/incidents/${inc.id}/report?format=md`, target: '_blank', rel: 'noopener' }, 'Markdown'), h('a', { class: 'btn sm', href: `/api/oncall/incidents/${inc.id}/report`, download: `incident-${inc.id}.json` }, 'Download signed JSON'))),
      h('pre', { class: 'out report' }, reportMarkdown)) : h('div', { class: 'panel empty small' }, 'This incident is still open; the report is produced when it closes.'),
    transcript.length ? h('div', { class: 'panel stack-s' }, h('h3', {}, 'Call transcript'), h('ol', { class: 'tscript static' }, transcript.map((t) => h('li', { class: `who-${t.speaker}` }, h('span', { class: 'who' }, t.speaker === 'user' ? 'Caller' : 'Engineer', t.source === 'text' ? h('em', {}, ' typed') : null), h('p', {}, t.text))))) : null);
}
