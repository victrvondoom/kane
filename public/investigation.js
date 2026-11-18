// Failure investigation and fix verification views. Every value comes from the API. Status, outcome and history are
// persisted server state; nothing here decides a verdict. Notes and transitions are written through the API and the
// page re-reads the server after each write.
const S = () => window.SP;

const STATUS_CLASS = { OPEN: 's-untested', INVESTIGATING: 's-running', READY_FOR_VERIFICATION: 's-blocked', VERIFYING: 's-running', VERIFIED_FIXED: 's-verified',
  STILL_FAILING: 's-failed', PARTIALLY_RESOLVED: 's-blocked', REGRESSION_INTRODUCED: 's-failed', INCONCLUSIVE: 's-untested' };
const STATUS_LABEL = { OPEN: 'Open', INVESTIGATING: 'Investigating', READY_FOR_VERIFICATION: 'Ready for verification', VERIFYING: 'Verifying', VERIFIED_FIXED: 'Verified fixed',
  STILL_FAILING: 'Still failing', PARTIALLY_RESOLVED: 'Partially resolved', REGRESSION_INTRODUCED: 'New regression', INCONCLUSIVE: 'Inconclusive' };
const CONFIDENCE = { CONFIRMED_OBSERVATION: ['Confirmed observation', 's-verified'], STRONG_CORRELATION: ['Strong correlation', 's-blocked'],
  POSSIBLE_CORRELATION: ['Possible correlation', 's-untested'], INSUFFICIENT_EVIDENCE: ['Insufficient evidence', 's-untested'] };
const SEVERITY = { high: 's-failed', medium: 's-blocked', low: 's-untested', info: 's-untested' };
const OUTCOME_CLASS = { VERIFIED_FIXED: 's-verified', STILL_FAILING: 's-failed', PARTIALLY_RESOLVED: 's-blocked', REGRESSION_INTRODUCED: 's-failed', INCONCLUSIVE: 's-untested', INCOMPARABLE: 's-untested' };

const pill = (text, cls) => S().h('span', { class: `tag ${cls}` }, text);
const statusPill = (s) => pill(STATUS_LABEL[s] || s, STATUS_CLASS[s] || 's-untested');
const when = (iso) => S().fmtTime(iso);
const evUrl = (uid) => `/api/evidence/${uid}/file`;

function loader(el, fn) {
  el.replaceChildren(S().h('div', { class: 'panel empty small', 'aria-busy': 'true' }, 'Loading investigation…'));
  fn().catch((e) => el.replaceChildren(S().h('div', { class: 'panel empty stack', role: 'alert' }, S().h('p', {}, `Could not load: ${e.message}`),
    S().h('div', {}, S().h('button', { class: 'btn', onclick: () => loader(el, fn) }, 'Retry')))));
  return el;
}

/** The result page's entry point: create (or open) the persistent investigation for a failed result. */
export function investigateButton(runId, resultId) {
  const { h, api, toast } = S();
  const btn = h('button', { class: 'btn primary', 'data-investigate': resultId }, 'Investigate failure');
  btn.addEventListener('click', async () => {
    btn.disabled = true; btn.textContent = 'Opening…';
    try {
      const r = await api('POST', `/runs/${runId}/results/${resultId}/investigations`, {});
      toast(r.created ? 'Investigation created' : 'Opened the existing investigation');
      location.hash = `#/i/${r.investigation.id}`;
    } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = 'Investigate failure'; }
  });
  return h('div', { class: 'panel stack-s' }, h('h3', {}, 'Failure investigation'),
    h('p', { class: 'small mute' }, 'Keeps this failure, its evidence and its diagnosis as a persistent record, and lets you re-run the same flow to check whether it is fixed.'), btn);
}

export async function InvestigationPage(iid) {
  const { h, api, act, toast, render } = S();
  const out = h('div', { class: 'stack-l' });
  return loader(out, async () => {
    const d = await api('GET', `/investigations/${iid}`);
    const i = d.investigation;
    const projectLink = h('a', { href: `#/p/${i.projectId}`, class: 'cat' }, `project ${i.projectId}`);
    const header = h('div', { class: 'panel stack' },
      h('div', { class: 'row spread', style: { 'align-items': 'flex-start' } },
        h('div', { class: 'stack-s grow' }, h('h3', {}, h('a', { href: `#/p/${i.projectId}/investigations`, style: { 'text-decoration': 'none' } }, '← Investigations')),
          h('h1', {}, `${i.criterionKey} · ${d.original?.criterionText ? d.original.criterionText.slice(0, 90) : 'failed flow'}`),
          h('div', { class: 'row small' }, projectLink, h('a', { class: 'cat', href: `#/run/${i.runId}/${i.resultId}` }, `run #${i.runId}`), h('span', { class: 'cat' }, `result #${i.resultId}`))),
        h('div', { class: 'stack-s', style: { 'align-items': 'flex-end' } }, statusPill(i.status))),
      h('dl', { class: 'kvs' },
        h('div', { class: 'kv' }, h('dt', {}, 'Created'), h('dd', {}, when(i.createdAt))),
        h('div', { class: 'kv' }, h('dt', {}, 'Last update'), h('dd', {}, when(i.updatedAt))),
        h('div', { class: 'kv' }, h('dt', {}, 'Kane verdict'), h('dd', {}, pill(d.original?.verdict || i.originalVerdict, 's-failed'), ' ', h('span', { class: 'small mute' }, 'original, immutable'))),
        h('div', { class: 'kv' }, h('dt', {}, 'Signature'), h('dd', {}, h('code', { class: 'mono small' }, i.signature.slice(0, 12)), h('span', { class: 'small mute' }, ` · v${i.signatureVersion}`))),
      ),
      h('div', { class: 'row' }, ...(d.allowedTransitions || []).map((to) => h('button', { class: 'btn sm', 'data-transition': to,
        onclick: act(async () => { await api('POST', `/investigations/${iid}/status`, { status: to }); toast(`Status: ${STATUS_LABEL[to]}`); render(); }) }, `Mark ${STATUS_LABEL[to].toLowerCase()}`)),
        !(d.allowedTransitions || []).length ? h('span', { class: 'small mute' }, 'No manual status change is available from this state.') : null));

    // ---- failure summary: only what Kane recorded ----
    const o = d.original;
    const summary = h('div', { class: 'panel stack' }, h('h3', {}, 'Failure summary'),
      h('dl', { class: 'kvs' },
        h('div', { class: 'kv' }, h('dt', {}, 'Failed step'), h('dd', {}, o?.failingStep || h('span', { class: 'mute' }, 'Kane did not report the failing step'))),
        h('div', { class: 'kv' }, h('dt', {}, 'Failure message'), h('dd', {}, o?.message || h('span', { class: 'mute' }, 'No message recorded'))),
        h('div', { class: 'kv' }, h('dt', {}, 'Error kind'), h('dd', {}, o?.errorKind || '—')),
        h('div', { class: 'kv' }, h('dt', {}, 'Evidence'), h('dd', {}, `${d.evidence.completeness.available} of ${d.evidence.completeness.total} files available`,
          d.evidence.completeness.missing.length ? h('div', { class: 'small mute' }, `Missing: ${d.evidence.completeness.missing.join(', ')}`) : null))));

    // ---- evidence explorer: real files only ----
    const shots = d.evidence.items.filter((e) => e.kind === 'screenshot' && e.available);
    const others = d.evidence.items.filter((e) => e.kind !== 'screenshot');
    const evidence = h('div', { class: 'panel stack' }, h('h3', {}, 'Evidence explorer'),
      !d.evidence.items.length ? h('p', { class: 'small mute' }, 'Kane produced no evidence files for the original execution.') : null,
      shots.length ? h('div', { class: 'shots' }, shots.map((e) => h('a', { href: evUrl(e.id), target: '_blank', rel: 'noopener', title: e.name }, h('img', { src: evUrl(e.id), alt: `Screenshot ${e.name}`, loading: 'lazy' })))) : null,
      others.length ? evidenceTable(others, h) : null);

    // ---- findings & diagnosis ----
    const dx = d.diagnosis;
    const findings = dx ? h('div', { class: 'panel stack' }, h('div', { class: 'row spread' }, h('h3', {}, 'Diagnosis'),
        h('span', { class: 'small mute' }, `deterministic rules · generation ${dx.generation}${d.diagnosisGenerations > 1 ? ` of ${d.diagnosisGenerations}` : ''}`)),
      h('div', { class: 'callout' }, h('b', {}, 'Most likely cause: '), dx.mostLikelyCause.text, ' ', pill(CONFIDENCE[dx.mostLikelyCause.confidence]?.[0] || dx.mostLikelyCause.confidence, CONFIDENCE[dx.mostLikelyCause.confidence]?.[1] || 's-untested')),
      h('div', { class: 'stack-s' }, h('h3', {}, 'Confirmed observations'), h('ul', { class: 'reasons' }, dx.confirmedObservations.map((x) => h('li', {}, x)))),
      dx.hypotheses.length ? h('div', { class: 'stack-s' }, h('h3', {}, 'Hypothesis (not proven)'), h('ul', { class: 'reasons' }, dx.hypotheses.map((x) => h('li', {}, x)))) : null,
      dx.unknowns.length ? h('div', { class: 'stack-s' }, h('h3', {}, 'Unknown'), h('ul', { class: 'reasons' }, dx.unknowns.map((x) => h('li', {}, x)))) : null,
      h('div', { class: 'stack-s' }, h('h3', {}, `Findings (${dx.findings.length})`), dx.findings.map((f) => findingCard(f, d, h))),
      h('div', { class: 'stack-s' }, h('h3', {}, 'Recommended next steps'), h('ol', { class: 'reasons' }, dx.nextSteps.map((x) => h('li', {}, x)))),
      h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: act(async () => { await api('POST', `/investigations/${iid}/diagnosis`, {}); toast('New diagnosis generation saved'); render(); }) }, 'Generate a new diagnosis from the evidence')))
      : h('div', { class: 'panel empty' }, 'No diagnosis yet.');

    // ---- notes (persisted through the API) ----
    const ta = h('textarea', { placeholder: 'What did you check? Notes are recorded as your statements, not as verified evidence.', 'aria-label': 'Investigation note', maxLength: 4000 });
    const notes = h('div', { class: 'panel stack' }, h('h3', {}, `Developer notes (${d.notes.length})`),
      d.notes.length ? h('ul', { class: 'feed tall', style: { border: '1px solid var(--line)', borderRadius: '8px' } }, d.notes.map((n) => h('li', {}, h('time', {}, when(n.createdAt)), h('span', { class: 'small' }, `${n.author}: `), h('span', { style: { whiteSpace: 'pre-wrap' } }, n.body)))) : h('p', { class: 'small mute' }, 'No notes yet.'),
      h('form', { class: 'stack-s', onsubmit: (e) => e.preventDefault() }, ta,
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: act(async () => { await api('POST', `/investigations/${iid}/notes`, { body: ta.value }); toast('Note saved'); render(); }) }, 'Add note'))));

    // ---- verification ----
    const latest = d.verifications[0];
    const verification = h('div', { class: 'panel stack' }, h('div', { class: 'row spread' }, h('h3', {}, 'Fix verification'),
        h('button', { class: 'btn primary', disabled: !d.canVerify, title: d.canVerify ? '' : 'A verification is already running',
          onclick: act(async () => {
            const r = await api('POST', `/investigations/${iid}/verifications`, {});
            toast(`Verification attempt ${r.verification.attempt} queued`); render();
          }) }, 'Run verification')),
      h('p', { class: 'small mute' }, 'Re-runs the same flow through Kane CLI. The outcome is decided by the comparison rules, never by a later unrelated test. Each attempt is kept.'),
      !d.verifications.length ? h('div', { class: 'empty small' }, 'No verification has run yet.') : null,
      latest ? verificationSummary(latest, iid, api, h) : null,
      d.verifications.length > 1 ? h('details', {}, h('summary', { class: 'small' }, `All attempts (${d.verifications.length})`),
        h('ol', { class: 'reasons' }, d.verifications.map((v) => h('li', {}, `Attempt ${v.attempt} · ${v.status}${v.outcomeLabel ? ` · ${v.outcomeLabel}` : ''} · ${when(v.createdAt)}`)))) : null);

    // ---- history: persisted lifecycle events, oldest first ----
    const history = h('div', { class: 'panel flush' }, h('div', { class: 'panel-h' }, h('h3', {}, `History (${d.events.length})`)),
      h('ul', { class: 'feed' }, d.events.map((e) => h('li', {}, h('time', {}, when(e.at)), h('span', { class: 'small' }, `${e.actor} · ${historyLabel(e)}`)))));

    out.replaceChildren(header, summary, evidence, findings, verification, notes, history);
  });
}

function evidenceTable(items, h) {
  const row = (e) => h('tr', {}, h('td', {}, h('span', { class: 'cat' }, e.kind.replace('_', ' '))),
    h('td', { class: 'mono small' }, e.available ? h('a', { href: evUrl(e.id), target: '_blank', rel: 'noopener' }, e.name) : h('span', { class: 'mute' }, `${e.name} (unavailable)`)),
    h('td', { class: 'num mute small' }, e.size != null ? `${(e.size / 1024).toFixed(1)} kB` : ''));
  return h('table', {}, h('tbody', {}, items.map(row)));
}

function findingCard(f, d, h) {
  const conf = CONFIDENCE[f.confidence] || [f.confidence, 's-untested'];
  const refs = f.evidence.map((r) => r.kind === 'screenshot' ? h('a', { class: 'cat', href: evUrl(r.uid), target: '_blank', rel: 'noopener' }, `screenshot ${r.name}`)
    : r.kind === 'result' ? h('a', { class: 'cat', href: `#/run/${d.investigation.runId}/${r.id}` }, 'original result')
    : h('span', { class: 'cat', title: `${r.kind} · evidence ${r.evidenceUid ?? ''} · entry ${r.index ?? ''}` }, `${r.kind} ${r.name ?? ''}${r.index != null ? ` #${r.index}` : ''}`));
  return h('details', { class: 'panel', style: { padding: '12px 14px' } }, h('summary', { class: 'row', style: { cursor: 'pointer' } },
      h('code', { class: 'mono small' }, f.id), pill(f.category.replace(/_/g, ' '), 'cat'), pill(f.severity, SEVERITY[f.severity] || 's-untested'), pill(conf[0], conf[1]),
      h('span', { class: 'small' }, f.title)),
    h('div', { class: 'stack-s', style: { marginTop: '10px' } },
      h('div', {}, h('b', {}, 'Observed: '), f.observation),
      h('div', { class: 'small' }, h('b', {}, 'Why this is linked (or not): '), f.rationale),
      f.limitations?.length ? h('div', { class: 'small mute' }, `Limitations: ${f.limitations.join('; ')}`) : null,
      refs.length ? h('div', { class: 'row small' }, h('span', { class: 'mute' }, 'Evidence:'), ...refs) : h('div', { class: 'small mute' }, 'No evidence item supports this finding.')));
}

function historyLabel(e) {
  const x = e.detail || {};
  return ({ created: 'investigation created', status_changed: `status ${STATUS_LABEL[x.from] || x.from} → ${STATUS_LABEL[x.to] || x.to}`, diagnosis_generated: `diagnosis generation ${x.generation}`,
    note_added: 'note added', verification_requested: `verification attempt ${x.attempt} requested`, verification_completed: `verification ${x.attempt}: ${x.outcome || 'inconclusive'}` })[e.type] || e.type;
}

function verificationSummary(v, iid, api, h) {
  const c = v.comparison;
  const busy = v.status === 'QUEUED' || v.status === 'RUNNING';
  const rows = [];
  if (busy) return h('div', { class: 'callout' }, h('span', { class: 'dot live' }), ` Attempt ${v.attempt} is ${v.status.toLowerCase()}. This page refreshes the outcome from the stored run when you reload.`,
    h('div', {}, h('button', { class: 'btn sm', onclick: () => S().render() }, 'Check status')));
  if (!c) return h('div', { class: 'callout' }, `Attempt ${v.attempt}: ${v.status}`);
  const cls = OUTCOME_CLASS[v.outcome] || 's-untested';
  return h('div', { class: 'stack' },
    h('div', { class: `verdict ${cls}` }, h('b', {}, `Attempt ${v.attempt} · ${v.outcomeLabel || v.outcome}`), h('span', {}, c.reason)),
    h('dl', { class: 'kvs' },
      h('div', { class: 'kv' }, h('dt', {}, 'Original failure'), h('dd', {}, c.originalFailureStatus ? `${c.originalFailureStatus.toLowerCase()} in the verification` : '—')),
      h('div', { class: 'kv' }, h('dt', {}, 'Flow comparable'), h('dd', {}, c.flowComparable === false ? 'No — the flow text changed' : c.flowComparable ? 'Yes' : '—')),
      h('div', { class: 'kv' }, h('dt', {}, 'Run'), h('dd', {}, v.runId ? h('a', { href: `#/run/${v.runId}` }, `run #${v.runId}`) : '—')),
      h('div', { class: 'kv' }, h('dt', {}, 'Completed'), h('dd', {}, when(v.completedAt)))),
    c.newFailures?.length ? h('div', { class: 'stack-s' }, h('h3', {}, `New failures (${c.newFailures.length})`), h('ul', { class: 'reasons' }, c.newFailures.map((x) => h('li', {}, `${x.kind}: ${x.observation}`)))) : null,
    c.resolvedFindings?.length ? h('div', { class: 'stack-s' }, h('h3', {}, `Resolved (${c.resolvedFindings.length})`), h('ul', { class: 'reasons' }, c.resolvedFindings.map((x) => h('li', {}, x.observation)))) : null,
    c.persistentFindings?.length ? h('div', { class: 'stack-s' }, h('h3', {}, `Persistent (${c.persistentFindings.length})`), h('ul', { class: 'reasons' }, c.persistentFindings.map((x) => h('li', {}, x.observation)))) : null,
    h('div', { class: 'row' }, h('a', { class: 'btn sm', href: `/api/investigations/${iid}/verifications/${v.id}/report`, download: '' }, 'Download report (JSON)')));
}

/** Project-level list of investigations, reached from the project's tabs. */
export function InvestigationsTab({ project: p }) {
  const { h, api } = S();
  const out = h('div', {});
  return loader(out, async () => {
    const { investigations } = await api('GET', `/projects/${p.id}/investigations`);
    out.replaceChildren(investigations.length ? h('div', { class: 'panel flush scroll' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Investigation'), h('th', {}, 'Flow'), h('th', {}, 'Status'), h('th', {}, 'Kane verdict'), h('th', {}, 'Verifications'), h('th', {}, 'Updated'))),
      h('tbody', {}, investigations.map((i) => h('tr', { class: 'click', onclick: () => { location.hash = `#/i/${i.id}`; } },
        h('td', { class: 'mono small' }, i.id), h('td', { class: 'key' }, i.criterionKey), h('td', {}, statusPill(i.status)),
        h('td', { class: 'small' }, i.originalVerdict), h('td', { class: 'num' }, i.verifications), h('td', { class: 'small mute' }, when(i.updatedAt))))))) :
      h('div', { class: 'panel empty stack' }, h('p', {}, 'No investigations yet. Open a failed result in Run history and choose “Investigate failure”.')));
  });
}

