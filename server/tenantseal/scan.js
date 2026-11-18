// TenantSeal scan: PLANT → DISCOVER → PROBE (second tenant, anonymous) → TAMPER → OWNER CONTROL → VERDICT.
// Every browser action goes through the existing Kane adapter (server/kane.js: runKane, classify, collectEvidence).
// Verdicts are computed from the HAR evidence each run wrote, not from the engine's own report.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runKane, classify, collectEvidence, kaneConfig, kaneStatus } from '../kane.js';
import { readHarFiles, discoverRoutes, concretePath, sameOriginPath } from './har.js';
import { classifyRead, classifyTamper, classifyOwner, aggregateScan, CHECK, SCAN } from './verdict.js';
import { resolveCredentials, TenantConfigError } from './config.js';
import { scanTree, fingerprintOf } from '../agentgate/fingerprint.js';
import { writeReport } from './report.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_ENGINE = path.resolve(here, '..', '..', 'tests', 'fixtures', 'fake-tenant-browser.js');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
export const newCanary = (prefix = 'TENANTSEAL') => `${prefix}-${crypto.randomBytes(12).toString('hex')}`;
const slug = (s) => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40);

/** Capture the resource id from a route template such as /docs/:id. */
export function idFromTemplate(template, pathname) {
  if (!pathname) return null;
  const parts = template.split(':id');
  const re = new RegExp('^' + parts.map((s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('([A-Za-z0-9_-]{1,64})') + '$');
  const m = re.exec(pathname);
  return m ? m[1] : null;
}

/** Which engine will run, and whether it is allowed to run. Never falls back silently. */
export async function prepareEngine(kind) {
  if (kind === 'simulated') {
    const config = kaneConfig({ ...process.env, KANE_CLI_BIN: FIXTURE_ENGINE });
    const status = await kaneStatus(config, { fresh: true });
    if (!status.isFixture) return { ok: false, kind, status, reason: 'the simulated engine did not identify as the TenantSeal test fixture' };
    return { ok: true, kind, config, status };
  }
  if (kind !== 'kane') return { ok: false, kind, status: null, reason: `unknown engine "${kind}"` };
  const config = kaneConfig();
  const status = await kaneStatus(config, { fresh: true });
  if (status.isFixture) return { ok: false, kind, status, reason: 'KANE_CLI_BIN points at a test fixture. Use --engine simulated for a SIMULATED scan, or configure the real kane-cli.' };
  if (!status.ready) return { ok: false, kind, status, reason: `Kane CLI is not ready (${status.state}): ${status.detail}` };
  return { ok: true, kind, config, status };
}

/** Plain-language objective for the browser. The machine-readable plan follows for the test engine. */
export function objectiveFor(plan, targetUrl) {
  const who = plan.identity
    ? `Sign in as ${plan.identity} with the sign-in form, using the credential variable ${plan.credentialKey}.`
    : 'Do not sign in. Act as an anonymous visitor.';
  const steps = plan.steps.map((s, i) => `${i + 1}. ${s.do === 'get' ? 'Open ' + s.path : `Submit the form at ${s.path} (${s.method || 'POST'})`}`).join(' ');
  return `Start at ${targetUrl}. ${who} Then, as a real user, carry out these steps in order: ${steps} Report what each page shows. This is an authorised security test of records planted for this test only. TENANTSEAL_PLAN:${JSON.stringify(plan)}`;
}

/** Observed signed-in identity from the evidence: the GET of the home page after sign-in. */
export function observedIdentity(entries, origin, homePath) {
  const hits = entries.filter((e) => e.method === 'GET' && sameOriginPath(e.url, origin) === homePath);
  for (const e of hits.reverse()) {
    const m = /Signed in as ([A-Za-z0-9_-]+)/.exec(e.body);
    if (m) return m[1];
  }
  return null;
}

async function runProbe(ctx, plan, label) {
  const { budget, runsRoot, config, engine, credentials, origin } = ctx;
  const homePath = config.workflows.homePath;
  const fullSteps = plan.identity ? [{ do: 'get', path: homePath }, ...plan.steps] : plan.steps;
  const fullPlan = { name: label, identity: plan.identity || null, login: !!plan.identity, credentialKey: plan.credentialKey || null, steps: fullSteps };
  const variables = plan.credentialKey ? [{ key: plan.credentialKey, value: credentials[plan.credentialKey], secret: true }] : [];
  if (budget.used >= budget.max) {
    return { label, runStatus: 'not_run', errorKind: 'budget', reason: `run budget of ${budget.max} executions reached`, entries: [], identity: null, identityFailed: false, runs: 0 };
  }
  let attempts = 0, outcome = null, cls = null, runId = null, evidence = [], har = { entries: [], files: 0, malformed: 0 };
  do {
    attempts++; budget.used++;
    runId = `${stamp()}-${slug(label)}${attempts > 1 ? '-retry' + attempts : ''}`;
    const workDir = path.join(runsRoot, runId);
    outcome = await runKane({ objective: objectiveFor(fullPlan, config.target.url), url: config.target.url, workDir, variables, config: engine.config });
    cls = classify(outcome);
    evidence = [];
    har = { entries: [], files: 0, malformed: 0 };
    if (cls.status === 'passed' || cls.status === 'failed') {
      evidence = collectEvidence({ outcome, workDir, destDir: path.join(workDir, 'evidence') });
      har = readHarFiles(path.join(workDir, 'evidence'));
      if (cls.status === 'passed' && (har.files === 0 || har.entries.length === 0)) {
        cls = { status: 'error', errorKind: 'missing_evidence', reason: 'the browser run finished but wrote no network (HAR) evidence; the run is unverified' };
      }
    }
  } while (cls.errorKind === 'network' && attempts <= config.limits.retries && budget.used < budget.max);

  const observed = har.entries.length ? observedIdentity(har.entries, origin, homePath) : null;
  const identityFailed = !!plan.identity && (observed !== plan.identity || cls.status === 'failed');
  return {
    label, runId, runStatus: cls.status, errorKind: cls.errorKind || null, reason: cls.reason || outcome?.runEnd?.reason || null,
    identity: plan.identity ? { expected: plan.identity, observed } : null,
    identityFailed, entries: har.entries, malformed: har.malformed,
    evidenceCount: evidence.length, durationMs: outcome?.durationMs ?? 0, creditsConsumed: outcome?.runEnd?.credits_consumed ?? null,
    runs: attempts, plan: { identity: fullPlan.identity, steps: fullSteps.map((s) => ({ do: s.do, path: s.path, method: s.method || null })) },
  };
}

/** Fingerprints of the trusted specification and scanner. A change during a scan voids the scan. */
export function trustedFingerprints(cwd, config) {
  const cfgFile = path.join(cwd, '.tenantseal', 'config.json');
  const cfgSha = fs.existsSync(cfgFile) ? sha(fs.readFileSync(cfgFile)) : sha(JSON.stringify(config));
  const scanner = fs.readdirSync(here).filter((f) => f.endsWith('.js')).sort().map((f) => sha(fs.readFileSync(path.join(here, f))));
  return { configSha: cfgSha, scannerSha: sha(scanner.join('|')) };
}

/** Run one complete TenantSeal scan. Persists the scan and its report under <cwd>/.tenantseal/scans/<id>/. */
export async function runTenantScan({ cwd, config, engineKind = 'kane', credentials = null, env = process.env }) {
  const scanId = `${stamp()}-${crypto.randomBytes(3).toString('hex')}`;
  const startedAt = new Date().toISOString();
  const scanDir = path.join(cwd, '.tenantseal', 'scans', scanId);
  const runsRoot = path.join(cwd, '.tenantseal', 'runs', scanId);
  const trustedBefore = trustedFingerprints(cwd, config);
  const origin = config.target.origin;
  const finish = (fields) => {
    const scan = { scanId, startedAt, finishedAt: new Date().toISOString(), target: origin, engineKind, trusted: { before: trustedBefore, after: trustedFingerprints(cwd, config) }, ...fields };
    fs.mkdirSync(scanDir, { recursive: true });
    scan.report = writeReport(scanDir, scan);
    return scan;
  };

  const engine = await prepareEngine(engineKind);
  if (!engine.ok) return finish({ verdict: SCAN.ERROR, releaseBlocking: true, reasons: [engine.reason], checks: [], runs: [], routes: [], resource: null });

  let creds = credentials;
  if (!creds) {
    try { creds = resolveCredentials(config, env); }
    catch (e) { return finish({ verdict: SCAN.BLOCKED_CONFIGURATION, releaseBlocking: true, reasons: [e instanceof TenantConfigError ? e.message : String(e.message)], checks: [], runs: [], routes: [], resource: null }); }
  }
  const credentialsByKey = { owner_password: creds.owner, second_password: creds.second };
  const ctx = { config, engine, runsRoot, origin, budget: { used: 0, max: config.limits.maxRuns }, credentials: credentialsByKey };
  const { owner, second } = config.personas;
  const ownerPlan = (steps) => ({ identity: owner.identity, credentialKey: 'owner_password', steps });
  const secondPlan = (steps) => ({ identity: second.identity, credentialKey: 'second_password', steps });
  const anonPlan = (steps) => ({ identity: null, steps });
  const canary = newCanary('TENANTSEAL');
  const bodyField = config.records.bodyField;
  const readTpl = config.workflows.readPathTemplate, editTpl = config.workflows.editPathTemplate;
  const checks = [], runs = [];
  const record = (p) => runs.push({ label: p.label, runId: p.runId || null, runStatus: p.runStatus, errorKind: p.errorKind, durationMs: p.durationMs ?? 0, creditsConsumed: p.creditsConsumed ?? null, evidenceCount: p.evidenceCount ?? 0, runs: p.runs ?? 1 });

  // PLANT: the owner creates a private record through the real UI, whose body carries a fresh canary.
  const plant = await runProbe(ctx, ownerPlan([{ do: 'form', method: 'POST', path: config.workflows.createRecordPath, fields: { [bodyField]: `Private note ${canary}` } }]), 'plant');
  record(plant);
  const resourceId = plant.entries.filter((e) => e.method === 'GET' && e.body.includes(canary))
    .map((e) => idFromTemplate(readTpl, sameOriginPath(e.url, origin))).find(Boolean) || null;
  const readPath = resourceId ? concretePath(readTpl, resourceId) : null;
  const editPath = resourceId ? concretePath(editTpl, resourceId) : null;
  if (!resourceId) {
    // A run that completed (passed or reported a failure) without the record is unverified; an environment fault is an error.
    const completed = plant.runStatus === 'passed' || plant.runStatus === 'failed';
    checks.push({ id: 'PLANT', kind: 'plant', verdict: completed ? CHECK.INCONCLUSIVE : CHECK.ERROR, reason: completed ? `the planted record was not created or not found in the browser evidence${plant.reason ? ' (' + plant.reason + ')' : ''}` : `plant run ${plant.runStatus}: ${plant.reason}` });
  } else {
    const pv = classifyOwner({ probe: plant, origin, pathname: readPath, markers: [canary], ownerIdentity: owner.identity, denialStatuses: config.policy.denialStatuses });
    checks.push({ id: 'PLANT', kind: 'plant', verdict: pv.verdict, reason: pv.reason, runId: plant.runId });
  }

  let routes = [];
  let discovery = { foreignEntries: 0, files: 0, malformed: 0 };
  if (resourceId) {
    // DISCOVER: the owner browses the record and saves it; the HAR of those runs lists the routes that relate to it.
    const disc = await runProbe(ctx, ownerPlan([
      { do: 'get', path: readPath }, { do: 'get', path: editPath },
      { do: 'form', method: 'POST', path: editPath, fields: { [bodyField]: `Private note ${canary}` } },
    ]), 'discover');
    record(disc);
    const ownerEntries = [...plant.entries, ...disc.entries];
    discovery = { ...discoverRoutes({ entries: ownerEntries, origin, resourceId, canary }), files: disc.evidenceCount, malformed: plant.malformed + disc.malformed };
    routes = discovery.routes.map((r) => ({ ...r }));
    for (const m of config.discovery.manualRoutes) routes.push({ method: m.method, template: m.template, kind: 'configured', observations: 0, carriesCanary: false, sources: [] });
    const seenKey = new Set();
    routes = routes.filter((r) => { const k = `${r.method} ${r.template}`; if (seenKey.has(k)) return false; seenKey.add(k); return true; });
    if (!routes.length) checks.push({ id: 'DISCOVERY', kind: 'plant', verdict: CHECK.INCONCLUSIVE, reason: 'discovery found no same-origin routes related to the record' });
  }
  const permitted = (t) => config.policy.permittedPaths.includes(t);

  // PROBE: GET routes as the second tenant and as an anonymous visitor.
  for (const r of routes.filter((x) => x.method === 'GET')) {
    if (!permitted(r.template)) {
      checks.push({ id: `READ ${r.template}`, kind: 'read', route: r.template, actor: 'second', verdict: CHECK.INCONCLUSIVE, reason: `discovered route ${r.template} is not in policy.permittedPaths; it was not probed` });
      continue;
    }
    const p = concretePath(r.template, resourceId);
    for (const actor of ['second', 'anonymous']) {
      const probe = await runProbe(ctx, actor === 'second' ? secondPlan([{ do: 'get', path: p }]) : anonPlan([{ do: 'get', path: p }]), `read-${actor}-${r.template}`);
      record(probe);
      const v = classifyRead({ probe, origin, pathname: p, canary, expectedIdentity: actor === 'second' ? second.identity : null });
      checks.push({ id: `READ ${actor} GET ${r.template}`, kind: 'read', route: r.template, actor, verdict: v.verdict, reason: v.reason, runId: probe.runId || null });
    }
  }

  // TAMPER: the second tenant attempts each discovered write through the UI form; the owner's view decides.
  const tokens = [];
  for (const [i, m] of routes.filter((x) => x.method !== 'GET').entries()) {
    if (!permitted(m.template)) {
      checks.push({ id: `TAMPER ${m.method} ${m.template}`, kind: 'tamper', route: m.template, actor: 'second', verdict: CHECK.INCONCLUSIVE, reason: `discovered route ${m.template} is not in policy.permittedPaths; it was not probed` });
      continue;
    }
    const writePath = concretePath(m.template, resourceId);
    const token = newCanary('TENANTSEAL-TAMPER');
    tokens.push(token);
    const attempt = await runProbe(ctx, secondPlan([{ do: 'get', path: editPath }, { do: 'form', method: m.method, path: writePath, fields: { [bodyField]: token } }]), `tamper-${i}`);
    record(attempt);
    const ownerAfter = await runProbe(ctx, ownerPlan([{ do: 'get', path: readPath }]), `owner-after-tamper-${i}`);
    record(ownerAfter);
    const v = classifyTamper({ attempt, owner: ownerAfter, origin, writePath, method: m.method, readPath, canary, tamperToken: token, secondIdentity: second.identity, ownerIdentity: owner.identity });
    checks.push({ id: `TAMPER second ${m.method} ${m.template}`, kind: 'tamper', route: m.template, actor: 'second', verdict: v.verdict, reason: v.reason, runId: attempt.runId || null });
  }

  // OWNER CONTROL: after the negative probes the owner must still reach the record and its pages.
  if (resourceId) {
    for (const tpl of [readTpl, editTpl]) {
      const p = concretePath(tpl, resourceId);
      const probe = await runProbe(ctx, ownerPlan([{ do: 'get', path: p }]), `owner-control-${slug(tpl)}`);
      record(probe);
      const v = classifyOwner({ probe, origin, pathname: p, markers: [canary, ...tokens], ownerIdentity: owner.identity, denialStatuses: config.policy.denialStatuses });
      checks.push({ id: `OWNER ${tpl}`, kind: 'owner', verdict: v.verdict, reason: v.reason, runId: probe.runId || null });
    }
  }

  const trustedAfter = trustedFingerprints(cwd, config);
  const integrityChanged = trustedAfter.configSha !== trustedBefore.configSha || trustedAfter.scannerSha !== trustedBefore.scannerSha;
  const agg = aggregateScan({
    checks, routes: routes.map((r) => r.template), engine: engine.kind,
    configValid: !integrityChanged, configReason: 'the trusted specification or scanner changed during the scan',
  });
  // The revision covers application source only; TenantSeal's own run output is excluded so it cannot change it.
  const appRevision = fingerprintOf(new Map([...scanTree(path.resolve(cwd, config.app.sourceDir))].filter(([k]) => !k.startsWith('.tenantseal/'))));
  return finish({
    verdict: agg.verdict, releaseBlocking: agg.releaseBlocking, reasons: agg.reasons,
    engine: { kind: engine.kind, version: engine.status?.version ?? null, fixture: !!engine.status?.isFixture },
    appRevision, canary, resource: resourceId ? { id: resourceId, readPath, editPath } : null,
    discovery: { routes: routes.map((r) => ({ method: r.method, template: r.template, kind: r.kind, observations: r.observations, carriesCanary: r.carriesCanary, sources: r.sources })), foreignEntries: discovery.foreignEntries, malformed: discovery.malformed || 0 },
    checks, runs, budget: { used: ctx.budget.used, max: ctx.budget.max },
  });
}
