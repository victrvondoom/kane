// Integration Test Suite for Multi-Engine Architecture & Nine-Layer SAE Interpretability Lab
// Tests workspace isolation, Gatekeeper, Playtest Agent, OQED, and 9-Layer SAE.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../server/db.js';
import { getProjectWorkspace, safeWorkspacePath } from '../server/workspace.js';
import { runGatekeeperScan, runInvestigatorTool, getGatekeeperAudits } from '../server/gatekeeper-bridge.js';
import { runPlaytestInvestigation, getPlaytestFilmstrips } from '../server/playtest-bridge.js';
import { checkOqedEligibility, runOqedOptimization } from '../server/oqed-bridge.js';
import {
  getSaeStatus,
  ensureSaeModel,
  analyzePromptActivations,
  runSteeringExperiment,
  evaluateSaeLayerQuality,
  getFeatures,
  updateFeatureLabel,
  getCrossLayerGraph,
  getLayerEvaluations,
} from '../server/sae/sae-bridge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function testDb() {
  const tmp = path.join(ROOT, 'data', `test-engines-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tmp, { recursive: true });
  const db = openDb(tmp);
  db.run(`INSERT INTO users (id, email, name, pass_hash, created_at) VALUES (1, 'u@test.local', 'User', 'x', 't')`);
  db.run(`INSERT INTO projects (id, user_id, name, app_url, created_at) VALUES (1, 1, 'Engine Test App', 'http://127.0.0.1:4100/', 't')`);
  return { db, dir: tmp };
}

test('Workspace Isolation: enforces project-bounded directory and path traversal protection', () => {
  const { db, dir } = testDb();
  try {
    const ws = getProjectWorkspace({ db, projectId: 1, dataDir: dir });
    assert.ok(ws.canonicalPath.includes('project-1'));
    assert.ok(fs.existsSync(ws.canonicalPath));

    // Path within workspace resolves safely
    const safe = safeWorkspacePath(ws.canonicalPath, 'package.json');
    assert.ok(safe.endsWith('package.json'));

    // Path traversal is blocked
    assert.throws(() => {
      safeWorkspacePath(ws.canonicalPath, '../../etc/passwd');
    }, /Path escapes workspace boundary/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Gatekeeper: package intelligence scan and multi-tool investigator tools', async () => {
  const { db, dir } = testDb();
  try {
    // 1. Run Gatekeeper scan on root workspace
    const scanRes = await runGatekeeperScan({
      db,
      projectId: 1,
      workspaceDir: ROOT,
      correlationId: 'test-scan-1',
    });

    assert.ok(scanRes.scanId > 0, 'Scan recorded in database');
    assert.ok(['ALLOWED', 'SUSPICIOUS', 'BLOCKED', 'REQUIRES_REVIEW'].includes(scanRes.verdict));
    assert.ok(scanRes.packageCount > 0, 'Packages parsed');

    // Verify persisted record in SQLite
    const audits = getGatekeeperAudits({ db, projectId: 1 });
    assert.ok(Array.isArray(audits));

    // 2. Test Multi-Tool Investigator: 'read' tool
    const readToolRes = await runInvestigatorTool({
      db,
      projectId: 1,
      toolName: 'read',
      args: { targetPath: 'package.json', startLine: 1, endLine: 10 },
      correlationId: 'test-inv-read',
    });
    assert.ok(readToolRes.ok);
    assert.ok(readToolRes.data.lines.some((l) => l.includes('name')));

    // 3. Test Multi-Tool Investigator: 'search' tool
    const searchToolRes = await runInvestigatorTool({
      db,
      projectId: 1,
      toolName: 'search',
      args: { pattern: 'express' },
      correlationId: 'test-inv-search',
    });
    assert.ok(searchToolRes.ok);
    assert.ok(searchToolRes.data.matches.length > 0);

    // 4. Test Multi-Tool Investigator: 'decode' tool
    const decodeToolRes = await runInvestigatorTool({
      db,
      projectId: 1,
      toolName: 'decode',
      args: { text: 'aGVsbG8gd29ybGQ=', encoding: 'base64' },
      correlationId: 'test-inv-decode',
    });
    assert.ok(decodeToolRes.ok);
    assert.equal(decodeToolRes.data.decoded, 'hello world');

    // 5. Test Multi-Tool Investigator: 'strings' tool
    const stringsToolRes = await runInvestigatorTool({
      db,
      projectId: 1,
      toolName: 'strings',
      args: { targetPath: 'package.json', minLength: 5 },
      correlationId: 'test-inv-strings',
    });
    assert.ok(stringsToolRes.ok);
    assert.ok(stringsToolRes.data.strings.length > 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Playtest Agent: visual filmstrip, state diff, and independent judge verdict', async () => {
  const { db, dir } = testDb();
  try {
    db.run(`INSERT INTO runs (id, project_id, trigger, status, created_at) VALUES (10, 1, 'manual', 'completed', 't')`);
    db.run(`INSERT INTO criteria (id, project_id, key, text, created_at, updated_at) VALUES (1, 1, 'AC-001', 'Button responds', 't', 't')`);
    db.run(`INSERT INTO results (id, run_id, criterion_id, criterion_key, criterion_text, text_hash, status, reason) VALUES (101, 10, 1, 'AC-001', 'Button responds', 'h', 'failed', 'Timeout waiting for selector')`);

    // Run Playtest investigation
    const invRes = await runPlaytestInvestigation({
      db,
      projectId: 1,
      resultId: 101,
      runId: 10,
      failureReason: 'Assertion error: discount not applied',
      replayRunId: 11,
      replayResultId: 102,
      reproduced: true,
      correlationId: 'pt-test-1',
    });

    assert.ok(invRes);
    assert.ok(['CONFIRMED', 'NOT_REPRODUCIBLE', 'INCONCLUSIVE', 'CONFIRMED_DEFECT', 'TRANSIENT_PASS'].includes(invRes.status));
    assert.ok(['YES', 'NO'].includes(invRes.verdict));
    assert.ok(invRes.dossier, 'Defect dossier formulated');
    assert.ok(invRes.dossier.defectTitle);

    // Verify persisted filmstrip in SQLite
    const filmstrips = getPlaytestFilmstrips({ db, projectId: 1 });
    assert.ok(filmstrips.length >= 2, 'Has before and after frames');
    assert.equal(filmstrips[0].result_id, 101);
    assert.equal(filmstrips[0].frame_seq, 1);
    assert.ok(filmstrips[0].state_diff);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('OQED Superoptimizer: scans native targets and reports Linux requirement honestly', async () => {
  const { db, dir } = testDb();
  try {
    // Project workspace with no native targets
    const elig = checkOqedEligibility({ db, projectId: 1, workspaceDir: dir });
    assert.equal(elig.eligible, false);
    assert.ok(elig.code.includes('UNAVAILABLE') || elig.code === 'READY');

    // Run optimization on non-native workspace: safely handles absence of targets
    const optRes = await runOqedOptimization({
      db,
      projectId: 1,
      workspaceDir: dir,
      correlationId: 'oqed-test-1',
    });
    assert.equal(optRes.eligible, false);
    assert.match(optRes.reason, /No native C\/C\+\+ targets found/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SAE Interpretability Lab: 9 layers TopK/JumpReLU, activation extraction, feature registry, DAG edges, and causal steering', async () => {
  const { db, dir } = testDb();
  try {
    // 1. Status Check
    const status = getSaeStatus();
    assert.equal(status.available, true);
    assert.deepEqual(status.defaultLayers, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(status.defaultLayers.length, 9, 'Exactly nine layers');

    // 2. Initialize 9-layer SAE model
    const model = ensureSaeModel(db, {
      name: 'Nine-Layer Test SAE',
      modelId: 'transformer-9l-test',
      selectedLayers: [0, 1, 2, 3, 4, 5, 6, 7, 8],
      saeType: 'TopK',
      hiddenDim: 64,
      featuresDim: 256,
      kSparsity: 16,
    });
    assert.ok(model.id > 0);
    assert.equal(model.totalLayers, 9);
    assert.equal(model.selectedLayers.length, 9);

    // 3. Extract activations across all 9 layers for prompt
    const prompt = 'The quick brown fox jumps over the lazy dog and verifies release proofs';
    const analysisRes = await analyzePromptActivations({
      db,
      modelId: model.modelId,
      prompt,
      topK: 8,
      correlationId: 'sae-test-analyze',
    });

    assert.ok(analysisRes.analysis);
    assert.ok(analysisRes.analysis.layers);
    // Verify each of the 9 layers produced feature activations
    for (let l = 0; l < 9; l++) {
      assert.ok(analysisRes.analysis.layers[l], `Layer ${l} activations present`);
      assert.ok(analysisRes.analysis.layers[l].tokenFeatures.length > 0, `Layer ${l} has firing features`);
    }

    // Verify cross-layer edges were computed
    assert.ok(analysisRes.analysis.crossLayerEdges.length > 0, 'Cross-layer DAG edges generated');

    // 4. Feature Registry & Calibrated Thresholding Queries
    const featuresL0 = getFeatures({ db, modelId: model.id, layerIndex: 0 });
    assert.ok(featuresL0.length > 0, 'Layer 0 features persisted');
    const firstFeat = featuresL0[0];
    assert.equal(firstFeat.layer_index, 0);
    assert.ok(firstFeat.activation_frequency > 0);
    assert.ok(['UNLABELED', 'MODEL_PROPOSED'].includes(firstFeat.label_status));

    // 5. Feature Labeling & Provenance Tracking
    const updated = updateFeatureLabel({
      db,
      featureId: firstFeat.id,
      label: 'syntactic:noun_phrase_agent',
      description: 'Activates on subject entity tokens',
      status: 'HUMAN_CONFIRMED',
      provenance: { user: 'researcher@deepmind.test', method: 'prompt_contrast' },
    });
    assert.equal(updated.label, 'syntactic:noun_phrase_agent');
    assert.equal(updated.label_status, 'HUMAN_CONFIRMED');
    assert.match(updated.label_provenance, /researcher@deepmind\.test/);

    // 6. Cross-Layer Feature DAG Retrieval
    const graph = getCrossLayerGraph({ db, modelId: model.id, minCausalityScore: 0.0 });
    assert.ok(graph.nodes.length > 0);
    assert.ok(graph.edges.length > 0);
    const edge = graph.edges[0];
    assert.ok(edge.sourceLayer < edge.targetLayer, 'DAG flows from lower to higher layer');
    assert.ok(edge.coactivationScore > 0);

    // 7. Causal Steering Experiment
    const steerRes = await runSteeringExperiment({
      db,
      featureId: firstFeat.id,
      prompt: 'The dog barked loudly at the courier',
      coefficient: 3.5,
      intervention: 'activation_clamping',
      correlationId: 'sae-test-steer',
    });
    assert.ok(steerRes.experimentId > 0);
    assert.ok(steerRes.baselineOutput);
    assert.ok(steerRes.steeredOutput);
    assert.ok(steerRes.semanticDriftScore >= 0);
    assert.ok(steerRes.sideEffectScore >= 0);

    // 8. 9-Layer Reconstruction Quality Evaluation
    const evalRes = await evaluateSaeLayerQuality({
      db,
      modelId: model.modelId,
      correlationId: 'sae-test-eval',
    });
    assert.ok(evalRes.evaluations);
    assert.equal(evalRes.evaluations.length, 9, 'Evaluations across exactly 9 layers');
    for (const ev of evalRes.evaluations) {
      assert.ok(ev.reconstructionLoss >= 0);
      assert.ok(ev.explainedVariance >= 0);
      assert.ok(ev.l0Sparsity > 0);
      assert.ok(ev.deadFeatureFraction >= 0 && ev.deadFeatureFraction <= 1.0);
    }

    // Verify persisted layer evaluations in SQLite
    const persistedEvals = getLayerEvaluations({ db, modelId: model.id });
    assert.equal(persistedEvals.length, 9);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
