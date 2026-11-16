// Event-triggered continuous monitoring. GitHub `workflow_run` and `deployment_status` deliveries are validated,
// persisted in a durable ledger (watch_events), correlated with registered builds and then handed to the existing
// Continuous Watch assessment (watch.runCheck). The event path never creates results, evidence or verdicts: a green
// workflow or a successful deployment is only a reason to look at the project, not proof that it works.
//
// Lifecycle of an accepted event:  QUEUED → PROCESSING → COMPLETED   (or QUEUED ⇄ PROCESSING with backoff → FAILED)
//                                  IGNORED is terminal (not subscribed, intermediate state, or not a health signal).
// Receipt and validation happen before a row exists; a rejected payload is answered with 400 and logged in
// webhook_deliveries, never queued. Duplicates are detected by the delivery id before any effect.
import { now, audit } from './db.js';
import { getConfig } from './watch.js';

export const MAX_ATTEMPTS = 3;
export const RETRY_MS = [15_000, 60_000];   // wait after the 1st and 2nd failed assessment
export const BUSY_RETRY_MS = 15_000;        // another check holds the project; not counted as a failure
export const MAX_PENDING = 50;              // queued events per project; beyond this new events are recorded as IGNORED

const SHA = /^[0-9a-f]{7,64}$/;
const ENV = /^[\w.-]{1,40}$/;
const REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;
const WORKFLOW_OUTCOMES = new Set(['success', 'failure', 'timed_out']);
const DEPLOYMENT_OUTCOMES = { success: 'success', failure: 'failure', error: 'failure' };
const DEPLOYMENT_IGNORED = {
  inactive: 'superseded by a newer deployment (inactive): not a health signal',
  pending: 'intermediate deployment state', queued: 'intermediate deployment state', in_progress: 'intermediate deployment state', waiting: 'intermediate deployment state',
};
export const EVENT_SOURCE = { workflow_run: 'github_workflow_run', deployment_status: 'github_deployment' };
const SUBSCRIPTION = { workflow_run: ['workflowRun', 'GitHub Actions workflow_run'], deployment_status: ['deployment', 'deployment_status'] };

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
const isoOrNull = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);
const safeUrl = (v) => {
  if (typeof v !== 'string' || v.length > 500) return null;
  try { const u = new URL(v); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; }
};
/** Never store or return credentials, signatures or stack traces. */
export const redact = (msg) => String(msg ?? '').replace(/(whsec_|spk_|sk_|sha256=)[\w+/=-]+/g, '[redacted]').replace(/\s+/g, ' ').slice(0, 300);
const reject = (error) => ({ error });

/** Pure validation and classification of a GitHub payload. No database access. */
export function normalize(event, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b) return reject('payload must be a JSON object');
  const repo = b.repository?.full_name;
  if (typeof repo !== 'string' || !REPO.test(repo)) return reject('repository.full_name is missing or invalid');
  const action = str(b.action, 40);
  if (!action) return reject('action is missing');
  return event === 'workflow_run' ? workflowRun(b, repo, action) : deployment(b, repo, action);
}

function workflowRun(b, repo, action) {
  const r = b.workflow_run;
  if (!r || typeof r !== 'object') return reject('workflow_run object is missing');
  const sha = typeof r.head_sha === 'string' ? r.head_sha.toLowerCase() : '';
  if (!SHA.test(sha)) return reject('workflow_run.head_sha (commit) is missing or invalid');
  const id = Number(r.id);
  if (!Number.isSafeInteger(id) || id <= 0) return reject('workflow_run.id is missing or invalid');
  const conclusion = typeof r.conclusion === 'string' ? r.conclusion.slice(0, 40) : null;
  const base = { source: EVENT_SOURCE.workflow_run, action, externalId: id, externalState: conclusion, repository: repo,
    workflowName: str(r.name, 200), branch: str(r.head_branch, 200), commitSha: sha, environment: null, targetUrl: safeUrl(r.html_url),
    description: null, occurredAt: isoOrNull(r.updated_at) || isoOrNull(r.created_at) };
  if (action !== 'completed') return { ...base, qualifies: false, reason: `workflow_run.${action} is an intermediate event` };
  if (!conclusion) return { ...base, qualifies: false, reason: 'completed workflow run has no conclusion' };
  if (!WORKFLOW_OUTCOMES.has(conclusion)) return { ...base, qualifies: false, reason: `conclusion "${conclusion}" does not change project health` };
  return { ...base, qualifies: true, outcome: conclusion, reason: `workflow "${base.workflowName || id}" completed with ${conclusion}` };
}

function deployment(b, repo, action) {
  const d = b.deployment, s = b.deployment_status;
  if (!d || typeof d !== 'object' || !s || typeof s !== 'object') return reject('deployment and deployment_status objects are required');
  const sha = typeof d.sha === 'string' ? d.sha.toLowerCase() : '';
  if (!SHA.test(sha)) return reject('deployment.sha (commit) is missing or invalid');
  const id = Number(d.id);
  if (!Number.isSafeInteger(id) || id <= 0) return reject('deployment.id is missing or invalid');
  const env = d.environment ?? null;
  if (env !== null && (typeof env !== 'string' || !ENV.test(env))) return reject('deployment.environment is invalid');
  const state = typeof s.state === 'string' ? s.state.slice(0, 40) : '';
  if (!state) return reject('deployment_status.state is missing');
  const base = { source: EVENT_SOURCE.deployment_status, action, externalId: id, externalState: state, repository: repo, workflowName: null,
    branch: str(d.ref, 200), commitSha: sha, environment: env, targetUrl: safeUrl(s.environment_url) || safeUrl(s.target_url),
    description: str(s.description ?? d.description, 300), occurredAt: isoOrNull(s.updated_at) || isoOrNull(s.created_at) };
  if (DEPLOYMENT_OUTCOMES[state]) return { ...base, qualifies: true, outcome: DEPLOYMENT_OUTCOMES[state],
    reason: `deployment ${id} to ${env || 'an unspecified environment'} reported ${state}` };
  return { ...base, qualifies: false, reason: DEPLOYMENT_IGNORED[state] || `deployment state "${state}" is not supported` };
}

/** Correlate a commit with a registered SHIPPROOF build. Read-only: a build is never invented or registered here. */
export function correlate(db, projectId, sha, environment) {
  if (!sha) return null;
  const rows = db.all('SELECT * FROM builds WHERE project_id = ? AND commit_sha LIKE ? ORDER BY id DESC LIMIT 20', projectId, `${sha}%`);
  if (environment) return rows.find((b) => b.environment === environment) || null;
  return rows[0] || null; // no environment given: the newest build of that commit
}

function subscription(cfg, event) {
  const [key, label] = SUBSCRIPTION[event];
  if (!cfg.events.enabled) return { on: false, why: 'event-triggered monitoring is off for this project' };
  if (!cfg.events[key]) return { on: false, why: `subscription to ${label} is off` };
  return { on: true };
}

export function createEvents({ db, watch, log = () => {}, tickMs = 5000, autoKick = true }) {
  let running = null, stopped = false, timer = null;
  const pending = (projectId) => db.get(`SELECT COUNT(*) n FROM watch_events WHERE project_id = ? AND state IN ('QUEUED','PROCESSING')`, projectId).n;

  /**
   * Called from the GitHub webhook handler INSIDE its transaction, after the delivery id was found to be new.
   * Returns one of: { status: 'rejected', error } | { status: 'queued'|'ignored', eventId, reason, buildId }.
   */
  function ingest(projectId, delivery, event, body) {
    const n = normalize(event, body);
    if (n.error) return { status: 'rejected', error: n.error };
    const sub = subscription(getConfig(db, projectId), event);
    let state = 'QUEUED', reason = n.reason;
    if (!sub.on) { state = 'IGNORED'; reason = sub.why; }
    else if (!n.qualifies) state = 'IGNORED';
    else if (pending(projectId) >= MAX_PENDING) { state = 'IGNORED'; reason = `more than ${MAX_PENDING} events are waiting; this one was recorded but not assessed`; }
    const build = correlate(db, projectId, n.commitSha, n.environment);
    if (n.qualifies && state === 'QUEUED') reason = `${n.reason}; assessment queued`;
    const t = now();
    const id = Number(db.run(`INSERT INTO watch_events (project_id, delivery_id, source, action, external_state, state, reason, repository, workflow_name, external_id,
        branch, commit_sha, environment, target_url, description, build_id, occurred_at, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      projectId, delivery, n.source, n.action, n.externalState, state, reason, n.repository, n.workflowName, n.externalId, n.branch, n.commitSha,
      n.environment, n.targetUrl, n.description, build?.id ?? null, n.occurredAt, t).lastInsertRowid);
    db.run(`INSERT INTO webhook_deliveries (project_id, delivery_id, event, outcome, build_id, detail, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      projectId, delivery, event, state === 'QUEUED' ? 'queued' : 'ignored', build?.id ?? null, reason, t);
    audit(db, { projectId, actor: 'github', action: 'watch.event_received', entity: 'watch_event', entityId: id, detail: { event, state, reason, commit: n.commitSha, environment: n.environment, buildId: build?.id ?? null } });
    log('info', 'watch.event', { projectId, event, state, eventId: id });
    return { status: state === 'QUEUED' ? 'queued' : 'ignored', eventId: id, reason, buildId: build?.id ?? null };
  }

  function finish(id, state, reason, error = null) {
    db.run(`UPDATE watch_events SET state = ?, reason = ?, error = ?, processed_at = ?, not_before = NULL WHERE id = ?`, state, reason, error, now(), id);
  }

  /** After a restart: an interrupted PROCESSING event is requeued unless its check was already persisted. */
  function recover() {
    let n = 0;
    for (const e of db.all(`SELECT id, attempts, project_id FROM watch_events WHERE state = 'PROCESSING'`)) {
      const done = db.get('SELECT id FROM watch_checks WHERE event_id = ?', e.id);
      if (done) { db.run(`UPDATE watch_events SET state = 'COMPLETED', check_id = ?, processed_at = ? WHERE id = ?`, done.id, now(), e.id); }
      else if (e.attempts >= MAX_ATTEMPTS) finish(e.id, 'FAILED', 'interrupted repeatedly by server restarts', 'The server stopped during every attempt.');
      else db.run(`UPDATE watch_events SET state = 'QUEUED', processing_started_at = NULL, not_before = NULL, reason = 'recovered after a server restart' WHERE id = ?`, e.id);
      n++;
    }
    if (n) log('warn', 'watch.events_recovered', { count: n });
    return n;
  }

  async function processOne(id) {
    // Compare-and-swap claim: exactly one worker can move an event from QUEUED to PROCESSING.
    if (!db.run(`UPDATE watch_events SET state = 'PROCESSING', attempts = attempts + 1, processing_started_at = ?, not_before = NULL WHERE id = ? AND state = 'QUEUED'`, now(), id).changes) return;
    const ev = db.get('SELECT * FROM watch_events WHERE id = ?', id);
    const sub = subscription(getConfig(db, ev.project_id), ev.source === EVENT_SOURCE.workflow_run ? 'workflow_run' : 'deployment_status');
    if (!sub.on) return finish(id, 'IGNORED', sub.why);
    const build = correlate(db, ev.project_id, ev.commit_sha, ev.environment);
    db.run('UPDATE watch_events SET build_id = ? WHERE id = ?', build?.id ?? null, id);
    try {
      // runCheck persists the check and marks this event COMPLETED in one transaction (exactly-once).
      await watch.runCheck(ev.project_id, 'event', { eventId: id });
    } catch (e) {
      const message = redact(e.message);
      if (e.status === 409 || e.status === 503) { // project busy or shutting down: retry without spending an attempt
        db.run(`UPDATE watch_events SET state = 'QUEUED', attempts = attempts - 1, processing_started_at = NULL, not_before = ?, error = ? WHERE id = ? AND state = 'PROCESSING'`,
          new Date(Date.now() + BUSY_RETRY_MS).toISOString(), message, id);
        return;
      }
      if (ev.attempts >= MAX_ATTEMPTS) { finish(id, 'FAILED', `assessment failed ${ev.attempts} times`, message); log('error', 'watch.event_failed', { eventId: id, error: message }); }
      else {
        db.run(`UPDATE watch_events SET state = 'QUEUED', processing_started_at = NULL, not_before = ?, error = ? WHERE id = ? AND state = 'PROCESSING'`,
          new Date(Date.now() + RETRY_MS[ev.attempts - 1]).toISOString(), message, id);
        log('warn', 'watch.event_retry', { eventId: id, attempt: ev.attempts, error: message });
      }
    }
  }

  /** Serial worker: one event (and therefore at most one assessment) at a time, in arrival order. */
  function drain() {
    if (!running) running = (async () => {
      while (!stopped) {
        const next = db.get(`SELECT id FROM watch_events WHERE state = 'QUEUED' AND (not_before IS NULL OR not_before <= ?) ORDER BY id LIMIT 1`, now());
        if (!next) break;
        await processOne(next.id);
      }
    })().catch((e) => log('error', 'watch.worker', { error: redact(e.message) })).finally(() => { running = null; });
    return running;
  }
  const kick = () => { if (autoKick) setImmediate(() => drain()); };
  function start() { recover(); if (tickMs > 0) { timer = setInterval(kick, tickMs); timer.unref?.(); } kick(); }
  /** Stop taking new events and wait (bounded) for the one in flight; anything unfinished is recovered on boot. */
  async function stop() { stopped = true; clearInterval(timer); timer = null; if (running) await Promise.race([running, new Promise((r) => setTimeout(r, 10_000).unref?.())]); }

  /** Merged event history: lifecycle events plus the other webhook deliveries (push, ping, ignored types). */
  function history(projectId, { state, limit = 50 } = {}) {
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const events = db.all(`SELECT * FROM watch_events WHERE project_id = ? ${state ? 'AND state = ?' : ''} ORDER BY id DESC LIMIT ?`, ...(state ? [projectId, state, n] : [projectId, n]))
      .map((e) => ({ kind: 'event', id: e.id, deliveryId: e.delivery_id, event: e.source === EVENT_SOURCE.workflow_run ? 'workflow_run' : 'deployment_status', source: e.source,
        action: e.action, externalState: e.external_state, state: e.state, reason: e.reason, repository: e.repository, workflowName: e.workflow_name,
        externalId: e.external_id, branch: e.branch, commitSha: e.commit_sha, environment: e.environment, targetUrl: e.target_url, buildId: e.build_id,
        checkId: e.check_id, receivedAt: e.received_at, processedAt: e.processed_at, attempts: e.attempts, duplicates: e.duplicates, error: e.error }));
    const deliveries = state ? [] : db.all(`SELECT d.*, b.commit_sha FROM webhook_deliveries d LEFT JOIN builds b ON b.id = d.build_id
        WHERE d.project_id = ? AND d.event NOT IN ('workflow_run','deployment_status') ORDER BY d.id DESC LIMIT ?`, projectId, n)
      .map((d) => ({ kind: 'delivery', id: `d${d.id}`, deliveryId: d.delivery_id, event: d.event, source: `github_${d.event}`, action: null, externalState: null,
        state: d.outcome, reason: d.detail || '', repository: null, workflowName: null, externalId: null, branch: null, commitSha: d.commit_sha || null,
        environment: null, targetUrl: null, buildId: d.build_id, checkId: null, receivedAt: d.received_at, processedAt: null, attempts: 0, duplicates: 0, error: null }));
    return [...events, ...deliveries].sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt)).slice(0, n);
  }

  return { ingest, drain, kick, start, stop, recover, history, pending };
}
