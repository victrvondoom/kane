// Failure investigations and fix verification.
//
//   failed Kane result ──► investigation (persisted, references the original run/result/evidence, snapshot of facts)
//        │                   ├─ diagnosis: deterministic rules over the evidence (generations are kept)
//        │                   ├─ lifecycle: validated transitions, append-only history, developer notes
//        └─ verification: the SAME flow re-run through the existing runner ─► comparison ─► outcome
//
// Invariants: Kane's verdict on the original result is never changed; nothing here writes runs, results or evidence.
// AI is not used. Every conclusion lists the evidence that produced it. A verification that could not establish the
// facts is INCONCLUSIVE, never a fix; an unrelated passing test never resolves an investigation.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { now, audit, newUid } from './db.js';
import { summarizeEvidence, redactText, redactUrl } from './telemetry.js';

export const STATUSES = ['OPEN', 'INVESTIGATING', 'READY_FOR_VERIFICATION', 'VERIFYING', 'VERIFIED_FIXED', 'STILL_FAILING', 'PARTIALLY_RESOLVED', 'REGRESSION_INTRODUCED', 'INCONCLUSIVE'];
export const OUTCOME_STATUS = { VERIFIED_FIXED: 'VERIFIED_FIXED', STILL_FAILING: 'STILL_FAILING', PARTIALLY_RESOLVED: 'PARTIALLY_RESOLVED', REGRESSION_INTRODUCED: 'REGRESSION_INTRODUCED', INCONCLUSIVE: 'INCONCLUSIVE', INCOMPARABLE: 'INCONCLUSIVE' };
export const OUTCOME_LABEL = { VERIFIED_FIXED: 'FIX VERIFIED', STILL_FAILING: 'FAILURE REPRODUCED', PARTIALLY_RESOLVED: 'PARTIALLY RESOLVED', REGRESSION_INTRODUCED: 'NEW REGRESSION DETECTED',
  INCONCLUSIVE: 'VERIFICATION INCONCLUSIVE', INCOMPARABLE: 'VERIFICATION INCONCLUSIVE — FLOW CHANGED' };
// Lifecycle transitions a user may request. Outcome states can only be left for INVESTIGATING (re-open).
// VERIFYING and every outcome state are set by the verification engine, never by a request.
const TRANSITIONS = { OPEN: ['INVESTIGATING'], INVESTIGATING: ['READY_FOR_VERIFICATION'], READY_FOR_VERIFICATION: ['INVESTIGATING'] };
for (const s of ['VERIFIED_FIXED', 'STILL_FAILING', 'PARTIALLY_RESOLVED', 'REGRESSION_INTRODUCED', 'INCONCLUSIVE']) TRANSITIONS[s] = ['INVESTIGATING'];
export const ACTIVE_RUN = ['queued', 'starting', 'running'];
const FAILED_RESULT = new Set(['failed', 'error', 'timeout']);
const STOP = new Set(['the', 'and', 'with', 'that', 'this', 'should', 'after', 'before', 'page', 'shows', 'there', 'user', 'when', 'then', 'from', 'into', 'your', 'have', 'will', 'does', 'only']);
const CATEGORY_RANK = { server_error: 0, network_failure: 1, client_error: 2, console_error: 3 };

const parseJson = (t) => { try { return JSON.parse(t); } catch { return null; } };
export const normalizeText = (s) => String(s ?? '').toLowerCase().replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, '<id>').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 160);
const tokens = (s) => new Set(String(s ?? '').toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4 && !STOP.has(w)));
const linked = (a, b) => [...a].some((t) => b.has(t));
const pathTokens = (url) => { try { return tokens(new URL(url).pathname.replace(/[/_.-]+/g, ' ')); } catch { return new Set(); } };

/** Facts Kane recorded for a result. Nothing is inferred here: a missing step stays null. */
export function failureFacts(result) {
  const step = result.failing_step ? parseJson(result.failing_step) : null;
  const stepText = typeof step === 'string' ? step : step?.description || step?.step || step?.name || step?.text || null;
  const message = result.reason || result.one_liner || result.summary || null;
  return { status: result.status, errorKind: result.error_kind || null, category: result.status === 'failed' ? 'assertion_failure' : 'execution_error',
    failingStep: stepText ? redactText(stepText, 300) : null, message: message ? redactText(message, 400) : null, criterionKey: result.criterion_key,
    durationMs: result.duration_ms ?? null, startedAt: result.started_at ?? null };
}

/** Evidence rows of one result, with availability checked inside the evidence root (path confinement). */
export function evidenceFor(db, resultId, evidenceRoot) {
  const rows = db.all('SELECT uid, name, kind, rel_path, mime, size FROM evidence WHERE result_id = ? ORDER BY id', resultId);
  const root = path.resolve(evidenceRoot);
  return rows.map((r) => {
    const file = r.rel_path ? path.resolve(root, r.rel_path) : null;
    const available = !!file && file.startsWith(root + path.sep) && fs.existsSync(file);
    // Display names are file names only: stored names can carry the session directory layout.
    return { uid: r.uid, name: path.basename(String(r.name ?? '')), kind: r.kind, mime: r.mime, size: r.size, relPath: r.rel_path, available };
  });
}

/** Everything the rules need about one result. Telemetry is read from confined files only. */
export function sideOf(db, evidenceRoot, result) {
  const rows = evidenceFor(db, result.id, evidenceRoot);
  const t = summarizeEvidence(rows.map((r) => ({ uid: r.uid, name: r.name, kind: r.kind, rel_path: r.relPath, mime: r.mime })), evidenceRoot);
  return buildSide({ result, rows, t });
}
/** Pure: the facts, signature and comparable endpoints of one execution. Used directly by the tests with synthetic telemetry. */
export function buildSide({ result, rows, t }) {
  const facts = failureFacts(result);
  const failures = t.network?.failures ?? [];
  const endpoints = [...new Set(failures.map((f) => `${f.method} ${f.url}`))].sort();
  const serverEndpoints = [...new Set(failures.filter((f) => f.status === 0 || f.status >= 500).map((f) => `${f.method} ${f.url}`))].sort();
  const consoleErrors = [...new Set((t.console?.samples ?? []).filter((s) => s.level === 'error').map((s) => normalizeText(s.text)))].sort();
  const signatureParts = { v: 1, criterion: facts.criterionKey, category: facts.category, step: normalizeText(facts.failingStep), message: normalizeText(facts.message), endpoints: serverEndpoints };
  return { result, rows, t, facts, endpoints, serverEndpoints, consoleErrors, hasNetwork: !!t.network, hasConsole: !!t.console, criterionVersionId: result.criterion_version_id ?? null,
    signature: crypto.createHash('sha256').update(JSON.stringify(signatureParts)).digest('hex').slice(0, 32), signatureParts,
    available: rows.filter((r) => r.available).length, missing: rows.filter((r) => !r.available).map((r) => r.name) };
}

const ref = (kind, extra) => ({ kind, ...extra });
/** Deterministic diagnosis. Every finding cites the evidence it is based on. */
export function diagnose(side, { similarFailures = 0 } = {}) {
  const { facts, t, rows } = side;
  const stepTok = tokens(`${facts.failingStep ?? ''} ${facts.message ?? ''}`);
  // Defence in depth: everything that reaches the output is redacted here too, not only in the parsers.
  const netFails = (t.network?.failures ?? []).slice(0, 12).map((f) => ({ ...f, url: redactUrl(f.url) }));
  const consoleErr = (t.console?.samples ?? []).filter((s) => s.level === 'error').slice(0, 8).map((s) => ({ ...s, text: redactText(s.text) }));
  const screenshots = rows.filter((r) => r.kind === 'screenshot');
  const findings = [], confirmed = [], unknowns = [];
  confirmed.push(`Kane recorded the execution as "${facts.status}"${facts.errorKind ? ` (${facts.errorKind})` : ''}.`);
  if (facts.failingStep) confirmed.push(`Kane reported the failing step: "${facts.failingStep}".`);
  else unknowns.push('Kane did not report which step failed.');
  if (similarFailures > 0) confirmed.push(`This flow has failed ${similarFailures} other time${similarFailures === 1 ? '' : 's'} in this project's recorded history.`);
  if (facts.category === 'execution_error') {
    findings.push({ id: 'F-EXEC', category: 'execution_error', severity: 'high', title: 'Kane did not produce a verdict',
      observation: `Execution ended as "${facts.status}"${facts.errorKind ? ` (${facts.errorKind})` : ''}.`, evidence: [ref('result', { id: side.result.id })],
      rationale: 'The harness or environment stopped the execution, so the application was not judged.', confidence: 'CONFIRMED_OBSERVATION', linkedToStep: false, limitations: [] });
  }
  if (screenshots.length) findings.push({ id: 'F-SHOT', category: 'screenshot', severity: 'info', title: `${screenshots.length} screenshot${screenshots.length === 1 ? '' : 's'} captured`,
    observation: `Screenshot evidence is available: ${screenshots.map((s) => s.name).join(', ')}.`, evidence: screenshots.map((s) => ref('screenshot', { uid: s.uid, name: s.name })),
    rationale: 'Screenshots show the page as Kane saw it. This diagnosis does not interpret their pixels.', confidence: 'CONFIRMED_OBSERVATION', linkedToStep: false, limitations: [] });
  else findings.push({ id: 'F-NOSHOT', category: 'missing_evidence', severity: 'medium', title: 'No screenshot available', observation: 'No screenshot was recorded for this execution.',
    evidence: [], rationale: 'Without a screenshot the visible state at the failure cannot be checked.', confidence: 'INSUFFICIENT_EVIDENCE', linkedToStep: false, limitations: ['visual state unknown'] });
  let n = 0;
  for (const f of netFails) {
    const cat = f.status === 0 ? 'network_failure' : f.status >= 500 ? 'server_error' : 'client_error';
    const isLinked = linked(stepTok, pathTokens(f.url));
    const corroborated = consoleErr.some((s) => linked(pathTokens(f.url), tokens(s.text)));
    const confidence = isLinked ? (corroborated ? 'STRONG_CORRELATION' : 'POSSIBLE_CORRELATION') : 'INSUFFICIENT_EVIDENCE';
    const observed = f.status === 0 ? `Request ${f.method} ${f.url} failed to connect${f.error ? ` (${f.error})` : ''}.` : `${f.method} ${f.url} returned HTTP ${f.status}.`;
    const summary = f.status === 0 ? `${f.method} ${f.url} could not connect` : `${f.method} ${f.url} returned HTTP ${f.status}`;
    findings.push({ id: `F-NET-${++n}`, category: cat, summary, severity: cat === 'client_error' ? 'medium' : 'high', title: cat === 'server_error' ? `HTTP ${f.status} from ${f.method} ${new URL(f.url).pathname}`
      : cat === 'network_failure' ? `Connection failed: ${new URL(f.url).pathname}` : `HTTP ${f.status} from ${f.method} ${new URL(f.url).pathname}`,
      observation: observed, evidence: [ref('network', { evidenceUid: f.evidenceUid, name: f.evidenceName, index: f.index })],
      rationale: isLinked ? `The request path shares terms with the failed step${corroborated ? ' and a console error' : ''}.`
        : 'The request is not linked to the failed step, so it is recorded but not treated as its cause.',
      confidence, linkedToStep: isLinked, corroborated, limitations: isLinked ? [] : ['not linked to the failed step'] });
  }
  for (const s of consoleErr) {
    const isLinked = linked(stepTok, tokens(s.text));
    findings.push({ id: `F-CON-${++n}`, category: 'console_error', summary: `console error "${s.text}"`, severity: 'medium', title: 'Console error recorded', observation: `Console error: "${s.text}".`,
      evidence: [ref('console', { evidenceUid: s.evidenceUid, name: s.evidenceName })], rationale: isLinked ? 'The message shares terms with the failed step.' : 'The message is not linked to the failed step.',
      confidence: 'CONFIRMED_OBSERVATION', linkedToStep: isLinked, corroborated: false, limitations: isLinked ? [] : ['not linked to the failed step'] });
  }
  // Most likely cause: only findings linked to the failed step can be causes; ties go to the stronger category.
  const candidates = findings.filter((f) => f.linkedToStep && f.category in CATEGORY_RANK)
    .sort((a, b) => (b.corroborated ? 1 : 0) - (a.corroborated ? 1 : 0) || CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category]);
  let cause;
  if (facts.category === 'execution_error') cause = { text: 'No application cause can be assessed: Kane did not reach a verdict. Fix the harness or environment first.', confidence: 'CONFIRMED_OBSERVATION', findingIds: ['F-EXEC'] };
  else if (candidates.length) {
    const c = candidates[0];
    const PREFIX = { server_error: 'a server error: ', network_failure: 'a request that could not connect: ', client_error: 'a rejected request: ', console_error: 'an application console error: ' };
    cause = { text: `The failed step appears linked to ${PREFIX[c.category]}${c.summary}.`, confidence: c.confidence, findingIds: [c.id] };
  } else cause = { text: 'The available evidence does not identify a cause for the failed step.', confidence: 'INSUFFICIENT_EVIDENCE', findingIds: [] };
  const unlinked = findings.filter((f) => !f.linkedToStep && ['server_error', 'network_failure', 'client_error', 'console_error'].includes(f.category));
  if (unlinked.length) unknowns.push(`${unlinked.length} recorded failure${unlinked.length === 1 ? '' : 's'} (${[...new Set(unlinked.map((u) => u.category.replace('_', ' ')))].join(', ')}) are not linked to the failed step and were not treated as causes.`);
  if (!t.network) unknowns.push('No network (HAR) evidence was recorded, so request-level causes cannot be checked.');
  if (!t.console) unknowns.push('No console evidence was recorded, so application errors cannot be checked.');
  const next = [];
  if (facts.category === 'execution_error') next.push('Re-run after fixing the harness or environment; this execution cannot show the application is broken.');
  for (const f of findings.filter((x) => x.linkedToStep && x.category === 'server_error').slice(0, 2)) next.push(`Check the server logs for ${f.observation.replace(/ returned.*/, '').replace(/^.*? /, '')} around ${side.facts.startedAt ?? 'the run time'}.`);
  for (const f of findings.filter((x) => x.linkedToStep && x.category === 'network_failure').slice(0, 2)) next.push('Confirm the target host is reachable from the verification environment.');
  if (consoleErr.length) next.push('Open the console error in the application source and check its stack, if the evidence recorded one.');
  if (!screenshots.length) next.push('Capture screenshots for this flow so the failure state can be inspected.');
  if (!next.length) next.push('Inspect the failing step in the screenshot and reproduce it manually against the application.');
  return { engine: 'deterministic-v1', category: facts.category, mostLikelyCause: cause,
    confirmedObservations: confirmed, hypotheses: cause.confidence === 'INSUFFICIENT_EVIDENCE' ? [] : [`${cause.text} (${cause.confidence}; a hypothesis, not a proven fact)`],
    unknowns, nextSteps: next, findings,
    relatedRequests: findings.filter((f) => f.category in { server_error: 1, network_failure: 1, client_error: 1 }).map((f) => ({ observation: f.observation, linkedToStep: f.linkedToStep, confidence: f.confidence, evidence: f.evidence })),
    relatedConsole: findings.filter((f) => f.category === 'console_error').map((f) => ({ observation: f.observation, linkedToStep: f.linkedToStep, evidence: f.evidence })),
    evidenceCompleteness: { items: rows.length, available: side.available, missing: side.missing, screenshots: screenshots.length, network: !!t.network, console: !!t.console },
    generatedAt: now() };
}

const endpointDiff = (a, b) => ({ added: b.filter((x) => !a.includes(x)), removed: a.filter((x) => !b.includes(x)), kept: b.filter((x) => a.includes(x)) });
/** Compare a verification execution with the original failure. Explicit rules, in order; the first match decides. */
export function compareExecutions(orig, ver, { runStatus = 'completed', origRunId, verRunId } = {}) {
  const base = { flowComparable: null, originalFailureStatus: null, outcome: null, label: null, reason: null, newFailures: [], resolvedFindings: [], persistentFindings: [],
    missingEvidence: { original: orig.missing, verification: ver?.missing ?? [] }, evidenceRefs: { original: orig.rows.filter((r) => r.available).map((r) => r.uid), verification: (ver?.rows ?? []).filter((r) => r.available).map((r) => r.uid) },
    original: { runId: origRunId, resultId: orig.result.id, signature: orig.signature, failingStep: orig.facts.failingStep, message: orig.facts.message, status: orig.facts.status, endpoints: orig.serverEndpoints },
    verification: ver ? { runId: verRunId, resultId: ver.result.id, signature: ver.signature, failingStep: ver.facts.failingStep, message: ver.facts.message, status: ver.facts.status, endpoints: ver.serverEndpoints } : null,
    buildsDiffer: null };
  const done = (outcome, reason, extra = {}) => ({ ...base, ...extra, outcome, label: OUTCOME_LABEL[outcome], reason });
  if (!ver || ACTIVE_RUN.includes(runStatus)) return done('INCONCLUSIVE', 'The verification run has not produced a result yet.', { flowComparable: null });
  if (!ver.result || ['error', 'timeout', 'cancelled'].includes(ver.facts.status)) return done('INCONCLUSIVE',
    `Kane did not produce a verdict${ver?.facts?.errorKind ? ` (${ver.facts.errorKind})` : ''}. An infrastructure failure is never evidence that the defect was fixed.`, { flowComparable: null });
  if (orig.criterionVersionId !== ver.criterionVersionId) return done('INCOMPARABLE', 'The flow text changed after the original failure, so the two executions test different flows.', { flowComparable: false });
  if (orig.facts.category === 'execution_error') return done('INCONCLUSIVE', 'The original result was an execution error, not an application failure. There is no application failure to verify.', { flowComparable: true });
  if (ver.available === 0) return done('INCONCLUSIVE', 'The verification produced no evidence files. A verdict without evidence cannot establish a fix.', { flowComparable: true });
  // Evidence parity: if the original was judged with network or console evidence, the verification must have it too,
  // otherwise absence of errors cannot be distinguished from absence of data.
  const missingKind = [orig.hasNetwork && !ver.hasNetwork && 'network (HAR)', orig.hasConsole && !ver.hasConsole && 'console'].filter(Boolean);
  if (missingKind.length) return done('INCONCLUSIVE', `The verification recorded no ${missingKind.join(' or no ')} evidence, so new failures cannot be ruled out. Insufficient evidence.`, { flowComparable: true });
  const diff = endpointDiff(orig.endpoints, ver.endpoints);
  const newConsole = ver.consoleErrors.filter((x) => !orig.consoleErrors.includes(x));
  const resolved = orig.endpoints.filter((x) => !ver.endpoints.includes(x)).map((x) => ({ kind: 'endpoint', observation: x }));
  const persistent = diff.kept.map((x) => ({ kind: 'endpoint', observation: x }));
  const newFailures = [...diff.added.map((x) => ({ kind: 'endpoint', observation: x })), ...newConsole.map((x) => ({ kind: 'console_error', observation: x }))];
  const extra = { flowComparable: true, newFailures, resolvedFindings: resolved, persistentFindings: persistent,
    buildsDiffer: orig.result.build_id != null && ver.result.build_id != null ? orig.result.build_id !== ver.result.build_id : null };
  if (ver.facts.status === 'passed') {
    if (newFailures.length) return done('REGRESSION_INTRODUCED', 'The original failure is no longer observed, but the comparable flow now shows new material failures.',
      { ...extra, originalFailureStatus: 'ABSENT' });
    return done('VERIFIED_FIXED', 'The comparable flow passed with evidence; the original failure signature is absent and no new material failure was observed.', { ...extra, originalFailureStatus: 'ABSENT' });
  }
  if (ver.signature === orig.signature) return done('STILL_FAILING', 'The same failure signature was reproduced in the comparable flow.', { ...extra, originalFailureStatus: 'PRESENT' });
  const sameStep = !!orig.facts.failingStep && normalizeText(orig.facts.failingStep) === normalizeText(ver.facts.failingStep);
  if (sameStep && diff.added.length === 0) return done('PARTIALLY_RESOLVED', 'The original failing step still fails, but the failure changed and no new failing endpoint appeared.', { ...extra, originalFailureStatus: 'CHANGED' });
  return done('REGRESSION_INTRODUCED', 'The flow now fails differently from the original failure: a different step or a new failing endpoint.', { ...extra, originalFailureStatus: 'CHANGED' });
}

/** Repository + lifecycle. All methods take already-authorised ids; route handlers do the ownership checks. */
export function createInvestigations({ db, runner, evidenceRoot }) {
  const view = (i) => i && ({ id: i.uid, projectId: i.project_id, runId: i.run_id, resultId: i.result_id, criterionKey: i.criterion_key, status: i.status,
    originalVerdict: i.original_status, signature: i.signature, signatureVersion: i.signature_version, createdAt: i.created_at, updatedAt: i.updated_at,
    failure: parseJson(i.failure_json) });
  const byUid = (uid, userId) => db.get(`SELECT i.* FROM investigations i JOIN projects p ON p.id = i.project_id WHERE i.uid = ? AND p.user_id = ?`, uid, userId);
  const history = (inv, type, actorUserId, detail = {}) => db.run('INSERT INTO investigation_events (investigation_id, type, actor_user_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?)',
    inv.id, type, actorUserId ?? null, JSON.stringify(detail), now());
  const latestDiagnosis = (invId) => { const r = db.get('SELECT * FROM investigation_diagnoses WHERE investigation_id = ? ORDER BY generation DESC LIMIT 1', invId); return r ? { generation: r.generation, engine: r.engine, createdAt: r.created_at, ...parseJson(r.diagnosis_json) } : null; };

  function priorFailures(projectId, criterionKey, resultId) {
    return db.get(`SELECT COUNT(*) n FROM results r JOIN runs n ON n.id = r.run_id WHERE n.project_id = ? AND r.criterion_key = ? AND r.status IN ('failed','error','timeout') AND r.id != ?`, projectId, criterionKey, resultId).n;
  }

  /** Create (or return the existing) investigation for one failed result. Idempotent per result. */
  function createForResult({ userId, runId, resultId }) {
    const r = db.get(`SELECT r.*, n.project_id FROM results r JOIN runs n ON n.id = r.run_id JOIN projects p ON p.id = n.project_id
      WHERE r.id = ? AND r.run_id = ? AND p.user_id = ?`, resultId, runId, userId);
    if (!r) return { error: 404, message: 'Result not found' };
    const existing = db.get('SELECT * FROM investigations WHERE result_id = ?', r.id);
    if (existing) return { created: false, investigation: view(existing) };
    if (!FAILED_RESULT.has(r.status)) return { error: 409, message: `A "${r.status}" result has nothing to investigate. Only failed or errored results can be investigated.` };
    const side = sideOf(db, evidenceRoot, r);
    const diag = diagnose(side, { similarFailures: priorFailures(r.project_id, r.criterion_key, r.id) });
    const t = now(), uid = newUid();
    try {
      return db.tx(() => {
        const id = Number(db.run(`INSERT INTO investigations (uid, project_id, user_id, run_id, result_id, criterion_id, criterion_key, criterion_version_id, original_status, status, failure_json, signature, signature_version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, 1, ?, ?)`, uid, r.project_id, userId, r.run_id, r.id, r.criterion_id, r.criterion_key, r.criterion_version_id ?? null,
          r.status, JSON.stringify(side.facts), side.signature, t, t).lastInsertRowid);
        const inv = db.get('SELECT * FROM investigations WHERE id = ?', id);
        db.run('INSERT INTO investigation_diagnoses (investigation_id, generation, engine, diagnosis_json, created_at) VALUES (?, 1, ?, ?, ?)', id, diag.engine, JSON.stringify(diag), t);
        history(inv, 'created', userId, { runId: r.run_id, resultId: r.id, originalVerdict: r.status, signature: side.signature });
        history(inv, 'diagnosis_generated', null, { generation: 1, engine: diag.engine, findings: diag.findings.length });
        audit(db, { userId, projectId: r.project_id, action: 'investigation.created', entity: 'investigation', entityId: id, detail: { resultId: r.id, runId: r.run_id } });
        return { created: true, investigation: view(inv) };
      });
    } catch (e) {
      if (/UNIQUE/.test(e.message)) { const again = db.get('SELECT * FROM investigations WHERE result_id = ?', r.id); return { created: false, investigation: view(again) }; }
      throw e;
    }
  }

  function detail(inv) {
    const original = db.get(`SELECT r.*, n.trigger run_trigger, n.started_at run_started FROM results r JOIN runs n ON n.id = r.run_id WHERE r.id = ?`, inv.result_id);
    const side = original ? sideOf(db, evidenceRoot, original) : null;
    const verifs = db.all('SELECT * FROM investigation_verifications WHERE investigation_id = ? ORDER BY attempt DESC', inv.id);
    return {
      investigation: view(inv),
      original: original ? { runId: original.run_id, resultId: original.id, criterionKey: original.criterion_key, criterionText: original.criterion_text, verdict: original.status,
        errorKind: original.error_kind, startedAt: original.started_at, finishedAt: original.finished_at, durationMs: original.duration_ms, failingStep: side.facts.failingStep,
        message: side.facts.message, criterionVersionId: original.criterion_version_id, runTrigger: original.run_trigger } : null,
      evidence: side ? { items: side.rows.map((r) => ({ id: r.uid, kind: r.kind, name: r.name, mime: r.mime, size: r.size, available: r.available })),
        completeness: { total: side.rows.length, available: side.available, missing: side.missing } } : { items: [], completeness: { total: 0, available: 0, missing: [] } },
      diagnosis: latestDiagnosis(inv.id),
      diagnosisGenerations: db.get('SELECT COUNT(*) n FROM investigation_diagnoses WHERE investigation_id = ?', inv.id).n,
      notes: db.all(`SELECT n.id, n.body, n.created_at, u.name author FROM investigation_notes n LEFT JOIN users u ON u.id = n.author_user_id WHERE n.investigation_id = ? ORDER BY n.id`, inv.id)
        .map((n) => ({ id: n.id, body: n.body, createdAt: n.created_at, author: n.author || 'former user' })),
      events: db.all(`SELECT e.id, e.type, e.detail_json, e.created_at, u.name actor FROM investigation_events e LEFT JOIN users u ON u.id = e.actor_user_id WHERE e.investigation_id = ? ORDER BY e.id`, inv.id)
        .map((e) => ({ id: e.id, type: e.type, at: e.created_at, actor: e.actor || (e.type === 'created' ? 'unknown' : 'system'), detail: parseJson(e.detail_json) })),
      verifications: verifs.map(verificationView),
      allowedTransitions: TRANSITIONS[inv.status] ?? [],
      canVerify: inv.status !== 'VERIFYING',
    };
  }

  const verificationView = (v) => ({ id: v.uid, attempt: v.attempt, status: v.status, runId: v.run_id, resultId: v.result_id, outcome: v.outcome,
    outcomeLabel: v.outcome ? OUTCOME_LABEL[v.outcome] : null, createdAt: v.created_at, completedAt: v.completed_at,
    comparison: parseJson(v.comparison_json) });

  function changeStatus({ userId, uid, to }) {
    const inv = byUid(uid, userId);
    if (!inv) return { error: 404, message: 'Investigation not found' };
    if (!STATUSES.includes(to)) return { error: 400, message: 'Unknown status' };
    if (!(TRANSITIONS[inv.status] ?? []).includes(to)) return { error: 409, message: `Invalid transition from ${inv.status} to ${to}`, allowed: TRANSITIONS[inv.status] ?? [] };
    db.tx(() => {
      db.run('UPDATE investigations SET status = ?, updated_at = ? WHERE id = ? AND status = ?', to, now(), inv.id, inv.status);
      history(inv, 'status_changed', userId, { from: inv.status, to });
    });
    audit(db, { userId, projectId: inv.project_id, action: 'investigation.status', entity: 'investigation', entityId: inv.id, detail: { from: inv.status, to } });
    return { investigation: view(db.get('SELECT * FROM investigations WHERE id = ?', inv.id)) };
  }

  function addNote({ userId, uid, body }) {
    const inv = byUid(uid, userId);
    if (!inv) return { error: 404, message: 'Investigation not found' };
    const text = String(body ?? '').trim();
    if (!text) return { error: 400, message: 'A note cannot be empty' };
    if (text.length > 4000) return { error: 400, message: 'A note may be at most 4000 characters' };
    const noteId = db.tx(() => {
      const id = Number(db.run('INSERT INTO investigation_notes (investigation_id, author_user_id, body, created_at) VALUES (?, ?, ?, ?)', inv.id, userId, text, now()).lastInsertRowid);
      history(inv, 'note_added', userId, { noteId: id });
      return id;
    });
    return { noteId };
  }

  function refreshDiagnosis({ userId, uid }) {
    const inv = byUid(uid, userId);
    if (!inv) return { error: 404, message: 'Investigation not found' };
    const original = db.get('SELECT * FROM results WHERE id = ?', inv.result_id);
    if (!original) return { error: 404, message: 'The original result no longer exists' };
    const side = sideOf(db, evidenceRoot, original);
    const diag = diagnose(side, { similarFailures: priorFailures(inv.project_id, inv.criterion_key, original.id) });
    db.tx(() => {
      const gen = db.get('SELECT COALESCE(MAX(generation), 0) g FROM investigation_diagnoses WHERE investigation_id = ?', inv.id).g + 1;
      db.run('INSERT INTO investigation_diagnoses (investigation_id, generation, engine, diagnosis_json, created_at) VALUES (?, ?, ?, ?, ?)', inv.id, gen, diag.engine, JSON.stringify(diag), now());
      db.run('UPDATE investigations SET updated_at = ? WHERE id = ?', now(), inv.id);
      history(inv, 'diagnosis_generated', userId, { generation: gen, engine: diag.engine, findings: diag.findings.length });
    });
    return { diagnosis: latestDiagnosis(inv.id) };
  }

  /** Start a verification: re-run the investigated flow through the existing runner. */
  function startVerification({ userId, uid }) {
    const inv = byUid(uid, userId);
    if (!inv) return { error: 404, message: 'Investigation not found' };
    // A finished attempt is brought up to date before deciding whether one is still running.
    for (const v of db.all(`SELECT * FROM investigation_verifications WHERE investigation_id = ? AND status IN ('QUEUED','RUNNING')`, inv.id)) refreshVerification(v);
    const current = db.get('SELECT status FROM investigations WHERE id = ?', inv.id).status;
    const active = db.get(`SELECT uid FROM investigation_verifications WHERE investigation_id = ? AND status IN ('QUEUED','RUNNING')`, inv.id);
    if (active) return { error: 409, message: 'A verification is already in progress for this investigation.', verificationId: active.uid };
    if (current === 'VERIFYING') return { error: 409, message: 'A verification is already running for this investigation.' };
    const crit = db.get('SELECT id, archived FROM criteria WHERE id = ? AND project_id = ?', inv.criterion_id, inv.project_id);
    if (!crit || crit.archived) return { error: 409, message: 'The investigated flow was archived or removed, so it cannot be re-verified. Restore it or start a new investigation.' };
    const busy = runner.activeRunFor(inv.project_id);
    if (busy) return { error: 409, message: `Run #${busy} is already in progress for this project.`, activeRunId: busy };
    const runId = runner.enqueue({ projectId: inv.project_id, criterionIds: [inv.criterion_id], trigger: 'investigation', note: `Verification of investigation ${inv.uid}` });
    const attempt = db.get('SELECT COALESCE(MAX(attempt), 0) a FROM investigation_verifications WHERE investigation_id = ?', inv.id).a + 1;
    const vuid = newUid();
    db.tx(() => {
      const vid = Number(db.run(`INSERT INTO investigation_verifications (uid, investigation_id, attempt, status, run_id, requested_by, created_at) VALUES (?, ?, ?, 'QUEUED', ?, ?, ?)`, vuid, inv.id, attempt, runId, userId, now()).lastInsertRowid);
      db.run(`UPDATE investigations SET status = 'VERIFYING', updated_at = ? WHERE id = ?`, now(), inv.id);
      history(inv, 'verification_requested', userId, { attempt, runId, verificationId: vuid });
      return vid;
    });
    audit(db, { userId, projectId: inv.project_id, action: 'investigation.verify', entity: 'investigation', entityId: inv.id, detail: { attempt, runId } });
    return { verification: verificationView(db.get('SELECT * FROM investigation_verifications WHERE uid = ?', vuid)) };
  }

  /**
   * Bring a verification up to date from persisted state. Idempotent and restart-safe: the decision is only written
   * once (compare-and-swap on the verification's status), so two readers can never record two outcomes.
   */
  function refreshVerification(v) {
    if (!v || ['COMPLETED', 'FAILED'].includes(v.status)) return v;
    const run = db.get('SELECT * FROM runs WHERE id = ?', v.run_id);
    if (!run) return finish(v, 'FAILED', null, { reason: 'The verification run no longer exists.' });
    if (ACTIVE_RUN.includes(run.status)) {
      if (run.status === 'running' && v.status !== 'RUNNING') db.run(`UPDATE investigation_verifications SET status = 'RUNNING' WHERE id = ? AND status = 'QUEUED'`, v.id);
      return db.get('SELECT * FROM investigation_verifications WHERE id = ?', v.id);
    }
    const inv = db.get('SELECT * FROM investigations WHERE id = ?', v.investigation_id);
    const original = db.get('SELECT * FROM results WHERE id = ?', inv.result_id);
    const verResult = db.get('SELECT * FROM results WHERE run_id = ? AND criterion_id = ? ORDER BY id DESC LIMIT 1', v.run_id, inv.criterion_id);
    const origSide = sideOf(db, evidenceRoot, original);
    const verSide = verResult ? sideOf(db, evidenceRoot, verResult) : null;
    const cmp = compareExecutions(origSide, verSide && { ...verSide, criterionVersionId: verResult.criterion_version_id ?? null }, { runStatus: run.status, origRunId: original.run_id, verRunId: run.id });
    if (!verResult && cmp.reason == null) cmp.reason = 'No result was recorded for the verification run.';
    return finish(v, 'COMPLETED', cmp.outcome, cmp, inv);
  }

  function finish(v, status, outcome, comparison, inv = db.get('SELECT * FROM investigations WHERE id = ?', v.investigation_id)) {
    const won = db.tx(() => {
      const r = db.run(`UPDATE investigation_verifications SET status = ?, outcome = ?, comparison_json = ?, result_id = ?, completed_at = ? WHERE id = ? AND status IN ('QUEUED','RUNNING')`,
        status, outcome, JSON.stringify(comparison), comparison?.verification?.resultId ?? null, now(), v.id);
      if (!r.changes) return false;
      const to = outcome ? OUTCOME_STATUS[outcome] : 'INCONCLUSIVE';
      db.run('UPDATE investigations SET status = ?, updated_at = ? WHERE id = ?', to, now(), inv.id);
      history(inv, 'verification_completed', null, { attempt: v.attempt, verificationId: v.uid, outcome, status: to, runId: v.run_id });
      return true;
    });
    if (won) audit(db, { projectId: inv.project_id, actor: 'verification', action: 'investigation.verified', entity: 'investigation', entityId: inv.id, detail: { attempt: v.attempt, outcome } });
    return db.get('SELECT * FROM investigation_verifications WHERE id = ?', v.id);
  }

  function verificationFor(userId, invUid, vUid) {
    const inv = byUid(invUid, userId);
    if (!inv) return { error: 404, message: 'Investigation not found' };
    const v = db.get('SELECT * FROM investigation_verifications WHERE uid = ? AND investigation_id = ?', vUid, inv.id);
    if (!v) return { error: 404, message: 'Verification not found' };
    return { verification: verificationView(refreshVerification(v)), investigation: view(db.get('SELECT * FROM investigations WHERE id = ?', inv.id)), inv };
  }

  /** Exportable report: no paths, no credentials, no stdout/stderr. Evidence is referenced by id and name only. */
  function report(userId, invUid, vUid) {
    const got = verificationFor(userId, invUid, vUid);
    if (got.error) return got;
    const { verification: v, investigation: inv, inv: row } = got;
    const project = db.get('SELECT name, app_url FROM projects WHERE id = ?', row.project_id);
    const diagnosis = latestDiagnosis(row.id);
    return { report: { schema: 'shipproof.fix-verification.v1', generatedAt: now(), investigation: inv.id, status: inv.status,
      project: { name: project.name, appUrl: redactUrl(project.app_url) },
      originalExecution: { runId: row.run_id, resultId: row.result_id, verdict: row.original_status, signature: row.signature, failure: parseJson(row.failure_json) },
      diagnosis: diagnosis ? { category: diagnosis.category, mostLikelyCause: diagnosis.mostLikelyCause, confirmedObservations: diagnosis.confirmedObservations, unknowns: diagnosis.unknowns, findings: diagnosis.findings.map((f) => ({ id: f.id, category: f.category, observation: f.observation, confidence: f.confidence, evidence: f.evidence })) } : null,
      verification: { attempt: v.attempt, status: v.status, outcome: v.outcome, label: v.outcomeLabel, runId: v.runId, completedAt: v.completedAt, comparison: v.comparison } } };
  }

  /** Re-check every open verification of a project (called when the project is read, so reloads always show truth). */
  function syncProject(projectId) {
    for (const v of db.all(`SELECT v.* FROM investigation_verifications v JOIN investigations i ON i.id = v.investigation_id WHERE i.project_id = ? AND v.status IN ('QUEUED','RUNNING')`, projectId)) refreshVerification(v);
  }

  return { createForResult, byUid, view, detail, changeStatus, addNote, refreshDiagnosis, startVerification, verificationFor, report, syncProject, verificationView,
    list: (projectId) => db.all('SELECT * FROM investigations WHERE project_id = ? ORDER BY id DESC LIMIT 200', projectId).map((i) => ({ ...view(i),
      verifications: db.get('SELECT COUNT(*) n FROM investigation_verifications WHERE investigation_id = ?', i.id).n })) };
}
