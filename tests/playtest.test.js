// Playtest Agent Failure Investigation & Reproduction Tests
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  investigateFailure,
  recordInvestigation,
  getInvestigation,
  listInvestigations,
  DEFECT_STATUSES,
} from '../server/playtest.js';

function createMockDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, app_url TEXT);
    INSERT INTO projects VALUES (1, 'Store App', 'http://127.0.0.1:4100/');
    CREATE TABLE playtest_investigations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      run_id INTEGER,
      result_id INTEGER,
      criterion_key TEXT NOT NULL,
      defect_status TEXT NOT NULL,
      diagnosis TEXT NOT NULL,
      reproduced INTEGER NOT NULL DEFAULT 0,
      steps_reproduced TEXT DEFAULT '[]',
      evidence_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
  `);
  return {
    raw: db,
    get: (sql, ...p) => db.prepare(sql).get(...p),
    all: (sql, ...p) => db.prepare(sql).all(...p),
    run: (sql, ...p) => db.prepare(sql).run(...p),
  };
}

test('Playtest Agent: confirms genuine application defect from Kane failure', async () => {
  const project = { id: 1, app_url: 'http://127.0.0.1:4100/' };
  const failedResult = {
    id: 42,
    run_id: 10,
    criterion_key: 'AC-002',
    status: 'failed',
    exit_code: 1,
    summary: 'Order total shows $80.00, expected $72.00',
    failing_step: JSON.stringify({ step: 3, remark: 'Order total shows $80.00, expected $72.00' }),
  };
  const evidenceFiles = [
    { name: 'cart-after-coupon.txt', kind: 'log', mime: 'text/plain', rel_path: 'cart.txt' },
  ];

  const inv = await investigateFailure({
    project,
    result: failedResult,
    run: { id: 10 },
    evidenceFiles,
  });

  assert.equal(inv.defectStatus, DEFECT_STATUSES.CONFIRMED_DEFECT);
  assert.equal(inv.reproduced, 1);
  assert.equal(inv.criterionKey, 'AC-002');
  assert.match(inv.diagnosis, /SUCCESSFULLY REPRODUCED/);
  assert.equal(inv.evidenceList.length, 1);
});

test('Playtest Agent: classifies network / environment failure as unconfirmed transient', async () => {
  const project = { id: 1, app_url: 'http://127.0.0.1:4100/' };
  const networkErrorResult = {
    id: 43,
    run_id: 11,
    criterion_key: 'AC-001',
    status: 'error',
    error_kind: 'network',
    summary: 'Connection refused at 127.0.0.1:9',
  };

  const inv = await investigateFailure({
    project,
    result: networkErrorResult,
    run: { id: 11 },
  });

  assert.equal(inv.defectStatus, DEFECT_STATUSES.UNCONFIRMED_TRANSIENT);
  assert.equal(inv.reproduced, 0);
  assert.match(inv.diagnosis, /classified as network/);
});

test('Playtest Agent: persists investigations with replay steps and evidence cards', async () => {
  const db = createMockDb();
  const project = { id: 1, app_url: 'http://127.0.0.1:4100/' };
  const failedResult = {
    id: 50,
    run_id: 12,
    criterion_key: 'AC-005',
    status: 'failed',
    exit_code: 1,
    summary: 'Catalogue did not show discounted item',
  };

  const inv = await investigateFailure({ project, result: failedResult, run: { id: 12 } });
  const invId = recordInvestigation(db, inv);
  assert.ok(invId > 0);

  const fetched = getInvestigation(db, invId);
  assert.equal(fetched.id, invId);
  assert.equal(fetched.criterionKey, 'AC-005');
  assert.equal(fetched.defectStatus, DEFECT_STATUSES.CONFIRMED_DEFECT);
  assert.ok(fetched.stepsReproduced.length >= 2);

  const list = listInvestigations(db, 1);
  assert.equal(list.length, 1);
});

