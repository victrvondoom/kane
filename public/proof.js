// Layer 3 views: Proof Explorer, Builds & Change Impact, Release Intelligence (freshness, stability, risk, policy),
// CI integration and Proof Dossier. Every value rendered here comes from the API; nothing is computed as business
// state in the browser (the one exception, by design, is the independent re-hash of a dossier).
const S = () => window.SP;
const FRESH = { CURRENT: 's-verified', STALE: 's-blocked', UNVERIFIED: 's-untested', FAILED: 's-failed', BLOCKED: 's-blocked' };
const STAB = { stable_pass: ['Stable pass', 's-verified'], stable_fail: ['Consistently failing', 's-failed'], intermittent: ['Intermittent', 's-blocked'], insufficient_data: ['Not enough data', 's-untested'] };
const pill = (text, cls) => S().h('span', { class: `tag ${cls}` }, text);
const fresh = (s) => pill(s, FRESH[s] || 's-untested');
const stab = (s) => pill(STAB[s][0], STAB[s][1]);
const risk = (l) => pill(`${l} risk`, { high: 's-failed', medium: 's-blocked', low: 's-untested' }[l]);
const sha = (s, n = 7) => S().h('code', { class: 'mono', title: s }, s ? s.slice(0, n) : '—');
const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const loader = (el, fn) => { el.replaceChildren(S().h('div', { class: 'panel empty small' }, 'Loading…')); fn().catch((e) => el.replaceChildren(S().h('div', { class: 'panel empty stack' }, S().h('p', {}, e.message), S().h('div', {}, S().h('button', { class: 'btn', onclick: () => loader(el, fn) }, 'Retry'))))); return el; };
const buildLink = (pid, b) => b ? S().h('a', { href: `#/p/${pid}/builds/${b.id}`, class: 'mono', title: b.commitSha }, b.shortSha, b.environment !== 'default' ? ` · ${b.environment}` : '') : S().h('span', { class: 'mute' }, 'no build');

// ---------- Proof Explorer ----------
export function ProofTab({ project: p }, sub) {
  const { h, api } = S();
  if (sub) return traceView(p, sub);
  const out = h('div', { class: 'stack' });
  const q = h('input', { type: 'search', placeholder: 'Search key, text, area, source path, commit SHA, run #, evidence SHA-256…', 'aria-label': 'Search proof records' });
  const state = h('select', { 'aria-label': 'Filter by evidence state' }, ['', 'CURRENT', 'STALE', 'UNVERIFIED', 'FAILED', 'BLOCKED'].map((v) => h('option', { value: v }, v || 'All evidence states')));
  const load = () => loader(out, async () => {
    const d = await api('GET', `/projects/${p.id}/proof?q=${encodeURIComponent(q.value)}&state=${state.value}`);
    out.replaceChildren(
      h('div', { class: 'row small mute' }, `${d.criteria.length} of ${d.total} criteria`, d.build ? [' · current build ', buildLink(p.id, d.build)] : ' · no build registered',
        Object.entries(d.counts).filter(([, n]) => n).map(([k, n]) => h('span', {}, ' · ', `${n} ${k.toLowerCase()}`))),
      d.builds.length ? h('div', { class: 'panel stack-s' }, h('h3', {}, 'Builds'), d.builds.map((b) => h('div', { class: 'row small' }, buildLink(p.id, b), h('span', { class: 'mute' }, b.branch || '', ' · ', S().fmtTime(b.createdAt))))) : null,
      d.runs.length ? h('div', { class: 'panel stack-s' }, h('h3', {}, 'Runs'), d.runs.map((r) => h('div', { class: 'row small' }, h('a', { href: `#/run/${r.id}` }, `Run #${r.id}`), S().tag(r.status)))) : null,
      d.evidence.length ? h('div', { class: 'panel stack-s' }, h('h3', {}, 'Evidence artifacts'), d.evidence.map((e) => h('div', { class: 'row small' }, sha(e.sha256, 16), h('span', {}, e.name), h('a', { href: `#/p/${p.id}/proof/${e.criterion_id}` }, e.criterion_key), h('a', { href: `#/run/${e.run_id}/${e.result_id}` }, `run #${e.run_id}`)))) : null,
      d.criteria.length ? h('div', { class: 'panel flush scroll' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'ID'), h('th', {}, 'Criterion'), h('th', {}, 'Version'), h('th', {}, 'Evidence'), h('th', {}, 'Stability'), h('th', {}, 'Risk'))),
        h('tbody', {}, d.criteria.map((c) => h('tr', { class: 'click', tabIndex: 0, onclick: () => (location.hash = `#/p/${p.id}/proof/${c.id}`), onkeydown: (e) => e.key === 'Enter' && (location.hash = `#/p/${p.id}/proof/${c.id}`) },
          h('td', { class: 'key' }, c.key), h('td', {}, h('div', { class: 'stack-s' }, c.text, h('span', { class: 'small mute' }, c.reason), c.areas.length ? h('div', { class: 'row' }, c.areas.map((a) => h('span', { class: 'cat' }, a))) : null)),
          h('td', { class: 'small' }, c.version ? [`v${c.version.number} `, sha(c.version.contentHash, 10)] : '—'), h('td', {}, fresh(c.freshness)), h('td', {}, stab(c.stability)), h('td', {}, risk(c.risk)))))))
        : h('div', { class: 'panel empty' }, d.total ? 'No criteria match this search.' : 'No acceptance criteria yet.'));
  });
  q.addEventListener('input', debounce(load)); state.addEventListener('change', load);
  load();
  return h('div', { class: 'stack' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, q), state), out);
}
function traceView(p, cid) {
  const { h, api, fmtTime, fmtDur, tag } = S();
  const out = h('div', {});
  return loader(out, async () => {
    const { trace: t } = await api('GET', `/projects/${p.id}/proof/criteria/${cid}`);
    const c = t.criterion, vn = Object.fromEntries(t.versions.map((v) => [v.id, v.number]));
    const node = (title, count, body) => h('section', { class: 'node stack' }, h('h3', {}, title, count != null ? h('span', { class: 'count' }, count) : null), body);
    out.replaceChildren(h('div', { class: 'stack-l' },
      h('div', { class: 'row spread' }, h('a', { class: 'btn sm', href: `#/p/${p.id}/proof` }, '← Proof explorer'), h('span', { class: 'small mute' }, 'Project → Build → Requirement → Criterion → Execution → Evidence → Repair → Decision')),
      h('div', { class: 'graph stack' },
        t.requirement ? node('Requirement', null, h('div', { class: 'panel' }, h('p', { class: 'small', style: { 'white-space': 'pre-wrap' } }, t.requirement.text), h('p', { class: 'small mute' }, `Recorded ${fmtTime(t.requirement.created_at)}`))) : null,
        node('Acceptance criterion', null, h('div', { class: 'panel stack' },
          h('div', { class: 'row' }, h('span', { class: 'key' }, c.key), c.freshness ? fresh(c.freshness.state) : pill('archived', 's-untested'), c.stability ? stab(c.stability.classification) : null, c.risk ? risk(c.risk.level) : null,
            c.criticality ? h('span', { class: 'cat' }, c.criticality) : null, c.mandatory === false ? h('span', { class: 'cat' }, 'optional') : null),
          h('p', {}, c.text),
          c.freshness ? h('ul', { class: 'reasons' }, c.freshness.reasons.map((r) => h('li', {}, h('code', { class: 'mono' }, r.code), ' ', r.message, r.runId ? [' ', h('a', { href: `#/run/${r.runId}/${r.resultId}` }, `run #${r.runId}`)] : null))) : null,
          c.paths ? h('div', { class: 'small mute' }, c.paths.length ? ['Source mapping: ', c.paths.map((x) => h('code', { class: 'mono' }, x, ' '))] : 'No source-path mapping — every change is treated as potentially affecting this criterion.') : null)),
        node('Criterion versions', t.versions.length, h('div', { class: 'panel flush scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Version'), h('th', {}, 'Content hash'), h('th', {}, 'Text and coverage'), h('th', {}, 'Executions'), h('th', {}, 'Created'))),
          h('tbody', {}, t.versions.map((v) => h('tr', {}, h('td', { class: 'key' }, `v${v.number}`, v.current ? h('span', { class: 'cat', style: { 'margin-left': '6px' } }, 'current') : null), h('td', {}, sha(v.contentHash, 12)),
            h('td', {}, h('div', { class: 'stack-s small' }, v.text, h('span', { class: 'mute' }, `${v.criticality} · ${v.mandatory ? 'mandatory' : 'optional'}${v.paths.length ? ` · ${v.paths.join(', ')}` : ' · unmapped'}`))),
            h('td', { class: 'num' }, v.executions), h('td', { class: 'small mute' }, fmtTime(v.createdAt)))))))),
        node('Executions', t.executions.length, t.executions.length ? h('div', { class: 'panel flush scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Run'), h('th', {}, 'Outcome'), h('th', {}, 'Criterion ver.'), h('th', {}, 'Build'), h('th', {}, 'Engine'), h('th', {}, 'Events'), h('th', {}, 'Evidence (SHA-256)'), h('th', {}, 'Finished'))),
          h('tbody', {}, t.executions.map((e) => h('tr', { class: e.appliesToCurrentText ? '' : 'dim' }, h('td', {}, h('a', { class: 'key', href: `#/run/${e.runId}/${e.resultId}` }, `#${e.runId}`), h('div', { class: 'small mute' }, e.trigger)),
            h('td', {}, tag(e.status, e.status === 'error' ? S().KIND[e.errorKind] : null), e.appliesToCurrentText ? null : h('div', { class: 'small mute' }, 'older text')),
            h('td', { class: 'num' }, e.versionId ? `v${vn[e.versionId] ?? '?'}` : '—'), h('td', {}, buildLink(p.id, e.build)),
            h('td', { class: 'small' }, e.engine ? h('span', { class: e.engineKind === 'test-fixture' ? 's-failed mono' : 'mono' }, e.engine) : '—', e.engineKind === 'test-fixture' ? h('div', { class: 'small s-failed' }, 'test fixture') : null),
            h('td', { class: 'num' }, e.eventCount),
            h('td', { class: 'small' }, e.evidence.length ? e.evidence.slice(0, 4).map((x) => h('div', {}, x.sha256 ? [h('a', { href: `/api/evidence/${x.id}/file`, target: '_blank', rel: 'noopener' }, sha(x.sha256, 12)), ' '] : null, h('span', { class: 'mute' }, x.kind))) : h('span', { class: 'mute' }, 'none'),
              e.evidence.length > 4 ? h('div', { class: 'mute' }, `+${e.evidence.length - 4} more`) : null),
            h('td', { class: 'small mute' }, fmtTime(e.finishedAt), h('div', {}, fmtDur(e.durationMs)))))))) : h('div', { class: 'panel empty small' }, 'This criterion has never been executed.')),
        node('Repair tasks', t.repairs.length, t.repairs.length ? h('div', { class: 'panel flush scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Task'), h('th', {}, 'State'), h('th', {}, 'Original failure'), h('th', {}, 'Fix declared'), h('th', {}, 'Verified by'))),
          h('tbody', {}, t.repairs.map((r) => h('tr', {}, h('td', { class: 'key' }, `RT-${r.id}`), h('td', {}, tag(r.status === 'verified' ? 'verified' : 'failed')),
            h('td', {}, h('a', { href: `#/run/${r.originRunId}/${r.sourceResultId}` }, `run #${r.originRunId}`), r.failures > 1 ? h('span', { class: 'small mute' }, ` · failed ${r.failures}×`) : null),
            h('td', { class: 'small' }, r.fixDeclaredAt ? `${r.fixDeclaredBy} · ${fmtTime(r.fixDeclaredAt)}` : '—', r.fixNote ? h('div', { class: 'mute' }, r.fixNote) : null),
            h('td', {}, r.verifiedResultId ? h('a', { href: `#/run/${r.verifyRunId}/${r.verifiedResultId}` }, `run #${r.verifyRunId}`) : h('span', { class: 'mute' }, 'not yet'))))))) : h('div', { class: 'panel empty small' }, 'No failure has been recorded for this criterion.')),
        node('Release decisions', t.decisions.length, t.decisions.length ? h('div', { class: 'panel flush scroll' }, h('table', {}, h('tbody', {}, t.decisions.map((d) => h('tr', {}, h('td', { class: 'key' }, `#${d.id}`), h('td', {}, tag(d.verdict === 'blocked' ? 'failed' : d.verdict)),
          h('td', {}, buildLink(p.id, d.build)), h('td', { class: 'small mute' }, `policy v${d.policyVersion} · by ${d.requestedBy} · ${fmtTime(d.createdAt)}`)))))) : h('div', { class: 'panel empty small' }, 'No release decision has been recorded yet (CI and dossiers record them).')))));
  });
}

// ---------- Builds & change impact ----------
export function BuildsTab({ project: p }, sub) {
  const { h, api, act, toast, fmtTime, tag } = S();
  if (sub) return impactView(p, sub);
  const list = h('div', {}), more = h('div', {});
  const q = h('input', { type: 'search', placeholder: 'Filter by commit, branch, message or build id', 'aria-label': 'Filter builds' });
  const env = h('select', { 'aria-label': 'Filter by environment' }, h('option', { value: '' }, 'All environments'));
  let builds = [];
  const f = { sha: h('input', { placeholder: 'Commit SHA (7–64 hex)', required: true }), branch: h('input', { placeholder: 'Branch' }), environment: h('input', { placeholder: 'Environment (default)' }),
    appUrl: h('input', { type: 'url', placeholder: 'Deployment URL for this build (optional)' }), paths: h('textarea', { placeholder: 'Changed file paths, one per line. Leave empty if unknown — impact is then treated as unknown.', style: { 'min-height': '70px' } }) };
  const load = (before) => loader(before ? more : list, async () => {
    const d = await api('GET', `/projects/${p.id}/builds?limit=10&q=${encodeURIComponent(q.value)}&environment=${encodeURIComponent(env.value)}${before ? `&before=${before}` : ''}`);
    builds = before ? builds.concat(d.builds) : d.builds;
    if (env.options.length !== d.environments.length + 1) { const cur = env.value; env.replaceChildren(h('option', { value: '' }, 'All environments'), ...d.environments.map((e) => h('option', { value: e, selected: e === cur }, e))); }
    list.replaceChildren(builds.length ? h('ol', { class: 'timeline' }, builds.map((b, i) => h('li', {}, h('a', { class: 'panel stack-s', href: `#/p/${p.id}/builds/${b.id}`, style: { 'text-decoration': 'none', display: 'grid' } },
      h('div', { class: 'row spread' }, h('div', { class: 'row' }, h('span', { class: 'key' }, b.shortSha), b.branch ? h('span', { class: 'cat' }, b.branch) : null, h('span', { class: 'cat' }, b.environment), h('span', { class: 'cat' }, b.source.replace('_', ' ')),
        i === 0 && !before && !q.value && !env.value ? pill('current build', 's-running') : null), h('span', { class: 'small mute' }, fmtTime(b.createdAt))),
      b.message ? h('span', { class: 'small' }, b.message) : null,
      h('div', { class: 'row small mute' }, b.pathsKnown ? `${b.changedPaths.length} changed file${b.changedPaths.length === 1 ? '' : 's'}` : h('span', { class: 's-blocked' }, 'change set unknown'),
        ` · ${b.executions.total} execution${b.executions.total === 1 ? '' : 's'} on this build`, b.executions.total ? ` (${b.executions.passed || 0} passed, ${b.executions.failed || 0} failed)` : '',
        b.runs.map((r) => h('span', {}, ' · ', `run #${r.id} ${r.status}`))))))) : h('div', { class: 'panel empty' }, d.total || q.value || env.value ? 'No builds match.' : 'No builds registered. Register one below, from CI, or through the GitHub webhook.'));
    more.replaceChildren(d.nextBefore ? h('button', { class: 'btn', onclick: () => load(d.nextBefore) }, 'Load older builds') : h('span', { class: 'small mute' }, `${builds.length} of ${d.total} build${d.total === 1 ? '' : 's'}`));
  });
  q.addEventListener('input', debounce(() => load())); env.addEventListener('change', () => load());
  load();
  return h('div', { class: 'stack-l' }, h('div', { class: 'stack' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, q), env), list, more),
    h('form', { class: 'panel stack', onsubmit: act(async (e) => {
      e.preventDefault();
      const paths = f.paths.value.split('\n').map((s) => s.trim()).filter(Boolean);
      const { build, created } = await api('POST', `/projects/${p.id}/builds`, { commitSha: f.sha.value.trim(), branch: f.branch.value, environment: f.environment.value, appUrl: f.appUrl.value || undefined, changedPaths: paths.length ? paths : undefined });
      toast(created ? `Build ${build.shortSha} registered` : `Build ${build.shortSha} was already registered`); location.hash = `#/p/${p.id}/builds/${build.id}`;
    }) }, h('h3', {}, 'Register a build'), h('p', { class: 'small mute' }, 'Normally done by CI or the GitHub webhook. A build is immutable once registered; the same commit and environment always resolve to the same build.'),
      h('div', { class: 'grid2' }, h('label', {}, 'Commit', f.sha), h('label', {}, 'Branch', f.branch), h('label', {}, 'Environment', f.environment), h('label', {}, 'Deployment URL', f.appUrl)),
      h('label', {}, 'Changed paths', f.paths), h('div', {}, h('button', { class: 'btn primary', type: 'submit' }, 'Register build'))));
}
function impactView(p, bid) {
  const { h, api, act, toast, fmtTime } = S();
  const out = h('div', {});
  return loader(out, async () => {
    const d = await api('GET', `/projects/${p.id}/builds/${bid}/impact`);
    const b = d.build, s = d.summary;
    const IMP = { affected: 's-failed', unaffected: 's-verified', unknown: 's-blocked' };
    let filter = '';
    const table = h('div', {});
    const draw = () => table.replaceChildren(h('div', { class: 'panel flush scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'ID'), h('th', {}, 'Criterion'), h('th', {}, 'Impact'), h('th', {}, 'Evidence'), h('th', {}, 'Plan'))),
      h('tbody', {}, d.items.filter((i) => !filter || i.impact === filter).map((i) => h('tr', {}, h('td', {}, h('a', { class: 'key', href: `#/p/${p.id}/proof/${i.id}` }, i.key)),
        h('td', {}, h('div', { class: 'stack-s' }, i.text, h('span', { class: 'small mute' }, i.impactReason), i.matched.length ? h('div', { class: 'small' }, i.matched.map((m) => h('code', { class: 'mono' }, m, ' '))) : null,
          h('span', { class: 'small mute' }, i.paths.length ? `mapping: ${i.paths.join(', ')}` : 'no mapping'))),
        h('td', {}, pill(i.impact, IMP[i.impact])), h('td', {}, fresh(i.freshness)), h('td', { class: 'small' }, h('b', { class: i.include ? 's-blocked' : 's-verified' }, i.include ? 'Verify' : 'Skip'), h('div', { class: 'mute' }, i.why.replace(/^(Included|Excluded) — /, '')))))))));
    draw();
    out.replaceChildren(h('div', { class: 'stack-l' },
      h('div', { class: 'row spread' }, h('a', { class: 'btn sm', href: `#/p/${p.id}/builds` }, '← Builds'),
        h('button', { class: 'btn primary', disabled: !s.toVerify, onclick: act(async () => { try { const { run } = await api('POST', `/projects/${p.id}/runs`, { mode: 'plan', buildId: b.id }); toast('Verification plan queued'); location.hash = `#/run/${run.id}`; } catch (e) { if (e.data?.activeRunId) location.hash = `#/run/${e.data.activeRunId}`; throw e; } }) },
          s.toVerify ? `Run verification plan (${s.toVerify} of ${s.total})` : 'Nothing to verify')),
      h('div', { class: 'panel stack' }, h('div', { class: 'row' }, h('h2', {}, 'Build ', b.shortSha), b.branch ? h('span', { class: 'cat' }, b.branch) : null, h('span', { class: 'cat' }, b.environment), h('span', { class: 'cat' }, b.source.replace('_', ' '))),
        h('dl', { class: 'kv' }, h('dt', {}, 'Commit'), h('dd', { class: 'mono' }, b.commitSha), h('dt', {}, 'Registered'), h('dd', {}, fmtTime(b.createdAt)), b.buildId ? [h('dt', {}, 'Build id'), h('dd', { class: 'mono' }, b.buildId)] : null,
          b.appUrl ? [h('dt', {}, 'URL'), h('dd', { class: 'mono' }, b.appUrl)] : null, b.message ? [h('dt', {}, 'Message'), h('dd', {}, b.message)] : null, h('dt', {}, 'Policy'), h('dd', {}, `v${d.policyVersion}`)),
        b.pathsKnown ? h('details', {}, h('summary', { class: 'small' }, `${b.changedPaths.length} changed file${b.changedPaths.length === 1 ? '' : 's'}`), h('pre', { style: { 'margin-top': '8px' } }, b.changedPaths.join('\n') || '(none)'))
          : h('div', { class: 'callout' }, h('b', {}, 'Change set unknown. '), 'No file list was supplied for this build, so every criterion is treated as potentially affected.')),
      h('div', { class: 'stats' }, [['affected', 'Affected', 's-failed'], ['unknown', 'Unknown impact', 's-blocked'], ['unaffected', 'Unaffected', 's-verified']].map(([k, l, c]) =>
        h('button', { class: 'stat statbtn', onclick: () => { filter = filter === k ? '' : k; draw(); }, title: 'Click to filter' }, h('b', { class: s[k] ? c : '' }, s[k]), h('span', {}, l))),
        h('div', { class: 'stat' }, h('b', {}, s.toVerify), h('span', {}, 'To verify'))),
      table));
  });
}

// ---------- Release intelligence ----------
export function IntelligenceTab({ project: p }) {
  const { h, api, act, toast, fmtTime, tag } = S();
  const out = h('div', {});
  let view = 'freshness', state = '';
  return loader(out, async function draw() {
    const [{ decision: d, history }, pol] = await Promise.all([api('GET', `/projects/${p.id}/intelligence`), api('GET', `/projects/${p.id}/policy`)]);
    const link = (b) => b.runId ? h('a', { href: `#/run/${b.runId}/${b.resultId}` }, `run #${b.runId}`) : null;
    const rules = Object.entries(pol.policy.rules).map(([k, v]) => [k, typeof v === 'boolean' ? h('input', { type: 'checkbox', checked: v, 'data-rule': k }) : h('input', { type: 'number', value: v, min: 3, max: 200, 'data-rule': k, style: { width: '90px' } })]);
    const RULE = { requireCurrentEvidence: 'Mandatory criteria need current evidence (stale passes do not count)', unknownImpactInvalidates: 'Unknown change impact invalidates earlier evidence', blockCriticalUnstable: 'Critical criteria that are intermittent block release',
      requireSameEnvironment: 'Evidence must come from the build\'s environment', pinEngineVersion: 'Evidence from another engine version is stale', reverifyOnPolicyChange: 'Evidence produced under an older policy version is stale',
      requireBuild: 'A registered build is required for a decision', minStabilitySample: 'Application outcomes needed before judging stability', stabilityWindow: 'Most recent outcomes considered for stability' };
    const body = h('div', {});
    const rows = () => d.criteria.filter((c) => !state || c.freshness.state === state);
    const tables = {
      freshness: () => h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'ID'), h('th', {}, 'Evidence'), h('th', {}, 'Why'), h('th', {}, 'Supporting run'))),
        h('tbody', {}, rows().map((c) => h('tr', {}, h('td', {}, h('a', { class: 'key', href: `#/p/${p.id}/proof/${c.id}` }, c.key), h('div', { class: 'small mute' }, c.mandatory ? c.criticality : 'optional')), h('td', {}, fresh(c.freshness.state)),
          h('td', {}, h('ul', { class: 'reasons' }, c.freshness.reasons.map((r) => h('li', {}, h('code', { class: 'mono' }, r.code), ' ', r.message)))), h('td', { class: 'small' }, c.latest ? h('a', { href: `#/run/${c.latest.runId}/${c.latest.resultId}` }, `run #${c.latest.runId}`) : '—'))))),
      stability: () => h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'ID'), h('th', {}, 'Classification'), h('th', {}, 'Sample'), h('th', {}, 'Failure frequency'), h('th', {}, 'Recent application outcomes'), h('th', {}, 'Excluded (infrastructure)'))),
        h('tbody', {}, rows().map((c) => { const s = c.stability; return h('tr', {}, h('td', {}, h('a', { class: 'key', href: `#/p/${p.id}/proof/${c.id}` }, c.key)), h('td', {}, stab(s.classification)),
          h('td', { class: 'num' }, `${s.sample} / ${s.minSample} needed`), h('td', { class: 'num' }, s.sample ? `${s.failures} of ${s.sample}` : '—'),
          h('td', {}, s.recent.length ? h('span', { class: 'trail' }, s.recent.map((r) => h('a', { href: `#/run/${r.runId}/${r.resultId}`, title: `run #${r.runId}: ${r.status}${r.environment ? ` · ${r.environment}` : ''}` }, h('i', { class: `bg-${r.status}` })))) : h('span', { class: 'small mute' }, 'none')),
          h('td', { class: 'small mute' }, s.excluded.total ? Object.entries(s.excluded.byKind).map(([k, n]) => `${n} ${S().KIND[k] || k}`).join(', ') : '—')); }))),
      risk: () => h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'ID'), h('th', {}, 'Level'), h('th', {}, 'Contributing factors (points)'))),
        h('tbody', {}, rows().slice().sort((a, b) => b.risk.score - a.risk.score).map((c) => h('tr', {}, h('td', {}, h('a', { class: 'key', href: `#/p/${p.id}/proof/${c.id}` }, c.key)), h('td', {}, risk(c.risk.level), h('div', { class: 'small mute num' }, `${c.risk.score} pts`)),
          h('td', {}, c.risk.factors.length ? h('ul', { class: 'reasons' }, c.risk.factors.map((f) => h('li', {}, h('code', { class: 'mono' }, `+${f.points} ${f.factor}`), ' ', f.detail))) : h('span', { class: 'small mute' }, 'No risk factors.')))))),
    };
    const paint = () => body.replaceChildren(...[h('div', { class: 'row' }, ['freshness', 'stability', 'risk'].map((v) => h('button', { class: `btn sm${view === v ? ' primary' : ''}`, onclick: () => { view = v; paint(); } }, v[0].toUpperCase() + v.slice(1))),
      h('select', { 'aria-label': 'Filter by evidence state', onchange: (e) => { state = e.target.value; paint(); } }, ['', 'CURRENT', 'STALE', 'UNVERIFIED', 'FAILED', 'BLOCKED'].map((v) => h('option', { value: v, selected: v === state }, v ? `${v} (${d.freshness[v]})` : 'All states')))),
      rows().length ? h('div', { class: 'panel flush scroll', style: { 'margin-top': '12px' } }, tables[view]()) : h('div', { class: 'panel empty', style: { 'margin-top': '12px' } }, d.criteria.length ? 'No criteria in this state.' : 'No acceptance criteria yet.'),
      view === 'risk' ? h('p', { class: 'small mute', style: { 'margin-top': '8px' } }, 'Risk is an ordinal prioritisation built from the listed factors (≥7 high, ≥4 medium). It is not a probability and never changes a verdict.') : null,
      view === 'stability' ? h('p', { class: 'small mute', style: { 'margin-top': '8px' } }, `Classified from the last ${pol.policy.rules.stabilityWindow} application outcomes (passed/failed) of the current criterion text. Authentication, network, timeout and interruption results are excluded.`) : null].filter(Boolean));
    paint();
    out.replaceChildren(h('div', { class: 'stack-l' },
      h('div', { class: 'panel stack' }, h('div', { class: 'row spread', style: { 'align-items': 'flex-start' } },
        h('div', { class: 'stack-s' }, h('h3', {}, 'Release decision'), h('h2', {}, d.verdict === 'verified' ? 'This release is allowed.' : d.verdict === 'blocked' ? 'This release is blocked.' : 'This release is not verified.'),
          h('div', { class: 'small mute' }, 'Policy v', d.policy.version, ' · ', d.build ? ['build ', buildLink(p.id, d.build)] : 'no build registered', ' · computed ', fmtTime(d.decidedAt))),
        h('div', { class: `stamp ${d.verdict === 'verified' ? 's-verified' : d.verdict === 'blocked' ? 's-failed' : 's-blocked'}` }, h('b', {}, 'SHIPPROOF GATE'), h('span', {}, { verified: 'RELEASE VERIFIED', blocked: 'RELEASE BLOCKED', unverified: 'NOT VERIFIED' }[d.verdict]))),
        d.blocking.length ? h('div', { class: 'stack-s' }, h('h3', {}, `Blocking conditions (${d.blocking.length})`), d.blocking.map((b) => h('div', { class: `callout ${['FAILED', 'CRITICAL_UNSTABLE'].includes(b.code) ? 'bad' : ''} stack-s` },
          h('div', { class: 'row' }, h('code', { class: 'mono' }, b.code), b.criterionKey ? h('a', { class: 'key', href: `#/p/${p.id}/proof/${b.criterionId}` }, b.criterionKey) : null, link(b)), h('span', {}, b.message), h('span', { class: 'small mute' }, 'To resolve: ', b.action))))
          : h('div', { class: 'callout ok' }, 'Every mandatory criterion has current passing evidence under policy v', d.policy.version, '.'),
        d.strictGate.verdict !== d.verdict ? h('p', { class: 'small mute' }, `The strict execution gate alone reads “${d.strictGate.verdict}”; freshness and policy rules are what change the outcome here.`) : null),
      h('div', { class: 'stats' }, Object.entries(d.freshness).map(([k, n]) => h('button', { class: 'stat statbtn', title: 'Click to filter', onclick: () => { state = state === k ? '' : k; paint(); } }, h('b', { class: n ? FRESH[k] : '' }, n), h('span', {}, k)))),
      body,
      h('div', { class: 'panel stack' }, h('div', { class: 'row spread' }, h('h3', {}, `Release policy · version ${pol.policy.version}`), h('span', { class: 'small mute' }, `in effect since ${fmtTime(pol.policy.createdAt)}`)),
        h('div', { class: 'stack-s' }, rules.map(([k, input]) => h('label', { class: 'row rule' }, input, h('span', {}, RULE[k] || k)))),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: act(async () => {
          const next = Object.fromEntries(rules.map(([k, i]) => [k, i.type === 'checkbox' ? i.checked : Number(i.value)]));
          const r = await api('PUT', `/projects/${p.id}/policy`, { rules: next });
          toast(r.policy.version === pol.policy.version ? 'Policy unchanged' : `Policy v${r.policy.version} saved`); S().render();
        }) }, 'Save as new policy version'), h('span', { class: 'small mute' }, 'Every change creates a new version; decisions and executions record the version they used.')),
        h('details', {}, h('summary', { class: 'small' }, 'Rules that cannot be configured'), h('ul', { class: 'reasons', style: { 'margin-top': '8px' } }, pol.invariants.map((i) => h('li', {}, i))))),
      history.length ? h('section', { class: 'stack' }, h('h3', {}, 'Recorded decisions'), h('div', { class: 'panel flush scroll' }, h('table', {}, h('tbody', {}, history.map((x) => h('tr', {}, h('td', { class: 'key' }, `#${x.id}`), h('td', {}, tag(x.verdict === 'blocked' ? 'failed' : x.verdict)),
        h('td', {}, x.commit_sha ? sha(x.commit_sha) : h('span', { class: 'mute' }, 'no build')), h('td', { class: 'small mute' }, `policy v${x.policy_version} · by ${x.requested_by} · ${fmtTime(x.created_at)}`))))))) : null));
  });
}

// ---------- CI integration ----------
export function CITab({ project: p }) {
  const { h, api, act, toast, copy, fmtTime, dialog } = S();
  const out = h('div', {});
  return loader(out, async function draw() {
    const d = await api('GET', `/projects/${p.id}/integration`);
    const yml = await (await fetch('/ci/shipproof-verify.yml')).text();
    const secretOut = h('div', {});
    const envIn = h('input', { value: d.webhook.environment, 'aria-label': 'Environment for webhook builds', style: { 'max-width': '200px' } });
    out.replaceChildren(h('div', { class: 'stack-l' },
      h('div', { class: 'panel stack' }, h('h3', {}, 'GitHub Actions release gate'),
        h('p', { class: 'small mute' }, 'The workflow registers the exact commit, runs the change-impact verification plan, waits for the real result and fails the job unless the release decision allows it.'),
        h('dl', { class: 'kv' }, h('dt', {}, 'Secret'), h('dd', {}, h('code', { class: 'mono' }, 'SHIPPROOF_API_KEY'), ' — ', d.ci.hasApiKey ? 'a project API key exists' : 'no key yet', ' · ', h('a', { href: `#/p/${p.id}/settings` }, d.ci.hasApiKey ? 'rotate in Settings' : 'generate in Settings')),
          h('dt', {}, 'Variable'), h('dd', {}, h('code', { class: 'mono' }, 'SHIPPROOF_URL'), ' = ', h('code', { class: 'mono' }, d.ci.baseUrl)),
          h('dt', {}, 'Variable'), h('dd', {}, h('code', { class: 'mono' }, 'SHIPPROOF_APP_URL'), ' — optional per-commit deployment URL'),
          h('dt', {}, 'Client'), h('dd', {}, h('a', { class: 'mono', href: d.ci.clientUrl, target: '_blank', rel: 'noopener' }, d.ci.clientUrl))),
        h('details', {}, h('summary', { class: 'small' }, '.github/workflows/shipproof-verify.yml'), h('pre', { style: { 'margin-top': '8px', 'max-height': '420px' } }, yml)),
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: act(() => copy(yml, 'Workflow')) }, 'Copy workflow'), h('a', { class: 'btn', href: d.ci.workflowUrl, download: 'shipproof-verify.yml' }, 'Download'))),
      h('div', { class: 'panel stack' }, h('div', { class: 'row spread' }, h('h3', {}, 'GitHub push webhook'), d.webhook.configured ? pill('configured', 's-verified') : pill('not configured', 's-untested')),
        h('p', { class: 'small mute' }, 'Registers a build for every push, with its changed files, so evidence goes stale the moment relevant code changes. Deliveries are authenticated with HMAC-SHA256 and processed once.'),
        h('dl', { class: 'kv' }, h('dt', {}, 'Payload URL'), h('dd', { class: 'mono' }, d.webhook.url), h('dt', {}, 'Content type'), h('dd', { class: 'mono' }, d.webhook.contentType), h('dt', {}, 'Events'), h('dd', {}, 'Just the push event'),
          h('dt', {}, 'Environment'), h('dd', {}, envIn)),
        secretOut,
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: act(async () => {
          if (d.webhook.configured && !(await dialog({ title: 'Rotate the webhook secret?', body: 'GitHub deliveries signed with the old secret will be rejected until you update the webhook.', confirm: 'Rotate secret', danger: true }))) return;
          const r = await api('POST', `/projects/${p.id}/webhook`, { environment: envIn.value.trim() || 'default' }); d.webhook.configured = true;
          secretOut.replaceChildren(h('div', { class: 'callout ok stack-s' }, h('b', {}, 'Copy this secret now — it is stored encrypted and not shown again.'), h('code', { class: 'mono', id: 'webhook-secret' }, r.secret), h('div', {}, h('button', { class: 'btn sm', onclick: act(() => copy(r.secret, 'Webhook secret')) }, 'Copy'))));
        }) }, d.webhook.configured ? 'Rotate secret' : 'Create webhook secret'),
          d.webhook.configured ? [h('button', { class: 'btn', onclick: act(async () => { await api('POST', `/projects/${p.id}/webhook`, { environment: envIn.value.trim() || 'default', rotate: false }); toast('Environment saved'); }) }, 'Save environment'),
            h('button', { class: 'btn danger', onclick: act(async () => { await api('DELETE', `/projects/${p.id}/webhook`); toast('Webhook secret removed'); S().render(); }) }, 'Remove')] : null)),
      h('section', { class: 'stack' }, h('h3', {}, `Recent deliveries (${d.deliveries.length})`), d.deliveries.length ? h('div', { class: 'panel flush scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Received'), h('th', {}, 'Event'), h('th', {}, 'Outcome'), h('th', {}, 'Detail'), h('th', {}, 'Delivery id'))),
        h('tbody', {}, d.deliveries.map((x) => h('tr', {}, h('td', { class: 'small mute' }, fmtTime(x.received_at)), h('td', { class: 'mono' }, x.event), h('td', {}, pill(x.outcome.replace('_', ' '), x.outcome === 'build_registered' || x.outcome === 'ok' ? 's-verified' : x.outcome === 'rejected' ? 's-failed' : 's-untested')),
          h('td', { class: 'small' }, x.detail || ''), h('td', { class: 'mono small mute' }, x.delivery_id)))))) : h('div', { class: 'panel empty small' }, 'No authenticated deliveries received yet.'))));
  });
}

// ---------- Proof dossier ----------
async function rehash(doc) { // independent check in the browser: canonical JSON → SHA-256
  const canon = (v) => v === null || typeof v !== 'object' ? JSON.stringify(v ?? null) : Array.isArray(v) ? `[${v.map(canon).join(',')}]` : `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canon(doc.payload)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function DossierTab({ project: p }, sub) {
  const { h, api, act, toast, copy, fmtTime, tag } = S();
  const out = h('div', {});
  if (sub) return loader(out, async () => {
    const d = await api('GET', `/dossiers/${sub}`), doc = d.document, pl = doc.payload, m = doc.manifest, es = pl.executionSummary;
    const local = await rehash(doc).catch(() => null);
    const ok = d.verification.valid && local === m.payloadSha256;
    out.replaceChildren(h('div', { class: 'stack-l' },
      h('div', { class: 'row spread' }, h('a', { class: 'btn sm', href: `#/p/${p.id}/dossier` }, '← Dossiers'), h('div', { class: 'row' }, h('a', { class: 'btn primary', href: `/api/dossiers/${d.id}/download` }, 'Download JSON'), h('button', { class: 'btn', onclick: () => window.print() }, 'Print / PDF'))),
      h('div', { class: 'panel stack' }, h('div', { class: 'row spread', style: { 'align-items': 'flex-start' } },
        h('div', { class: 'stack-s' }, h('h3', {}, 'Proof dossier'), h('h1', {}, pl.project.name), h('div', { class: 'mono mute' }, pl.build ? `${pl.build.commitSha} · ${pl.build.environment}${pl.build.branch ? ` · ${pl.build.branch}` : ''}` : 'No build registered')),
        h('div', { class: `stamp lg ${pl.decision.verdict === 'verified' ? 's-verified' : pl.decision.verdict === 'blocked' ? 's-failed' : 's-blocked'}` }, h('b', {}, `DECISION #${pl.decision.id}`), h('span', {}, { verified: 'RELEASE VERIFIED', blocked: 'RELEASE BLOCKED', unverified: 'NOT VERIFIED' }[pl.decision.verdict]))),
        h('div', { class: `callout ${ok ? 'ok' : 'bad'} stack-s`, id: 'dossier-integrity' }, h('b', {}, ok ? 'Integrity verified' : 'INTEGRITY CHECK FAILED'),
          h('span', { class: 'small' }, ok ? 'The payload hash was recomputed in this browser and matches the manifest; the Ed25519 signature is valid' + (d.signedByThisServer ? ' and was made by this server\'s key.' : ', but it was NOT made by this server\'s key.')
            : [...d.verification.problems, local !== m.payloadSha256 ? 'browser-computed hash differs from the manifest' : null].filter(Boolean).join('; '))),
        es.testFixture ? h('div', { class: 'callout bad' }, h('b', {}, `${es.testFixture} supporting execution${es.testFixture === 1 ? ' was' : 's were'} produced by a test stand-in engine. `), 'They are not Kane CLI evidence.') : null,
        h('dl', { class: 'kv' }, h('dt', {}, 'Decided'), h('dd', {}, fmtTime(pl.decision.decidedAt)), h('dt', {}, 'Policy'), h('dd', {}, `version ${pl.policy.version}`),
          h('dt', {}, 'Supporting executions'), h('dd', {}, `${es.kaneCli} Kane CLI · ${es.testFixture} test fixture · ${es.unverified} criteria without current proof`),
          h('dt', {}, 'Evidence'), h('dd', {}, `${m.evidence.length} hashed artifact${m.evidence.length === 1 ? '' : 's'}${es.missingEvidence ? ` · ${es.missingEvidence} missing` : ''}${es.evidenceMismatch ? ` · ${es.evidenceMismatch} MODIFIED SINCE CAPTURE` : ''}`),
          h('dt', {}, 'Payload SHA-256'), h('dd', { class: 'mono' }, m.payloadSha256), h('dt', {}, 'Signing key'), h('dd', { class: 'mono' }, `${m.algorithm} · ${m.keyId}`)),
        pl.decision.blocking.length ? h('div', { class: 'stack-s' }, h('h3', {}, 'Blocking conditions'), pl.decision.blocking.map((b) => h('div', { class: 'callout' }, h('code', { class: 'mono' }, b.code), ' ', b.message))) : null),
      h('section', { class: 'stack' }, h('h3', {}, 'Criteria and supporting evidence'), h('div', { class: 'panel flush scroll' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'ID'), h('th', {}, 'Criterion (version)'), h('th', {}, 'State'), h('th', {}, 'Supporting execution'), h('th', {}, 'Evidence SHA-256'))),
        h('tbody', {}, pl.criteria.map((c) => { const s = c.supportingExecution; return h('tr', {}, h('td', {}, h('a', { class: 'key', href: `#/p/${p.id}/proof/${c.criterionId}` }, c.key)),
          h('td', {}, h('div', { class: 'stack-s' }, c.text, h('span', { class: 'small mute' }, c.version ? `v${c.version.number} · ${c.version.contentHash.slice(0, 16)}…` : '', ` · ${c.criticality} · ${c.mandatory ? 'mandatory' : 'optional'}`))),
          h('td', {}, fresh(c.freshness.state), h('div', { class: 'small mute' }, c.freshness.reasons[0].message)),
          h('td', { class: 'small' }, s ? h('div', { class: 'stack-s' }, h('a', { href: `#/run/${s.runId}/${s.resultId}` }, `run #${s.runId}`), h('span', { class: `mono ${s.engineKind === 'test-fixture' ? 's-failed' : ''}` }, s.engine || 'unknown engine'),
            h('span', { class: 'mute' }, `exit ${s.exitCode} · ${s.commitSha ? s.commitSha.slice(0, 7) : 'no build'} · ${fmtTime(s.finishedAt)}`)) : h('span', { class: 'mute' }, 'None — not currently verified')),
          h('td', { class: 'small' }, s ? s.evidence.map((e) => h('div', {}, e.sha256 ? sha(e.sha256, 16) : h('span', { class: 'mute' }, e.kind), ' ', h('span', { class: e.integrity === 'ok' || e.integrity === 'link' ? 'mute' : 's-failed' }, e.integrity === 'ok' ? '' : e.integrity))) : '—')); }))))),
      pl.repairs.length ? h('section', { class: 'stack' }, h('h3', {}, 'Repair history'), h('div', { class: 'panel flush scroll' }, h('table', {}, h('tbody', {}, pl.repairs.map((r) => h('tr', {}, h('td', { class: 'key' }, `RT-${r.id}`), h('td', { class: 'key' }, r.criterionKey), h('td', {}, tag(r.status === 'verified' ? 'verified' : 'failed')),
        h('td', { class: 'small' }, `failed in run #${r.originRunId}`, r.verifyRunId ? ` → verified by run #${r.verifyRunId}` : ' → not verified', r.fixDeclaredBy ? ` · fix declared by ${r.fixDeclaredBy}` : ''))))))) : null,
      h('div', { class: 'panel stack noprint' }, h('h3', {}, 'Verify independently'), h('p', { class: 'small mute' }, 'The file is self-contained: canonical JSON, SHA-256 manifest and an Ed25519 signature with the public key embedded. Pin the key id to confirm who signed it.'),
        h('pre', {}, `node scripts/verify-dossier.mjs shipproof-dossier-${d.id}.json --trust-key ${m.keyId}`), h('div', {}, h('button', { class: 'btn sm', onclick: act(() => copy(m.payloadSha256, 'Payload hash')) }, 'Copy payload hash')))));
  });
  return loader(out, async function draw() {
    const [{ dossiers, key }, { builds }] = await Promise.all([api('GET', `/projects/${p.id}/dossiers`), api('GET', `/projects/${p.id}/builds?limit=20`)]);
    const sel = h('select', { 'aria-label': 'Build' }, h('option', { value: '' }, builds.length ? `Current build (${builds[0].shortSha})` : 'No build registered'), builds.slice(1).map((b) => h('option', { value: b.id }, `${b.shortSha} · ${b.environment}`)));
    out.replaceChildren(h('div', { class: 'stack-l' },
      h('div', { class: 'panel stack' }, h('h3', {}, 'Generate a proof dossier'), h('p', { class: 'small mute' }, 'A signed, machine-readable record of what was verified, on which build, under which policy, with the SHA-256 of every evidence artifact. Generating one also records a release decision.'),
        h('div', { class: 'row' }, sel, h('button', { class: 'btn primary', onclick: act(async () => { const r = await api('POST', `/projects/${p.id}/dossiers`, sel.value ? { buildId: Number(sel.value) } : {}); toast('Dossier generated and signed'); location.hash = `#/p/${p.id}/dossier/${r.id}`; }) }, 'Generate dossier'),
          h('span', { class: 'small mute' }, `Signing key ${key.algorithm} · ${key.keyId}`))),
      dossiers.length ? h('div', { class: 'panel flush scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Generated'), h('th', {}, 'Decision'), h('th', {}, 'Build'), h('th', {}, 'Payload SHA-256'), h('th', {}, ''))),
        h('tbody', {}, dossiers.map((x) => h('tr', { class: 'click', onclick: () => (location.hash = `#/p/${p.id}/dossier/${x.id}`) }, h('td', { class: 'small' }, fmtTime(x.createdAt)), h('td', {}, tag(x.verdict === 'blocked' ? 'failed' : x.verdict)),
          h('td', {}, x.build ? sha(x.build.commitSha) : h('span', { class: 'mute' }, 'no build')), h('td', {}, sha(x.payloadSha256, 24)), h('td', {}, h('a', { class: 'btn sm', href: `#/p/${p.id}/dossier/${x.id}` }, 'Open'))))))) : h('div', { class: 'panel empty' }, 'No dossiers generated yet.')));
  });
}
