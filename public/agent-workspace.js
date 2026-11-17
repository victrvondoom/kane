// SHIPPROOF ENGINEER — the app-wide conversation with the On-call engineer, shown as a drawer from every page.
// One controller and one drawer, mounted once outside the page renderer: route changes do not close the activity
// stream, lose the transcript or discard an unsent draft. It reuses the On-call API and the server's one-session-per-
// account rule; it creates no parallel agent. Authority is always the server snapshot; the stream only adds events.
import { initialState, applyActivity, applySnapshot, composeMessage, sameProject, projectOf } from './agent-state.js';

const S = () => window.SP;
const $ = (id) => drawer?.querySelector(`#${id}`);
const LEVEL = { read_only: 'Read-only', engineering: 'Engineering autonomy' };
const CONTEXT_OPEN = '[SHIPPROOF context attached by the user]', CONTEXT_CLOSE = '[end of context]';

let st = initialState(), owner = null, es = null, esSid = null, drawer = null, reconnectTimer = null, reconnectAttempts = 0, refreshTimer = null;
const ui = { open: false, expanded: false, project: null, attached: null, busy: false, note: '', permission: 'read_only', ended: null, opener: null };

// ---------------------------------------------------------------- state & server
function closeStream() { clearTimeout(reconnectTimer); es?.close(); es = null; esSid = null; }
function openStream(sid) {
  closeStream(); esSid = sid;
  const src = new EventSource(`/api/oncall/sessions/${encodeURIComponent(sid)}/stream?after=${st.lastId}`); es = src;
  src.addEventListener('open', () => { if (es !== src) return; reconnectAttempts = 0; st.connection = 'live'; paintHeader(); });
  src.addEventListener('activity', (m) => { if (es === src) onActivity(JSON.parse(m.data)); });
  src.addEventListener('live', (m) => { if (es === src) onLive(JSON.parse(m.data)); });
  src.addEventListener('error', () => {
    if (es !== src) return;
    if (src.readyState === EventSource.CLOSED) { closeStream(); st.connection = 'reconnecting'; reconnectLater(sid); }
    else st.connection = 'reconnecting'; // the browser retries and resends Last-Event-ID; the server replays the gap
    paintHeader();
  });
}
function reconnectLater(sid) {
  clearTimeout(reconnectTimer);
  if (reconnectAttempts >= 6) { st.connection = 'offline'; ui.note = 'The connection to the engineer was lost. Open the drawer again to reconnect.'; paintAll(); return; }
  const wait = Math.min(16000, 1000 * 2 ** reconnectAttempts++);
  reconnectTimer = setTimeout(async () => {
    try { const snap = await S().api('GET', `/oncall/sessions/${sid}`); if (st.session?.id !== sid) return; st = applySnapshot(st, snap); if (snap.session.status === 'active') openStream(sid); }
    catch (e) { if (e.status === 404) { closeStream(); ui.note = 'That conversation no longer exists.'; } else reconnectLater(sid); }
    paintAll();
  }, wait);
}
function attach(snap) {
  closeStream();
  st = { ...applySnapshot(initialState(), snap), status: st.status, connection: 'connecting', error: null };
  ui.ended = null; ui.note = '';
  if (snap.session.status === 'active') openStream(snap.session.id);
}
function onActivity(ev) {
  const r = applyActivity(st, ev); if (!r.fresh) return; st = r.state;
  if (ev.kind === 'session.ended' || /^(incident|check|git|authorization|session|tool)/.test(ev.kind)) scheduleRefresh();
  paintActivity(); paintHeader();
}
function onLive(ev) {
  if (ev.kind === 'agent.state') { st.engineer = ev.payload; paintControl(); }
  else if (ev.kind === 'transcript') scheduleRefresh();
}
function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => refresh().catch(() => {}), 150); }
async function refresh() {
  const sid = st.session?.id; if (!sid) return paintAll();
  try {
    const snap = await S().api('GET', `/oncall/sessions/${sid}`);
    if (st.session?.id !== sid) return;
    st = applySnapshot(st, snap);
    if (snap.session.status !== 'active') { closeStream(); if (ui.ended == null) ui.ended = snap.session.endReason || 'ended'; st.connection = 'idle'; }
  } catch (e) { ui.note = e.message; }
  paintAll();
}
/** Reconciles with the server: resumes the account's active conversation (e.g. one started on the On-call screen). */
async function sync() {
  const status = await S().api('GET', '/oncall/status');
  st.status = status;
  const act = status.activeSession;
  if (act && act.status === 'active' && act.id !== st.session?.id) attach(await S().api('GET', `/oncall/sessions/${act.id}`));
  else if (!act && st.session?.status === 'active') await refresh();
  paintAll();
}
const actionError = (e) => { ui.note = e.message || 'The request failed.'; paintNotice(); };

// ---------------------------------------------------------------- public API
/** Mount once per signed-in user; restores an active conversation after a page load. */
export async function ensureAgent(user) {
  mountAgent();
  if (owner === user.id) return;
  owner = user.id; st = initialState(); closeStream();
  try { const status = await S().api('GET', '/oncall/status'); st.status = status; if (status.activeSession?.status === 'active') attach(await S().api('GET', `/oncall/sessions/${status.activeSession.id}`)); }
  catch (e) { actionError(e); }
  paintAll();
}
/** Sign-out: the stream closes and nothing from this account stays in the page. */
export function resetAgent() { closeStream(); owner = null; st = initialState(); ui.project = null; ui.attached = null; ui.open = false; if (drawer) { drawer.hidden = true; document.body.classList.remove('agent-open'); } }
export function setAgentProject(project) { ui.project = project || null; if (drawer) { paintHeader(); paintControl(); } }
export const agentIsOpen = () => ui.open;

export function openAgent({ context = null } = {}) {
  mountAgent();
  if (!ui.open) ui.opener = document.activeElement;
  ui.open = true; drawer.hidden = false; document.body.classList.add('agent-open');
  if (context) { ui.attached = context; ui.note = ''; }
  paintAll();
  sync().catch(actionError);
  requestAnimationFrame(() => (st.session?.status === 'active' ? $('ag-input') : drawer.querySelector('[data-focus-start]'))?.focus({ preventScroll: true }));
}
export function closeAgent() {
  if (!drawer) return;
  ui.open = false; drawer.hidden = true; document.body.classList.remove('agent-open');
  if (ui.opener?.isConnected) ui.opener.focus({ preventScroll: true });
}
export const toggleAgent = () => (ui.open ? closeAgent() : openAgent());

// ---------------------------------------------------------------- actions (each one calls the server; the UI then reads back)
/** Starts a conversation. An active one is replaced only after confirmation: always when the project differs, or when the user asked for a new one. */
async function startConversation({ forceNew = false } = {}) {
  if (ui.busy) return;
  const projectId = ui.project?.id ?? null;
  if (st.session?.status === 'active' && (forceNew || !sameProject(st.session, projectId))) {
    const where = projectId != null ? `“${ui.project.name}”` : 'no project';
    const ok = await S().dialog({ title: 'Replace the current conversation?', confirm: 'Start new conversation', danger: true,
      body: `Your active conversation is ${projectOf(st.session) == null ? 'not linked to a project' : 'linked to a project'}. Starting a new one for ${where} ends it. Its transcript and evidence stay on the server.` });
    if (!ok) return;
  }
  ui.busy = true; ui.note = ''; paintAll();
  try { attach(await S().api('POST', '/oncall/sessions', { projectId, permissionLevel: ui.permission, mode: 'text' })); S().toast('Conversation started'); }
  catch (e) { actionError(e); }
  finally { ui.busy = false; paintAll(); }
}
async function send() {
  const input = $('ag-input'), typed = input.value.trim(), s = st.session;
  if (!typed || !s || s.status !== 'active' || ui.busy) return;
  ui.busy = true; ui.note = ''; paintComposer();
  try { await S().api('POST', `/oncall/sessions/${s.id}/message`, { text: composeMessage(typed, ui.attached) }); input.value = ''; ui.attached = null; }
  catch (e) { actionError(e); }
  finally { ui.busy = false; paintComposer(); }
  scheduleRefresh();
}
async function stopWork() {
  const s = st.session; if (!s) return;
  try { const { stopped } = await S().api('POST', `/oncall/sessions/${s.id}/interrupt`, {}); if (!stopped) S().toast('The engineer was not running anything.'); }
  catch (e) { actionError(e); }
  scheduleRefresh();
}
async function endConversation() {
  const s = st.session; if (!s || s.status !== 'active' || ui.busy) return;
  const ok = await S().dialog({ title: 'End this conversation?', confirm: 'End conversation', danger: true,
    body: 'The engineer stops. An open incident is closed with a report of how far it got. The transcript and evidence are kept.' });
  if (!ok) return;
  ui.busy = true; paintAll();
  try { await S().api('POST', `/oncall/sessions/${s.id}/end`, {}); S().toast('Conversation ended'); await refresh(); }
  catch (e) { actionError(e); }
  finally { ui.busy = false; paintAll(); }
}
async function changePermission(level) {
  const s = st.session; if (!s) return;
  try { await S().api('POST', `/oncall/sessions/${s.id}/permission`, { level }); S().toast(`Permission: ${LEVEL[level]}`); }
  catch (e) { actionError(e); }
  await refresh();
}
async function decide(a, approve) {
  try { await S().api('POST', `/oncall/sessions/${st.session.id}/authorizations/${a.id}`, { approve }); S().toast(approve ? 'Approved — the engineer may run it once' : 'Denied'); }
  catch (e) { actionError(e); }
  await refresh();
}
async function openEvidence(ref) {
  const sid = st.session?.id; if (!sid) return;
  try {
    const { evidence: e } = await S().api('GET', `/oncall/sessions/${sid}/evidence/${encodeURIComponent(ref)}`);
    const { h, fmtTime, fmtDur } = S();
    const d = h('dialog', { class: 'dlg wide' }, h('div', { class: 'stack' },
      h('div', { class: 'row spread' }, h('h2', {}, `${e.ref} · ${e.tool}`), h('span', { class: `tag ${e.ok ? 's-verified' : 's-failed'}` }, e.ok ? 'ok' : 'error')),
      h('p', { class: 'small mute' }, e.summary), h('p', { class: 'small mono mute' }, `input ${JSON.stringify(e.input)}`),
      h('pre', { class: 'out' }, e.output), h('p', { class: 'small mono mute' }, `sha256 ${e.sha256 || '—'} · ${fmtTime(e.at)}${e.durationMs != null ? ` · ${fmtDur(e.durationMs)}` : ''}`),
      h('div', { class: 'row', style: { 'justify-content': 'flex-end' } }, h('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Close'))));
    d.addEventListener('close', () => d.remove()); document.body.append(d); d.showModal();
  } catch (e) { actionError(e); }
}

// ---------------------------------------------------------------- drawer (built once; repainted by region)
export function mountAgent() {
  if (drawer) return drawer;
  const { h } = S();
  drawer = h('aside', { id: 'agent', class: 'ag-drawer', hidden: true, role: 'complementary', 'aria-label': 'SHIPPROOF ENGINEER' },
    h('header', { class: 'agent-head' },
      h('div', { class: 'grow stack-s' }, h('h3', {}, 'SHIPPROOF ENGINEER'), h('div', { class: 'small agent-status', id: 'ag-status', role: 'status' })),
      h('button', { class: 'btn sm agent-desk', id: 'ag-expand', type: 'button', 'aria-pressed': 'false', onclick: () => { ui.expanded = !ui.expanded; drawer.classList.toggle('expanded', ui.expanded); $('ag-expand').setAttribute('aria-pressed', String(ui.expanded)); $('ag-expand').textContent = ui.expanded ? 'Collapse' : 'Expand'; } }, 'Expand'),
      h('button', { class: 'btn sm', type: 'button', 'aria-label': 'Close SHIPPROOF ENGINEER', onclick: closeAgent }, '✕')),
    h('div', { class: 'agent-project small mute', id: 'ag-project' }),
    h('div', { id: 'ag-notice' }),
    h('div', { class: 'agent-scroll', id: 'ag-scroll' },
      h('div', { id: 'ag-control' }),
      h('div', { id: 'ag-approvals' }),
      h('section', { 'aria-label': 'Conversation' }, h('ol', { class: 'tscript agent-tscript', id: 'ag-transcript', 'aria-live': 'polite' })),
      h('details', { class: 'agent-activity' }, h('summary', { class: 'small' }, 'Tool activity'), h('ol', { class: 'feed', id: 'ag-activity', 'aria-live': 'polite' }))),
    h('form', { class: 'agent-composer', id: 'ag-composer', onsubmit: (e) => { e.preventDefault(); send(); } },
      h('div', { id: 'ag-attached' }),
      h('div', { class: 'agent-input-row' },
        h('textarea', { id: 'ag-input', rows: 2, maxLength: 4000, 'aria-label': 'Message to SHIPPROOF ENGINEER', placeholder: 'Ask the engineer…',
          oninput: () => paintComposer(),
          onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } } }),
        h('button', { class: 'btn primary', id: 'ag-send', type: 'submit' }, 'Send')),
      h('p', { class: 'small mute agent-hint' }, 'Enter sends · Shift+Enter for a new line')));
  drawer.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) { e.stopPropagation(); closeAgent(); } });
  if (window.visualViewport) { // on-screen keyboard: lift the composer above it
    const vv = window.visualViewport, fit = () => drawer.style.setProperty('--kb', `${Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))}px`);
    vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); fit();
  }
  document.body.append(drawer);
  paintAll();
  return drawer;
}

const withRefs = (text) => String(text ?? '').split(/(\bE-\d+\b)/).map((part) => (/^E-\d+$/.test(part)
  ? S().h('button', { class: 'ref', type: 'button', title: `Open evidence ${part}`, onclick: () => openEvidence(part) }, part) : part));
function messageBody(text) {
  const { h } = S();
  if (!String(text).startsWith(CONTEXT_OPEN)) return [h('p', {}, withRefs(text))];
  const end = String(text).indexOf(CONTEXT_CLOSE), ctx = String(text).slice(CONTEXT_OPEN.length, end).trim(), rest = String(text).slice(end + CONTEXT_CLOSE.length).trim();
  const record = /Record: (.*)/.exec(ctx)?.[1] || 'record';
  return [h('details', { class: 'ctx-msg' }, h('summary', { class: 'small' }, `Context attached · ${record}`), h('pre', { class: 'out' }, ctx)), rest ? h('p', {}, withRefs(rest)) : null];
}
function paintHeader() {
  if (!drawer) return;
  const s = st.session, active = s?.status === 'active';
  const text = active ? { live: 'Live', connecting: 'Connecting…', reconnecting: 'Reconnecting…', offline: 'Offline' }[st.connection] || 'Live'
    : ui.ended ? 'Conversation ended' : st.status && !st.status.enabled ? 'Not enabled for your account' : 'No active conversation';
  const dot = active ? (st.connection === 'live' ? 'ok' : st.connection === 'offline' ? 'bad' : 'warn') : '';
  $('ag-status').replaceChildren(S().h('i', { class: `dot ${dot}` }), ` ${text}${active ? ` · ${LEVEL[s.permissionLevel] || s.permissionLevel}` : ''}`);
  const pid = projectOf(s);
  const convProject = active ? (pid == null ? 'Conversation: no project' : `Conversation: ${ui.project?.id === pid ? ui.project.name : `project #${pid}`}`) : '';
  $('ag-project').textContent = [ui.project ? `This page: ${ui.project.name}` : 'This page: no project', convProject].filter(Boolean).join(' · ');
}
function paintNotice() {
  const n = $('ag-notice'); if (!n) return;
  n.replaceChildren(...(ui.note ? [S().h('div', { class: 'callout bad', role: 'alert' }, ui.note)] : []));
}
function paintControl() {
  if (!drawer) return;
  const { h } = S(), s = st.session, active = s?.status === 'active', status = st.status, levels = status?.levels?.length ? status.levels : ['read_only'];
  const nodes = [];
  if (status && !status.enabled) nodes.push(h('div', { class: 'callout bad' }, h('b', {}, 'The engineer is not enabled for your account. '), 'An operator grants access on the server (ONCALL_READERS, ONCALL_ENGINEERS or ONCALL_APPROVERS).'));
  else if (status && !status.reasoning?.configured) nodes.push(h('div', { class: 'callout bad' }, h('b', {}, 'The engineer is unavailable. '), `The server has no credentials for ${status.reasoning?.provider || 'the reasoning provider'}. Projects and verification still work.`));
  const permission = (value, onchange) => h('label', { class: 'inline' }, 'Permission', h('select', { onchange, disabled: ui.busy }, levels.map((l) => h('option', { value: l, selected: l === value }, LEVEL[l]))));
  if (active) {
    const engineerLine = st.engineer.state === 'working' ? `Engineer working · ${String(st.engineer.tool || '').replace(/_/g, ' ')}` : st.engineer.state === 'thinking' ? 'Engineer thinking…' : 'Waiting for you.';
    nodes.push(h('div', { class: 'row spread' }, h('span', { class: 'small', role: 'status' }, engineerLine),
      h('button', { class: 'btn sm danger', type: 'button', disabled: st.engineer.state === 'idle' || ui.busy, title: 'Stop what the engineer is doing right now', onclick: stopWork }, 'Stop work')));
    nodes.push(h('div', { class: 'row' }, permission(s.permissionLevel, (e) => changePermission(e.target.value)),
      h('button', { class: 'btn sm', type: 'button', disabled: ui.busy, onclick: () => startConversation({ replaceConfirmed: false, forceNew: true }) }, 'New conversation'),
      h('button', { class: 'btn sm danger', type: 'button', disabled: ui.busy, onclick: endConversation }, 'End conversation')));
  } else {
    const blocked = !status?.enabled || !status?.reasoning?.configured;
    nodes.push(h('p', { class: 'small mute' }, ui.ended ? `The last conversation ended (${String(ui.ended).replace(/_/g, ' ')}). Its transcript is kept.`
      : 'Talk to the engineer by typing. It can inspect the project, explain evidence and, with engineering autonomy, make and propose a fix on a separate branch.'));
    nodes.push(h('div', { class: 'row' }, permission(ui.permission, (e) => { ui.permission = e.target.value; }),
      h('button', { class: 'btn primary', type: 'button', 'data-focus-start': '', disabled: blocked || ui.busy, title: blocked ? 'Unavailable — see the notice above' : undefined, onclick: startConversation }, ui.busy ? 'Starting…' : 'Start conversation')));
    nodes.push(h('p', { class: 'small mute' }, ui.project ? `The conversation will be linked to “${ui.project.name}”, so the engineer works on that project.` : 'No project is open on this page, so the conversation is general. Open a project to link it.'));
  }
  $('ag-control').replaceChildren(...nodes);
  paintApprovals(); paintComposer(); paintNotice();
}
function paintApprovals() {
  const box = $('ag-approvals'); if (!box) return;
  const { h } = S(), pending = (st.authorizations || []).filter((a) => a.status === 'pending');
  box.replaceChildren(...pending.map((a) => h('section', { class: 'approve', role: 'region', 'aria-label': 'Production action awaiting approval' },
    h('div', { class: 'stack-s' }, h('h3', {}, 'Production action — needs approval'), h('p', {}, h('b', {}, a.action)), h('p', { class: 'small mute' }, `Engineer’s reason: ${a.reason}`),
      h('p', { class: 'small mute' }, `Valid once, for exactly this action. Expires ${S().fmtTime(a.expiresAt)}. Approval cannot be given by voice.`)),
    st.status?.canApprove ? h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => decide(a, false) }, 'Deny'), h('button', { class: 'btn primary', type: 'button', onclick: () => decide(a, true) }, 'Approve'))
      : h('p', { class: 'small' }, 'Waiting for an approver. Your account cannot approve production actions.'))));
}
function paintTranscript() {
  const box = $('ag-transcript'); if (!box) return;
  const { h } = S(), near = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.replaceChildren(...st.transcript.map((t) => h('li', { class: `who-${t.speaker}` },
    h('span', { class: 'who' }, t.speaker === 'user' ? 'You' : t.speaker === 'agent' ? 'Engineer' : 'System', t.source === 'text' ? h('em', {}, ' typed') : null), ...messageBody(t.text))));
  if (!st.transcript.length) box.replaceChildren(h('li', { class: 'empty small mute' }, st.session ? 'Say what is wrong, or ask about a result, a failure or a release blocker.' : ''));
  if (near) box.scrollTop = box.scrollHeight;
}
function describe(ev) {
  const p = ev.payload || {};
  switch (ev.kind) {
    case 'tool': return { text: `${p.tool}${p.summary ? ` — ${p.summary}` : ''}`, bad: !p.ok, ref: p.ref, tier: p.tier };
    case 'incident.opened': return { text: `Incident opened: ${p.incident?.title || ''}` };
    case 'incident.stage': return { text: `Incident stage → ${p.stage}` };
    case 'incident.closed': return { text: `Incident closed as ${p.incident?.status || ''}` };
    case 'check.started': return { text: `Check running: ${p.kind || ''}${p.phase ? ` (${p.phase})` : ''}` };
    case 'check.finished': return { text: `Check ${p.kind || ''}: ${p.status || ''}`, bad: p.status === 'failed' || p.status === 'error' };
    case 'git.branch': return { text: `Branch ${p.branch} created` };
    case 'git.commit': return { text: `Commit ${String(p.sha || '').slice(0, 7)} — ${p.subject || ''}` };
    case 'git.push': return { text: `Pushed ${p.branch}` };
    case 'git.pr': return { text: `Pull request #${p.number} ${p.existing ? 'already open' : 'opened'}` };
    case 'git.merge': return { text: `Pull request #${p.number} merged` };
    case 'authorization.requested': return { text: `Approval requested: ${p.authorization?.action}` };
    case 'authorization.decided': return { text: `Approval ${p.authorization?.status}: ${p.authorization?.action}` };
    case 'agent.interrupted': return { text: 'Engineer stopped at your request' };
    case 'agent.error': return { text: `Engineer error: ${p.message}`, bad: true };
    case 'session.permission': return { text: `Permission set to ${LEVEL[p.level] || p.level}` };
    case 'session.started': return { text: 'Conversation started' };
    case 'session.ended': return { text: `Conversation ended (${String(p.reason || '').replace(/_/g, ' ')})` };
    default: return null;
  }
}
function paintActivity() {
  const box = $('ag-activity'); if (!box) return;
  const { h } = S(), rows = st.activity.map((ev) => ({ ev, d: describe(ev) })).filter((r) => r.d).slice(-60);
  box.replaceChildren(...rows.map(({ ev, d }) => h('li', { class: d.bad ? 'err' : '' },
    h('time', {}, new Date(ev.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })),
    d.tier ? h('span', { class: `tier t-${{ read_only: 'read', engineering: 'eng', production: 'prod' }[d.tier]}` }, d.tier) : null,
    h('span', { class: 'grow' }, d.text), d.ref ? h('button', { class: 'ref', type: 'button', onclick: () => openEvidence(d.ref) }, d.ref) : null)));
  if (!rows.length) box.replaceChildren(h('li', { class: 'empty small mute' }, 'No tool activity yet.'));
}
function paintComposer() {
  const form = $('ag-composer'); if (!form) return;
  const { h } = S(), active = st.session?.status === 'active', ctx = ui.attached;
  $('ag-attached').replaceChildren(...(ctx ? [h('div', { class: 'ctx-chip small' }, h('span', { class: 'grow' }, `Attached: ${ctx.kind} · ${ctx.title}`),
    h('button', { class: 'btn sm', type: 'button', 'aria-label': 'Remove attached context', onclick: () => { ui.attached = null; paintComposer(); } }, '✕'))] : []));
  const input = $('ag-input'), send_ = $('ag-send');
  input.disabled = !active || ui.busy;
  send_.disabled = !active || ui.busy || !input.value.trim();
  input.placeholder = active ? 'Ask the engineer…' : 'Start a conversation to ask the engineer';
}
function paintAll() {
  if (!drawer) return;
  paintHeader(); paintNotice(); paintControl(); paintTranscript(); paintActivity(); paintComposer();
}
