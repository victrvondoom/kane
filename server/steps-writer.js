// Steps Writer — Test Specification Engine
// Converts tasks and application specifications into structured, versioned, and executable test scenarios.
import crypto from 'node:crypto';
import { categorize } from './requirements.js';
import { now } from './db.js';

export const SCENARIO_TYPES = ['positive', 'negative', 'regression', 'edge_case'];

/**
 * Deterministically parse and generate structured verification specifications from tasks/requirements.
 */
export function generateSpecifications({ task = '', requirements = '', appUrl = 'http://localhost:4000/' }) {
  const specs = [];
  const rawText = [task, requirements].filter(Boolean).join('\n');
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

  let counter = 1;
  for (const line of lines) {
    if (line.length < 5) continue;
    const key = `SPEC-${String(counter).padStart(3, '0')}`;
    const category = categorize(line);

    // Detect if this is a negative scenario (e.g. "cannot", "fails", "without", "reject", "prevent", "invalid")
    const isNegative = /\b(cannot|can't|must not|should not|reject\w*|refus\w*|prevent\w*|without|invalid|unauthori[sz]ed|fail\w*)\b/i.test(line);
    const isRegression = /\b(still|remain\w*|regress\w*|broken|fix\w*|restore\w*|backward)\b/i.test(line);
    const scenarioType = isRegression ? 'regression' : isNegative ? 'negative' : 'positive';

    const preconditions = derivePreconditions(line, scenarioType);
    const steps = deriveSteps(line, scenarioType, appUrl);
    const expected = deriveExpected(line, scenarioType);
    const kaneObjective = buildKaneObjective({ appUrl, title: line, steps, expected, preconditions });

    specs.push({
      specKey: key,
      title: line.replace(/[.!?]+$/, ''),
      objective: line,
      category,
      scenarioType,
      version: 1,
      preconditions,
      steps,
      expected,
      kaneObjective,
    });
    counter++;
  }

  // If no lines found, provide a baseline specification
  if (!specs.length) {
    specs.push({
      specKey: 'SPEC-001',
      title: 'Application core functionality loads and behaves correctly',
      objective: 'Verify the application loads and expected user workflow executes successfully.',
      category: 'functional',
      scenarioType: 'positive',
      version: 1,
      preconditions: ['Application server is running and reachable'],
      steps: [
        { step: 1, action: 'navigate', target: appUrl, value: null, description: `Open ${appUrl}` },
        { step: 2, action: 'assert', target: 'body', value: 'visible', description: 'Confirm main view is displayed' },
      ],
      expected: 'Page loads without errors and expected elements are visible.',
      kaneObjective: `Go to ${appUrl}. Verify the page loads cleanly and main view is visible. If not visible, the check fails.`,
    });
  }

  return specs;
}

function derivePreconditions(text, type) {
  const pre = ['Application server is running and accessible at target URL'];
  if (/coupon|discount|cart|order|checkout/i.test(text)) {
    pre.push('Product catalogue is populated and available');
    pre.push('Active session or user can be created');
  }
  if (/login|auth|session|register/i.test(text)) {
    pre.push('User auth service is initialized');
  }
  if (type === 'negative') {
    pre.push('System enforces validation and security constraints');
  }
  return pre;
}

function deriveSteps(text, type, appUrl) {
  const steps = [
    { step: 1, action: 'navigate', target: appUrl, value: null, description: `Navigate to ${appUrl}` },
  ];

  if (/coupon|discount|cart/i.test(text)) {
    steps.push({ step: 2, action: 'click', target: 'a[href*="cart"], button[data-testid*="cart"], .card button', value: null, description: 'Select item and add to cart' });
    if (/coupon|SAVE10/i.test(text)) {
      const couponMatch = text.match(/\b([A-Z0-9]{4,10})\b/);
      const code = couponMatch ? couponMatch[1] : 'SAVE10';
      steps.push({ step: 3, action: 'fill', target: 'input[name="code"], input[placeholder*="coupon" i]', value: code, description: `Enter coupon code ${code}` });
      steps.push({ step: 4, action: 'click', target: 'button:has-text("Apply"), input[type="submit"]', value: null, description: 'Apply coupon code' });
    }
  } else if (/register|login|auth/i.test(text)) {
    steps.push({ step: 2, action: 'click', target: 'a[href*="login"], a[href*="register"]', value: null, description: 'Navigate to authentication view' });
    steps.push({ step: 3, action: 'fill', target: 'input[type="email"], input[name="email"]', value: 'qa-test@example.com', description: 'Provide credentials' });
  } else {
    steps.push({ step: 2, action: 'assert', target: 'main, #app, body', value: 'visible', description: 'Inspect application UI state' });
  }

  const stepNum = steps.length + 1;
  steps.push({
    step: stepNum,
    action: 'assert',
    target: 'body',
    value: type === 'negative' ? 'error-notice' : 'success-state',
    description: type === 'negative' ? 'Assert rejection/validation message appears' : 'Assert expected outcome is visible on page',
  });

  return steps;
}

function deriveExpected(text, type) {
  if (type === 'negative') {
    return 'Operation is rejected with an appropriate error or validation message, and invalid state is not persisted.';
  }
  return `The expected outcome is visible on the page and satisfies: "${text.trim()}".`;
}

export function buildKaneObjective({ appUrl, title, steps = [], expected, preconditions = [] }) {
  const parts = [`Go to ${appUrl}.`];
  if (preconditions.length) {
    parts.push(`Preconditions: ${preconditions.join('; ')}.`);
  }
  if (steps.length) {
    const stepLines = steps.map((s) => `${s.step}. ${s.description}`).join(' ');
    parts.push(`Execute steps: ${stepLines}.`);
  }
  parts.push(`Finish by asserting: ${expected} If the outcome is not observed, the check fails.`);
  return parts.join(' ');
}

/**
 * Persist or update a test specification in the database with immutable versioning.
 */
export function saveSpecification(db, projectId, spec) {
  const existing = db.get('SELECT * FROM test_specifications WHERE project_id = ? AND spec_key = ?', projectId, spec.specKey);
  const nowTs = now();

  const preconditionsJson = JSON.stringify(spec.preconditions || []);
  const stepsJson = JSON.stringify(spec.steps || []);

  if (existing) {
    const newVersion = existing.version + 1;
    db.run(
      `UPDATE test_specifications SET title = ?, objective = ?, category = ?, scenario_type = ?, version = ?,
       preconditions = ?, steps = ?, expected = ?, kane_objective = ?, updated_at = ? WHERE id = ?`,
      spec.title, spec.objective, spec.category || 'functional', spec.scenarioType || 'positive', newVersion,
      preconditionsJson, stepsJson, spec.expected, spec.kaneObjective, nowTs, existing.id
    );

    db.run(
      `INSERT INTO test_spec_versions (spec_id, version, content_json, created_at) VALUES (?, ?, ?, ?)`,
      existing.id, newVersion, JSON.stringify({ ...spec, version: newVersion }), nowTs
    );

    return { id: existing.id, version: newVersion, specKey: spec.specKey, updated: true };
  }

  const res = db.run(
    `INSERT INTO test_specifications (project_id, spec_key, title, objective, category, scenario_type, version, preconditions, steps, expected, kane_objective, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    projectId, spec.specKey, spec.title, spec.objective, spec.category || 'functional', spec.scenarioType || 'positive',
    preconditionsJson, stepsJson, spec.expected, spec.kaneObjective, nowTs, nowTs
  );

  const specId = Number(res.lastInsertRowid);
  db.run(
    `INSERT INTO test_spec_versions (spec_id, version, content_json, created_at) VALUES (?, 1, ?, ?)`,
    specId, JSON.stringify({ ...spec, version: 1 }), nowTs
  );

  return { id: specId, version: 1, specKey: spec.specKey, created: true };
}

export function listSpecifications(db, projectId) {
  const rows = db.all('SELECT * FROM test_specifications WHERE project_id = ? ORDER BY id', projectId);
  return rows.map(formatSpecRow);
}

export function getSpecification(db, specId) {
  const row = db.get('SELECT * FROM test_specifications WHERE id = ?', specId);
  if (!row) return null;
  const versions = db.all('SELECT version, created_at FROM test_spec_versions WHERE spec_id = ? ORDER BY version DESC', specId);
  return { ...formatSpecRow(row), versions };
}

function formatSpecRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    specKey: row.spec_key,
    title: row.title,
    objective: row.objective,
    category: row.category,
    scenarioType: row.scenario_type,
    version: row.version,
    preconditions: JSON.parse(row.preconditions || '[]'),
    steps: JSON.parse(row.steps || '[]'),
    expected: row.expected,
    kaneObjective: row.kane_objective,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

