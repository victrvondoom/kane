// Continuous Watch dashboard: health, findings, remediation workflow, event activity, trends and configuration.
// Every value rendered here comes from the API. Health, lifecycle and the remediation plan are persisted backend
// state; the browser only groups and orders them. Nothing here can change a verification result.
const S = () => window.SP;

const HEALTH = { healthy: ['Healthy', 's-verified', 'ok'], degraded: ['Degraded', 's-blocked', 'warn'], blocked: ['Blocked', 's-failed', 'bad'] };
const TRIGGER = { schedule: ['Scheduled', 'cat'], manual: ['Manual', 'cat'], event: ['Event-triggered', 'cat cat-event'] };
const SEVERITY = { blocking: 's-failed', high: 's-failed', medium: 's-blocked', low: 's-untested', info: 's-untested' };
const SEVERITY_RANK = ['blocking', 'high', 'medium', 'low', 'info'];
const ORIGIN = { harness: 'Harness', environment: 'Environment', application: 'Application', evidence: 'Evidence', process: 'Process' };
const ACTION = { fix_harness: 'Repair the verification engine', fix_environment: 'Repair the environment', verify: 'Run verification for the criteria', verify_all: 'Re-collect evidence for every criterion',
  replay: 'Replay the failing criterion', repair: 'Fix the application, then re-verify', investigate: 'Investigate the cause', cancel_run: 'Cancel the stuck run',
  restart_workflow: 'Restart the autonomous workflow' };
const STEP = { fix_harness: 'Fix the verification engine', fix_environment: 'Fix the environment', verify: 'Verify criteria', replay: 'Replay criterion', repair: 'Repair the application',
  investigate: 'Investigate', verify_all: 'Verify all criteria', cancel_run: 'Cancel stuck run', restart_workflow: 'Restart workflow' };
const EVENT_STATE = { QUEUED: ['Queued', 's-untested'], PROCESSING: ['Processing', 's-running'], COMPLETED: ['Completed', 's-verified'], IGNORED: ['Ignored', 's-untested'], FAILED: ['Failed', 's-failed'],
  queued: ['Queued', 's-untested'], ignored: ['Ignored', 's-untested'], rejected: ['Rejected', 's-failed'], build_registered: ['Build registered', 's-verified'], ok: ['Accepted', 's-verified'] };
const GROUPS = [['new', 'New'], ['persisting', 'Persisting'], ['reopened', 'Reopened'], ['resolved', 'Resolved']];

const short = (sha) => (sha ? String(sha).slice(0, 7) : '—');
const ago = (iso) => S().ago(iso);
const when = (iso) => S().fmtTime(iso);
const findingId = (f) => `F-${String(f.fingerprint).slice(0, 8).toUpperCase()}`;
const groupOf = (f) => (f.status === 'resolved' ? 'resolved' : f.occurrences <= 1 ? 'new' : f.reopens > 0 ? 'reopened' : 'persisting');
const sevPill = (sev) => S().h('span', { class: `tag ${SEVERITY[sev] || 's-untested'}` }, sev);
const pill = (text, cls) => S().h('span', { class: `tag ${cls}` }, text);
const tagLabel = (t) => { const [label, cls] = TRIGGER[t] || [t, 'cat']; return S().h('span', { class: cls }, label); };
const healthPill = (health) => { const [label, cls] = HEALTH[health] || [health, 's-untested']; return pill(label, cls); };
const dot = (health) => S().h('i', { class: `dot ${HEALTH[health]?.[2] || ''}` });

/** Loading, error and retry states for every section (the API is the only source of truth). */
/** Explicit confirmation for actions that spend engine credits. Resolves true only on the confirm button. */
function confirmDialog({ title, body, confirm }) {
  return new Promise((resolve) => {
    const d = S().h('dialog', { class: 'dlg', 'aria-label': title }, S().h('div', { class: 'stack' }, S().h('h2', {}, title), S().h('p', { class: 'small' }, body),
      S().h('div', { class: 'row', style: { 'justify-content': 'flex-end' } },
        S().h('button', { class: 'btn', onclick: () => { d.close('cancel'); } }, 'Cancel'),
        S().h('button', { class: 'btn primary', onclick: () => { d.close('confirm'); } }, confirm))));
    d.addEventListener('close', () => { resolve(d.returnValue === 'confirm'); d.remove(); });
    document.body.append(d); d.showModal();
  });
}
function loader(el, fn) {
  el.replaceChildren(S().h('div', { class: 'panel empty small', 'aria-busy': 'true' }, 'Loading watch data…'));
  fn().catch((e) => el.replaceChildren(S().h('div', { class: 'panel empty stack', role: 'alert' }, S().h('p', {}, `Could not load watch data: ${e.message}`),
    S().h('div', {}, S().h('button', { class: 'btn', onclick: () => loader(el, fn) }, 'Retry')))));
  return el;
}

export function WatchTab({ project: p }, sub) {
  const { h, api, act, toast } = S();
  const pid = p.id;
  const out = h('div', {});
  let state = { status: 'all', lifecycle: 'all', severity: '', origin: '', q: '', sort: 'severity', eventState: '' };

  return loader(out, async function draw() {
    const [w, c, f, t, e, integ] = await Promise.all([
      api('GET', `/projects/${pid}/watch`), api('GET', `/projects/${pid}/watch/checks?limit=30`), api('GET', `/projects/${pid}/watch/findings`),
      api('GET', `/projects/${pid}/watch/trend?limit=30`), api('GET', `/projects/${pid}/watch/events?limit=50`), api('GET', `/projects/${pid}/integration`),
    ]);
    const cfg = w.config, checks = c.checks, findings = f.findings, latest = checks[0] || null;
    const selected = (sub && checks.find((x) => String(x.id) === String(sub))) || latest;
    const openFindings = findings.filter((x) => x.status === 'open');
    const groups = { new: [], persisting: [], reopened: [], resolved: [] };
    for (const x of findings) groups[groupOf(x)].push(x);
    const counts = Object.fromEntries(GROUPS.map(([k]) => [k, groups[k].length]));

    // ---------- 1. overview ----------
    const scheduleLabel = cfg.enabled ? `On · every ${cfg.intervalMinutes} min` : 'Off';
    const sources = [cfg.events.workflowRun && 'workflow_run', cfg.events.deployment && 'deployment_status'].filter(Boolean);
    const eventLabel = cfg.events.enabled ? (sources.length ? `On · ${sources.join(', ')}` : 'On · no sources selected') : 'Off';
    const lastEvent = checks.find((x) => x.trigger === 'event');
    const planStatus = !selected ? '—' : selected.plan.blocked ? 'Blocked' : selected.plan.steps.length ? (selected.startedRunId ? 'Executed' : selected.plan.steps.some((s) => s.automatic) ? 'Eligible' : 'Manual action needed') : 'Nothing to do';
    const overview = h('section', { class: 'stack', id: 'watch-overview' },
      h('div', { class: 'panel stack' },
        h('div', { class: 'row spread', style: { 'align-items': 'flex-start' } },
          h('div', { class: 'stack-s' }, h('h3', {}, 'Health overview'),
            h('div', { class: 'row', style: { gap: '10px' } }, selected ? dot(selected.health) : null,
              h('h2', {}, selected ? { healthy: 'Healthy', degraded: 'Degraded', blocked: 'Blocked' }[selected.health] : 'Not measured yet'),
              selected ? healthPill(selected.health) : null),
            h('div', { class: 'small mute' }, latest ? `Latest check #${latest.id} · ${when(latest.startedAt)} · ${ago(latest.startedAt)}` : 'Run a check to measure this project’s verification system.')),
          h('div', { class: 'row' },
            h('button', { class: 'btn primary', onclick: act(async () => { const r = await api('POST', `/projects/${pid}/watch/check`, {}); toast(`Check #${r.check.id}: ${r.check.health}`); location.hash = `#/p/${pid}/watch/${r.check.id}`; }) }, 'Run check now'),
            h('button', { class: 'btn', onclick: () => S().render() }, 'Refresh'))),
        h('div', { class: 'stats' },
          h('div', { class: 'stat' }, h('b', { class: openFindings.length ? 's-blocked' : 's-verified' }, openFindings.length), h('span', {}, 'Open findings')),
          h('div', { class: 'stat' }, h('b', {}, counts.new), h('span', {}, 'New')),
          h('div', { class: 'stat' }, h('b', {}, counts.persisting), h('span', {}, 'Persisting')),
          h('div', { class: 'stat' }, h('b', { class: counts.reopened ? 's-blocked' : '' }, counts.reopened), h('span', {}, 'Reopened')),
          h('div', { class: 'stat' }, h('b', { class: 'mute' }, counts.resolved), h('span', {}, 'Resolved'))),
        h('dl', { class: 'kvs' },
          h('div', { class: 'kv' }, h('dt', {}, 'Scheduled'), h('dd', {}, scheduleLabel, cfg.enabled && cfg.nextDueAt ? h('span', { class: 'small mute' }, ` · next ${when(cfg.nextDueAt)}`) : null)),
          h('div', { class: 'kv' }, h('dt', {}, 'Event-triggered'), h('dd', {}, eventLabel)),
          h('div', { class: 'kv' }, h('dt', {}, 'Automatic verification'), h('dd', {}, cfg.autoRun ? pill('On · starts Kane CLI runs', 's-blocked') : pill('Off', 's-untested'))),
          h('div', { class: 'kv' }, h('dt', {}, 'Latest remediation'), h('dd', {}, planStatus)),
          h('div', { class: 'kv' }, h('dt', {}, 'Last event check'), h('dd', {}, lastEvent ? h('a', { href: `#/p/${pid}/watch/${lastEvent.id}` }, `#${lastEvent.id} · ${ago(lastEvent.startedAt)}`) : h('span', { class: 'mute' }, 'None yet')))),
        h('div', { class: 'stack-s' }, h('h3', {}, 'Recent monitoring activity'),
          checks.length ? h('ul', { class: 'feed', style: { 'border-top': '1px solid var(--line)' } }, checks.slice(0, 8).map((x) => h('li', {},
            h('time', {}, when(x.startedAt)), tagLabel(x.trigger), healthPill(x.health),
            h('a', { href: `#/p/${pid}/watch/${x.id}`, class: 'key' }, `check #${x.id}`),
            h('span', { class: 'small mute', style: { 'flex-basis': 'auto' } }, `${x.counts.open} open · ${x.counts.new} new · ${x.counts.resolved} resolved`),
            x.event ? h('span', { class: 'small mute' }, `${x.event.repository || ''} ${x.event.workflowName || ''} ${x.event.environment ? `· ${x.event.environment}` : ''}`) : null)))
            : h('div', { class: 'empty small' }, 'No monitoring activity yet.'))));

    // ---------- 2. findings board ----------
    const sevRank = (x) => SEVERITY_RANK.indexOf(x.severity);
    const matches = (x) => (state.status === 'all' || x.status === state.status) && (state.lifecycle === 'all' || groupOf(x) === state.lifecycle)
      && (!state.severity || x.severity === state.severity) && (!state.origin || x.origin === state.origin)
      && (!state.q || `${x.variable} ${x.scenario} ${x.cause} ${findingId(x)}`.toLowerCase().includes(state.q));
    const sorters = { severity: (a, b) => sevRank(a) - sevRank(b) || Date.parse(b.lastSeen) - Date.parse(a.lastSeen), recent: (a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen), occurrences: (a, b) => b.occurrences - a.occurrences };
    const card = (x) => {
      const rel = [];
      if (x.criterionId) rel.push(h('a', { href: `#/p/${pid}/proof/${x.criterionId}`, class: 'cat' }, `criterion ${x.criterionId}`));
      if (x.resultId) rel.push(h('span', { class: 'cat' }, `result ${x.resultId}`));
      return h('article', { class: 'panel stack-s finding', 'data-group': groupOf(x), style: { padding: '14px' } },
        h('div', { class: 'row spread' }, h('code', { class: 'mono' }, findingId(x)), h('span', { class: 'row', style: { gap: '6px' } }, sevPill(x.severity), x.status === 'resolved' ? pill('Resolved', 's-verified') : null)),
        h('div', { class: 'key', style: { 'white-space': 'normal' } }, x.variable),
        h('div', {}, x.scenario),
        h('div', { class: 'small mute' }, x.cause),
        h('div', { class: 'row small' }, h('span', { class: 'cat' }, ORIGIN[x.origin] || x.origin), x.value != null ? h('span', { class: 'num' }, `value ${JSON.stringify(x.value)}`) : null,
          x.threshold != null ? h('span', { class: 'num mute' }, `threshold ${x.threshold}`) : null, ...rel),
        h('div', { class: 'small mute num' }, `×${x.occurrences} · first ${when(x.firstSeen)} · last ${when(x.lastSeen)}${x.reopens ? ` · reopened ${x.reopens}×` : ''}`),
        h('div', { class: 'small' }, h('b', {}, 'Next: '), ACTION[x.action?.type] || 'Investigate', x.action?.hint ? ` — ${x.action.hint}` : ''),
        h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => inspect(x) }, 'Inspect finding')));
    };
    const board = () => {
      const rows = findings.filter(matches).sort(sorters[state.sort]);
      if (!findings.length) return h('div', { class: 'empty panel small' }, selected ? 'No findings. The latest check found nothing outside its thresholds.' : 'No findings yet. Run a check to measure the project.');
      if (!rows.length) return h('div', { class: 'empty panel small' }, 'No findings match these filters.');
      return h('div', { class: 'board' }, GROUPS.filter(([k]) => state.lifecycle === 'all' || state.lifecycle === k).map(([k, label]) => {
        const items = rows.filter((x) => groupOf(x) === k);
        return h('section', { class: 'lane', 'aria-label': `${label} findings` }, h('h3', {}, label, h('span', { class: 'count' }, items.length)),
          items.length ? items.map(card) : h('div', { class: 'small mute lane-empty' }, `No ${label.toLowerCase()} findings.`));
      }));
    };
    const select = (key, values, label) => h('select', { 'aria-label': label, onchange: (ev) => { state[key] = ev.target.value; paintBoard(); } },
      values.map(([v, t]) => h('option', { value: v, selected: state[key] === v }, t)));
    const boardBody = h('div', {});
    const paintBoard = () => boardBody.replaceChildren(board());
    const findingsSec = h('section', { class: 'stack', id: 'watch-findings' },
      h('div', { class: 'row spread' }, h('h3', {}, `Findings board · ${findings.length}`), h('span', { class: 'small mute' }, 'Persisted lifecycle, not recomputed per view')),
      h('div', { class: 'row filters' },
        select('lifecycle', [['all', 'All lifecycles'], ...GROUPS], 'Lifecycle'),
        select('status', [['all', 'Open and resolved'], ['open', 'Open only'], ['resolved', 'Resolved only']], 'Status'),
        select('severity', [['', 'Any severity'], ...SEVERITY_RANK.map((x) => [x, x])], 'Severity'),
        select('origin', [['', 'Any origin'], ...Object.entries(ORIGIN)], 'Origin'),
        select('sort', [['severity', 'Sort: severity'], ['recent', 'Sort: last seen'], ['occurrences', 'Sort: occurrences']], 'Sort'),
        h('input', { type: 'search', placeholder: 'Search variable, scenario, cause or id', 'aria-label': 'Search findings', style: { width: 'min(320px, 100%)' }, oninput: (ev) => { state.q = ev.target.value.trim().toLowerCase(); paintBoard(); } })),
      boardBody);
    paintBoard();

    // ---------- 3. remediation workflow (the selected check's persisted plan) ----------
    const remediation = h('section', { class: 'stack', id: 'watch-remediation' }, h('h3', {}, 'Remediation workflow'), selected ? workflow(selected) : h('div', { class: 'empty panel small' }, 'No check selected.'));

    // ---------- 4. event activity ----------
    const eventFilter = h('select', { 'aria-label': 'Event state', onchange: (ev) => { state.eventState = ev.target.value; loadEvents(); } },
      [['', 'All events'], ['COMPLETED', 'Completed'], ['QUEUED', 'Queued'], ['IGNORED', 'Ignored'], ['FAILED', 'Failed']].map(([v, t]) => h('option', { value: v, selected: state.eventState === v }, t)));
    const eventBody = h('div', {});
    async function loadEvents() {
      eventBody.replaceChildren(h('div', { class: 'panel empty small' }, 'Loading events…'));
      try { const r = await api('GET', `/projects/${pid}/watch/events?limit=50${state.eventState ? `&state=${state.eventState}` : ''}`); eventBody.replaceChildren(eventTable(r.events, r.pending)); }
      catch (err) { eventBody.replaceChildren(h('div', { class: 'panel empty', role: 'alert' }, `Could not load events: ${err.message}`)); }
    }
    const eventsSec = h('section', { class: 'stack', id: 'watch-events' },
      h('div', { class: 'row spread' }, h('h3', {}, 'Event activity'), eventFilter),
      !integ.webhook.configured ? h('div', { class: 'callout' }, 'No GitHub webhook secret exists for this project, so no event can arrive. ', h('a', { href: `#/p/${pid}/ci` }, 'Create the webhook in CI.'))
        : h('p', { class: 'small mute' }, 'Events arrive through the project webhook. GitHub must send ', h('code', {}, 'workflow_run'), ' and ', h('code', {}, 'deployment_status'), ' deliveries to it; each is authenticated before it is recorded.'),
      eventBody);
    eventBody.replaceChildren(eventTable(e.events, e.pending));

    // ---------- 5. analytics ----------
    const analytics = trends(t, checks, findings);

    // ---------- 6. configuration ----------
    const configSec = configuration(pid, cfg, w.defaults, integ, api, act, toast);

    out.replaceChildren(h('div', { class: 'stack-l watch' },
      overview, findingsSec, remediation, eventsSec, analytics, configSec));
  });

  // -------- remediation: the workflow is derived from the check's persisted plan, not a fixed script --------
  function workflow(c) {
    const findings = c.findings || [];
    const steps = c.plan.steps || [];
    const exec = c.startedRunId ? null : steps.some((s) => s.type === 'verify' && s.automatic) && !c.plan.blocked;
    const nodes = [];
    nodes.push(stage('Trigger', c.trigger === 'event' ? `GitHub ${c.event?.workflowName ? `workflow “${c.event.workflowName}”` : c.event?.externalId ? `deployment ${c.event.externalId}` : 'event'} ${c.event ? `· ${c.event.externalState || c.event.state}` : ''} · ${c.event?.commitSha ? short(c.event.commitSha) : ''}` : c.trigger === 'schedule' ? 'Scheduled interval reached' : 'Started manually',
      h('span', { class: 'row', style: { gap: '8px' } }, tagLabel(c.trigger), c.event ? h('a', { href: `#/p/${p.id}/builds`, class: 'small' }, 'builds') : null, c.event?.repository ? h('span', { class: 'small mute' }, c.event.repository) : null)));
    nodes.push(stage('Health assessment', `${HEALTH[c.health]?.[0] || c.health} · ${Object.keys(c.variables).length} variables measured`, healthPill(c.health)));
    const open = findings.filter((f) => f.severity !== 'info');
    nodes.push(stage('Finding identification', open.length ? `${open.length} finding${open.length === 1 ? '' : 's'} in this check` : 'No findings outside thresholds',
      open.length ? h('span', { class: 'row', style: { gap: '6px' } }, SEVERITY_RANK.filter((sv) => open.some((f) => f.severity === sv)).map((sv) => sevPill(sv))) : null));
    if (!steps.length) nodes.push(stage('Remediation plan', 'Empty: nothing to remediate', pill('No steps', 's-untested')));
    if (c.plan.blocked) nodes.push(stage('Blocked', 'Harness or environment problems come first. Verification would not produce a verdict until they are resolved.', pill('Blocked', 's-failed')));
    steps.forEach((s) => nodes.push(planStep(c, s, findings)));
    nodes.push(stage('User-approved execution', c.startedRunId ? `Verification run #${c.startedRunId} was started by this plan` : exec ? 'Eligible: starts Kane CLI runs for the criteria listed above; consumes engine credits.'
      : c.plan.blocked ? 'Not possible: the plan is blocked.' : steps.length ? 'Nothing automatic to execute. Work the manual steps above.' : 'Not needed.',
      c.startedRunId ? h('a', { class: 'btn sm', href: `#/run/${c.startedRunId}` }, `Open run #${c.startedRunId}`) : exec ? h('button', { class: 'btn sm primary', onclick: () => executePlan(c) }, 'Execute eligible plan') : null));
    nodes.push(stage('Persisted result', `Stored in watch check #${c.id} at ${when(c.finishedAt)}. Verification outcomes are recorded only by Kane CLI runs.`, null));
    return h('ol', { class: 'timeline wf-steps' }, nodes.map((n) => h('li', {}, n)));
  }
  function stage(title, detail, right) {
    return h('div', { class: 'panel stack-s wf-card' }, h('div', { class: 'row spread' }, h('h3', {}, title), right || null), h('div', { class: 'small' }, detail));
  }
  function planStep(c, s, findings) {
    const blockers = (s.blockedBy || []).map((fp) => findings.find((f) => f.fingerprint === fp)).filter(Boolean);
    const status = s.blockedBy?.length ? pill('Blocked', 's-failed')
      : s.type === 'verify' && c.startedRunId ? pill('Completed by run', 's-verified')
      : s.automatic ? pill('Automatically eligible', 's-blocked') : pill('Manual', 's-untested');
    return h('div', { class: 'panel stack-s wf-card', 'data-step-type': s.type },
      h('div', { class: 'row spread' }, h('h3', {}, `Step ${s.order} · ${STEP[s.type] || s.type}`), status),
      h('div', { class: 'small' }, s.why),
      s.hint ? h('div', { class: 'small mute' }, s.hint) : null,
      s.criterionIds ? h('div', { class: 'row small' }, h('span', {}, 'Criteria:'), ...s.criterionIds.map((id) => h('a', { href: `#/p/${p.id}/proof/${id}`, class: 'cat' }, `#${id}`))) : null,
      s.criterionId ? h('div', { class: 'row small' }, h('span', {}, 'Criterion:'), h('a', { href: `#/p/${p.id}/proof/${s.criterionId}`, class: 'cat' }, `#${s.criterionId}`)) : null,
      s.blockedBy?.length ? h('div', { class: 'small mute' }, `Waits for: ${blockers.map((b) => b.scenario).join('; ') || `${s.blockedBy.length} blocking finding(s)`}. Explanation: a verification run cannot yield a verdict while these are open.`) : null);
  }
  async function executePlan(c) {
    const auto = c.plan.steps.filter((x) => x.type === 'verify' && x.automatic).flatMap((x) => x.criterionIds || []);
    const ok = await confirmDialog({ title: 'Start verification?',
      body: `This starts a Kane CLI verification run for ${auto.length || 'the'} criteria in this plan. Kane runs a real browser and consumes engine credits. The result is recorded only from that run’s evidence.`,
      confirm: 'Start verification run' });
    if (!ok) return;
    const r = await api('POST', `/projects/${p.id}/watch/checks/${c.id}/execute`, {});
    if (r.started) { toast(`Verification run #${r.runId} started for ${r.criterionIds.length} criteria`); location.hash = `#/run/${r.runId}`; }
    else toast(r.reason || 'Plan not executed', true);
  }

  function eventTable(events, pending) {
    if (!events.length) return h('div', { class: 'panel empty small' }, pending ? `${pending} event(s) waiting.` : 'No events recorded yet. Accepted, ignored, rejected and duplicate deliveries appear here.');
    return h('div', { class: 'panel flush scroll' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Received'), h('th', {}, 'Event'), h('th', {}, 'Subject'), h('th', {}, 'State'), h('th', {}, 'Build'), h('th', {}, 'Watch check'), h('th', {}, 'Processed'))),
      h('tbody', {}, events.flatMap((e) => {
        const [label, cls] = EVENT_STATE[e.state] || [e.state, 's-untested'];
        const subject = e.kind === 'event' ? [e.repository, e.workflowName || (e.externalId ? `#${e.externalId}` : ''), e.environment].filter(Boolean).join(' · ') : (e.deliveryId ? 'delivery' : '');
        const main = h('tr', { class: 'click', tabindex: 0, 'data-event': e.id, onclick: (ev) => toggle(ev.currentTarget) },
          h('td', { class: 'small num' }, when(e.receivedAt)),
          h('td', {}, h('code', { class: 'mono' }, e.event), e.action ? h('div', { class: 'small mute' }, e.action) : null),
          h('td', { class: 'small' }, subject || '—', e.commitSha ? h('div', { class: 'mono small mute' }, short(e.commitSha)) : null),
          h('td', {}, pill(label, cls), e.reason ? h('div', { class: 'small mute' }, e.reason) : null),
          h('td', { class: 'small' }, e.buildId ? h('a', { href: `#/p/${p.id}/builds` }, `build ${e.buildId}`) : h('span', { class: 'mute' }, e.kind === 'event' ? 'not correlated' : '—')),
          h('td', { class: 'small' }, e.checkId ? h('a', { href: `#/p/${p.id}/watch/${e.checkId}` }, `check #${e.checkId}`) : h('span', { class: 'mute' }, '—')),
          h('td', { class: 'small num' }, e.processedAt ? when(e.processedAt) : h('span', { class: 'mute' }, e.state === 'QUEUED' ? 'waiting' : '—')));
        const detail = h('tr', { class: 'dim hidden', 'data-detail': e.id }, h('td', { colspan: 7 }, h('dl', { class: 'kvs' },
          h('div', { class: 'kv' }, h('dt', {}, 'Delivery'), h('dd', { class: 'mono' }, e.deliveryId)),
          h('div', { class: 'kv' }, h('dt', {}, 'External id'), h('dd', {}, e.externalId ?? '—')),
          h('div', { class: 'kv' }, h('dt', {}, 'Result'), h('dd', {}, e.externalState || '—')),
          e.branch ? h('div', { class: 'kv' }, h('dt', {}, 'Branch'), h('dd', { class: 'mono' }, e.branch)) : null,
          e.targetUrl ? h('div', { class: 'kv' }, h('dt', {}, 'Target'), h('dd', {}, h('a', { href: e.targetUrl, target: '_blank', rel: 'noopener noreferrer' }, e.targetUrl))) : null,
          e.attempts ? h('div', { class: 'kv' }, h('dt', {}, 'Attempts'), h('dd', {}, String(e.attempts))) : null,
          e.duplicates ? h('div', { class: 'kv' }, h('dt', {}, 'Duplicates'), h('dd', {}, `${e.duplicates} redelivery(ies) ignored`)) : null,
          e.error ? h('div', { class: 'kv' }, h('dt', {}, 'Error'), h('dd', { class: 'bad-text' }, e.error)) : null,
          h('div', { class: 'kv' }, h('dt', {}, 'Reason'), h('dd', {}, e.reason || '—')))));
        return [main, detail];
      }))));
    function toggle(row) { const d = row.nextElementSibling; if (d) d.classList.toggle('hidden'); }
  }

  function inspect(x) {
    const rows = [['Finding', findingId(x)], ['Variable', x.variable], ['Scenario', x.scenario], ['Detected cause', x.cause], ['Origin', ORIGIN[x.origin] || x.origin],
      ['Severity', x.severity], ['Status', x.status], ['Lifecycle', groupOf(x)], ['Occurrences', x.occurrences], ['Reopened', x.reopens || 0],
      ['First seen', when(x.firstSeen)], ['Last seen', when(x.lastSeen)], ['Resolved at', x.resolvedAt ? when(x.resolvedAt) : '—'],
      ['Measured value', x.value == null ? '—' : JSON.stringify(x.value)], ['Threshold', x.threshold ?? '—'],
      ['Criterion', x.criterionId ? `#${x.criterionId}` : '—'], ['Result', x.resultId ? `#${x.resultId}` : '—'],
      ['Recommended action', `${ACTION[x.action?.type] || 'Investigate'}${x.action?.hint ? ` — ${x.action.hint}` : ''}`]];
    if (x.files?.length) rows.push(['Affected files', x.files.map((f) => `${f.name} (${f.problem})`).join(', ')]);
    const d = h('dialog', { class: 'dlg wide', 'aria-label': `Finding ${findingId(x)}` }, h('div', { class: 'stack' },
      h('div', { class: 'row spread' }, h('h2', {}, findingId(x)), sevPill(x.severity)),
      h('dl', { class: 'kvs' }, rows.map(([k, v]) => h('div', { class: 'kv' }, h('dt', {}, k), h('dd', {}, v)))),
      h('div', { class: 'row', style: { 'justify-content': 'flex-end' } }, h('button', { class: 'btn', onclick: () => d.close() }, 'Close'))));
    d.addEventListener('close', () => d.remove());
    document.body.append(d); d.showModal();
  }

  function trends(t, checks, findings) {
    const hist = [...t.checks].slice(-30);
    const seriesBars = (key, label, max, note) => {
      const pts = (t.series[key] || []).slice(-30);
      if (!pts.length) return h('div', { class: 'small mute' }, `${label}: not measured yet.`);
      const top = Math.max(max ?? 0, ...pts.map((x) => x.value), 0.0001);
      return h('div', { class: 'stack-s' }, h('div', { class: 'row spread small' }, h('span', {}, label), h('span', { class: 'num mute' }, `latest ${pts.at(-1).value}`)),
        h('div', { class: 'spark', role: 'img', 'aria-label': `${label}, ${pts.length} checks` }, pts.map((x) => h('i', { title: `${when(x.at)} · ${x.value}`, style: { height: `${Math.max(4, (x.value / top) * 100)}%` }, class: x.value > 0 ? 'bad' : '' }))),
        note ? h('div', { class: 'small mute' }, note) : null);
    };
    const freq = {};
    for (const f of findings) freq[f.variable] = (freq[f.variable] || 0) + f.occurrences;
    const topVars = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const maxFreq = Math.max(1, ...topVars.map((x) => x[1]));
    const recurring = findings.filter((f) => f.occurrences > 1).sort((a, b) => b.occurrences - a.occurrences).slice(0, 8);
    const durations = findings.filter((f) => /durationMs$/.test(f.variable));
    return h('section', { class: 'stack', id: 'watch-analytics' }, h('h3', {}, 'Historical analytics'),
      h('div', { class: 'grid2' },
        h('div', { class: 'panel stack-s' }, h('div', { class: 'row spread' }, h('b', {}, 'Health history'), h('span', { class: 'small mute' }, `${hist.length} checks`)),
          hist.length ? h('div', { class: 'spark health', role: 'img', 'aria-label': 'Health per check' }, hist.map((x) => h('i', { class: HEALTH[x.health]?.[2] || '', title: `#${x.id} · ${when(x.at)} · ${x.health} · ${x.open} open` })))
            : h('div', { class: 'small mute' }, 'No checks yet.')),
        h('div', { class: 'panel stack-s' }, h('b', {}, 'Finding frequency'),
          topVars.length ? h('ul', { class: 'bars' }, topVars.map(([v, n]) => h('li', {}, h('span', { class: 'key' }, v), h('span', { class: 'bar' }, h('i', { style: { width: `${(n / maxFreq) * 100}%` } })), h('span', { class: 'num' }, n))))
            : h('div', { class: 'small mute' }, 'No findings recorded.'))),
      h('div', { class: 'grid2' },
        h('div', { class: 'panel stack-s' }, h('b', {}, 'Recurring failures'),
          recurring.length ? h('ul', { class: 'reasons' }, recurring.map((f) => h('li', {}, `${findingId(f)} ${f.variable} · ×${f.occurrences}${f.reopens ? ` · reopened ${f.reopens}×` : ''}`)))
            : h('div', { class: 'small mute' }, 'Nothing has recurred.')),
        h('div', { class: 'panel stack-s' }, h('b', {}, 'Infrastructure instability'),
          seriesBars('executions.noVerdictRate', 'Executions without a verdict', 1, 'Share of recent executions that ended for harness reasons (auth, network, timeout), not application outcomes.')),
        h('div', { class: 'panel stack-s' }, h('b', {}, 'Verification duration changes'),
          durations.length ? h('ul', { class: 'reasons' }, durations.map((f) => h('li', {}, `${f.scenario}`))) : h('div', { class: 'small mute' }, 'No duration above the threshold.'),
          h('div', { class: 'small mute' }, 'Durations are reported as findings when they exceed the per-project threshold; no per-check duration series is stored.')),
        h('div', { class: 'panel stack-s' }, h('b', {}, 'Evidence abnormalities'),
          seriesBars('evidence.missing', 'Missing evidence files', null), seriesBars('evidence.tampered', 'Tampered evidence files', null))));
  }

  function configuration(pid, cfg, defaults, integ, api, act, toast) {
    const sched = { enabled: h('input', { type: 'checkbox', checked: cfg.enabled }), interval: h('input', { type: 'number', min: 1, max: 10080, value: cfg.intervalMinutes, style: { width: '120px' } }) };
    const ev = { enabled: h('input', { type: 'checkbox', checked: cfg.events.enabled }), workflowRun: h('input', { type: 'checkbox', checked: cfg.events.workflowRun }), deployment: h('input', { type: 'checkbox', checked: cfg.events.deployment }) };
    const auto = h('input', { type: 'checkbox', checked: cfg.autoRun });
    const custom = cfg.customThresholds || {};
    const thr = Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, h('input', { type: 'number', step: 'any', value: custom[k] ?? v, 'data-key': k, style: { width: '120px' } })]));
    return h('section', { class: 'stack', id: 'watch-config' }, h('h3', {}, 'Watch configuration'),
      h('div', { class: 'grid2' },
        h('form', { class: 'panel stack', onsubmit: (e) => e.preventDefault() }, h('div', { class: 'stack-s' }, h('b', {}, 'Scheduled monitoring'),
          h('p', { class: 'small mute' }, 'A timer runs the probes at the interval. It measures SHIPPROOF’s own state and starts no browser runs unless automatic verification is on.')),
          h('label', { class: 'inline' }, 'Enabled', sched.enabled), h('label', {}, 'Interval (minutes)', sched.interval),
          h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: act(async () => { await api('PUT', `/projects/${pid}/watch`, { enabled: sched.enabled.checked, intervalMinutes: Number(sched.interval.value) }); toast('Scheduled monitoring saved'); S().render(); }) }, 'Save schedule'))),
        h('form', { class: 'panel stack', onsubmit: (e) => e.preventDefault() }, h('div', { class: 'stack-s' }, h('b', {}, 'Event-triggered monitoring'),
          h('p', { class: 'small mute' }, 'Independent of the schedule and off by default. A qualifying GitHub event starts one assessment, never a verification run by itself.')),
          h('label', { class: 'inline' }, 'Enable event-triggered monitoring', ev.enabled),
          h('label', { class: 'inline' }, h('span', { class: 'stack-s' }, 'GitHub Actions workflow_run', h('span', { class: 'small mute', style: { 'text-transform': 'none', 'letter-spacing': 0, font: '13px var(--sans)' } }, 'completed runs with success, failure or timed out')), ev.workflowRun),
          h('label', { class: 'inline' }, h('span', { class: 'stack-s' }, 'Deployment status', h('span', { class: 'small mute', style: { 'text-transform': 'none', 'letter-spacing': 0, font: '13px var(--sans)' } }, 'success, failure or error; inactive and intermediate states are ignored')), ev.deployment),
          !integ.webhook.configured ? h('div', { class: 'callout' }, 'Create the project webhook first (CI tab).') : null,
          h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: act(async () => { await api('PUT', `/projects/${pid}/watch`, { events: { enabled: ev.enabled.checked, workflowRun: ev.workflowRun.checked, deployment: ev.deployment.checked } }); toast('Event subscriptions saved'); S().render(); }) }, 'Save event settings'))),
        h('form', { class: 'panel stack', onsubmit: (e) => e.preventDefault() }, h('div', { class: 'stack-s' }, h('b', {}, 'Automatic verification'),
          h('p', { class: 'small mute' }, 'Opt-in and disabled by default. When on, a check whose plan asks for verification starts Kane CLI runs for those criteria, from scheduled and event-triggered checks.')),
          h('div', { class: 'callout bad' }, 'Each automatic run executes Kane CLI in a real browser and consumes engine credits.'),
          h('label', { class: 'inline' }, 'Allow checks to start verification runs', auto),
          h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: act(async () => { await api('PUT', `/projects/${pid}/watch`, { autoRun: auto.checked }); toast(auto.checked ? 'Automatic verification on' : 'Automatic verification off'); S().render(); }) }, 'Save'))),
        h('form', { class: 'panel stack', onsubmit: (e) => e.preventDefault() }, h('div', { class: 'stack-s' }, h('b', {}, 'Per-project thresholds'),
          h('p', { class: 'small mute' }, 'Values that differ from the defaults are stored for this project only.')),
          h('div', { class: 'stack-s' }, Object.keys(defaults).map((k) => h('label', { class: 'inline' }, h('span', { class: 'mono small' }, k), thr[k]))),
          h('div', { class: 'row' },
            h('button', { class: 'btn primary', onclick: act(async () => { const next = {}; for (const [k, input] of Object.entries(thr)) { const v = Number(input.value); if (v !== defaults[k]) next[k] = v; }
              await api('PUT', `/projects/${pid}/watch`, { thresholds: next }); toast('Thresholds saved'); S().render(); }) }, 'Save thresholds'),
            h('button', { class: 'btn', onclick: act(async () => { await api('PUT', `/projects/${pid}/watch`, { thresholds: {} }); toast('Thresholds reset to defaults'); S().render(); }) }, 'Reset to defaults')))))
  }
}
