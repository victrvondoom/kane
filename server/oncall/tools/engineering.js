// Engineering execution: an isolated branch, file edits, allowlisted checks, a red/green regression proof, commit,
// push and pull request — plus the single production action this server can execute (merge), which needs an approver.
import fs from 'node:fs';
import path from 'node:path';
import { ToolError } from './registry.js';
import { git, safePath, isDenied, defaultBranch, createWorktree, scratchWorktree, treeSha, headSha, status as gitStatus, integrityViolations, commitAll, pushBranch, repoInfo, parseGithubRepo, slugify } from '../git.js';
import { resolveCheck, runCheck, testCounts, honest } from '../checks.js';
import { verificationOf, VERIFICATION_LABEL } from '../report.js';

const S = (o = {}) => ({ type: 'string', ...o });
const tail = (s, n) => { const t = String(s || ''); return t.length > n ? `… [${t.length - n} earlier characters omitted]\n${t.slice(-n)}` : t; };

export function registerEngineeringTools(reg, { cfg, store, deps }) {
  const { db, dataDir, github } = deps;
  const worktreesDir = path.join(dataDir, 'oncall', 'worktrees');
  const editable = (inc, rel) => { if (isDenied(rel)) throw new ToolError('protected_path', `${rel} is protected (secrets, data, dependencies or git internals) and cannot be modified by the agent.`); return safePath(inc.worktree, rel); };
  const touched = (ctx) => { const inc = store.incidents.byId(ctx.incident.id); if (inc.stage === 'verify' || inc.stage === 'deliver') return inc; return store.incidents.advance(inc, 'repair'); };
  const recordCheck = (inc, phase, kind, target, r, tree) => Number(db.run('INSERT INTO oncall_checks (incident_id, phase, kind, target, command, status, exit_code, tree_sha, output_tail, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    inc.id, phase, kind, target ? [].concat(target).join(' ') : null, r.command, r.status, r.exitCode, tree, tail(r.output, 6000), r.durationMs, new Date().toISOString()).lastInsertRowid);
  const linkEvidence = (ids) => (ref) => { for (const id of ids) db.run('UPDATE oncall_checks SET evidence_ref = ? WHERE id = ?', ref, id); };

  reg.define({ name: 'eng_start_branch', tier: 'engineering', needs: 'plan', description: 'Create the dedicated repair branch (oncall/…) in an isolated git worktree cut from the repository’s real default branch. All edits, checks and commits for this incident happen there; the running checkout is never touched.',
    input: { type: 'object', properties: { slug: S({ maxLength: 60 }) } },
    async handler(ctx, { slug }) {
      const inc = ctx.incident;
      if (inc.worktree) throw new ToolError('branch_exists', `Repair branch ${inc.branch} already exists for this incident.`);
      const base = await defaultBranch(cfg.repoDir, cfg.baseBranch), branch = `${cfg.branchPrefix}inc-${inc.id}-${slugify(slug || inc.title)}`;
      const wt = await createWorktree({ repoDir: cfg.repoDir, worktreesDir, branch, base, prefix: cfg.branchPrefix });
      store.incidents.set(inc.id, { repo_dir: cfg.repoDir, worktree: wt.dir, branch, base_branch: base, base_sha: wt.baseSha, head_sha: wt.baseSha });
      store.incidents.advance(store.incidents.byId(inc.id), 'repair');
      store.emit(ctx.session.id, 'git.branch', { branch, base, baseSha: wt.baseSha }, inc.id);
      return { summary: `Created ${branch} from ${wt.startedFrom} @ ${wt.baseSha.slice(0, 7)}`, data: { branch, baseBranch: base, baseSha: wt.baseSha, startedFrom: wt.startedFrom }, meta: { branch } };
    } });

  reg.define({ name: 'eng_write_file', tier: 'engineering', needs: 'branch', description: 'Create a file or replace its whole content on the repair branch (use for new files such as regression tests; prefer eng_edit_file for changes to existing code).',
    input: { type: 'object', required: ['path', 'content'], properties: { path: S({ maxLength: 400 }), content: S({ maxLength: 300000 }) } },
    async handler(ctx, { path: rel, content }) {
      const abs = editable(ctx.incident, rel), existed = fs.existsSync(abs);
      if (existed && !fs.statSync(abs).isFile()) throw new ToolError('not_a_file', `${rel} is not a regular file`);
      fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, content);
      touched(ctx); store.emit(ctx.session.id, 'git.edit', { path: rel, action: existed ? 'rewritten' : 'created', lines: content.split('\n').length }, ctx.incident.id);
      return { summary: `${existed ? 'Rewrote' : 'Created'} ${rel} (${content.split('\n').length} lines)`, data: { path: rel, created: !existed, bytes: Buffer.byteLength(content) }, meta: { path: rel } };
    } });

  reg.define({ name: 'eng_edit_file', tier: 'engineering', needs: 'branch', description: 'Replace an exact snippet in a file on the repair branch. old_text must match exactly and (unless replace_all) exactly once — read the file first.',
    input: { type: 'object', required: ['path', 'old_text', 'new_text'], properties: { path: S({ maxLength: 400 }), old_text: S({ minLength: 1, maxLength: 60000 }), new_text: S({ maxLength: 60000 }), replace_all: { type: 'boolean' } } },
    async handler(ctx, { path: rel, old_text, new_text, replace_all }) {
      const abs = editable(ctx.incident, rel);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new ToolError('not_found', `${rel} does not exist on the repair branch`);
      const src = fs.readFileSync(abs, 'utf8'), n = src.split(old_text).length - 1;
      if (n === 0) throw new ToolError('no_match', `old_text was not found in ${rel}. Re-read the file; the text must match exactly, including whitespace.`);
      if (n > 1 && !replace_all) throw new ToolError('ambiguous', `old_text occurs ${n} times in ${rel}. Include more surrounding context or set replace_all.`);
      if (old_text === new_text) throw new ToolError('no_change', 'old_text and new_text are identical');
      fs.writeFileSync(abs, replace_all ? src.split(old_text).join(new_text) : src.replace(old_text, () => new_text));
      touched(ctx); store.emit(ctx.session.id, 'git.edit', { path: rel, action: 'edited', replacements: replace_all ? n : 1 }, ctx.incident.id);
      return { summary: `Edited ${rel} (${replace_all ? n : 1} replacement(s))`, data: { path: rel, replacements: replace_all ? n : 1 }, meta: { path: rel } };
    } });

  reg.define({ name: 'eng_run_check', tier: 'engineering', needs: 'branch', description: 'Run an allowlisted check on the repair branch and get its REAL exit status and output. kind: "test" (the configured full test command), "test_file" (node --test on specific test files), "syntax" (node --check one file), "build", "lint". You cannot pass a command line.',
    input: { type: 'object', required: ['kind'], properties: { kind: S({ enum: ['test', 'test_file', 'syntax', 'build', 'lint'] }), target: S({ maxLength: 400 }), targets: { type: 'array', items: S({ maxLength: 400 }), maxItems: 10 } } },
    async handler(ctx, { kind, target, targets }) {
      const inc = ctx.incident, t = targets?.length ? targets : target;
      if ((kind === 'test_file' || kind === 'syntax') && !t) throw new ToolError('invalid_input', `${kind} needs a target file`);
      let argv; try { argv = resolveCheck(cfg, inc.worktree, kind, t); } catch (e) { throw new ToolError('check_unavailable', e.message); }
      const tree = await treeSha(inc.worktree);
      store.emit(ctx.session.id, 'check.started', { kind, target: t || null }, inc.id);
      const r = honest(kind, await runCheck({ argv, cwd: inc.worktree, timeoutMs: cfg.checkTimeoutMs, signal: ctx.signal }));
      const id = recordCheck(inc, 'verify', kind, t, r, tree), counts = testCounts(r.output);
      const cur = store.incidents.byId(inc.id); if (cur.stage !== 'deliver') store.incidents.advance(cur, 'verify');
      store.emit(ctx.session.id, 'check.finished', { checkId: id, kind, target: t || null, status: r.status, exitCode: r.exitCode, durationMs: r.durationMs, counts }, inc.id);
      return { summary: `${kind}${t ? ` ${[].concat(t).join(' ')}` : ''}: ${r.status.toUpperCase()} (exit ${r.exitCode ?? '—'}, ${Math.round(r.durationMs / 100) / 10}s)${counts ? ` — ${counts.pass ?? '?'} passed, ${counts.fail ?? '?'} failed` : ''}`,
        data: { status: r.status, exitCode: r.exitCode, command: r.command, durationMs: r.durationMs, counts, treeSha: tree, output: tail(ctx.redactor.text(r.output), 7000) }, after: linkEvidence([id]), meta: { checkId: id, status: r.status } };
    }, maxOutput: 9000 });

  reg.define({ name: 'eng_prove_fix', tier: 'engineering', needs: 'branch', description: 'Prove the fix addresses the diagnosed failure: runs the given regression test file(s) against the code BEFORE your change (must fail — the failure is reproduced) and against the repair branch (must pass). This is the only way a root cause becomes "verified". The test files must exist on the repair branch.',
    input: { type: 'object', required: ['test_files'], properties: { test_files: { type: 'array', items: S({ maxLength: 400 }), minItems: 1, maxItems: 6 } } },
    async handler(ctx, { test_files }) {
      const inc = ctx.incident; let argv;
      try { argv = resolveCheck(cfg, inc.worktree, 'test_file', test_files); } catch (e) { throw new ToolError('check_unavailable', e.message); }
      const rels = argv.slice(2);
      const scratch = await scratchWorktree({ repoDir: cfg.repoDir, worktreesDir, sha: inc.base_sha, name: `proof-${inc.id}-${Date.now()}` });
      let red;
      try {
        for (const rel of rels) { const to = path.join(scratch.dir, rel); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(inc.worktree, rel), to); }
        store.emit(ctx.session.id, 'check.started', { kind: 'proof', target: rels, phase: 'before fix' }, inc.id);
        red = honest('test_file', await runCheck({ argv, cwd: scratch.dir, timeoutMs: cfg.checkTimeoutMs, signal: ctx.signal }));
      } finally { await scratch.remove(); }
      const tree = await treeSha(inc.worktree);
      store.emit(ctx.session.id, 'check.started', { kind: 'proof', target: rels, phase: 'after fix' }, inc.id);
      const green = honest('test_file', await runCheck({ argv, cwd: inc.worktree, timeoutMs: cfg.checkTimeoutMs, signal: ctx.signal }));
      const ids = [recordCheck(inc, 'proof_red', 'test_file', rels, red, inc.base_sha), recordCheck(inc, 'proof_green', 'test_file', rels, green, tree)];
      const proven = red.status === 'failed' && green.status === 'passed';
      store.emit(ctx.session.id, 'check.proof', { tests: rels, before: red.status, after: green.status, proven }, inc.id);
      const why = proven ? 'The failure is reproduced without the fix and gone with it.' : red.status !== 'failed' ? `The test did not fail on the code before the fix (${red.status}) — it does not reproduce the reported failure, so the root cause stays unverified.` : `The test still does not pass on the repair branch (${green.status}).`;
      return { summary: `Regression proof ${proven ? 'HOLDS' : 'DOES NOT HOLD'}: before fix ${red.status}, after fix ${green.status}`, data: { proven, explanation: why, beforeFix: { status: red.status, exitCode: red.exitCode, output: tail(ctx.redactor.text(red.output), 2500) }, afterFix: { status: green.status, exitCode: green.exitCode, output: tail(ctx.redactor.text(green.output), 2500) } },
        after: linkEvidence(ids), meta: { proven } };
    }, maxOutput: 9000 });

  reg.define({ name: 'eng_status', tier: 'engineering', needs: 'branch', description: 'State of the repair branch: changed files, diff stat against the base, integrity-guard findings, HEAD, and what the recorded checks currently prove.',
    async handler(ctx) {
      const inc = ctx.incident, st = await gitStatus(inc.worktree), viol = await integrityViolations(inc.worktree, inc.base_sha);
      const stat = (await git(inc.worktree, ['diff', '--stat', inc.base_sha, '--', '.'])).stdout.trim();
      const v = await verificationOf(store, { ...inc, head_sha: await headSha(inc.worktree) }, cfg.repoDir);
      return { summary: `${inc.branch}: ${st.length} uncommitted change(s); verification ${v.level}${viol.length ? `; ${viol.length} integrity violation(s)` : ''}`,
        data: { branch: inc.branch, base: `${inc.base_branch}@${inc.base_sha.slice(0, 12)}`, head: await headSha(inc.worktree), uncommitted: st, diffStatAgainstBase: stat || 'no changes', integrityViolations: viol, verification: v, statement: VERIFICATION_LABEL[v.level] } };
    } });

  reg.define({ name: 'eng_commit', tier: 'engineering', needs: 'branch', description: 'Commit all changes on the repair branch with a meaningful message (subject line ≤ 72 chars, then why). Refused if the change weakens checks (deleted tests, skip/only markers, protected paths).',
    input: { type: 'object', required: ['message'], properties: { message: S({ minLength: 10, maxLength: 3000 }) } },
    async handler(ctx, { message }) {
      const inc = ctx.incident, viol = await integrityViolations(inc.worktree, inc.base_sha);
      if (viol.length) throw new ToolError('integrity_violation', `Commit refused — the change weakens verification instead of fixing the problem:\n- ${viol.join('\n- ')}\nRevert those parts and fix the underlying defect.`);
      const subject = message.split('\n')[0];
      if (subject.length > 100) throw new ToolError('invalid_input', 'The commit subject line is too long (max 100 characters).');
      const c = await commitAll(inc.worktree, `${message.trim()}\n\nOn-call incident: ${inc.uid}\nRequested-by: ${ctx.user.name}`, { name: 'SHIPPROOF On-Call Agent', email: 'oncall-agent@shipproof.invalid' });
      store.incidents.set(inc.id, { head_sha: c.sha });
      store.emit(ctx.session.id, 'git.commit', { sha: c.sha, subject, files: c.files }, inc.id);
      return { summary: `Committed ${c.sha.slice(0, 7)}: ${subject} (${c.files.length} file(s))`, data: { sha: c.sha, files: c.files, note: 'Checks recorded before this commit still count only if they ran on exactly this tree.' }, meta: { sha: c.sha } };
    } });

  /** Shared delivery gate: nothing leaves this machine unless the committed tree is the tree the tests passed on. */
  const deliverable = async (inc) => {
    if ((await gitStatus(inc.worktree)).length) throw new ToolError('uncommitted_changes', 'There are uncommitted changes on the repair branch. Commit them (and re-run the tests) before delivering.');
    const head = await headSha(inc.worktree);
    if (head === inc.base_sha) throw new ToolError('nothing_to_deliver', 'The repair branch has no commits beyond its base.');
    const viol = await integrityViolations(inc.worktree, inc.base_sha);
    if (viol.length) throw new ToolError('integrity_violation', `Delivery refused:\n- ${viol.join('\n- ')}`);
    const v = await verificationOf(store, { ...inc, head_sha: head }, cfg.repoDir);
    if (!v.testsPassedOnHead) throw new ToolError('not_verified', `Delivery refused: ${VERIFICATION_LABEL[v.level]}. ${v.testSuite ? (v.testSuite.status !== 'passed' ? `The last run of "${v.testSuite.command}" ${v.testSuite.status}.` : 'The tests passed on a different tree than the one committed — run eng_run_check kind "test" again.') : 'Run eng_run_check kind "test" first.'} Tell the user the fix is not verified rather than pushing it.`);
    return { head, v };
  };

  reg.define({ name: 'eng_push', tier: 'engineering', needs: 'branch', description: 'Push the repair branch to the remote. Only succeeds when everything is committed and the full test command passed on exactly the committed tree. Never pushes the default branch and never force-pushes.',
    async handler(ctx) {
      const inc = ctx.incident, { head, v } = await deliverable(inc);
      const r = await pushBranch({ dir: inc.worktree, branch: inc.branch, base: inc.base_branch, prefix: cfg.branchPrefix, token: cfg.github.token });
      store.incidents.set(inc.id, { head_sha: head, pushed_sha: head }); store.incidents.advance(store.incidents.byId(inc.id), 'deliver');
      store.emit(ctx.session.id, 'git.push', { branch: inc.branch, sha: head, verification: v.level }, inc.id);
      return { summary: `Pushed ${inc.branch} @ ${head.slice(0, 7)} (${VERIFICATION_LABEL[v.level]})`, data: { branch: inc.branch, sha: head, attempts: r.attempts, verification: v.level }, meta: { sha: head } };
    } });

  const prBody = (inc, v, summary) => {
    const d = JSON.parse(inc.diagnosis_json), p = JSON.parse(inc.plan_json);
    return [`## Incident`, inc.description, '', '## Root cause', d.rootCause, '', `- Primary failure: ${d.primaryFailure}`, `- Root cause status: ${v.rootCauseReproduced ? 'verified by reproduction' : 'supported by evidence, not reproduced'} (agent confidence: ${d.confidence})`, '',
      '## Change', summary, '', '## Verification', `- ${VERIFICATION_LABEL[v.level]}`, v.testSuite ? `- \`${v.testSuite.command}\` → ${v.testSuite.status} (exit ${v.testSuite.exitCode})` : '- test suite not run',
      v.regressionProof ? `- Regression test ${[].concat(v.regressionProof.tests).join(', ')}: before fix ${v.regressionProof.reproducedBeforeFix ? 'fails' : 'does not fail'}, after fix ${v.regressionProof.passesAfterFix ? 'passes' : 'does not pass'}` : '- no red/green regression proof',
      ...(p.regressionRisks?.length ? ['', '## Regression risks', ...p.regressionRisks.map((r) => `- ${r}`)] : []), '', `---`, `Opened by the SHIPPROOF on-call agent for ${inc.uid}. Review before merging; the agent cannot merge without an approver.`].join('\n');
  };
  reg.define({ name: 'eng_open_pull_request', tier: 'engineering', needs: 'branch', description: 'Open a draft pull request for the pushed repair branch against the default branch. The description is assembled by the server from the recorded diagnosis and verification; you supply the title and a short description of the change.',
    input: { type: 'object', required: ['title', 'summary'], properties: { title: S({ minLength: 8, maxLength: 120 }), summary: S({ minLength: 20, maxLength: 3000 }) } },
    async handler(ctx, { title, summary }) {
      const inc = ctx.incident, head = await headSha(inc.worktree);
      if (!inc.pushed_sha || inc.pushed_sha !== head) throw new ToolError('not_pushed', 'Push the repair branch first (eng_push); the pull request must point at the verified commit.');
      const repo = cfg.github.repo || parseGithubRepo((await repoInfo(cfg.repoDir)).remote);
      if (!repo) throw new ToolError('github_not_configured', 'Could not determine the GitHub repository. Set ONCALL_GITHUB_REPO=owner/name on the server.');
      const v = await verificationOf(store, inc, cfg.repoDir);
      const pr = await github.openPullRequest({ repo, head: inc.branch, base: inc.base_branch, title, body: ctx.redactor.text(prBody(inc, v, summary)), draft: true });
      store.incidents.set(inc.id, { pr_url: pr.url, pr_number: pr.number });
      store.emit(ctx.session.id, 'git.pr', { url: pr.url, number: pr.number, existing: pr.existing }, inc.id);
      return { summary: `${pr.existing ? 'Pull request already open' : 'Opened draft pull request'} #${pr.number}: ${pr.url}`, data: { number: pr.number, url: pr.url, base: inc.base_branch, head: inc.branch, draft: pr.draft }, meta: { url: pr.url } };
    } });

  // ---------------- production ----------------
  const mergeParams = (inc) => ({ pullRequest: inc?.pr_number ?? null, sha: inc?.pushed_sha ?? null });
  reg.define({ name: 'request_production_action', tier: 'engineering', needs: 'incident', description: 'Ask a human approver to authorize a production action. The only production action this server can execute is "merge_pull_request" (merging this incident’s pull request). The approval is given on screen by a signed-in approver — never by voice — and is valid once, for exactly this pull request and commit. Deployments, restarts, database operations, credential rotation and deletions are not available to you at all: list them as follow_ups when closing.',
    input: { type: 'object', required: ['action', 'reason'], properties: { action: S({ enum: ['merge_pull_request'] }), reason: S({ minLength: 10, maxLength: 600 }) } },
    async handler(ctx, { action, reason }) {
      const inc = ctx.incident;
      if (!inc.pr_number) throw new ToolError('workflow', 'There is no pull request to merge yet.');
      const a = store.authorizations.request({ sessionId: ctx.session.id, incidentId: inc.id, action: 'prod_merge_pull_request', params: mergeParams(inc), reason, ttlMs: cfg.authorizationTtlMs });
      store.emit(ctx.session.id, 'authorization.requested', { authorization: a, pullRequest: inc.pr_url }, inc.id);
      return { summary: `Authorization ${a.status} for ${action} (PR #${inc.pr_number})`, data: { authorizationId: a.id, status: a.status, expiresAt: a.expiresAt, note: a.status === 'approved' ? 'Approved — you may run prod_merge_pull_request once.' : 'Waiting for an approver to confirm on the call screen. Tell the user, then stop and wait; do not retry in a loop.' } };
    } });

  reg.define({ name: 'prod_merge_pull_request', tier: 'production', needs: 'branch', authorizes: (ctx, input, inc) => mergeParams(inc), description: 'Merge this incident’s pull request. Runs only with a fresh on-screen approval obtained through request_production_action.',
    async handler(ctx) {
      const inc = ctx.incident, repo = cfg.github.repo || parseGithubRepo((await repoInfo(cfg.repoDir)).remote);
      const r = await github.mergePullRequest({ repo, number: inc.pr_number, sha: inc.pushed_sha });
      if (!r.merged) throw new ToolError('merge_failed', `GitHub did not merge the pull request: ${r.message || 'unknown reason'}`);
      store.emit(ctx.session.id, 'git.merge', { number: inc.pr_number, sha: r.sha }, inc.id);
      return { summary: `Merged pull request #${inc.pr_number} (${String(r.sha).slice(0, 7)})`, data: r };
    } });
}
