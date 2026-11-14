#!/usr/bin/env node
// SHIPPROOF CI client (Node 18+, no dependencies). Registers the commit as a build, triggers
// verification, waits for the real result and exits non-zero unless the release decision allows it.
//   exit 0 = release verified · 1 = blocked / not verified · 2 = could not complete (config, network, timeout)
// Required env: SHIPPROOF_URL, SHIPPROOF_API_KEY, and COMMIT_SHA (or GITHUB_SHA).
// Optional env: BRANCH, ENVIRONMENT (default "default"), BUILD_ID, APP_URL, CHANGED_PATHS_FILE (one path per line),
//               MODE ("plan" = only what the change impact requires, or "full"), TIMEOUT_SECONDS (default 1800), POLL_MS.
import fs from 'node:fs';

const env = process.env;
const base = (env.SHIPPROOF_URL || '').replace(/\/$/, ''), key = env.SHIPPROOF_API_KEY;
const commitSha = env.COMMIT_SHA || env.GITHUB_SHA, environment = env.ENVIRONMENT || 'default';
class ExitError extends Error {
  constructor(code) {
    super();
    this.code = code;
  }
}

const die = (msg) => { console.error(`shipproof: ${msg}`); throw new ExitError(2); };

async function call(method, path, body) {
  let res;
  try { res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); }
  catch (e) { die(`cannot reach ${base}: ${e.message}`); }
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const need = (r, what) => { if (r.status >= 400) die(`${what} failed (${r.status}): ${r.data.error || 'unknown error'}`); return r.data; };

async function main() {
  if (!base || !key || !commitSha) die('SHIPPROOF_URL, SHIPPROOF_API_KEY and COMMIT_SHA (or GITHUB_SHA) are required');

  let changedPaths;
  if (env.CHANGED_PATHS_FILE) {
    if (!fs.existsSync(env.CHANGED_PATHS_FILE)) die(`CHANGED_PATHS_FILE ${env.CHANGED_PATHS_FILE} does not exist`);
    changedPaths = fs.readFileSync(env.CHANGED_PATHS_FILE, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  }
  const b = need(await call('POST', '/api/agent/builds', { commitSha, environment, branch: env.BRANCH || env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || undefined,
    buildId: env.BUILD_ID || env.GITHUB_RUN_ID || undefined, appUrl: env.APP_URL || undefined, changedPaths }), 'build registration');
  console.log(`shipproof: build ${b.build.shortSha} (${environment}) ${b.created ? 'registered' : 'already registered'} — impact: ${b.impact.affected} affected, ${b.impact.unknown} unknown, ${b.impact.unaffected} unaffected, ${b.impact.toVerify} to verify`);

  let runId = null;
  const v = await call('POST', '/api/agent/verify', { commitSha, environment, mode: env.MODE === 'full' ? 'full' : 'plan' });
  if (v.status === 409 && v.data.activeRunId) { runId = v.data.activeRunId; console.log(`shipproof: run #${runId} is already in progress; waiting for it`); }
  else { const d = need(v, 'verification trigger'); if (d.nothingToVerify) console.log('shipproof: nothing to verify — all evidence is current for this build'); else { runId = d.run.id; console.log(`shipproof: run #${runId} started (${d.run.total} checks)`); } }

  const deadline = Date.now() + (Number(env.TIMEOUT_SECONDS) || 1800) * 1000, poll = Number(env.POLL_MS) || 5000;
  while (runId) {
    const r = need(await call('GET', `/api/agent/runs/${runId}`), 'run status');
    if (r.finished) { for (const x of r.results) console.log(`  ${x.criterion_key}  ${x.status}${x.error_kind ? ` (${x.error_kind})` : ''}`); break; }
    if (Date.now() > deadline) die(`timed out waiting for run #${runId}`);
    await new Promise((s) => setTimeout(s, poll));
  }

  const d = need(await call('GET', `/api/agent/decision?commitSha=${commitSha}&environment=${encodeURIComponent(environment)}`), 'release decision');
  if (d.pendingRunId) die(`another run (#${d.pendingRunId}) is still in progress; no decision recorded`);
  const lines = [`SHIPPROOF decision #${d.decisionId} for ${d.commitSha.slice(0, 7)}: ${d.verdict.toUpperCase()} (policy v${d.policyVersion})`,
    ...d.blocking.map((x) => `  ✗ [${x.code}] ${x.message}${x.action ? ` → ${x.action}` : ''}`), `  ${d.reportUrl}`];
  console.log(lines.join('\n'));
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `### SHIPPROOF: ${d.verdict.toUpperCase()}\n\nCommit \`${d.commitSha}\` · decision #${d.decisionId} · policy v${d.policyVersion}\n\n${d.blocking.map((x) => `- **${x.code}** ${x.message}`).join('\n') || 'All mandatory criteria have current passing evidence.'}\n\n${d.reportUrl}\n`);
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `verdict=${d.verdict}\ndecision_id=${d.decisionId}\n`);
  process.exitCode = d.releaseAllowed ? 0 : 1;
}

main().catch((e) => {
  if (e instanceof ExitError) {
    process.exitCode = e.code;
  } else {
    console.error(e);
    process.exitCode = 1;
  }
});
