// Nine-Layer Sparse Autoencoder Interpretability Lab Bridge
// Coordinates model initialization, activation analysis, feature registry, cross-layer DAG, and steering experiments.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokeEngineWorker } from '../engine-worker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SAE_WORKER = path.resolve(__dirname, 'sae_engine.py');

/**
 * Check SAE subsystem readiness and available target model architectures.
 */
export function getSaeStatus() {
  return {
    engine: 'NineLayerInterpretabilityLab',
    available: true,
    supportedArchitectures: ['transformer-9l-base', 'llama-3-8b-instruct', 'qwen2.5-7b'],
    defaultLayers: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    supportedSaeTypes: ['TopK', 'JumpReLU'],
    hardwareAcceleration: process.arch === 'x64',
    note: 'Internal hidden-state activations supported across 9 discrete layers.',
  };
}

/**
 * Initialize a 9-layer SAE experiment model record in SQLite.
 */
export function ensureSaeModel(db, {
  id = null,
  name,
  modelName,
  modelId = 'transformer-9l-base',
  selectedLayers,
  layerIndices,
  saeType = 'TopK',
  hiddenDim,
  dIn,
  featuresDim,
  dSae,
  kSparsity,
  k,
} = {}) {
  const resolvedName = name || modelName || 'Transformer-9L Standard SAE';
  const resolvedLayers = selectedLayers || layerIndices || [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const resolvedHiddenDim = hiddenDim || dIn || 64;
  const resolvedFeaturesDim = featuresDim || dSae || 256;
  const resolvedK = kSparsity || k || 16;
  const resolvedSaeType = saeType.toLowerCase() === 'jumprelu' ? 'JumpReLU' : 'TopK';

  let row = null;
  const numericId = id || (typeof modelId === 'number' || (typeof modelId === 'string' && /^\d+$/.test(modelId)) ? Number(modelId) : null);
  if (numericId) {
    row = db.get('SELECT * FROM sae_models WHERE id = ?', numericId);
  }
  if (!row) {
    row = db.get('SELECT * FROM sae_models WHERE model_id = ? AND sae_type = ?', String(modelId), resolvedSaeType);
  }

  if (!row) {
    const now = new Date().toISOString();
    const actualModelId = (typeof modelId === 'string' && !/^\d+$/.test(modelId)) ? modelId : 'transformer-9l-base';
    const res = db.run(
      `INSERT INTO sae_models (name, model_id, total_layers, selected_layers_json, hidden_dim, features_dim, sae_type, k_sparsity, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      resolvedName,
      actualModelId,
      resolvedLayers.length,
      JSON.stringify(resolvedLayers),
      resolvedHiddenDim,
      resolvedFeaturesDim,
      resolvedSaeType,
      resolvedK,
      now
    );
    row = db.get('SELECT * FROM sae_models WHERE id = ?', Number(res.lastInsertRowid));
  }
  return {
    id: row.id,
    name: row.name,
    modelId: row.model_id,
    totalLayers: row.total_layers,
    selectedLayers: JSON.parse(row.selected_layers_json),
    hiddenDim: row.hidden_dim,
    featuresDim: row.features_dim,
    saeType: row.sae_type,
    kSparsity: row.k_sparsity,
    createdAt: row.created_at,
  };
}

/**
 * Analyze prompt activations across all 9 layers, record firing features and cross-layer DAG edges.
 */
export async function analyzePromptActivations({
  db,
  modelId,
  prompt,
  correlationId = null,
}) {
  const model = ensureSaeModel(db, { modelId });

  const workerRes = await invokeEngineWorker({
    engine: 'sae',
    scriptPath: SAE_WORKER,
    action: 'analyze_prompt',
    payload: {
      modelName: model.modelId,
      selectedLayers: model.selectedLayers,
      saeType: model.saeType,
      hiddenDim: model.hiddenDim,
      featuresDim: model.featuresDim,
      kSparsity: model.kSparsity,
      prompt,
    },
    correlationId,
    timeoutMs: 30000,
  });

  if (!workerRes.ok) {
    throw new Error(`SAE prompt analysis failed: ${workerRes.error}`);
  }

  const data = workerRes.data;
  const now = new Date().toISOString();
  const featureIdMap = new Map(); // "layer_featIdx" -> db id

  // Register firing features into sae_features
  for (const [layerStr, lData] of Object.entries(data.layers)) {
    const layer = Number(layerStr);
    for (const tokenItem of lData.tokenFeatures) {
      for (const feat of tokenItem.fired) {
        const featIdx = feat.featureIndex;
        const key = `${layer}_${featIdx}`;

        let fRow = db.get(
          'SELECT * FROM sae_features WHERE model_id = ? AND layer_index = ? AND feature_index = ?',
          model.id,
          layer,
          featIdx
        );

        if (!fRow) {
          const defaultLabel = `Feature L${layer}_F${featIdx} (activates on '${tokenItem.token}')`;
          const res = db.run(
            `INSERT INTO sae_features (
              model_id, layer_index, feature_index, activation_frequency, mean_magnitude,
              max_magnitude, firing_threshold, provisional_label, label_status, label_confidence,
              label_provenance, activating_examples_json, contrasting_examples_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            model.id,
            layer,
            featIdx,
            0.05,
            feat.magnitude,
            feat.magnitude,
            0.1,
            defaultLabel,
            'MODEL_PROPOSED',
            0.65,
            'Automated token activation frequency analysis',
            JSON.stringify([tokenItem.token]),
            JSON.stringify(['<neutral>']),
            now,
            now
          );
          featureIdMap.set(key, Number(res.lastInsertRowid));
        } else {
          // Update stats
          const currentActs = JSON.parse(fRow.activating_examples_json || '[]');
          if (!currentActs.includes(tokenItem.token)) {
            currentActs.push(tokenItem.token);
          }
          const maxMag = Math.max(fRow.max_magnitude, feat.magnitude);
          db.run(
            `UPDATE sae_features SET max_magnitude = ?, activating_examples_json = ?, updated_at = ?
             WHERE id = ?`,
            maxMag,
            JSON.stringify(currentActs.slice(0, 10)),
            now,
            fRow.id
          );
          featureIdMap.set(key, fRow.id);
        }
      }
    }
  }

  // Record cross-layer edges into sae_feature_edges
  for (const edge of data.crossLayerEdges || []) {
    const sId = featureIdMap.get(`${edge.sourceLayer}_${edge.sourceFeature}`);
    const tId = featureIdMap.get(`${edge.targetLayer}_${edge.targetFeature}`);
    if (sId && tId) {
      const existing = db.get(
        'SELECT 1 FROM sae_feature_edges WHERE source_feature_id = ? AND target_feature_id = ?',
        sId,
        tId
      );
      if (!existing) {
        db.run(
          `INSERT INTO sae_feature_edges (source_feature_id, target_feature_id, coactivation_score, cosine_similarity, relationship_type, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          sId,
          tId,
          edge.coactivationScore,
          edge.coactivationScore * 0.9,
          edge.relationshipType,
          now
        );
      }
    }
  }

  return {
    model,
    analysis: data,
  };
}

/**
 * Execute an isolated causal feature steering experiment.
 */
export async function runSteeringExperiment({
  db,
  featureId,
  prompt,
  coefficient = 2.0,
  intervention = 'activation_clamping',
  correlationId = null,
}) {
  const feat = db.get('SELECT f.*, m.model_id, m.sae_type, m.hidden_dim, m.features_dim FROM sae_features f JOIN sae_models m ON m.id = f.model_id WHERE f.id = ?', featureId);
  if (!feat) {
    throw new Error(`Feature #${featureId} not found`);
  }

  const workerRes = await invokeEngineWorker({
    engine: 'sae',
    scriptPath: SAE_WORKER,
    action: 'steer',
    payload: {
      modelName: feat.model_id,
      saeType: feat.sae_type,
      hiddenDim: feat.hidden_dim,
      featuresDim: feat.features_dim,
      layerIndex: feat.layer_index,
      featureIndex: feat.feature_index,
      prompt,
      coefficient,
      intervention,
    },
    correlationId,
    timeoutMs: 30000,
  });

  if (!workerRes.ok) {
    throw new Error(`Steering experiment failed: ${workerRes.error}`);
  }

  const data = workerRes.data;
  const now = new Date().toISOString();

  const res = db.run(
    `INSERT INTO sae_steering_experiments (
      feature_id, prompt, steering_coefficient, intervention_method, baseline_output,
      steered_output, semantic_drift_score, side_effect_score, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    featureId,
    prompt,
    coefficient,
    intervention,
    data.baselineOutput,
    data.steeredOutput,
    data.semanticDriftScore,
    data.sideEffectScore,
    now
  );

  return {
    experimentId: Number(res.lastInsertRowid),
    feature: feat,
    ...data,
    createdAt: now,
  };
}

/**
 * Evaluate SAE reconstruction quality across all 9 layers.
 */
export async function evaluateSaeLayerQuality({
  db,
  modelId,
  prompts = null,
  correlationId = null,
}) {
  const model = ensureSaeModel(db, { modelId });

  const workerRes = await invokeEngineWorker({
    engine: 'sae',
    scriptPath: SAE_WORKER,
    action: 'evaluate_quality',
    payload: {
      modelName: model.modelId,
      selectedLayers: model.selectedLayers,
      saeType: model.saeType,
      hiddenDim: model.hiddenDim,
      featuresDim: model.featuresDim,
      kSparsity: model.kSparsity,
      prompts,
    },
    correlationId,
    timeoutMs: 30000,
  });

  if (!workerRes.ok) {
    throw new Error(`SAE quality evaluation failed: ${workerRes.error}`);
  }

  const now = new Date().toISOString();
  const results = [];

  for (const [lStr, q] of Object.entries(workerRes.data)) {
    const l = Number(lStr);
    db.run(
      `INSERT INTO sae_layer_evaluations (model_id, layer_index, reconstruction_loss, explained_variance, l0_sparsity, dead_feature_fraction, evaluated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      model.id,
      l,
      q.reconstructionLoss,
      q.explainedVariance,
      q.l0Sparsity,
      q.deadFeatureFraction,
      now
    );
    results.push({ layerIndex: l, ...q });
  }

  return {
    model,
    evaluations: results,
  };
}

export function listSaeModels({ db }) {
  return db.all('SELECT * FROM sae_models ORDER BY id ASC').map((m) => ({
    ...m,
    selected_layers: JSON.parse(m.selected_layers_json || '[]'),
  }));
}

export function getSaeModel({ db, modelId }) {
  let row = typeof modelId === 'number' || /^\d+$/.test(modelId)
    ? db.get('SELECT * FROM sae_models WHERE id = ?', Number(modelId))
    : db.get('SELECT * FROM sae_models WHERE model_id = ?', String(modelId));
  if (!row) return null;
  return {
    ...row,
    selected_layers: JSON.parse(row.selected_layers_json || '[]'),
  };
}

export function getFeatures({ db, modelId, layerIndex = null, status = null, minFiringCount = 0, limit = 200 }) {
  let modelRow = typeof modelId === 'number' || /^\d+$/.test(modelId)
    ? db.get('SELECT id FROM sae_models WHERE id = ?', Number(modelId))
    : db.get('SELECT id FROM sae_models WHERE model_id = ?', String(modelId));
  const mId = modelRow ? modelRow.id : 1;

  let query = 'SELECT * FROM sae_features WHERE model_id = ?';
  const params = [mId];

  if (layerIndex !== null && layerIndex !== undefined) {
    query += ' AND layer_index = ?';
    params.push(layerIndex);
  }
  if (status) {
    query += ' AND label_status = ?';
    params.push(status);
  }
  if (minFiringCount > 0) {
    query += ' AND activation_frequency >= ?';
    params.push(minFiringCount);
  }

  query += ' ORDER BY activation_frequency DESC, max_magnitude DESC LIMIT ?';
  params.push(limit);

  return db.all(query, ...params).map((f) => ({
    ...f,
    label: f.provisional_label,
    activating_examples: JSON.parse(f.activating_examples_json || '[]'),
    contrasting_examples: JSON.parse(f.contrasting_examples_json || '[]'),
  }));
}

export function updateFeatureLabel({ db, featureId, label, description = '', status = 'HUMAN_CONFIRMED', provenance = {} }) {
  const now = new Date().toISOString();
  db.run(
    `UPDATE sae_features
     SET provisional_label = ?, label_status = ?, label_provenance = ?, updated_at = ?
     WHERE id = ?`,
    label,
    status,
    typeof provenance === 'string' ? provenance : JSON.stringify(provenance),
    now,
    featureId
  );
  const row = db.get('SELECT * FROM sae_features WHERE id = ?', featureId);
  if (!row) throw new Error(`Feature #${featureId} not found`);
  return {
    ...row,
    label: row.provisional_label,
    activating_examples: JSON.parse(row.activating_examples_json || '[]'),
  };
}

export function getCrossLayerGraph({ db, modelId, minCausalityScore = 0.0 }) {
  let modelRow = typeof modelId === 'number' || /^\d+$/.test(modelId)
    ? db.get('SELECT id FROM sae_models WHERE id = ?', Number(modelId))
    : db.get('SELECT id FROM sae_models WHERE model_id = ?', String(modelId));
  const mId = modelRow ? modelRow.id : 1;

  const edges = db.all(
    `SELECT e.*, sf.layer_index AS source_layer, sf.feature_index AS source_feature_idx, sf.provisional_label AS source_label,
            tf.layer_index AS target_layer, tf.feature_index AS target_feature_idx, tf.provisional_label AS target_label
     FROM sae_feature_edges e
     JOIN sae_features sf ON sf.id = e.source_feature_id
     JOIN sae_features tf ON tf.id = e.target_feature_id
     WHERE sf.model_id = ? AND e.coactivation_score >= ?
     ORDER BY e.coactivation_score DESC LIMIT 500`,
    mId,
    minCausalityScore
  );

  return {
    nodes: db.all('SELECT id, layer_index, feature_index, provisional_label AS label, label_status, activation_frequency, max_magnitude FROM sae_features WHERE model_id = ?', mId),
    edges: edges.map((e) => ({
      id: e.id,
      sourceId: e.source_feature_id,
      targetId: e.target_feature_id,
      sourceLayer: e.source_layer,
      sourceFeature: e.source_feature_idx,
      sourceLabel: e.source_label,
      targetLayer: e.target_layer,
      targetFeature: e.target_feature_idx,
      targetLabel: e.target_label,
      coactivationScore: e.coactivation_score,
      relationshipType: e.relationship_type,
    })),
  };
}

export function getLayerEvaluations({ db, modelId }) {
  let modelRow = typeof modelId === 'number' || /^\d+$/.test(modelId)
    ? db.get('SELECT id FROM sae_models WHERE id = ?', Number(modelId))
    : db.get('SELECT id FROM sae_models WHERE model_id = ?', String(modelId));
  const mId = modelRow ? modelRow.id : 1;

  return db.all(
    'SELECT * FROM sae_layer_evaluations WHERE model_id = ? ORDER BY evaluated_at DESC, layer_index ASC',
    mId
  );
}

// Aliases for route handlers
export const initSaeModel = (args) => ensureSaeModel(args.db, args);
export const analyzeActivations = ({ db, modelId, text, topK, correlationId }) =>
  analyzePromptActivations({ db, modelId, prompt: text, topK, correlationId });
export const steerModel = ({ db, modelId, prompt, interventions, correlationId }) => {
  const intv = (interventions && interventions[0]) || {};
  return runSteeringExperiment({
    db,
    featureId: intv.featureId || 1,
    prompt,
    coefficient: intv.coefficient || 2.0,
    intervention: intv.intervention || 'activation_clamping',
    correlationId,
  });
};
export const evaluateModel = ({ db, modelId, numSamples, correlationId }) =>
  evaluateSaeLayerQuality({ db, modelId, correlationId });

