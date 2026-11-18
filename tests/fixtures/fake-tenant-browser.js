#!/usr/bin/env node
// TEST FIXTURE ONLY — a stand-in for the kane-cli browser run used by the TenantSeal tests and the simulated
// demo. It speaks the same argv / NDJSON / exit-code contract as kane-cli (see server/kane.js) and performs the
// planned HTTP navigation a browser would: sign-in, redirects, page loads and the page's own background fetch()
// calls, recording every exchange in a HAR file. It identifies itself as a fixture; its results are never Kane
// evidence, and TenantSeal labels any scan that used it as SIMULATED.
//
// The plan is embedded in the objective as  TENANTSEAL_PLAN:<json>  and credentials arrive through the variables
// file exactly as kane-cli receives them (never on the command line, never in the HAR).
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('0.0.0-fixture-tenant-browser'); process.exit(0); }
if (args[0] === 'whoami') process.exit(0);
if (args[0] !== 'run') { console.error('unsupported command'); process.exit(64); }

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const objective = args[1] || '';
const urlArg = args[args.indexOf('--url') + 1];
const varsFile = args.indexOf('--variables-file') >= 0 ? args[args.indexOf('--variables-file') + 1] : null;
const fault = process.env.TB_FIXTURE_FAULT || '';

const idx = objective.indexOf('TENANTSEAL_PLAN:');
if (idx < 0) { console.error('no TENANTSEAL_PLAN in objective'); process.exit(64); }
const plan = JSON.parse(objective.slice(idx + 'TENANTSEAL_PLAN:'.length));
const vars = varsFile ? JSON.parse(fs.readFileSync(varsFile, 'utf8')) : {};
const origin = new URL(urlArg).origin;
const sessionDir = path.join(process.cwd(), 'session');
fs.mkdirSync(sessionDir, { recursive: true });

if (fault === 'network') { process.stderr.write('Error: connect ECONNREFUSED 127.0.0.1\n'); process.exit(2); }

const har = [];
let cookie = '';
const addEntry = (kind, method, url, status, headers, text) => {
  har.push({
    startedDateTime: new Date().toISOString(), time: 0, comment: `kind=${kind}`,
    request: { method, url, headers: [] },
    response: { status, headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
      content: { mimeType: headers['content-type'] || '', text: text.slice(0, 262144) } },
  });
};

async function exchange(kind, method, target, form = null, follow = 5) {
  let url = new URL(target, origin).href;
  let m = method;
  let body = form ? new URLSearchParams(form).toString() : null;
  for (let hop = 0; hop <= follow; hop++) {
    const res = await fetch(url, {
      method: m, redirect: 'manual',
      headers: { connection: 'close', ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: m === 'GET' ? undefined : body,
    });
    const text = await res.text();
    const headers = Object.fromEntries([...res.headers.entries()]);
    addEntry(hop === 0 ? kind : 'redirect', m, url, res.status, headers, text);
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of sc) {
      const kv = c.split(';')[0];
      if (/=$/.test(kv) || /Max-Age=0/i.test(c)) cookie = ''; else cookie = kv;
    }
    if (res.status >= 300 && res.status < 400 && headers.location) {
      url = new URL(headers.location, url).href; m = 'GET'; body = null; continue;
    }
    return { status: res.status, text, url };
  }
  return { status: 0, text: '', url };
}

// Browser behaviour: a page's own fetch() calls to its origin run in the background and are recorded.
async function background(html) {
  const seen = new Set();
  for (const m of html.matchAll(/fetch\(\s*["']([^"']+)["']/g)) {
    const u = new URL(m[1], origin);
    if (u.origin !== origin || seen.has(u.href)) continue;
    seen.add(u.href);
    const r = await fetch(u.href, { headers: { connection: 'close', ...(cookie ? { cookie } : {}) }, redirect: 'manual' });
    addEntry('background', 'GET', u.href, r.status, Object.fromEntries([...r.headers.entries()]), await r.text());
  }
}

// Ends the run. process.exit can abort on Windows while sockets are still open, so the exit code is set and the
// run unwinds through a sentinel instead.
const DONE = Symbol('done');
function finish(status, extra, exitCode) {
  fs.writeFileSync(path.join(sessionDir, 'network.har'), JSON.stringify({ log: { version: '1.2', creator: { name: 'fake-tenant-browser (TEST FIXTURE)', version: '0' }, entries: har } }, null, 2));
  fs.writeFileSync(path.join(sessionDir, 'run.log'), `fixture run: ${plan.name || 'probe'} status=${status}\n`);
  out({ type: 'stream_start', cli_version: 'fixture-tenant-browser' });
  for (const [i, s] of (plan.steps || []).entries()) out({ step: i + 1, status: 'done', remark: `${s.do} ${s.path || ''}`.trim() });
  out({ type: 'run_end', status, session_dir: sessionDir, credits_consumed: 0, ...extra });
  process.exitCode = exitCode;
  throw DONE;
}

try {
  const identity = { expected: plan.identity ?? null, observed: null };
  if (plan.login) {
    const pw = vars[plan.credentialKey]?.value;
    if (!pw) { console.error('missing credential variable'); process.exit(64); }
    const r = await exchange('navigation', 'POST', '/login', { username: plan.identity, password: pw });
    // exchange() follows the post-login redirect, so success is judged by the session cookie it received.
    // A rejected sign-in leaves no session; the identity check below would also catch it.
    if (!cookie) {
      // A rejected sign-in is an identity failure, not a security result.
      finish('failed', { reason: `sign-in rejected for ${plan.identity} (HTTP ${r.status})`, identity }, 1);
    }
    const home = await exchange('navigation', 'GET', '/docs');
    const m = home.text.match(/Signed in as ([A-Za-z0-9_-]+)/);
    identity.observed = m ? m[1] : null;
    if (identity.observed !== plan.identity) {
      finish('failed', { reason: `identity not established: expected ${plan.identity}, observed ${identity.observed ?? 'no session'}`, identity }, 1);
    }
  }
  for (const s of plan.steps || []) {
    if (s.do === 'get') {
      const r = await exchange('navigation', 'GET', s.path);
      if (r.status === 200) await background(r.text);
    } else if (s.do === 'form') {
      await exchange('navigation', s.method || 'POST', s.path, s.fields || {});
    } else {
      console.error(`unknown step ${s.do}`); process.exitCode = 64; throw DONE;
    }
  }
  finish('passed', { identity, summary: `${plan.steps?.length || 0} planned steps executed` }, 0);
} catch (e) {
  if (e === DONE) { /* exit code already set by finish() */ }
  else { process.stderr.write(`Error: ${e.cause?.code || e.message}\n`); process.exitCode = 2; }
}
