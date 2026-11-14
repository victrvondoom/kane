// Steps Writer Unit & Integration Tests
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  generateSpecifications,
  buildKaneObjective,
  saveSpecification,
  listSpecifications,
  getSpecification,
  SCENARIO_TYPES,
} from '../server/steps-writer.js';

function createMockDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, app_url TEXT);
    INSERT INTO projects VALUES (1, 'Test Project', 'http://127.0.0.1:4100/');
    CREATE TABLE test_specifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      spec_key TEXT NOT NULL,
      title TEXT NOT NULL,
      objective TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'functional',
      scenario_type TEXT NOT NULL DEFAULT 'positive',
      version INTEGER NOT NULL DEFAULT 1,
      preconditions TEXT NOT NULL DEFAULT '[]',
      steps TEXT NOT NULL DEFAULT '[]',
      expected TEXT NOT NULL,
      kane_objective TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, spec_key)
    );
    CREATE TABLE test_spec_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      spec_id INTEGER NOT NULL REFERENCES test_specifications(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      content_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (spec_id, version)
    );
  `);
  return {
    raw: db,
    get: (sql, ...p) => db.prepare(sql).get(...p),
    all: (sql, ...p) => db.prepare(sql).all(...p),
    run: (sql, ...p) => db.prepare(sql).run(...p),
  };
}

test('Steps Writer: generates structured specifications with steps, preconditions and expected outcomes', () => {
  const task = 'A user can apply coupon SAVE10 to get 10% off the total order.';
  const specs = generateSpecifications({ task, appUrl: 'http://127.0.0.1:4100/' });

  assert.equal(specs.length, 1);
  const s = specs[0];
  assert.equal(s.specKey, 'SPEC-001');
  assert.equal(s.scenarioType, 'positive');
  assert.ok(s.preconditions.length > 0);
  assert.ok(s.steps.length >= 3);
  assert.ok(s.steps.some((step) => step.action === 'fill' && step.value === 'SAVE10'));
  assert.match(s.kaneObjective, /Go to http:\/\/127\.0\.0\.1:4100\//);
  assert.match(s.kaneObjective, /SAVE10/);
});

test('Steps Writer: detects negative and regression scenarios', () => {
  const neg = generateSpecifications({ task: 'An unauthenticated visitor cannot submit an order without payment.' });
  assert.equal(neg[0].scenarioType, 'negative');
  assert.match(neg[0].expected, /rejected with an appropriate error/);

  const reg = generateSpecifications({ task: 'Cart items still remain in session after page reload.' });
  assert.equal(reg[0].scenarioType, 'regression');
  assert.equal(reg[0].category, 'persistence');
});

test('Steps Writer: builds explicit Kane objectives including preconditions, steps and assertions', () => {
  const obj = buildKaneObjective({
    appUrl: 'http://127.0.0.1:4100/',
    title: 'Checkout test',
    steps: [
      { step: 1, description: 'Open catalogue' },
      { step: 2, description: 'Add backpack to cart' },
    ],
    expected: 'Order total reads $72.00.',
    preconditions: ['User is logged in'],
  });

  assert.match(obj, /^Go to http:\/\/127\.0\.0\.1:4100\/\./);
  assert.match(obj, /Preconditions: User is logged in\./);
  assert.match(obj, /1\. Open catalogue 2\. Add backpack to cart\./);
  assert.match(obj, /Finish by asserting: Order total reads \$72\.00\./);
});

test('Steps Writer: persists specifications with immutable versioning', () => {
  const db = createMockDb();
  const specs = generateSpecifications({ task: 'Discount holds true across sessions.' });
  const first = specs[0];

  // Initial creation (v1)
  const created = saveSpecification(db, 1, first);
  assert.equal(created.version, 1);
  assert.equal(created.created, true);

  const fetched = getSpecification(db, created.id);
  assert.equal(fetched.version, 1);
  assert.equal(fetched.versions.length, 1);

  // Update specification (v2)
  const updatedSpec = {
    ...first,
    title: 'Discount holds true across all sessions (updated)',
    expected: 'Updated expectation condition',
  };
  const updated = saveSpecification(db, 1, updatedSpec);
  assert.equal(updated.version, 2);
  assert.equal(updated.updated, true);

  const refetched = getSpecification(db, created.id);
  assert.equal(refetched.version, 2);
  assert.equal(refetched.title, 'Discount holds true across all sessions (updated)');
  assert.equal(refetched.versions.length, 2);

  const allSpecs = listSpecifications(db, 1);
  assert.equal(allSpecs.length, 1);
});
