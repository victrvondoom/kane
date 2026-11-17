// Real regression trials. A known genuine defect is reintroduced into an ISOLATED copy of the demo store,
// the copy is started on its own port, and the criterion is executed through the normal engine path.
// The outcome is the comparison of the engine's verdicts with independently measured ground truth.
// Nothing here writes `results` rows, so a trial can never become release evidence.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { now } from './db.js';
import { buildObjective } from './kane.js';
import { DEFECTS, defectFor, setDefectState, measureGroundTruth } from './demo-defects.js';

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

async function startStore(dir) {
  const port = await freePort();
  const child = spawn(process.execPath, ['demo-app/server.js'], { cwd: dir, env: { ...process.env, DEMO_PORT: String(port) }, stdio: 'ignore' });
  let exited = false; child.on('exit', () => { exited = true; }); child.on('error', () => { exited = true; });
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 60 && !exited; i++) {
    try { if ((await fetch(url)).ok) return { child, url }; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  try { child.kill('SIGKILL'); } catch {}
  throw new Error('isolated demo store did not start');
}

export const engineKind = (engine) => (!engine ? 'unknown' : /fixture/i.test(engine) ? 'test-fixture' : 'kane-cli');

export async function runRegressionTrial({ db, runner, workspaceDir, dataDir, project, criterion, executionId = null }) {
  const key = defectFor(criterion.text);
  const ins = (outcome, reason) => Number(db.run(`INSERT INTO regression_trials (project_id, execution_id, criterion_id, criterion_key, defect_key, outcome, reason, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    project.id, executionId, criterion.id, criterion.key, key || 'none', outcome, reason, now(), outcome === 'pending' ? null : now()).lastInsertRowid);
  if (!key) return getTrial(db, ins('not_run', 'No known defect applies to this criterion, so no regression was executed.'));
  if (!fs.existsSync(path.join(workspaceDir, DEFECTS[key].file))) return getTrial(db, ins('not_run', 'The demo store source is not available in the workspace.'));
  const trialId = ins('pending', null);
  const runs = {};
  for (const variant of ['control', 'defect']) {
    const want = variant === 'defect';
    const dir = path.join(dataDir, 'trials', `trial-${trialId}-${variant}`);
    const rec = { status: 'not_executed', errorKind: null, reason: null, files: [] };
    let truth = { defectKey: key, defectPresent: want, measured: null, method: 'not measured' }, store = null, url = null;
    try {
      fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
      fs.cpSync(path.join(workspaceDir, 'demo-app'), path.join(dir, 'demo-app'), { recursive: true });
      const nm = path.join(workspaceDir, 'node_modules');
      if (fs.existsSync(nm)) fs.symlinkSync(fs.realpathSync(nm), path.join(dir, 'node_modules'));
      setDefectState(dir, key, want);
      truth = measureGroundTruth(dir, key);
      if (truth.defectPresent !== want) throw new Error(`ground truth mismatch: intended defect ${want ? 'present' : 'absent'}, measured ${truth.defectPresent ? 'present' : 'absent'}`);
      store = await startStore(dir); url = store.url;
      Object.assign(rec, await runner.runIsolated({ url, variables: db.all('SELECT key, value, secret FROM project_variables WHERE project_id = ?', project.id),
        objective: buildObjective({ appUrl: url, context: project.context, criterionText: criterion.text }), label: `trial-${trialId}-${variant}` }));
    } catch (e) { rec.status = 'not_executed'; rec.reason = e.message; }
    finally { try { store?.child.kill('SIGKILL'); } catch {} fs.rm(dir, { recursive: true, force: true }, () => {}); }
    db.run(`INSERT INTO regression_trial_runs (trial_id, variant, defect_present, ground_truth_json, target_url, status, error_kind, exit_code, command, summary, reason, engine, credits, duration_ms, evidence_json, started_at, finished_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, trialId, variant, truth.defectPresent ? 1 : 0, JSON.stringify(truth), url, rec.status, rec.errorKind ?? null, rec.exitCode ?? null,
      rec.command ?? null, rec.summary ?? null, rec.reason ?? null, rec.engine ?? null, rec.credits ?? null, rec.durationMs ?? null, JSON.stringify(rec.files || []), rec.startedAt ?? null, rec.finishedAt ?? now());
    runs[variant] = rec;
    if (rec.status !== 'passed' && variant === 'control') break; // without a passing control the defect run would prove nothing
  }
  const c = runs.control, d = runs.defect;
  const clean = (r) => r && !r.errorKind && (r.files?.length > 0 || r.testUrl);
  let outcome = 'inconclusive', reason;
  if (c.status !== 'passed') reason = `Control run against the healthy copy did not pass (${c.status}${c.errorKind ? '/' + c.errorKind : ''}): ${c.reason || c.summary || 'no detail'}. Detection cannot be judged.`;
  else if (!d || !['passed', 'failed'].includes(d.status) || d.errorKind) reason = `Defect run reached no verdict (${d?.status || 'not executed'}${d?.errorKind ? '/' + d.errorKind : ''}): ${d?.reason || 'no detail'}.`;
  else if (!clean(c) || !clean(d)) reason = 'A trial execution produced no evidence artifact.';
  else if (d.status === 'failed') { outcome = 'detected'; reason = 'Healthy copy passed and the copy with the reintroduced defect failed, matching ground truth.'; }
  else { outcome = 'missed'; reason = 'The copy with the reintroduced defect PASSED verification: the engine did not detect a defect that ground truth shows is present.'; }
  const engine = d?.engine || c.engine || null;
  db.run('UPDATE regression_trials SET outcome = ?, reason = ?, engine = ?, engine_kind = ?, finished_at = ? WHERE id = ?', outcome, reason, engine, engineKind(engine), now(), trialId);
  return getTrial(db, trialId);
}

export function getTrial(db, id) {
  const t = db.get('SELECT * FROM regression_trials WHERE id = ?', id);
  if (!t) return null;
  return { id: t.id, projectId: t.project_id, executionId: t.execution_id, criterionKey: t.criterion_key, defectKey: t.defect_key, outcome: t.outcome, reason: t.reason,
    engine: t.engine, engineKind: t.engine_kind, createdAt: t.created_at, finishedAt: t.finished_at,
    runs: db.all('SELECT * FROM regression_trial_runs WHERE trial_id = ? ORDER BY id', id).map((r) => ({ variant: r.variant, defectPresent: !!r.defect_present, groundTruth: JSON.parse(r.ground_truth_json),
      targetUrl: r.target_url, status: r.status, errorKind: r.error_kind, exitCode: r.exit_code, summary: r.summary, reason: r.reason, engine: r.engine, credits: r.credits, durationMs: r.duration_ms,
      evidence: JSON.parse(r.evidence_json), startedAt: r.started_at, finishedAt: r.finished_at })) };
}
export const listTrials = (db, projectId) => db.all('SELECT id FROM regression_trials WHERE project_id = ? ORDER BY id DESC', projectId).map((r) => getTrial(db, r.id));
