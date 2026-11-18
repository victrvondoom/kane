-- Migration 008: Multi-Engine Integration & Nine-Layer SAE Interpretability Lab

-- 1. Project Workspaces for Isolated Execution
CREATE TABLE IF NOT EXISTS project_workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  workspace_path TEXT NOT NULL,
  is_isolated INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_workspaces_pid ON project_workspaces(project_id);

-- 2. Gatekeeper Audit Records & Findings
CREATE TABLE IF NOT EXISTS gatekeeper_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scan_id INTEGER REFERENCES security_scans(id) ON DELETE SET NULL,
  package_name TEXT NOT NULL,
  package_version TEXT,
  spec_type TEXT NOT NULL DEFAULT 'registry',
  risk_level TEXT NOT NULL DEFAULT 'clean',
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gk_audits_project ON gatekeeper_audits(project_id, id);

-- 3. Playtest Visual Filmstrips & Independent Judge Records
CREATE TABLE IF NOT EXISTS playtest_filmstrips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  investigation_id INTEGER NOT NULL REFERENCES playtest_investigations(id) ON DELETE CASCADE,
  frame_seq INTEGER NOT NULL,
  image_path TEXT,
  action_taken TEXT,
  state_diff_json TEXT NOT NULL DEFAULT '{}',
  judge_observation TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_playtest_filmstrips_inv ON playtest_filmstrips(investigation_id, frame_seq);

-- 4. OQED Native Optimization Records & SMT Proofs
CREATE TABLE IF NOT EXISTS oqed_optimizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_function TEXT NOT NULL,
  source_file TEXT NOT NULL,
  baseline_cycles REAL,
  optimized_cycles REAL,
  speedup_ratio REAL,
  equivalence_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  smt_verification_json TEXT NOT NULL DEFAULT '{}',
  diff_asm TEXT,
  oqed_lock_entry TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oqed_optimizations_project ON oqed_optimizations(project_id, id);

-- 5. Nine-Layer Sparse Autoencoder Interpretability Lab
CREATE TABLE IF NOT EXISTS sae_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  model_id TEXT NOT NULL,
  total_layers INTEGER NOT NULL DEFAULT 9,
  selected_layers_json TEXT NOT NULL DEFAULT '[0,1,2,3,4,5,6,7,8]',
  hidden_dim INTEGER NOT NULL DEFAULT 64,
  features_dim INTEGER NOT NULL DEFAULT 256,
  sae_type TEXT NOT NULL DEFAULT 'TopK',
  k_sparsity INTEGER NOT NULL DEFAULT 16,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sae_features (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL REFERENCES sae_models(id) ON DELETE CASCADE,
  layer_index INTEGER NOT NULL,
  feature_index INTEGER NOT NULL,
  activation_frequency REAL NOT NULL DEFAULT 0.0,
  mean_magnitude REAL NOT NULL DEFAULT 0.0,
  max_magnitude REAL NOT NULL DEFAULT 0.0,
  firing_threshold REAL NOT NULL DEFAULT 0.1,
  provisional_label TEXT,
  label_status TEXT NOT NULL DEFAULT 'UNLABELED',
  label_confidence REAL NOT NULL DEFAULT 0.0,
  label_provenance TEXT,
  activating_examples_json TEXT NOT NULL DEFAULT '[]',
  contrasting_examples_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(model_id, layer_index, feature_index)
);
CREATE INDEX IF NOT EXISTS idx_sae_features_model_layer ON sae_features(model_id, layer_index);

CREATE TABLE IF NOT EXISTS sae_feature_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_feature_id INTEGER NOT NULL REFERENCES sae_features(id) ON DELETE CASCADE,
  target_feature_id INTEGER NOT NULL REFERENCES sae_features(id) ON DELETE CASCADE,
  coactivation_score REAL NOT NULL DEFAULT 0.0,
  cosine_similarity REAL NOT NULL DEFAULT 0.0,
  relationship_type TEXT NOT NULL DEFAULT 'co_activation',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sae_edges_source ON sae_feature_edges(source_feature_id);
CREATE INDEX IF NOT EXISTS idx_sae_edges_target ON sae_feature_edges(target_feature_id);

CREATE TABLE IF NOT EXISTS sae_steering_experiments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feature_id INTEGER NOT NULL REFERENCES sae_features(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  steering_coefficient REAL NOT NULL,
  intervention_method TEXT NOT NULL DEFAULT 'activation_clamping',
  baseline_output TEXT NOT NULL,
  steered_output TEXT NOT NULL,
  semantic_drift_score REAL NOT NULL DEFAULT 0.0,
  side_effect_score REAL NOT NULL DEFAULT 0.0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sae_steering_feature ON sae_steering_experiments(feature_id);

CREATE TABLE IF NOT EXISTS sae_layer_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL REFERENCES sae_models(id) ON DELETE CASCADE,
  layer_index INTEGER NOT NULL,
  reconstruction_loss REAL NOT NULL,
  explained_variance REAL NOT NULL,
  l0_sparsity REAL NOT NULL,
  dead_feature_fraction REAL NOT NULL,
  evaluated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sae_evals_model ON sae_layer_evaluations(model_id, layer_index);
