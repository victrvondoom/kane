// The incident report is assembled from recorded facts only: what ran, on which tree, with which exit status.
// The agent contributes prose (diagnosis, summary); every verification statement below is computed here.
import { git } from './git.js';
import { canonical, sha256 } from '../keys.js';

const J = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

/** What the records actually prove about this incident's fix. */
export async function verificationOf(store, inc, repoDir) {
  const checks = store.incidents.checks(inc.id);
  const last = (f) => [...checks].reverse().find(f) || null;
  let headTree = null;
  if (inc.head_sha) headTree = (await git(repoDir, ['rev-parse', `${inc.head_sha}^{tree}`], { allowFail: true })).stdout.trim() || null;
  const suite = last((c) => c.phase === 'verify' && c.kind === 'test');
  const red = last((c) => c.phase === 'proof_red'), green = last((c) => c.phase === 'proof_green');
  const suiteOnHead = !!suite && !!headTree && suite.treeSha === headTree;
  const proof = red && green ? { reproducedBeforeFix: red.status === 'failed', passesAfterFix: green.status === 'passed', greenOnHead: !!headTree && green.treeSha === headTree, tests: green.target, red: red.evidence, green: green.evidence } : null;
  const reproduced = !!proof && proof.reproducedBeforeFix && proof.passesAfterFix;
  const testsPassed = !!suite && suite.status === 'passed' && suiteOnHead;
  return {
    codeChanged: !!inc.head_sha && inc.head_sha !== inc.base_sha, headTree,
    testSuite: suite ? { status: suite.status, command: suite.command, exitCode: suite.exitCode, ranOnCommittedTree: suiteOnHead, evidence: suite.evidence, at: suite.at } : null,
    regressionProof: proof, testsPassedOnHead: testsPassed, rootCauseReproduced: reproduced,
    otherChecks: checks.filter((c) => c.phase === 'verify' && c.kind !== 'test').map((c) => ({ kind: c.kind, target: c.target, status: c.status, evidence: c.evidence })),
    // One word for the UI and the spoken summary; never upgraded by anything the model says.
    level: !inc.head_sha || inc.head_sha === inc.base_sha ? 'no_code_change' : testsPassed && reproduced ? 'verified' : testsPassed ? 'tests_passed' : suite ? 'failed' : 'unverified',
  };
}
export const VERIFICATION_LABEL = { verified: 'Verified — failure reproduced before the fix, test suite passes after it', tests_passed: 'Test suite passes on the committed fix (original failure not reproduced by a regression test)',
  failed: 'NOT verified — the last test run did not pass on the committed tree', unverified: 'NOT verified — no test run on the committed tree', no_code_change: 'No code change was made' };

export async function buildReport({ store, inc, repoDir, keys, user, followUps = [] }) {
  const v = await verificationOf(store, inc, repoDir), full = store.incidents.view(inc, { full: true });
  const d = full.diagnosis, doc = {
    kind: 'shipproof.oncall.incident-report', version: 1, incident: { id: inc.uid, title: inc.title, description: inc.description, environment: inc.environment, symptoms: inc.symptoms, impact: inc.impact, timeframe: inc.timeframe,
      expectedOutcome: inc.expected_outcome, projectId: inc.project_id, openedAt: inc.created_at, closedAt: inc.closed_at, outcome: inc.outcome, summary: inc.summary, handledFor: user?.name || null },
    timeline: full.timeline, facts: full.findings.filter((f) => f.kind === 'fact'), hypotheses: full.findings.filter((f) => f.kind === 'hypothesis'),
    diagnosis: d ? { ...d, rootCauseStatus: v.rootCauseReproduced ? 'verified_by_reproduction' : 'supported_by_evidence_not_reproduced' } : null,
    repairPlan: full.plan, verification: v, verificationStatement: VERIFICATION_LABEL[v.level],
    delivery: { branch: inc.branch, baseBranch: inc.base_branch, baseSha: inc.base_sha, commit: inc.head_sha, pushed: !!inc.pushed_sha && inc.pushed_sha === inc.head_sha, pullRequest: inc.pr_url ? { url: inc.pr_url, number: inc.pr_number } : null },
    checks: full.checks.map(({ outputTail, ...c }) => c), authorizations: full.authorizations, followUps,
    evidence: full.evidence.map((e) => ({ ref: e.ref, tool: e.tool, tier: e.tier, ok: e.ok, summary: e.summary, sha256: e.sha256, at: e.at })),
  };
  const payload = canonical(doc), signature = keys ? { algorithm: 'ed25519', keyId: keys.keyId, publicKey: keys.publicKey, payloadSha256: sha256(payload), value: keys.sign(payload) } : null;
  return { json: { ...doc, signature }, md: markdown(doc, signature) };
}

const refs = (a) => (a?.length ? ` _(${a.join(', ')})_` : '');
function markdown(r, sig) {
  const L = [], v = r.verification, d = r.diagnosis, add = (...x) => L.push(...x);
  add(`# Incident report — ${r.incident.title}`, '', `**Outcome:** ${String(r.incident.outcome || 'open').toUpperCase()}  `, `**Verification:** ${r.verificationStatement}  `, `**Opened:** ${r.incident.openedAt} · **Closed:** ${r.incident.closedAt || '—'}`, '');
  add('## Summary', r.incident.summary || '_No summary recorded._', '');
  add('## Incident', `- **Reported:** ${r.incident.description}`, ...[['Environment', r.incident.environment], ['Symptoms', r.incident.symptoms], ['Impact', r.incident.impact], ['Timeframe', r.incident.timeframe], ['Expected outcome', r.incident.expectedOutcome]].filter(([, x]) => x).map(([k, x]) => `- **${k}:** ${x}`), '');
  if (r.timeline.length) add('## Timeline', ...r.timeline.map((t) => `- \`${t.at}\` ${t.description}${refs(t.evidence)}`), '');
  add('## Observed facts', ...(r.facts.length ? r.facts.map((f) => `- ${f.statement}${refs(f.evidence)}`) : ['_None recorded._']), '');
  if (r.hypotheses.length) add('## Hypotheses', ...r.hypotheses.map((f) => `- **${f.status}** — ${f.statement}${refs(f.evidence)}`), '');
  if (d) add('## Diagnosis', `- **Primary failure:** ${d.primaryFailure}`, `- **Root cause:** ${d.rootCause}`, `- **Root cause status:** ${d.rootCauseStatus === 'verified_by_reproduction' ? 'verified by reproduction (regression test fails before the fix, passes after)' : 'supported by evidence, not reproduced'}`,
    `- **Confidence (agent’s assessment):** ${d.confidence}`, ...(d.contributingFactors?.length ? [`- **Contributing factors:** ${d.contributingFactors.join('; ')}`] : []), ...(d.affectedComponents?.length ? [`- **Affected components:** ${d.affectedComponents.join(', ')}`] : []),
    ...(d.downstreamImpact ? [`- **Downstream impact:** ${d.downstreamImpact}`] : []), `- **Evidence:** ${d.evidence.join(', ')}`, '');
  if (r.repairPlan) add('## Repair plan', ...r.repairPlan.steps.map((s, i) => `${i + 1}. ${s}`), ...(r.repairPlan.regressionRisks?.length ? ['', '**Regression risks:** ' + r.repairPlan.regressionRisks.join('; ')] : []), '');
  add('## Verification (computed from recorded executions)');
  if (v.testSuite) add(`- Test suite \`${v.testSuite.command}\`: **${v.testSuite.status}** (exit ${v.testSuite.exitCode ?? '—'}), ${v.testSuite.ranOnCommittedTree ? 'on the committed tree' : '**not on the committed tree**'} _(${v.testSuite.evidence})_`);
  else add('- Test suite: **not run**');
  if (v.regressionProof) add(`- Regression proof (${[].concat(v.regressionProof.tests).join(', ')}): before the fix **${v.regressionProof.reproducedBeforeFix ? 'failed (failure reproduced)' : 'did not fail'}** _(${v.regressionProof.red})_, after the fix **${v.regressionProof.passesAfterFix ? 'passed' : 'did not pass'}** _(${v.regressionProof.green})_`);
  else add('- Regression proof: none');
  for (const c of v.otherChecks) add(`- ${c.kind}${c.target ? ` ${c.target}` : ''}: ${c.status} _(${c.evidence})_`);
  add('', '## Delivery', `- Branch: ${r.delivery.branch ? `\`${r.delivery.branch}\` (from \`${r.delivery.baseBranch}\` @ ${String(r.delivery.baseSha).slice(0, 12)})` : 'none'}`, `- Commit: ${r.delivery.commit ? `\`${r.delivery.commit}\`` : 'none'}`,
    `- Pushed: ${r.delivery.pushed ? 'yes' : 'no'}`, `- Pull request: ${r.delivery.pullRequest ? r.delivery.pullRequest.url : 'none'}`, '');
  if (r.authorizations.length) add('## Production authorizations', ...r.authorizations.map((a) => `- ${a.action}: **${a.status}** (requested ${a.requestedAt})`), '');
  if (r.followUps.length) add('## Follow-ups for a human', ...r.followUps.map((f) => `- ${f}`), '');
  add('## Evidence ledger', '| Ref | Tool | Result | Summary | SHA-256 |', '|---|---|---|---|---|', ...r.evidence.map((e) => `| ${e.ref} | ${e.tool} | ${e.ok ? 'ok' : 'error'} | ${String(e.summary).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 140)} | \`${e.sha256.slice(0, 16)}\` |`), '');
  if (sig) add('---', `Signed (Ed25519, key \`${sig.keyId}\`). Payload SHA-256 \`${sig.payloadSha256}\`. The JSON form of this report carries the signature and public key for offline verification.`);
  return L.join('\n');
}
