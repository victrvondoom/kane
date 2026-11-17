// Playtest Agent Failure Investigation & Reproduction Tests
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/db.js';
import { investigateFailure, recordInvestigation, getInvestigation, listInvestigations, DEFECT_STATUSES } from '../server/playtest.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shipproof-playtest-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
// Real schema with one project, one criterion, an original failed result (#1) and persisted replays (#2 failed, #3 passed).
function seedDb() {
  const db = openDb(fs.mkdtempSync(path.join(tmp, 'db-')));
  db.run(`INSERT INTO users (id, email, name, pass_hash, created_at) VALUES (1, 'p@example.com', 'P', 'x', 't')`);
  db.run(`INSERT INTO projects (id, user_id, name, app_url, created_at) VALUES (1, 1, 'Store App', 'http://127.0.0.1:4100/', 't')`);
  db.run(`INSERT INTO criteria (id, project_id, key, text, created_at, updated_at) VALUES (1, 1, 'AC-002', 'Total shows $72.00', 't', 't'), (2, 1, 'AC-003', 'Other', 't', 't')`);
  for (const [id, status, crit] of [[1, 'failed', 1], [2, 'failed', 1], [3, 'passed', 1], [4, 'failed', 2]]) {
    db.run(`INSERT INTO runs (id, project_id, trigger, status, created_at) VALUES (?, 1, 'full', 'completed', 't')`, id);
    db.run(`INSERT INTO results (id, run_id, criterion_id, criterion_key, criterion_text, text_hash, status) VALUES (?, ?, ?, 'AC-002', 'x', 'h', ?)`, id, id, crit, status);
  }
  return db;
}
const project = { id: 1, app_url: 'http://127.0.0.1:4100/' };
const failed = { id: 1, run_id: 1, criterion_id: 1, criterion_key: 'AC-002', status: 'failed', exit_code: 1, summary: 'Order total shows $80.00, expected $72.00',
  failing_step: JSON.stringify({ step: 3, remark: 'Order total shows $80.00, expected $72.00' }) };

test('Playtest Agent: a failure is confirmed only by an executed, persisted, failed replay', async () => {
  const db = seedDb();
  const inv = await investigateFailure({ project, result: failed, run: { id: 1 }, evidenceFiles: [{ name: 'cart.txt', kind: 'log', mime: 'text/plain', rel_path: 'cart.txt' }],
    replay: async () => ({ runId: 2, resultId: 2, status: 'failed', reason: 'total was $80.00' }) });
  assert.equal(inv.defectStatus, DEFECT_STATUSES.CONFIRMED_DEFECT);
  assert.equal(inv.reproduced, 1);
  assert.match(inv.diagnosis, /SUCCESSFULLY REPRODUCED/);
  assert.equal(inv.evidenceList.length, 1);
  const got = getInvestigation(db, recordInvestigation(db, inv));
  assert.equal(got.defectStatus, DEFECT_STATUSES.CONFIRMED_DEFECT);
  assert.deepEqual([got.replay.runId, got.replay.resultId, got.replay.status], [2, 2, 'failed']);
  assert.equal(listInvestigations(db, 1).length, 1);
  db.close();
});

test('Playtest Agent: without a replay the result is INCONCLUSIVE, never reproduced', async () => {
  const inv = await investigateFailure({ project, result: failed, run: { id: 1 } });
  assert.equal(inv.defectStatus, DEFECT_STATUSES.INCONCLUSIVE);
  assert.equal(inv.reproduced, 0);
  assert.match(inv.diagnosis, /NOT EXECUTED/);
  assert.deepEqual(inv.stepsReproduced, []);
  for (const replay of [async () => { throw new Error('browser unavailable'); }, async () => ({ runId: 9, resultId: 9, status: 'error', errorKind: 'network' }),
    async () => ({ runId: 9, resultId: 9, status: 'timeout', errorKind: 'timeout' }), async () => ({ runId: 9, resultId: null, status: 'failed' })]) {
    const i = await investigateFailure({ project, result: failed, run: { id: 1 }, replay });
    assert.equal(i.defectStatus, DEFECT_STATUSES.INCONCLUSIVE); assert.equal(i.reproduced, 0);
  }
});

test('Playtest Agent: a replay that passes means the failure was not reproduced', async () => {
  const inv = await investigateFailure({ project, result: failed, run: { id: 1 }, replay: async () => ({ runId: 3, resultId: 3, status: 'passed' }) });
  assert.equal(inv.defectStatus, DEFECT_STATUSES.UNCONFIRMED_TRANSIENT);
  assert.equal(inv.reproduced, 0);
});

test('Playtest Agent: infrastructure failures are not application failures and are never replayed', async () => {
  for (const [status, error_kind, cls] of [['error', 'network', 'network'], ['error', 'auth', 'authentication'], ['timeout', 'timeout', 'timeout'], ['error', 'interrupted', 'interrupted'],
    ['error', 'no_evidence', 'missing_evidence'], ['error', 'did_not_start', 'engine_error'], ['error', 'inconsistent', 'engine_error'], ['cancelled', 'cancelled', 'interrupted']]) {
    let replayed = false;
    const inv = await investigateFailure({ project, result: { id: 43, run_id: 11, criterion_key: 'AC-001', status, error_kind, summary: 'x' }, run: { id: 11 }, replay: async () => { replayed = true; return { runId: 2, resultId: 2, status: 'failed' }; } });
    assert.equal(inv.defectStatus, DEFECT_STATUSES.NOT_APPLICATION_FAILURE, error_kind);
    assert.equal(inv.classification, cls);
    assert.equal(inv.reproduced, 0);
    assert.equal(replayed, false);
  }
});

test('Playtest Agent: a reproduction claim not backed by a real failed replay row is downgraded on persist', async () => {
  const db = seedDb();
  const claims = [
    { replayRunId: 99, replayResultId: 99 },   // execution that does not exist
    { replayRunId: 1, replayResultId: 1 },     // the original result presented as its own replay
    { replayRunId: 3, replayResultId: 3 },     // a replay that actually passed
    { replayRunId: 4, replayResultId: 4 },     // a failure of a different criterion
    { replayRunId: null, replayResultId: null },
  ];
  for (const c of claims) {
    const id = recordInvestigation(db, { projectId: 1, runId: 1, resultId: 1, criterionKey: 'AC-002', defectStatus: DEFECT_STATUSES.CONFIRMED_DEFECT, diagnosis: 'trust me', reproduced: 1, ...c });
    const got = getInvestigation(db, id);
    assert.equal(got.reproduced, false, JSON.stringify(c));
    assert.equal(got.defectStatus, DEFECT_STATUSES.INCONCLUSIVE);
  }
  db.close();
});
