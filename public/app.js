// SHIPPROOF single-page app. No build step; every value on screen is fetched from the API.
import { ProofTab, BuildsTab, IntelligenceTab, CITab, DossierTab } from './proof.js';
const $app = document.getElementById('app');
let me = null, system = null, cleanup = [];

// ---------- tiny DOM + API helpers ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && !['list', 'form'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
async function api(method, url, body) {
  const res = await fetch('/api' + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && me) { me = null; toast('Your session expired. Sign in again.', true); location.hash = '#/login'; }
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
  return data;
}
function toast(msg, bad) {
  const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), bad ? 6000 : 3200);
}
const act = (fn) => async (e) => {
  const b = e?.currentTarget; if (b?.tagName === 'BUTTON') b.disabled = true;
  try { await fn(e); } catch (err) { toast(err.message, true); } finally { if (b?.tagName === 'BUTTON') b.disabled = false; }
};
const fmtDur = (ms) => ms == null ? '—' : ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
const fmtTime = (iso) => iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const ago = (iso) => { if (!iso) return '—'; const s = (Date.now() - Date.parse(iso)) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`; };
const LABEL = { verified: 'Verified', failed: 'Failed', blocked: 'No evidence', untested: 'Not tested', passed: 'Passed', error: 'Exec error', timeout: 'Timed out',
  queued: 'Queued', starting: 'Starting', running: 'Running', cancelled: 'Cancelled', completed: 'Completed', interrupted: 'Interrupted', unverified: 'Unverified' };
const tag = (s, label) => h('span', { class: `tag s-${s}` }, s === 'running' || s === 'starting' ? h('i', { class: 'dot live' }) : null, label || LABEL[s] || s);
// Execution errors are never shown as one generic state: each cause has its own label.
const KIND = { auth: 'Kane not signed in', kane_not_installed: 'Kane unavailable', network: 'Network unavailable', interrupted: 'Interrupted', did_not_start: 'Did not start',
  no_evidence: 'Pass w/o evidence', target_blocked: 'Target blocked', inconsistent: 'Inconsistent result', spawn_failed: 'Kane unavailable', runner: 'Internal error' };
const resultTag = (r) => tag(r.status, r.status === 'error' ? KIND[r.errorKind] : null);
const ACTIVE = ['queued', 'starting', 'running'];
const FRESH_TAG = { STALE: ['blocked', 'Stale'], CURRENT: null };
// Modal dialogs (native <dialog>: focus trap, Esc to close). Resolves to the input value / true, or null when dismissed.
function dialog({ title, body, value, confirm = 'Confirm', danger = false, multiline = true, fields }) {
  if (fields) return new Promise((resolve) => {
    const inputs = fields.map((f) => [f.name, f.options ? h('select', { style: { width: '100%' } }, f.options.map((o) => h('option', { value: o, selected: o === f.value }, o))) : h(f.multiline ? 'textarea' : 'input', { value: f.value ?? '', placeholder: f.placeholder || '' })]);
    const d = h('dialog', { class: 'dlg' }, h('form', { method: 'dialog', class: 'stack', onsubmit: (e) => { e.preventDefault(); d.close(); resolve(Object.fromEntries(inputs.map(([n, i]) => [n, i.value]))); } },
      h('h2', {}, title), body ? h('p', { class: 'small mute' }, body) : null, fields.map((f, i) => h('label', {}, f.label, inputs[i][1])),
      h('div', { class: 'row', style: { 'justify-content': 'flex-end' } }, h('button', { class: 'btn', type: 'button', onclick: () => { d.close(); resolve(null); } }, 'Cancel'), h('button', { class: 'btn primary', type: 'submit' }, confirm))));
    d.addEventListener('cancel', () => resolve(null)); d.addEventListener('close', () => d.remove());
    document.body.append(d); d.showModal();
  });
  return new Promise((resolve) => {
    const input = value != null ? h(multiline ? 'textarea' : 'input', { value, 'aria-label': title }) : null;
    const d = h('dialog', { class: 'dlg' }, h('form', { method: 'dialog', class: 'stack', onsubmit: (e) => { e.preventDefault(); d.close(); resolve(input ? input.value : true); } },
      h('h2', {}, title), body ? h('p', { class: 'small mute' }, body) : null, input,
      h('div', { class: 'row', style: { 'justify-content': 'flex-end' } }, h('button', { class: 'btn', type: 'button', onclick: () => { d.close(); resolve(null); } }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'submit' }, confirm))));
    d.addEventListener('cancel', () => resolve(null)); d.addEventListener('close', () => d.remove());
    document.body.append(d); d.showModal(); (input || d.querySelector('button[type=submit]')).focus();
  });
}
const TRIGGER = { impact_plan: 'Change-impact plan', full: 'Full verification', rerun_failed: 'Re-run failed', untested: 'Untested only', selected: 'Selected criteria', repair_verify: 'Fix re-verification' };
const VERDICT = { verified: ['RELEASE VERIFIED', 's-verified'], blocked: ['RELEASE BLOCKED', 's-failed'], unverified: ['NOT VERIFIED', 's-blocked'] };
const stamp = (verdict, lg) => h('div', { class: `stamp ${VERDICT[verdict][1]}${lg ? ' lg' : ''}`, role: 'status' }, h('b', {}, 'SHIPPROOF GATE'), h('span', {}, VERDICT[verdict][0]));
const segBar = (counts, order) => {
  const total = order.reduce((a, k) => a + (counts[k] || 0), 0);
  return h('div', { class: 'bar', title: order.filter((k) => counts[k]).map((k) => `${counts[k]} ${LABEL[k] || k}`).join(' · ') || 'no data' },
    order.filter((k) => counts[k]).map((k) => h('i', { class: `bg-${k}`, style: { width: `${(counts[k] / total) * 100}%` } })));
};
const copy = async (text, what) => { await navigator.clipboard.writeText(text); toast(`${what} copied`); };

// ---------- chrome ----------
function shell(...content) {
  const k = system?.kane;
  const engine = me && k ? h('button', { class: 'engine', title: k.detail, onclick: act(async () => { system = await api('GET', '/system?fresh=1'); toast(`Kane CLI ${system.kane.version || 'not installed'} — ${system.kane.detail}`, !system.kane.ready); render(); }) },
    h('i', { class: `dot ${k.ready ? 'ok' : k.installed ? 'warn' : 'bad'}` }), k.installed ? `kane-cli ${k.version}` : 'kane-cli missing',
    h('span', { class: 'opt' }, { ready: '', not_authenticated: ' · not signed in', incompatible: ' · unsupported version', unavailable: '', test_fixture: ' · TEST STAND-IN' }[k.state])) : null;
  return h('div', {},
    h('header', { class: 'top' }, h('div', { class: 'wrap' },
      h('a', { class: 'brand', href: me ? '#/app' : '#/' }, h('i'), 'SHIPPROOF'),
      h('nav', {}, engine,
        me ? [h('a', { href: '#/app' }, 'Projects'), h('a', { href: '#/new', class: 'opt' }, 'New project'),
          h('button', { class: 'linkbtn', onclick: act(async () => { await api('POST', '/auth/logout'); me = null; location.hash = '#/'; render(); }) }, 'Sign out')]
          : [h('a', { href: '#/login' }, 'Sign in'), h('a', { class: 'btn primary sm', href: '#/signup' }, 'Get started')]))),
    h('main', { class: 'wrap' }, content));
}
const engineCallout = () => {
  const k = system?.kane;
  if (!k || k.ready) return null;
  if (k.state === 'test_fixture') return h('div', { class: 'callout bad' }, h('b', {}, 'Test stand-in engine — not Kane CLI. '), 'This server is configured with a fixture binary used by the automated tests. Nothing it produces is Kane CLI evidence.');
  const head = { unavailable: 'Kane CLI is not installed on this server. ', incompatible: `Kane CLI ${k.version} is not supported (minimum ${k.minVersion}). `, not_authenticated: 'Kane CLI is installed but not signed in. ' }[k.state];
  return h('div', { class: 'callout' }, h('b', {}, head), k.detail, ' Runs will be recorded as execution errors — never as passes — until this is fixed.');
};

// ---------- landing ----------
function Landing() {
  return shell(
    h('section', { class: 'hero' },
      h('div', { class: 'stack' },
        h('h3', {}, 'Release verification for AI-generated software'),
        h('h1', {}, 'Don’t trust what your coding agent says. ', h('em', {}, 'Verify what it ships.')),
        h('p', { class: 'lede' }, 'Generated code that compiles and passes unit tests still isn’t proof that the app works for a user. SHIPPROOF turns your requirements into acceptance criteria, runs each one in a real browser through Kane CLI, and only signs a release when the evidence says so.'),
        h('div', { class: 'row' }, h('a', { class: 'btn primary', href: me ? '#/app' : '#/signup' }, me ? 'Open your projects' : 'Start verifying'),
          h('a', { class: 'btn', href: me ? '#/new' : '#/login' }, me ? 'New project' : 'Sign in'))),
      h('div', { class: 'stack' },
        h('div', { class: 'ledger', 'aria-label': 'What counts as proof' },
          h('div', {}, h('span', {}, 'agent says “done”'), h('span', { class: 's-untested' }, 'not evidence')),
          h('div', {}, h('span', {}, 'code compiles'), h('span', { class: 's-untested' }, 'not evidence')),
          h('div', {}, h('span', {}, 'unit tests pass'), h('span', { class: 's-untested' }, 'not evidence')),
          h('div', {}, h('span', {}, 'kane-cli exit 0 + run_end passed'), h('span', { class: 's-verified' }, 'evidence')),
          h('div', {}, h('span', {}, 'auth error / timeout / no run_end'), h('span', { class: 's-blocked' }, 'unverified')),
          h('div', {}, h('span', {}, 'any mandatory criterion failed'), h('span', { class: 's-failed' }, 'release blocked'))),
        h('p', { class: 'small mute' }, 'These are the actual gate rules the server enforces. There is no manual override.'))),
    h('section', { class: 'stack', style: { 'padding-bottom': '80px' } },
      h('div', { class: 'steps' },
        ...[['01 · DEFINE', 'Write requirements in plain language', 'They are split into atomic acceptance criteria with stable IDs (AC-001…), categorised as functional, visual or data-persistence.'],
          ['02 · EXECUTE', 'Kane CLI drives a real browser', 'One kane-cli run per criterion in agent mode. NDJSON events stream live; exit code, stdout, stderr and evidence files are persisted.'],
          ['03 · REPAIR', 'Failures become repair tasks', 'Expected vs. observed, the failing step and evidence, packaged for a developer or coding agent. Criteria can’t be weakened while they fail.'],
          ['04 · GATE', 'Re-run, then sign', 'A claimed fix triggers a new Kane run. Failed and passing runs are both kept, and the shareable report shows the full trail.']]
          .map(([n, t, d]) => h('div', {}, h('b', {}, n), h('h2', {}, t), h('p', { class: 'mute small' }, d))))));
}

// ---------- auth ----------
function Auth(mode) {
  const err = h('div', { class: 'err', role: 'alert' });
  const f = { name: h('input', { name: 'name', autocomplete: 'name', required: true }), email: h('input', { name: 'email', type: 'email', autocomplete: 'email', required: true }),
    password: h('input', { name: 'password', type: 'password', minLength: 8, required: true, autocomplete: mode === 'signup' ? 'new-password' : 'current-password' }) };
  const submit = async (e) => {
    e.preventDefault(); err.textContent = '';
    try {
      const body = { email: f.email.value, password: f.password.value, ...(mode === 'signup' ? { name: f.name.value } : {}) };
      me = (await api('POST', `/auth/${mode}`, body)).user;
      system = await api('GET', '/system');
      location.hash = '#/app';
    } catch (ex) { err.textContent = ex.message; }
  };
  return shell(h('div', { class: 'auth stack' },
    h('h1', {}, mode === 'signup' ? 'Create your workspace' : 'Sign in'),
    h('form', { class: 'panel stack', onsubmit: submit },
      mode === 'signup' ? h('label', {}, 'Name', f.name) : null,
      h('label', {}, 'Email', f.email), h('label', {}, mode === 'signup' ? 'Password (8+ characters)' : 'Password', f.password),
      err, h('button', { class: 'btn primary', type: 'submit' }, mode === 'signup' ? 'Create account' : 'Sign in')),
    h('p', { class: 'small mute' }, mode === 'signup' ? ['Already have an account? ', h('a', { href: '#/login' }, 'Sign in')] : ['New here? ', h('a', { href: '#/signup' }, 'Create an account')])));
}

// ---------- dashboard ----------
async function Dashboard() {
  const { projects, recentRuns, metrics: m } = await api('GET', '/projects');
  const live = recentRuns.some((r) => ['queued', 'running'].includes(r.status));
  if (live) { const t = setTimeout(render, 3000); cleanup.push(() => clearTimeout(t)); }
  const totals = projects.reduce((a, p) => { for (const k of ['total', 'verified', 'failed', 'blocked', 'untested']) a[k] += p.gate.totals[k]; return a; }, { total: 0, verified: 0, failed: 0, blocked: 0, untested: 0 });
  return shell(h('div', { class: 'page stack-l' },
    h('div', { class: 'row spread' }, h('div', { class: 'stack-s' }, h('h3', {}, `${me.name}’s workspace`), h('h1', {}, 'Verification projects')),
      h('a', { class: 'btn primary', href: '#/new' }, 'New verification project')),
    engineCallout(),
    projects.length ? h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('b', {}, `${m.releaseReady}/${m.projects}`), h('span', {}, 'Projects release-verified')),
      h('div', { class: 'stat' }, h('b', {}, totals.total), h('span', {}, 'Criteria')),
      h('div', { class: 'stat' }, h('b', { class: 's-verified' }, totals.verified), h('span', {}, 'Verified')),
      h('div', { class: 'stat' }, h('b', { class: totals.failed ? 's-failed' : '' }, totals.failed), h('span', {}, 'Failed')),
      h('div', { class: 'stat' }, h('b', {}, totals.untested + totals.blocked), h('span', {}, 'Without evidence')),
      h('div', { class: 'stat' }, h('b', {}, m.completedRuns), h('span', {}, `Completed runs of ${m.runs}`)),
      h('div', { class: 'stat', title: `${m.executions.passed} passed, ${m.executions.failed} failed, ${m.executions.noVerdict} without a verdict` },
        h('b', {}, m.passRate == null ? '—' : `${Math.round(m.passRate * 100)}%`), h('span', {}, m.passRate == null ? 'Pass rate · no verdicts yet' : `Pass rate · ${m.executions.passed + m.executions.failed} verdicts`))) : null,
    projects.length ? h('div', { class: 'grid2' }, projects.map((p) => h('a', { class: 'panel stack', href: `#/p/${p.id}`, style: { 'text-decoration': 'none' } },
      h('div', { class: 'row spread' }, h('h2', {}, p.name), tag(p.gate.verdict === 'blocked' ? 'failed' : p.gate.verdict)),
      h('div', { class: 'mono mute' }, p.appUrl),
      segBar(p.gate.totals, ['verified', 'failed', 'blocked', 'untested']),
      h('div', { class: 'row spread small mute' },
        h('span', {}, `${p.gate.totals.verified}/${p.gate.totals.total} verified`, p.gate.totals.failed ? ` · ${p.gate.totals.failed} failed` : ''),
        h('span', {}, p.lastRun ? `last run ${ago(p.lastRun.createdAt)}` : 'never run')))))
      : h('div', { class: 'panel empty stack' }, h('h2', {}, 'No projects yet'),
        h('p', {}, 'Register an application URL, describe what it must do, and let Kane CLI prove it.'),
        h('div', {}, h('a', { class: 'btn primary', href: '#/new' }, 'Create your first project'))),
    recentRuns.length ? h('section', { class: 'stack' }, h('h3', {}, 'Recent verification runs'), runsTable(recentRuns, true)) : null));
}
function runsTable(runs, withProject) {
  const max = Math.max(1, ...runs.map((r) => r.durationMs || 0));
  return h('div', { class: 'panel flush scroll' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Run'), withProject ? h('th', {}, 'Project') : null, h('th', {}, 'Trigger'), h('th', {}, 'Status'), h('th', {}, 'Results'), h('th', {}, 'Duration'), h('th', {}, 'Started'))),
    h('tbody', {}, runs.map((r) => h('tr', { class: 'click', tabIndex: 0, onclick: () => (location.hash = `#/run/${r.id}`), onkeydown: (e) => e.key === 'Enter' && (location.hash = `#/run/${r.id}`) },
      h('td', { class: 'key' }, `#${r.id}`), withProject ? h('td', {}, r.projectName) : null,
      h('td', { class: 'small' }, TRIGGER[r.trigger] || r.trigger, r.parentRunId ? h('span', { class: 'mute' }, ` ← #${r.parentRunId}`) : null),
      h('td', {}, tag(r.status)),
      h('td', { style: { 'min-width': '170px' } }, h('div', { class: 'stack-s' }, segBar(r.counts, ['passed', 'failed', 'error', 'timeout', 'running', 'queued', 'cancelled']),
        h('span', { class: 'small mute mono' }, `${r.counts.passed || 0} passed · ${r.counts.failed || 0} failed · ${(r.counts.error || 0) + (r.counts.timeout || 0)} errors`))),
      h('td', { style: { 'min-width': '120px' } }, h('div', { class: 'stack-s' }, h('span', { class: 'num' }, fmtDur(r.durationMs)),
        h('div', { class: 'bar' }, h('i', { class: 'bg-untested', style: { width: `${((r.durationMs || 0) / max) * 100}%` } })))),
      h('td', { class: 'small mute' }, fmtTime(r.startedAt || r.createdAt)))))));
}

// ---------- new project ----------
async function NewProject() {
  const name = h('input', { required: true, maxLength: 100, placeholder: 'Checkout release v2' });
  const url = h('input', { required: true, type: 'url', placeholder: 'https://staging.example.com' });
  const ctx = h('textarea', { placeholder: 'Optional. Standing instructions for every check — e.g. which test account to use. Never put real credentials here.', style: { 'min-height': '70px' } });
  const req = h('textarea', { placeholder: 'One requirement per line, in plain language.\n\nA visitor can register, log in and add a product to the cart.\nApplying coupon SAVE10 reduces the order total by 10%.', style: { 'min-height': '170px' } });
  const preview = h('div', { class: 'stack-s' });
  const err = h('div', { class: 'err', role: 'alert' });
  let t;
  const refresh = () => { clearTimeout(t); t = setTimeout(async () => {
    preview.replaceChildren();
    if (!req.value.trim()) return;
    try {
      const { criteria } = await api('POST', '/decompose', { text: req.value });
      preview.append(h('h3', {}, `${criteria.length} acceptance criteria will be created`),
        ...criteria.map((c, i) => h('div', { class: 'row small' }, h('span', { class: 'key mute' }, `AC-${String(i + 1).padStart(3, '0')}`), h('span', { class: 'cat' }, c.category), h('span', { class: 'grow' }, c.text))));
    } catch {}
  }, 350); };
  req.addEventListener('input', refresh);
  const demo = act(async () => {
    const d = await api('GET', '/demo-template');
    name.value = d.name; url.value = d.appUrl; ctx.value = d.context; req.value = d.requirements; refresh();
    toast(d.reachable ? 'Demo scenario loaded — the demo store is reachable.' : `Demo scenario loaded, but ${d.appUrl} is not reachable. Start it with: npm run demo:app`, !d.reachable);
  });
  const submit = async (e) => {
    e.preventDefault(); err.textContent = '';
    try {
      const { project } = await api('POST', '/projects', { name: name.value, appUrl: url.value, context: ctx.value });
      if (req.value.trim()) await api('POST', `/projects/${project.id}/requirements`, { text: req.value });
      location.hash = `#/p/${project.id}`;
    } catch (ex) { err.textContent = ex.message; }
  };
  return shell(h('div', { class: 'page stack-l', style: { 'max-width': '760px' } },
    h('div', { class: 'row spread' }, h('div', { class: 'stack-s' }, h('h3', {}, 'New verification project'), h('h1', {}, 'What should be true before this ships?')),
      h('button', { class: 'btn', type: 'button', onclick: demo }, 'Load demo scenario')),
    h('form', { class: 'panel stack', onsubmit: submit },
      h('label', {}, 'Project name', name), h('label', {}, 'Application URL (live, reachable from this server)', url),
      h('label', {}, 'Requirements', req), preview, h('label', {}, 'Test context', ctx),
      err, h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Create project'), h('a', { class: 'btn', href: '#/app' }, 'Cancel')))));
}

// ---------- project ----------
async function Project(id, tab = 'requirements', sub) {
  const d = await api('GET', `/projects/${id}`);
  const { project: p, criteria, runs, repairTasks } = d;
  const g = p.gate, t = g.totals;
  const activeRun = runs.find((r) => ['queued', 'running'].includes(r.status));
  if (activeRun) { const tm = setTimeout(render, 2500); cleanup.push(() => clearTimeout(tm)); }
  const openTasks = repairTasks.filter((x) => x.status !== 'verified');
  const blocked = criteria.filter((c) => c.status === 'blocked');
  const start = (body, msg) => act(async () => {
    try { const { run } = await api('POST', `/projects/${id}/runs`, body); toast(msg); location.hash = `#/run/${run.id}`; }
    catch (e) { if (e.data?.activeRunId) { toast(e.message, true); location.hash = `#/run/${e.data.activeRunId}`; } else throw e; }
  });
  const tabs = [['requirements', 'Requirements', criteria.length], ['failures', 'Failure analysis', openTasks.length + blocked.length, true], ['history', 'History', d.runCount],
    ['proof', 'Proof explorer'], ['builds', 'Builds & impact'], ['intelligence', 'Release intelligence', g.reasons.length, true], ['ci', 'CI'], ['dossier', 'Dossier'], ['report', 'Release report'], ['settings', 'Settings']];
  const body = { requirements: () => RequirementsTab(d), failures: () => FailuresTab(d, start), history: () => HistoryTab(d), report: () => ReportTab(d), settings: () => SettingsTab(d),
    proof: () => ProofTab(d, sub), builds: () => BuildsTab(d, sub), intelligence: () => IntelligenceTab(d), ci: () => CITab(d), dossier: () => DossierTab(d, sub) }[tab] || (() => RequirementsTab(d));
  return shell(h('div', { class: 'page stack-l' },
    h('div', { class: 'row spread', style: { 'align-items': 'flex-start' } },
      h('div', { class: 'stack-s grow' }, h('h3', {}, h('a', { href: '#/app', style: { 'text-decoration': 'none' } }, '← Projects')), h('h1', {}, p.name),
        h('div', { class: 'row small' }, h('a', { class: 'mono mute', href: p.appUrl, target: '_blank', rel: 'noopener' }, p.appUrl),
          g.build ? h('a', { class: 'cat', href: `#/p/${id}/builds/${g.build.id}`, title: 'Current build' }, `build ${g.build.shortSha} · ${g.build.environment}`) : h('a', { class: 'cat', href: `#/p/${id}/builds` }, 'no build registered'),
          h('a', { class: 'cat', href: `#/p/${id}/intelligence` }, `policy v${g.policyVersion}`))),
      stamp(g.verdict)),
    engineCallout(),
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('b', {}, t.total), h('span', {}, 'Requirements')),
      h('div', { class: 'stat' }, h('b', { class: 's-verified' }, t.verified), h('span', {}, 'Verified')),
      h('div', { class: 'stat' }, h('b', { class: t.failed ? 's-failed' : '' }, t.failed), h('span', {}, 'Failed')),
      h('div', { class: 'stat' }, h('b', { class: t.blocked ? 's-blocked' : '' }, t.blocked), h('span', {}, 'No evidence')),
      h('div', { class: 'stat' }, h('b', {}, t.untested), h('span', {}, 'Not tested')),
      h('a', { class: 'stat', href: `#/p/${id}/intelligence`, style: { 'text-decoration': 'none' } }, h('b', { class: g.freshness.STALE ? 's-blocked' : '' }, g.freshness.STALE), h('span', {}, 'Stale evidence')),
      h('div', { class: 'stat' }, p.lastRun ? [h('div', {}, tag(p.lastRun.status)), h('span', {}, `Latest run · ${fmtDur(p.lastRun.durationMs)}`)] : [h('b', { class: 'mute' }, '—'), h('span', {}, 'Latest run')])),
    h('div', { class: 'row' },
      activeRun ? h('a', { class: 'btn primary', href: `#/run/${activeRun.id}` }, h('i', { class: 'dot live' }), `Watch run #${activeRun.id}`)
        : h('button', { class: 'btn primary', disabled: !criteria.length, onclick: start({}, 'Verification queued') }, 'Run full verification'),
      !activeRun && (t.failed + t.blocked) ? h('button', { class: 'btn', onclick: start({ mode: 'failed' }, 'Re-run queued') }, `Re-run ${t.failed + t.blocked} failed / unproven`) : null,
      !activeRun && t.untested && t.untested < t.total ? h('button', { class: 'btn', onclick: start({ mode: 'untested' }, 'Run queued') }, `Run ${t.untested} untested`) : null,
      g.reasons.length ? h('a', { class: 'small mute grow', href: `#/p/${id}/intelligence` }, g.reasons[0], g.reasons.length > 1 ? ` (+${g.reasons.length - 1} more)` : '') : h('span', { class: 'small s-verified' }, 'Every mandatory criterion has a passing execution with evidence.')),
    h('div', { class: 'stack' },
      h('nav', { class: 'tabs' }, tabs.map(([k, label, n, warn]) => h('a', { href: `#/p/${id}/${k}`, class: tab === k ? 'on' : '' }, label, n != null ? h('span', { class: `count${warn && n ? ' bad' : ''}` }, n) : null))),
      await body())));
}

function RequirementsTab({ project: p, criteria, runs }) {
  const pid = p.id;
  const ta = h('textarea', { placeholder: 'Describe one or more requirements in plain language. Each line or sentence becomes its own acceptance criterion.' });
  const add = act(async () => { await api('POST', `/projects/${pid}/requirements`, { text: ta.value }); toast('Criteria added'); render(); });
  const edit = (c) => act(async () => {
    const text = await dialog({ title: `Edit ${c.key}`, body: 'Changing the text discards its current evidence — it will be “not tested” until Kane CLI runs it again.', value: c.text, confirm: 'Save criterion' });
    if (text == null || text.trim() === c.text) return;
    await api('PATCH', `/projects/${pid}/criteria/${c.id}`, { text }); render();
  });
  const patch = (c, body) => act(async () => { await api('PATCH', `/projects/${pid}/criteria/${c.id}`, body); render(); });
  const recent = runs.filter((r) => !['queued'].includes(r.status)).slice(0, 8).reverse();
  return h('div', { class: 'stack-l' },
    criteria.length ? h('div', { class: 'panel flush scroll' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'ID'), h('th', {}, 'Acceptance criterion'), h('th', {}, 'Type'), h('th', {}, 'Status'), h('th', {}, 'Evidence'), h('th', {}, ''))),
      h('tbody', {}, criteria.map((c) => h('tr', {},
        h('td', { class: 'key' }, c.key),
        h('td', {}, h('div', { class: 'stack-s' }, h('span', {}, c.text),
          c.latest && c.status !== 'verified' ? h('span', { class: 'small mute' }, c.latest.failing_step?.remark || c.latest.reason || c.latest.summary || '') : null,
          h('div', { class: 'row small' }, h('a', { class: 'cat', href: `#/p/${pid}/proof/${c.id}`, title: 'Open in Proof explorer' }, c.version ? `v${c.version.number}` : 'v?', ' · trace'), h('span', { class: 'cat' }, c.criticality),
            c.areas.map((a) => h('span', { class: 'cat' }, a)), h('span', { class: 'cat', title: c.paths.join('\n') }, c.paths.length ? `${c.paths.length} path pattern${c.paths.length === 1 ? '' : 's'}` : 'unmapped')),
          h('label', { class: 'row small', style: { 'text-transform': 'none', 'letter-spacing': '0', 'font-family': 'var(--sans)' } },
            h('input', { type: 'checkbox', checked: c.mandatory, onchange: patch(c, { mandatory: !c.mandatory }) }), 'Mandatory for release'))),
        h('td', {}, h('select', { 'aria-label': `Type of ${c.key}`, onchange: (e) => patch(c, { category: e.target.value })(e) },
          ['functional', 'visual', 'persistence'].map((k) => h('option', { value: k, selected: c.category === k }, k)))),
        h('td', {}, c.freshness.state === 'STALE' ? tag('blocked', 'Stale') : c.freshness.state === 'BLOCKED' && c.status === 'verified' ? tag('blocked', 'Not accepted') : tag(c.status),
          c.freshness.state === 'STALE' ? h('div', { class: 'small mute', style: { 'max-width': '220px' } }, c.freshness.reasons[0].message) : null),
        h('td', { class: 'small' }, c.latest ? h('a', { href: `#/run/${c.latest.run_id}/${c.latest.id}` }, `run #${c.latest.run_id}`, c.evidenceCount ? ` · ${c.evidenceCount} file${c.evidenceCount === 1 ? '' : 's'}` : '') : h('span', { class: 'mute' }, 'none'),
          h('div', { class: 'mute' }, c.attempts ? `${c.attempts} execution${c.attempts === 1 ? '' : 's'}` : '')),
        h('td', {}, h('div', { class: 'row', style: { 'flex-wrap': 'nowrap' } },
          h('button', { class: 'btn sm', title: `Run ${c.key} now`, onclick: act(async () => { try { const { run } = await api('POST', `/projects/${pid}/runs`, { criterionIds: [c.id] }); location.hash = `#/run/${run.id}`; } catch (e) { if (e.data?.activeRunId) location.hash = `#/run/${e.data.activeRunId}`; throw e; } }) }, 'Run'),
          h('button', { class: 'btn sm', onclick: edit(c) }, 'Edit'),
          h('button', { class: 'btn sm', title: 'Criticality, functional areas and source-path mapping', onclick: act(async () => {
            const v = await dialog({ title: `Coverage of ${c.key}`, confirm: 'Save coverage', body: 'Used by change-impact analysis. Without a source mapping, every change is treated as potentially affecting this criterion. Saving creates a new criterion version.',
              fields: [{ name: 'criticality', label: 'Criticality', value: c.criticality, options: ['low', 'medium', 'high', 'critical'] }, { name: 'areas', label: 'Functional areas (comma separated)', value: c.areas.join(', '), placeholder: 'checkout, pricing' },
                { name: 'paths', label: 'Source file patterns (one per line; ** * ? supported)', value: c.paths.join('\n'), multiline: true, placeholder: 'src/cart/**\nsrc/pricing/*.js' }] });
            if (!v) return;
            await api('PATCH', `/projects/${pid}/criteria/${c.id}`, { criticality: v.criticality, areas: v.areas.split(',').map((x) => x.trim()).filter(Boolean), paths: v.paths.split('\n').map((x) => x.trim()).filter(Boolean) });
            toast('Coverage saved as a new version'); render();
          }) }, 'Coverage'),
          h('button', { class: 'btn sm danger', onclick: act(async () => { if (await dialog({ title: `Archive ${c.key}?`, body: 'It leaves the release gate. Its execution history is kept.', confirm: 'Archive', danger: true })) { await api('DELETE', `/projects/${pid}/criteria/${c.id}`); render(); } }) }, 'Archive'))))))))
      : h('div', { class: 'panel empty' }, 'No acceptance criteria yet. Add requirements below.'),
    h('div', { class: 'panel stack' }, h('h3', {}, 'Add requirements'), ta,
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: add }, 'Break into criteria & add'),
        h('span', { class: 'small mute' }, 'IDs are stable and never reused. A criterion with an open failure can’t be reworded, made optional or archived.'))),
    criteria.length && recent.length ? h('section', { class: 'stack' }, h('h3', {}, 'Evidence matrix — criteria × recent runs'), Matrix(pid, criteria, recent)) : null);
}
function Matrix(pid, criteria, runs) {
  const holder = h('div', { class: 'panel flush scroll' }, h('div', { class: 'empty small' }, 'Loading run results…'));
  Promise.all(runs.map((r) => api('GET', `/runs/${r.id}`))).then((details) => {
    const byRun = details.map((d) => Object.fromEntries(d.results.map((x) => [x.criterionId, x])));
    holder.replaceChildren(h('table', { class: 'matrix' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Criterion'), runs.map((r) => h('th', {}, h('a', { href: `#/run/${r.id}` }, `#${r.id}`))))),
      h('tbody', {}, criteria.map((c) => h('tr', {}, h('td', {}, h('span', { class: 'key' }, c.key), ' ', h('span', { class: 'small mute' }, c.text.length > 70 ? c.text.slice(0, 70) + '…' : c.text)),
        byRun.map((m, i) => { const x = m[c.id]; return h('td', {}, x ? h('a', { class: `cell on bg-${x.status}`, href: `#/run/${runs[i].id}/${x.id}`, title: `${c.key} in run #${runs[i].id}: ${(x.status === 'error' && KIND[x.errorKind]) || LABEL[x.status] || x.status}`, 'aria-label': `${c.key} run ${runs[i].id} ${x.status}` }) : h('span', { class: 'cell', title: 'not part of this run' })); }))))));
  }).catch((e) => holder.replaceChildren(h('div', { class: 'empty small' }, e.message)));
  return holder;
}

function FailuresTab({ project: p, criteria, repairTasks }, start) {
  const open = repairTasks.filter((t) => t.status !== 'verified'), closed = repairTasks.filter((t) => t.status === 'verified');
  const blocked = criteria.filter((c) => c.status === 'blocked');
  const card = (t) => {
    const note = h('input', { placeholder: 'What was changed? (commit, PR, short note)', maxLength: 1000 });
    const shots = t.evidence.filter((e) => e.kind === 'screenshot').slice(-6);
    return h('article', { class: 'panel stack' },
      h('div', { class: 'row spread' }, h('div', { class: 'row' }, h('span', { class: 'key' }, `RT-${t.id}`), h('span', { class: 'key mute' }, t.criterionKey),
        tag(t.status === 'verified' ? 'verified' : t.status === 'fix_applied' ? 'running' : 'failed'),
        t.failures > 1 ? h('span', { class: 'small mute' }, `failed ${t.failures}×`) : null),
        h('a', { class: 'btn sm', href: `#/run/${t.sourceResult.run_id}/${t.sourceResult.id}` }, `Evidence · run #${t.sourceResult.run_id}`)),
      h('p', {}, t.criterionText),
      h('div', { class: 'versus' },
        h('div', { class: 'exp' }, h('h3', {}, 'Expected'), h('p', { class: 'small' }, t.expected)),
        h('div', { class: 'obs' }, h('h3', {}, 'Observed in execution'), h('p', { class: 'small', style: { 'white-space': 'pre-wrap' } }, t.observed))),
      h('p', { class: 'small mute' }, t.diagnosis),
      h('ol', { class: 'chain' }, t.timeline.map((e) => h('li', {}, h('time', {}, fmtTime(e.ts)),
        h('span', {}, { 'repair_task.opened': 'Failure recorded', 'repair_task.failed_again': 'Re-verification failed', 'repair_task.fix_declared': `Fix declared by ${e.actor}`, 'repair_task.verified': 'Verified by passing run' }[e.action] || e.action,
          ' — ', h('a', { href: `#/run/${e.detail.runId ?? e.detail.verifyRunId}` }, `run #${e.detail.runId ?? e.detail.verifyRunId}`), e.detail.note ? h('span', { class: 'mute' }, ` · “${e.detail.note}”`) : null)))),
      shots.length ? h('div', { class: 'shots' }, shots.map((e) => h('a', { href: `/api/evidence/${e.id}/file`, target: '_blank', rel: 'noopener' }, h('img', { src: `/api/evidence/${e.id}/file`, alt: `Screenshot ${e.name}`, loading: 'lazy' })))) : null,
      t.status === 'verified'
        ? h('div', { class: 'callout ok' }, `Verified by passing run `, h('a', { href: `#/run/${t.verifiedBy.run_id}/${t.verifiedBy.id}` }, `#${t.verifiedBy.run_id}`), ` on ${fmtTime(t.verifiedBy.finished_at)}.`, t.fixNote ? ` Fix note: ${t.fixNote}` : '')
        : h('div', { class: 'stack' },
          h('details', {}, h('summary', { class: 'small' }, 'Repair task for your coding agent'), h('pre', { style: { 'margin-top': '10px' } }, t.prompt)),
          h('div', { class: 'row' }, h('button', { class: 'btn', onclick: act(() => copy(t.prompt, 'Repair task')) }, 'Copy repair task'),
            h('div', { class: 'grow', style: { 'min-width': '200px' } }, note),
            h('button', { class: 'btn primary', onclick: act(async () => { const { run } = await api('POST', `/repair-tasks/${t.id}/fix-applied`, { note: note.value }); toast('Fix recorded — Kane CLI is re-verifying'); location.hash = `#/run/${run.id}`; }) }, 'Fix applied → re-verify')),
          h('p', { class: 'small mute' }, 'Marking a fix does not close this task. Only a passing Kane CLI re-run can.')));
  };
  return h('div', { class: 'stack-l' },
    !open.length && !blocked.length ? h('div', { class: 'panel empty' }, repairTasks.length ? 'No open failures. Every repair task below was closed by a passing verification run.' : 'No failures recorded. Failures appear here only when a Kane CLI run reports one.') : null,
    open.length ? h('section', { class: 'stack' }, h('h3', {}, `Open repair tasks (${open.length})`), open.map(card)) : null,
    blocked.length ? h('section', { class: 'stack' }, h('h3', {}, `Executions without a verdict (${blocked.length})`),
      h('div', { class: 'callout' }, 'These checks did not produce evidence. They are environment or execution problems, not application defects — and they are not passes.'),
      h('div', { class: 'panel flush scroll' }, h('table', {}, h('tbody', {}, blocked.map((c) => h('tr', {}, h('td', { class: 'key' }, c.key), h('td', {}, h('div', { class: 'stack-s' }, c.text, h('span', { class: 'small s-blocked' }, c.latest.reason || ''))),
        h('td', {}, tag(c.latest.status, c.latest.status === 'error' ? KIND[c.latest.error_kind] : null)), h('td', {}, h('a', { class: 'btn sm', href: `#/run/${c.latest.run_id}/${c.latest.id}` }, 'Logs'))))))),
      h('div', {}, h('button', { class: 'btn', onclick: start({ mode: 'failed' }, 'Re-run queued') }, 'Re-run these checks'))) : null,
    closed.length ? h('section', { class: 'stack' }, h('h3', {}, `Resolved (${closed.length})`), closed.map(card)) : null);
}

function HistoryTab({ project: p }) {
  // Server-side pagination and filtering; nothing is held client-side beyond the pages already loaded.
  let status = '', runs = [], next = null, total = 0;
  const body = h('div', {}, h('div', { class: 'panel empty small' }, 'Loading history…'));
  const more = h('div', {});
  const sel = h('select', { 'aria-label': 'Filter by run status', onchange: () => { status = sel.value; runs = []; load(null); } },
    [['', 'All statuses'], ['completed', 'Completed'], ['running', 'Running'], ['queued', 'Queued'], ['cancelled', 'Cancelled'], ['interrupted', 'Interrupted']].map(([v, l]) => h('option', { value: v }, l)));
  const count = h('span', { class: 'small mute' });
  async function load(before) {
    try {
      const d = await api('GET', `/projects/${p.id}/runs?limit=10${status ? `&status=${status}` : ''}${before ? `&before=${before}` : ''}`);
      runs = runs.concat(d.runs); next = d.nextBefore; total = d.total;
      count.textContent = `${runs.length} of ${total} run${total === 1 ? '' : 's'}`;
      body.replaceChildren(runs.length ? runsTable(runs, false) : h('div', { class: 'panel empty' }, status ? `No ${status} runs.` : 'No verification runs yet.'));
      more.replaceChildren(next ? h('button', { class: 'btn', onclick: act(() => load(next)) }, 'Load older runs') : '');
    } catch (e) { body.replaceChildren(h('div', { class: 'panel empty stack' }, h('p', {}, `Could not load history: ${e.message}`), h('div', {}, h('button', { class: 'btn', onclick: () => load(before) }, 'Retry')))); }
  }
  load(null);
  return h('div', { class: 'stack' }, h('div', { class: 'row spread' }, sel, count), body, more);
}

async function ReportTab({ project: p }) {
  const pid = p.id;
  const { report } = await api('GET', `/projects/${pid}/report`);
  const linkOut = h('div', {});
  const days = h('select', { 'aria-label': 'Link expiry' }, [['', 'No expiry'], ['1', 'Expires in 1 day'], ['7', 'Expires in 7 days'], ['30', 'Expires in 30 days']].map(([v, l]) => h('option', { value: v, selected: v === '7' }, l)));
  const create = act(async () => {
    if (p.share.active && !(await dialog({ title: 'Replace the current link?', body: 'The existing public link stops working immediately.', confirm: 'Create new link', danger: true }))) return;
    const r = await api('POST', `/projects/${pid}/share`, days.value ? { expiresInDays: Number(days.value) } : {});
    p.share = { active: true, createdAt: new Date().toISOString(), expiresAt: r.expiresAt };
    linkOut.replaceChildren(h('div', { class: 'callout ok stack-s' }, h('b', {}, 'Copy this link now — only its hash is stored, so it cannot be shown again.'),
      h('a', { class: 'mono', id: 'share-link', href: r.url, target: '_blank', rel: 'noopener' }, r.url), h('div', {}, h('button', { class: 'btn sm', onclick: act(() => copy(r.url, 'Report link')) }, 'Copy link'))));
    status();
  });
  const state = h('div', { class: 'stack-s grow' });
  const actions = h('div', { class: 'row' });
  const status = () => {
    state.replaceChildren(h('h3', {}, 'Public report link'), h('p', { class: 'small mute' }, p.share.active ? `Active since ${fmtTime(p.share.createdAt)} · ${p.share.expiresAt ? `expires ${fmtTime(p.share.expiresAt)}` : 'no expiry'}. It always shows live gate status.`
      : p.share.expired ? 'The last link has expired.' : 'No public link. A link is read-only and always shows live gate status, never a snapshot.'));
    actions.replaceChildren(days, h('button', { class: 'btn primary', onclick: create }, p.share.active ? 'Replace link' : 'Create shareable link'),
      p.share.active ? h('button', { class: 'btn danger', onclick: act(async () => { await api('DELETE', `/projects/${pid}/share`); toast('Link revoked'); render(); }) }, 'Revoke') : '',
      h('button', { class: 'btn', onclick: () => window.print() }, 'Print / PDF'),
      h('button', { class: 'btn', onclick: () => { const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })), download: `shipproof-report-${pid}.json` }); a.click(); } }, 'Download JSON'));
  };
  status();
  return h('div', { class: 'stack-l' }, h('div', { class: 'panel stack noprint' }, h('div', { class: 'row spread' }, state, actions), linkOut),
    ReportBody(report, (id) => `/api/evidence/${id}/file`, true));
}
function ReportBody(r, evUrl, internal) {
  const t = r.gate.totals;
  const trail = (c) => h('span', { class: 'trail', title: c.trail.map((x) => `run #${x.runId}: ${x.status}`).join(' → ') || 'never executed' },
    c.trail.slice(-10).map((x) => h('i', { class: `bg-${x.status}` })), c.trail.length ? h('span', { class: 'small mute mono' }, ` ${c.trail.length}×`) : null);
  return h('div', { class: 'stack-l' },
    h('div', { class: 'panel stack' },
      h('div', { class: 'row spread', style: { 'align-items': 'flex-start' } },
        h('div', { class: 'stack-s' }, h('h3', {}, 'Release verification report'), h('h1', {}, r.project.name), h('div', { class: 'mono mute' }, r.project.appUrl)),
        stamp(r.gate.verdict, true)),
      h('dl', { class: 'kv' }, h('dt', {}, 'Generated'), h('dd', {}, fmtTime(r.generatedAt)), h('dt', {}, 'Engine'), h('dd', {}, r.engine),
        h('dt', {}, 'Mandatory criteria'), h('dd', {}, `${t.mandatoryVerified} of ${t.mandatory} verified by execution`),
        h('dt', {}, 'Runs'), h('dd', {}, `${r.runs.length} recorded`, r.window.firstRunAt ? ` · ${fmtTime(r.window.firstRunAt)} → ${fmtTime(r.window.lastRunAt)}` : '')),
      segBar(t, ['verified', 'failed', 'blocked', 'untested']),
      r.criteria.some((c) => /fixture/i.test(c.engine || '')) ? h('div', { class: 'callout bad' }, h('b', {}, 'Contains test-fixture executions. '), 'One or more results below were produced by a test stand-in engine, not by Kane CLI. This report is not Kane evidence.') : null,
      r.gate.reasons.length ? h('div', { class: `callout ${r.gate.verdict === 'blocked' ? 'bad' : ''}` }, h('b', {}, 'Why this release is not verified'), h('ul', { style: { margin: '6px 0 0', 'padding-left': '18px' } }, r.gate.reasons.map((x) => h('li', {}, x))))
        : h('div', { class: 'callout ok' }, 'Every mandatory acceptance criterion has a passing Kane CLI execution (exit code 0 with a passing run_end event) recorded against its current text.')),
    h('section', { class: 'stack' }, h('h3', {}, 'Acceptance criteria'),
      h('div', { class: 'panel flush scroll' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'ID'), h('th', {}, 'Criterion'), h('th', {}, 'Status'), h('th', {}, 'Execution trail'), h('th', {}, 'Latest evidence'))),
        h('tbody', {}, r.criteria.map((c) => h('tr', {}, h('td', { class: 'key' }, c.key),
          h('td', {}, h('div', { class: 'stack-s' }, c.text, h('div', { class: 'row' }, h('span', { class: 'cat' }, c.category), c.mandatory ? null : h('span', { class: 'cat' }, 'optional')),
            c.latest && c.status !== 'verified' ? h('span', { class: 'small mute' }, c.latest.reason || c.latest.summary || '') : null,
            c.screenshots.length ? h('div', { class: 'shots', style: { 'max-width': '360px' } }, c.screenshots.map((s) => h('a', { href: evUrl(s.id), target: '_blank', rel: 'noopener' }, h('img', { src: evUrl(s.id), alt: `Evidence screenshot for ${c.key}`, loading: 'lazy' })))) : null)),
          h('td', {}, tag(c.status)), h('td', {}, trail(c)),
          h('td', { class: 'small' }, c.latest ? h('div', { class: 'stack-s' },
            internal ? h('a', { href: `#/run/${c.latest.runId}/${c.latest.resultId}` }, `run #${c.latest.runId}`) : `run #${c.latest.runId}`,
            h('span', { class: 'mono mute' }, `exit ${c.latest.exitCode ?? 'n/a'} · ${fmtDur(c.latest.durationMs)}`), c.engine ? h('span', { class: `mono ${/fixture/i.test(c.engine) ? 's-failed' : 'mute'}` }, c.engine) : null, h('span', { class: 'mute' }, fmtTime(c.latest.finishedAt)),
            c.latest.testUrl ? h('a', { href: c.latest.testUrl, target: '_blank', rel: 'noopener' }, 'Kane Test Manager ↗') : null, h('span', { class: 'mute' }, `${c.evidenceCount} evidence item${c.evidenceCount === 1 ? '' : 's'}`)) : h('span', { class: 'mute' }, 'No execution')))))))),
    r.repairs.length ? h('section', { class: 'stack' }, h('h3', {}, 'Failure-to-fix trail'),
      h('div', { class: 'panel flush scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Task'), h('th', {}, 'Criterion'), h('th', {}, 'Observed failure'), h('th', {}, 'Failed in'), h('th', {}, 'Verified in'), h('th', {}, 'State'))),
        h('tbody', {}, r.repairs.map((x) => h('tr', {}, h('td', { class: 'key' }, `RT-${x.id}`), h('td', { class: 'key' }, x.criterionKey),
          h('td', { class: 'small', style: { 'white-space': 'pre-wrap' } }, x.observed, x.fixNote ? h('div', { class: 'mute' }, `Fix: ${x.fixNote}`) : null),
          h('td', { class: 'num' }, `#${x.failedRunId}`), h('td', { class: 'num' }, x.verifiedRunId ? `#${x.verifiedRunId}` : '—'), h('td', {}, tag(x.status === 'verified' ? 'verified' : 'failed')))))))) : null,
    h('section', { class: 'stack' }, h('h3', {}, 'Verification history'),
      r.runs.length ? h('div', { class: 'panel flush scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Run'), h('th', {}, 'Trigger'), h('th', {}, 'Status'), h('th', {}, 'Passed'), h('th', {}, 'Failed'), h('th', {}, 'Errors'), h('th', {}, 'Duration'), h('th', {}, 'Finished'))),
        h('tbody', {}, r.runs.map((x) => h('tr', {}, h('td', { class: 'key' }, `#${x.id}`), h('td', { class: 'small' }, TRIGGER[x.trigger] || x.trigger), h('td', {}, tag(x.status)),
          h('td', { class: 'num' }, x.counts.passed || 0), h('td', { class: 'num' }, x.counts.failed || 0), h('td', { class: 'num' }, (x.counts.error || 0) + (x.counts.timeout || 0)),
          h('td', { class: 'num' }, fmtDur(x.durationMs)), h('td', { class: 'small mute' }, fmtTime(x.finishedAt))))))) : h('div', { class: 'panel empty' }, 'No runs recorded.')),
    h('p', { class: 'small mute' }, 'Statuses in this report are derived from persisted Kane CLI process results. “No evidence” means an execution ended without a verdict (authentication, timeout, did-not-start); it is never counted as a pass.'));
}

function SettingsTab({ project: p, variables }) {
  const pid = p.id;
  const activity = h('div', { class: 'small mute' }, 'Loading activity…');
  api('GET', `/projects/${pid}/audit`).then(({ events }) => activity.replaceChildren(events.length ? h('div', { class: 'scroll' }, h('table', {}, h('tbody', {}, events.map((e) => h('tr', {},
    h('td', { class: 'small mute', style: { 'white-space': 'nowrap' } }, fmtTime(e.ts)), h('td', {}, h('span', { class: 'cat' }, e.actor)), h('td', { class: 'mono small' }, e.action),
    h('td', { class: 'small mute' }, Object.entries(e.detail).filter(([, v]) => v != null && typeof v !== 'object').map(([k, v]) => `${k}: ${v}`).join(' · '))))))) : 'No activity recorded yet.'))
    .catch((e) => activity.replaceChildren(`Could not load activity: ${e.message}`));
  const name = h('input', { value: p.name }), url = h('input', { value: p.appUrl, type: 'url' }), ctx = h('textarea', { value: p.context, style: { 'min-height': '80px' } });
  const vk = h('input', { placeholder: 'name, e.g. password' }), vv = h('input', { placeholder: 'value' }), vs = h('input', { type: 'checkbox', checked: true });
  const keyOut = h('div', {});
  return h('div', { class: 'stack-l', style: { 'max-width': '760px' } },
    h('div', { class: 'panel stack' }, h('h3', {}, 'Application under test'), h('label', {}, 'Project name', name), h('label', {}, 'Application URL', url), h('label', {}, 'Test context (sent to Kane with every check)', ctx),
      h('div', {}, h('button', { class: 'btn primary', onclick: act(async () => { await api('PATCH', `/projects/${pid}`, { name: name.value, appUrl: url.value, context: ctx.value }); toast('Saved'); render(); }) }, 'Save changes'))),
    h('div', { class: 'panel stack' }, h('h3', {}, 'Test variables'),
      h('p', { class: 'small mute' }, 'Reference as {{name}} in criteria. Passed to Kane CLI in a temporary variables file. Secret values are write-only and redacted from logs. Test accounts only.'),
      variables.length ? h('table', {}, h('tbody', {}, variables.map((v) => h('tr', {}, h('td', { class: 'key' }, `{{${v.key}}}`), h('td', { class: 'mono' }, v.secret ? '•••••••• (secret)' : v.value),
        h('td', {}, h('button', { class: 'btn sm danger', onclick: act(async () => { await api('DELETE', `/projects/${pid}/variables/${v.key}`); render(); }) }, 'Remove')))))) : null,
      h('div', { class: 'row' }, h('div', { class: 'grow' }, vk), h('div', { class: 'grow' }, vv), h('label', { class: 'row', style: { 'text-transform': 'none' } }, vs, 'secret'),
        h('button', { class: 'btn', onclick: act(async () => { await api('PUT', `/projects/${pid}/variables/${encodeURIComponent(vk.value.trim())}`, { value: vv.value, secret: vs.checked }); render(); }) }, 'Add variable'))),
    h('div', { class: 'panel stack' }, h('h3', {}, 'Coding-agent access'),
      h('p', { class: 'small mute' }, 'A project API key lets a coding agent pull open repair tasks, report a fix (which triggers a Kane re-run) and read the gate.'),
      h('pre', {}, `GET  /api/agent/repair-tasks\nPOST /api/agent/repair-tasks/:id/fix-applied   {"note":"…"}\nPOST /api/agent/runs                            {"mode":"failed"}\nGET  /api/agent/gate\nAuthorization: Bearer <project key>`),
      keyOut,
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: act(async () => { const { apiKey } = await api('POST', `/projects/${pid}/api-key`, {}); keyOut.replaceChildren(h('div', { class: 'callout ok stack-s' }, h('b', {}, 'Copy this key now — it is not shown again.'), h('code', { class: 'mono' }, apiKey), h('div', {}, h('button', { class: 'btn sm', onclick: act(() => copy(apiKey, 'API key')) }, 'Copy')))); }) }, p.hasApiKey ? 'Rotate API key' : 'Generate API key'),
        p.hasApiKey ? h('button', { class: 'btn danger', onclick: act(async () => { await api('DELETE', `/projects/${pid}/api-key`); toast('Key revoked'); render(); }) }, 'Revoke key') : null)),
    h('div', { class: 'panel stack' }, h('h3', {}, 'Activity log'), h('p', { class: 'small mute' }, 'Append-only record of sensitive actions by users, coding agents and the engine (latest 100).'), activity),
    h('div', { class: 'panel stack' }, h('h3', {}, 'Danger zone'),
      h('div', {}, h('button', { class: 'btn danger', onclick: act(async () => { if (await dialog({ title: `Delete “${p.name}”?`, body: 'All of its criteria, runs, evidence records and repair tasks are deleted. This cannot be undone.', confirm: 'Delete project', danger: true })) { await api('DELETE', `/projects/${pid}`); toast('Project deleted'); location.hash = '#/app'; } }) }, 'Delete project'))));
}

// ---------- live execution + evidence explorer ----------
async function RunPage(runId, selectedId) {
  let data = await api('GET', `/runs/${runId}`);
  let selected = Number(selectedId) || data.results.find((r) => ['starting', 'running'].includes(r.status))?.id || data.results.find((r) => ['failed', 'error', 'timeout'].includes(r.status))?.id || data.results[0]?.id;
  let follow = !selectedId;
  const events = [], seen = new Set();
  let lastId = 0;
  const conn = h('span', { class: 'small mute' }, 'connecting…');
  const head = h('div', {}), list = h('div', { class: 'panel flush exec-list' }), detail = h('div', { class: 'stack' }), log = h('div', { class: 'log', role: 'log', 'aria-label': 'Live Kane CLI output' });
  const full = new Map();
  const line = (e) => {
    const p = e.payload; let cls = 'l-kane', text;
    if (e.kind === 'system') { cls = `l-${p.level === 'ok' ? 'ok' : p.level === 'error' ? 'error' : 'info'}`; text = p.message; }
    else if (e.kind === 'stderr') { cls = 'l-stderr'; text = `stderr  ${p.text.trim()}`; }
    else if (p.type === 'run_end') { cls = /pass/i.test(p.status) ? 'l-ok' : 'l-error'; text = `run_end  status=${p.status}${p.summary ? ' — ' + p.summary : ''}`; }
    else if (!p.type && p.step != null) { cls = /fail/i.test(p.status) ? 'l-error' : 'l-kane'; text = `step ${p.step}  ${p.status || ''}  ${p.remark || ''}`; }
    else text = `${p.type || 'event'}  ${JSON.stringify(Object.fromEntries(Object.entries(p).filter(([k]) => !['type', 'ts', 'v'].includes(k)))).slice(0, 400)}`;
    return h('div', {}, h('time', {}, new Date(e.ts).toLocaleTimeString([], { hour12: false })), h('span', { class: cls }, text));
  };
  const drawLog = () => {
    const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    log.replaceChildren(...events.filter((e) => e.result_id === selected || e.result_id == null).map(line));
    if (!log.children.length) log.append(h('div', {}, h('time', {}, ''), h('span', { class: 'mute' }, 'No events yet for this check.')));
    if (atEnd || follow) log.scrollTop = log.scrollHeight;
  };
  const drawDetail = async () => {
    const r = data.results.find((x) => x.id === selected);
    if (!r) return detail.replaceChildren(h('div', { class: 'panel empty' }, 'This run has no checks.'));
    const done = !ACTIVE.includes(r.status);
    if (done && !full.has(r.id)) { try { full.set(r.id, (await api('GET', `/runs/${runId}/results/${r.id}`)).result); } catch {} }
    const f = full.get(r.id) || {};
    const shots = r.evidence.filter((e) => e.kind === 'screenshot'), files = r.evidence.filter((e) => e.kind !== 'screenshot');
    const steps = events.filter((e) => e.result_id === r.id && e.kind === 'kane' && !e.payload.type && e.payload.step != null);
    detail.replaceChildren(...[
      h('div', { class: 'panel stack' },
        h('div', { class: 'row spread' }, h('div', { class: 'row' }, h('span', { class: 'key' }, r.criterionKey), resultTag(r), r.isFixture ? h('span', { class: 'tag s-failed', title: 'Produced by a test stand-in engine, not Kane CLI' }, 'Test fixture') : null),
          h('span', { class: 'num mute' }, r.exitCode != null ? `exit ${r.exitCode} · ` : '', fmtDur(r.durationMs))),
        h('p', {}, r.criterionText),
        r.status === 'starting' ? h('p', { class: 'small mute' }, 'Kane CLI process launched; waiting for its first event.') : null,
        r.status === 'failed' ? h('div', { class: 'callout bad stack-s' }, h('b', {}, 'Kane CLI reported this criterion as not met'), h('span', {}, r.failingStep?.remark || r.reason || r.summary || ''),
          h('div', {}, h('a', { class: 'btn sm', href: `#/p/${data.project.id}/failures` }, 'Open failure analysis'))) : null,
        ['error', 'timeout'].includes(r.status) ? h('div', { class: 'callout stack-s' }, h('b', {}, 'No verdict — this is not a pass'), h('span', {}, r.errorExplanation), h('span', { class: 'small mute' }, r.reason || '')) : null,
        r.status === 'passed' ? h('div', { class: 'callout ok' }, r.summary || 'Kane CLI verified the expected outcome (exit 0, passing run_end).') : null,
        r.status === 'queued' ? h('p', { class: 'small mute' }, 'Waiting for the browser — checks run one at a time.') : null,
        h('dl', { class: 'kv' },
          r.engine ? [h('dt', {}, 'Engine'), h('dd', { class: 'mono' }, r.engine)] : null,
          r.kaneStatus ? [h('dt', {}, 'Kane status'), h('dd', { class: 'mono' }, r.kaneStatus)] : null,
          r.summary && r.status !== 'passed' ? [h('dt', {}, 'Summary'), h('dd', {}, r.summary)] : null,
          r.startedAt ? [h('dt', {}, 'Started'), h('dd', {}, fmtTime(r.startedAt))] : null, r.finishedAt ? [h('dt', {}, 'Finished'), h('dd', {}, fmtTime(r.finishedAt))] : null,
          r.credits != null ? [h('dt', {}, 'Credits'), h('dd', { class: 'mono' }, r.credits)] : null,
          r.finalState && Object.keys(r.finalState).length ? [h('dt', {}, 'Stored values'), h('dd', { class: 'mono' }, JSON.stringify(r.finalState))] : null,
          r.testUrl ? [h('dt', {}, 'Test Manager'), h('dd', {}, h('a', { href: r.testUrl, target: '_blank', rel: 'noopener' }, r.testUrl))] : null)),
      steps.length ? h('div', { class: 'panel flush' }, h('div', { class: 'panel-h' }, h('h3', {}, `Browser steps (${steps.length})`)), h('div', { class: 'scroll' }, h('table', {}, h('tbody', {}, steps.map((e) => h('tr', {}, h('td', { class: 'num mute' }, e.payload.step),
        h('td', {}, tag(/fail/i.test(e.payload.status) ? 'failed' : /done|pass/i.test(e.payload.status) ? 'passed' : 'running')), h('td', { class: 'small' }, e.payload.remark || ''))))))) : null,
      h('div', { class: 'panel stack' }, h('h3', {}, `Evidence (${r.evidence.length})`),
        !r.evidence.length ? h('p', { class: 'small mute' }, done ? 'Kane CLI produced no evidence files for this execution.' : 'Evidence is collected when the check finishes.') : null,
        shots.length ? h('div', { class: 'shots' }, shots.map((e) => h('a', { href: `/api/evidence/${e.id}/file`, target: '_blank', rel: 'noopener', title: e.name }, h('img', { src: `/api/evidence/${e.id}/file`, alt: `Screenshot ${e.name}`, loading: 'lazy' })))) : null,
        files.length ? h('table', {}, h('tbody', {}, files.map((e) => h('tr', {}, h('td', {}, h('span', { class: 'cat' }, e.kind.replace('_', ' '))), h('td', { class: 'mono small' }, h('a', { href: e.url || `/api/evidence/${e.id}/file`, target: '_blank', rel: 'noopener' }, e.name)),
          h('td', { class: 'num mute' }, e.size != null ? `${(e.size / 1024).toFixed(1)} kB` : 'link'))))) : null),
      done ? h('div', { class: 'panel stack' }, h('h3', {}, 'Execution record'),
        h('details', {}, h('summary', { class: 'small' }, 'Objective sent to Kane CLI'), h('pre', { style: { 'margin-top': '8px' } }, f.objective || '—')),
        h('details', {}, h('summary', { class: 'small' }, 'Command'), h('pre', { style: { 'margin-top': '8px' } }, f.command || '—')),
        h('details', {}, h('summary', { class: 'small' }, `stdout (NDJSON, ${(f.stdout || '').length} bytes)`), h('pre', { style: { 'margin-top': '8px' } }, f.stdout || '(empty)')),
        h('details', { open: !!f.stderr && r.status !== 'passed' }, h('summary', { class: 'small' }, `stderr (${(f.stderr || '').length} bytes)`), h('pre', { style: { 'margin-top': '8px' } }, f.stderr || '(empty)'))) : null].filter(Boolean));
  };
  const draw = () => {
    const r = data.run, active = ['queued', 'running'].includes(r.status);
    head.replaceChildren(h('div', { class: 'row spread', style: { 'align-items': 'flex-start' } },
      h('div', { class: 'stack-s grow' }, h('h3', {}, h('a', { href: `#/p/${data.project.id}`, style: { 'text-decoration': 'none' } }, `← ${data.project.name}`)),
        h('div', { class: 'row' }, h('h1', {}, `Run #${r.id}`), tag(r.status)),
        h('div', { class: 'small mute' }, TRIGGER[r.trigger] || r.trigger, r.parentRunId ? [' · follows ', h('a', { href: `#/run/${r.parentRunId}` }, `#${r.parentRunId}`)] : null, r.note ? ` · ${r.note}` : '', ' · ', h('span', { class: 'mono' }, data.project.appUrl))),
      h('div', { class: 'row' }, h('span', { class: 'num' }, fmtDur(r.durationMs)),
        active ? h('button', { class: 'btn danger', onclick: act(async () => { await api('POST', `/runs/${r.id}/cancel`); toast('Cancelling…'); }) }, 'Cancel run')
          : h('button', { class: 'btn', onclick: act(async () => { const { run } = await api('POST', `/projects/${data.project.id}/runs`, { criterionIds: data.results.map((x) => x.criterionId) }); location.hash = `#/run/${run.id}`; }) }, 'Run these again'))),
      h('div', { style: { 'margin-top': '16px' } }, segBar(r.counts, ['passed', 'failed', 'error', 'timeout', 'running', 'queued', 'cancelled'])));
    list.replaceChildren(...data.results.map((x) => h('button', { class: x.id === selected ? 'on' : '', onclick: () => { selected = x.id; follow = false; history.replaceState(null, '', `#/run/${runId}/${x.id}`); draw(); drawLog(); } },
      h('div', { class: 'row spread' }, h('span', { class: 'key' }, x.criterionKey), resultTag(x)),
      h('span', { class: 'small mute' }, x.criterionText.length > 90 ? x.criterionText.slice(0, 90) + '…' : x.criterionText),
      x.durationMs != null ? h('span', { class: 'num small mute' }, fmtDur(x.durationMs), x.evidence.length ? ` · ${x.evidence.length} evidence` : '') : null)));
    drawDetail();
  };
  const refresh = async () => { data = await api('GET', `/runs/${runId}`); if (follow) selected = data.results.find((r) => ['starting', 'running'].includes(r.status))?.id || selected; draw(); };
  draw();
  // Every event has a persisted id. The stream resumes from Last-Event-ID after a drop; `seen` makes delivery
  // idempotent; and a cursor-based poll covers proxies or suspended tabs where the stream cannot be kept open.
  let pending = false, ended = false;
  const ingest = (e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id); lastId = Math.max(lastId, e.id); events.push(e);
    if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; drawLog(); }); }
    return true;
  };
  const catchUp = async () => { const { events: evs } = await api('GET', `/runs/${runId}/events?after=${lastId}`); if (evs.map(ingest).some(Boolean)) await refresh(); };
  const es = new EventSource(`/api/runs/${runId}/stream`);
  es.onopen = () => { conn.textContent = 'live stream connected'; };
  es.onmessage = (m) => { const e = JSON.parse(m.data); if (ingest(e) && e.kind === 'system') refresh().then(drawLog); };
  es.onerror = () => { if (!ended) conn.textContent = 'stream interrupted — reconnecting, polling meanwhile'; };
  es.addEventListener('end', () => { ended = true; es.close(); conn.textContent = 'run finished · full event history loaded'; refresh().then(drawLog); });
  const tick = setInterval(() => { if (!ended && es.readyState !== EventSource.OPEN) catchUp().catch(() => {}); else if (ACTIVE.includes(data.run.status)) refresh().catch(() => {}); }, 3000);
  const wake = () => { if (!document.hidden && !ended) catchUp().catch(() => {}); };
  document.addEventListener('visibilitychange', wake);
  cleanup.push(() => { es.close(); clearInterval(tick); document.removeEventListener('visibilitychange', wake); });
  return shell(h('div', { class: 'page stack-l' }, head, engineCallout(),
    h('div', { class: 'exec' }, list, h('div', { class: 'stack' }, h('div', { class: 'panel flush' }, h('div', { class: 'panel-h' }, h('h3', {}, 'Engine output'), conn), log), detail))));
}

// ---------- public report ----------
async function PublicReport(token) {
  try {
    const { report } = await api('GET', `/public/report/${token}`);
    document.title = `${report.project.name} — SHIPPROOF report`;
    return shell(h('div', { class: 'page' }, ReportBody(report, (id) => `/api/public/report/${token}/evidence/${id}`, false)));
  } catch (e) { return shell(h('div', { class: 'page' }, h('div', { class: 'panel empty stack' }, h('h2', {}, 'Report unavailable'), h('p', {}, e.message)))); }
}

// ---------- router ----------
async function render() {
  cleanup.forEach((f) => f()); cleanup = [];
  const share = /^\/r\/([\w-]+)$/.exec(location.pathname);
  const parts = (location.hash.replace(/^#\/?/, '') || '').split('/').filter(Boolean);
  let view;
  // Show a loading state only if the data takes a moment; it is always replaced by content or an error.
  const slow = setTimeout(() => { if ($app.dataset.route !== location.hash || !$app.firstChild) $app.replaceChildren(shell(h('div', { class: 'page stack', 'aria-busy': 'true' }, h('div', { class: 'skel w40' }), h('div', { class: 'skel h120' }), h('div', { class: 'skel h240' })))); }, 180);
  try {
    if (share) view = await PublicReport(share[1]);
    else if (!parts.length) view = Landing();
    else if (parts[0] === 'login' || parts[0] === 'signup') view = me ? (location.hash = '#/app', null) : Auth(parts[0]);
    else if (!me) { location.hash = '#/login'; return; }
    else if (parts[0] === 'app') view = await Dashboard();
    else if (parts[0] === 'new') view = await NewProject();
    else if (parts[0] === 'p' && parts[1]) view = await Project(Number(parts[1]), parts[2], parts[3]);
    else if (parts[0] === 'run' && parts[1]) view = await RunPage(Number(parts[1]), parts[2]);
    else view = shell(h('div', { class: 'page' }, h('div', { class: 'panel empty stack' }, h('h2', {}, 'Page not found'), h('div', {}, h('a', { class: 'btn', href: '#/app' }, 'Back to projects')))));
  } catch (e) {
    view = shell(h('div', { class: 'page' }, h('div', { class: 'panel empty stack' }, h('h2', {}, 'Something went wrong'), h('p', {}, e.message), h('div', { class: 'row', style: { 'justify-content': 'center' } }, h('button', { class: 'btn primary', onclick: render }, 'Retry'), h('a', { class: 'btn', href: '#/app' }, 'Back to projects')))));
  }
  clearTimeout(slow);
  if (view) { const y = window.scrollY, same = $app.dataset.route === location.hash; $app.replaceChildren(view); $app.dataset.route = location.hash; window.scrollTo(0, same ? y : 0); }
}
window.SP = { h, api, act, toast, copy, dialog, tag, fmtTime, fmtDur, ago, KIND, LABEL, render: () => render() };
window.addEventListener('hashchange', render);
(async () => {
  try { me = (await api('GET', '/auth/me')).user; if (me) system = await api('GET', '/system'); } catch {}
  render();
})();
