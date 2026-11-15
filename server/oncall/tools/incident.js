// The incident record. These tools write only to the incident itself; they are how the agent's reasoning becomes
// structured, checkable state: facts must cite evidence, hypotheses are labelled as such, and closing is validated
// against what was actually executed.
import fs from 'node:fs';
import { ToolError } from './registry.js';
import { buildReport, verificationOf, VERIFICATION_LABEL } from '../report.js';
import { removeWorktree, status as gitStatus } from '../git.js';

const S = (o = {}) => ({ type: 'string', ...o });
const REFS = { type: 'array', items: S({ pattern: '^E-\\d+$' }), maxItems: 20 };
const FIELDS = { environment: S({ maxLength: 200 }), symptoms: S({ maxLength: 1500 }), impact: S({ maxLength: 800 }), timeframe: S({ maxLength: 300 }), expected_outcome: S({ maxLength: 600 }) };

export function registerIncidentTools(reg, { cfg, store, deps }) {
  const { db, keys } = deps;
  const cite = (ctx, refs, { min = 0, what }) => {
    const list = [...new Set(refs || [])];
    if (list.length < min) throw new ToolError('evidence_required', `${what} must cite at least ${min} evidence ref (the E-n ids returned by tools you have run).`);
    const missing = store.evidence.known(ctx.session.id, list);
    if (missing.length) throw new ToolError('unknown_evidence', `Unknown evidence ref(s): ${missing.join(', ')}. Cite only refs returned by tools in this session.`);
    return list;
  };
  const snapshot = async (inc) => ({ ...store.incidents.view(inc, { full: true }), evidence: undefined, verification: await verificationOf(store, inc, cfg.repoDir) });

  reg.define({ name: 'incident_open', tier: 'read_only', description: 'Open an incident for the problem the user reported. Do this as soon as you understand what is wrong; fill the optional fields from what the user actually said and leave unknowns out.',
    input: { type: 'object', required: ['title', 'description'], properties: { title: S({ minLength: 4, maxLength: 120 }), description: S({ minLength: 8, maxLength: 2000 }), project_id: { type: 'integer', minimum: 1 }, ...FIELDS } },
    async handler(ctx, { title, description, project_id, ...fields }) {
      if (ctx.incident) throw new ToolError('incident_open', `Incident "${ctx.incident.title}" is still open. Continue it or close it first.`);
      const pid = project_id ?? ctx.session.project_id ?? null;
      if (pid && !db.get('SELECT 1 FROM projects WHERE id = ? AND user_id = ?', pid, ctx.user.id)) throw new ToolError('not_found', `Project ${pid} was not found for this account.`);
      const inc = store.incidents.open({ userId: ctx.user.id, sessionId: ctx.session.id, projectId: pid, title, description, fields });
      store.emit(ctx.session.id, 'incident.opened', { incident: store.incidents.view(inc) }, inc.id);
      return { summary: `Incident opened: ${title}`, data: { incidentId: inc.uid, stage: inc.stage, projectId: pid, missing: Object.keys(FIELDS).filter((k) => !fields[k]) } };
    } });

  reg.define({ name: 'incident_update', tier: 'read_only', needs: 'incident', description: 'Refine the incident statement as you learn more (environment, symptoms, impact, timeframe, expected outcome, linked project).',
    input: { type: 'object', properties: { title: S({ minLength: 4, maxLength: 120 }), description: S({ minLength: 8, maxLength: 2000 }), project_id: { type: 'integer', minimum: 1 }, ...FIELDS } },
    async handler(ctx, { project_id, ...f }) {
      if (project_id && !db.get('SELECT 1 FROM projects WHERE id = ? AND user_id = ?', project_id, ctx.user.id)) throw new ToolError('not_found', `Project ${project_id} was not found for this account.`);
      const inc = store.incidents.set(ctx.incident.id, { ...f, ...(project_id ? { project_id } : {}) });
      store.emit(ctx.session.id, 'incident.updated', { incident: store.incidents.view(inc) }, inc.id);
      return { summary: 'Incident statement updated', data: store.incidents.view(inc) };
    } });

  reg.define({ name: 'incident_timeline_add', tier: 'read_only', needs: 'incident', description: 'Add a dated event to the incident timeline (a deploy, a commit, the first failure, a log error). The time must come from evidence.',
    input: { type: 'object', required: ['at', 'description', 'evidence'], properties: { at: S({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}', maxLength: 40 }), description: S({ minLength: 4, maxLength: 400 }), evidence: REFS } },
    async handler(ctx, { at, description, evidence }) {
      const refs = cite(ctx, evidence, { min: 1, what: 'A timeline event' });
      db.run('INSERT INTO oncall_timeline (incident_id, at, description, evidence_refs, created_at) VALUES (?, ?, ?, ?, ?)', ctx.incident.id, at, description, JSON.stringify(refs), new Date().toISOString());
      store.incidents.advance(ctx.incident, 'investigate'); store.emit(ctx.session.id, 'incident.timeline', { at, description, evidence: refs }, ctx.incident.id);
      return { summary: `Timeline: ${at} ${description}`, data: { events: store.incidents.timeline(ctx.incident.id).length } };
    } });

  reg.define({ name: 'incident_finding', tier: 'read_only', needs: 'incident', description: 'Record a finding. kind "fact" = something a tool result directly shows (must cite that evidence). kind "hypothesis" = an explanation you have not yet confirmed. Never record a hypothesis as a fact.',
    input: { type: 'object', required: ['kind', 'statement'], properties: { kind: S({ enum: ['fact', 'hypothesis'] }), statement: S({ minLength: 6, maxLength: 600 }), evidence: REFS } },
    async handler(ctx, { kind, statement, evidence }) {
      const refs = cite(ctx, evidence, { min: kind === 'fact' ? 1 : 0, what: 'A fact' }), t = new Date().toISOString();
      const id = Number(db.run('INSERT INTO oncall_findings (incident_id, kind, statement, evidence_refs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', ctx.incident.id, kind, statement, JSON.stringify(refs), t, t).lastInsertRowid);
      store.incidents.advance(ctx.incident, 'investigate'); store.emit(ctx.session.id, 'incident.finding', { id, kind, status: 'open', statement, evidence: refs }, ctx.incident.id);
      return { summary: `${kind === 'fact' ? 'Fact' : 'Hypothesis'} recorded: ${statement}`, data: { findingId: id, kind } };
    } });

  reg.define({ name: 'incident_resolve_hypothesis', tier: 'read_only', needs: 'incident', description: 'Mark a recorded hypothesis confirmed or rejected, citing the evidence that settled it.',
    input: { type: 'object', required: ['finding_id', 'status', 'evidence'], properties: { finding_id: { type: 'integer', minimum: 1 }, status: S({ enum: ['confirmed', 'rejected'] }), evidence: REFS } },
    async handler(ctx, { finding_id, status, evidence }) {
      const f = db.get(`SELECT * FROM oncall_findings WHERE id = ? AND incident_id = ? AND kind = 'hypothesis'`, finding_id, ctx.incident.id);
      if (!f) throw new ToolError('not_found', `Hypothesis ${finding_id} was not found on this incident.`);
      const refs = [...new Set([...JSON.parse(f.evidence_refs), ...cite(ctx, evidence, { min: 1, what: 'Resolving a hypothesis' })])];
      db.run('UPDATE oncall_findings SET status = ?, evidence_refs = ?, updated_at = ? WHERE id = ?', status, JSON.stringify(refs), new Date().toISOString(), f.id);
      store.emit(ctx.session.id, 'incident.finding', { id: f.id, kind: 'hypothesis', status, statement: f.statement, evidence: refs }, ctx.incident.id);
      return { summary: `Hypothesis ${status}: ${f.statement}`, data: { findingId: f.id, status } };
    } });

  reg.define({ name: 'incident_diagnose', tier: 'read_only', needs: 'incident', description: 'Record the diagnosis: primary failure, root cause, contributing factors, affected components, downstream impact and your confidence. Cite the evidence. Whether the root cause counts as VERIFIED is decided by the server from a red/green regression proof (eng_prove_fix), not by this call.',
    input: { type: 'object', required: ['primary_failure', 'root_cause', 'confidence', 'evidence'], properties: { primary_failure: S({ minLength: 6, maxLength: 500 }), root_cause: S({ minLength: 6, maxLength: 900 }),
      contributing_factors: { type: 'array', items: S({ maxLength: 300 }), maxItems: 8 }, affected_components: { type: 'array', items: S({ maxLength: 200 }), maxItems: 12 }, downstream_impact: S({ maxLength: 600 }),
      confidence: S({ enum: ['low', 'medium', 'high'] }), evidence: REFS } },
    async handler(ctx, i) {
      const refs = cite(ctx, i.evidence, { min: 1, what: 'A diagnosis' });
      const d = { primaryFailure: i.primary_failure, rootCause: i.root_cause, contributingFactors: i.contributing_factors || [], affectedComponents: i.affected_components || [], downstreamImpact: i.downstream_impact || null, confidence: i.confidence, evidence: refs, recordedAt: new Date().toISOString() };
      let inc = store.incidents.set(ctx.incident.id, { diagnosis_json: JSON.stringify(d) }); inc = store.incidents.advance(inc, 'diagnose');
      store.emit(ctx.session.id, 'incident.diagnosis', { diagnosis: d }, inc.id);
      return { summary: `Diagnosis recorded (${i.confidence} confidence): ${i.root_cause}`, data: { stage: inc.stage, rootCauseStatus: 'supported_by_evidence_not_reproduced', note: 'To verify it, add a regression test that fails without the fix and run eng_prove_fix.' } };
    } });

  reg.define({ name: 'incident_plan', tier: 'read_only', needs: 'incident', description: 'Record the repair plan before changing anything: concrete steps, regression risks, and how you will verify the fix (including the regression test you will add).',
    input: { type: 'object', required: ['steps', 'verification'], properties: { steps: { type: 'array', items: S({ maxLength: 400 }), minItems: 1, maxItems: 12 }, regression_risks: { type: 'array', items: S({ maxLength: 300 }), maxItems: 8 }, verification: { type: 'array', items: S({ maxLength: 300 }), minItems: 1, maxItems: 8 } } },
    async handler(ctx, { steps, regression_risks = [], verification }) {
      if (!ctx.incident.diagnosis_json) throw new ToolError('workflow', 'Record the diagnosis first (incident_diagnose).');
      const plan = { steps, regressionRisks: regression_risks, verification, recordedAt: new Date().toISOString() };
      const inc = store.incidents.set(ctx.incident.id, { plan_json: JSON.stringify(plan) });
      store.emit(ctx.session.id, 'incident.plan', { plan }, inc.id);
      return { summary: `Repair plan recorded (${steps.length} step(s))`, data: plan };
    } });

  reg.define({ name: 'incident_status', tier: 'read_only', description: 'The current incident as the server has it: stage, findings, diagnosis, plan, checks, branch/commit/PR and the computed verification level. Use it to re-ground before reporting to the user.',
    async handler(ctx) {
      if (!ctx.incident) return { summary: 'No incident is open in this session', data: { incident: null, permissionLevel: ctx.session.permission_level } };
      const s = await snapshot(ctx.incident);
      return { summary: `${ctx.incident.title}: stage ${s.stage}, verification ${s.verification.level}`, data: { ...s, permissionLevel: ctx.session.permission_level, pendingAuthorizations: store.authorizations.forSession(ctx.session.id).filter((a) => a.status === 'pending') } };
    }, maxOutput: 20000 });

  reg.define({ name: 'incident_close', tier: 'read_only', needs: 'incident', description: 'Close the incident and produce the signed report. outcome "resolved" is only accepted when the records support it (see errors); use "mitigated" or "unresolved" otherwise and say plainly what is still open. List anything a human must do (deploys, restarts, merges) in follow_ups.',
    input: { type: 'object', required: ['outcome', 'summary'], properties: { outcome: S({ enum: ['resolved', 'mitigated', 'unresolved'] }), summary: S({ minLength: 20, maxLength: 2500 }), follow_ups: { type: 'array', items: S({ maxLength: 300 }), maxItems: 12 }, no_code_change_reason: S({ maxLength: 500 }) } },
    async handler(ctx, { outcome, summary, follow_ups = [], no_code_change_reason }) {
      let inc = ctx.incident; const v = await verificationOf(store, inc, cfg.repoDir);
      if (outcome === 'resolved') {
        if (!inc.diagnosis_json) throw new ToolError('not_supported_by_records', 'Cannot close as resolved without a recorded diagnosis.');
        if (v.codeChanged || inc.worktree) {
          if (!v.testsPassedOnHead) throw new ToolError('not_supported_by_records', `Cannot close as resolved: ${VERIFICATION_LABEL[v.level]}. Re-run the tests on the committed tree, or close as "unresolved"/"mitigated" and state what is unverified.`);
          if (!inc.pushed_sha || inc.pushed_sha !== inc.head_sha) throw new ToolError('not_supported_by_records', 'Cannot close as resolved: the fix has not been pushed. Push the branch and open the pull request, or close as "mitigated".');
        } else if (!no_code_change_reason) throw new ToolError('not_supported_by_records', 'No code change was made. To close as resolved, give no_code_change_reason (what resolved it, backed by evidence) — otherwise close as "unresolved".');
      }
      let dirty = false; if (inc.worktree && fs.existsSync(inc.worktree)) { dirty = (await gitStatus(inc.worktree)).length > 0; if (!dirty) await removeWorktree(cfg.repoDir, inc.worktree); }
      inc = store.incidents.set(inc.id, { status: outcome, outcome, summary: no_code_change_reason ? `${summary}\n\nNo code change: ${no_code_change_reason}` : summary, stage: 'closed', closed_at: new Date().toISOString(), ...(dirty ? {} : { worktree: null }) });
      const report = await buildReport({ store, inc, repoDir: cfg.repoDir, keys, user: ctx.user, followUps: follow_ups });
      inc = store.incidents.set(inc.id, { report_json: JSON.stringify(report.json), report_md: ctx.redactor.text(report.md) });
      store.emit(ctx.session.id, 'incident.closed', { incident: store.incidents.view(inc), verification: v.level, statement: VERIFICATION_LABEL[v.level] }, inc.id);
      return { summary: `Incident closed as ${outcome}. ${VERIFICATION_LABEL[v.level]}`, data: { outcome, verification: v.level, statement: VERIFICATION_LABEL[v.level], pullRequest: inc.pr_url, branch: inc.branch, commit: inc.head_sha, uncommittedWorkKept: dirty, reportId: inc.uid } };
    } });
}
