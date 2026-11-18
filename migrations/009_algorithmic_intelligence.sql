-- Migration 009: Algorithmic Intelligence Storage
-- Supports: Test Impact Graphs, NSGA-II exploration, Delta Debugging, Ochiai SBFL,
-- Static Taint Analysis, MinHash Campaign Detection, and Merkle Evidence Transparency.

CREATE TABLE IF NOT EXISTS test_impact_analyses (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  commit_hash TEXT NOT NULL,
  changed_files TEXT NOT NULL, -- JSON array of file paths
  selected_criteria TEXT NOT NULL, -- JSON array of selected criteria with scores & rationale
  total_criteria INTEGER NOT NULL,
  selected_count INTEGER NOT NULL,
  confidence_score REAL NOT NULL,
  execution_budget_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_test_impact_project ON test_impact_analyses(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fault_localization_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT,
  total_components INTEGER NOT NULL,
  top_suspicious_components TEXT NOT NULL, -- JSON array with Ochiai metrics (score, n_ef, n_ep, etc.)
  failing_criteria TEXT NOT NULL, -- JSON array of failing criterion IDs
  matrix_summary TEXT, -- JSON summary of test spectrum
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fault_localization_project ON fault_localization_runs(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS algorithm_sequence_records (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  record_type TEXT NOT NULL, -- 'nsga2_frontier' | 'delta_debugging'
  original_step_count INTEGER NOT NULL,
  reduced_step_count INTEGER NOT NULL,
  reduction_ratio REAL NOT NULL,
  signature TEXT NOT NULL, -- failure signature or objective summary
  action_sequence TEXT NOT NULL, -- JSON array of steps
  objectives TEXT, -- JSON object: state_coverage, diversity, defect_potential, length
  evaluations_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_algorithm_sequence_project ON algorithm_sequence_records(project_id, record_type);

CREATE TABLE IF NOT EXISTS taint_analysis_findings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  package_name TEXT NOT NULL,
  source_type TEXT NOT NULL, -- 'env' | 'token' | 'filesystem' | 'credentials'
  sink_type TEXT NOT NULL, -- 'network' | 'exec' | 'filesystem' | 'dns'
  flow_path TEXT NOT NULL, -- JSON array of AST trace nodes
  severity TEXT NOT NULL, -- 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
  code_snippet TEXT,
  file_path TEXT NOT NULL,
  line_number INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_taint_findings_project ON taint_analysis_findings(project_id, severity);

CREATE TABLE IF NOT EXISTS campaign_clusters (
  id TEXT PRIMARY KEY,
  cluster_name TEXT NOT NULL,
  package_name TEXT NOT NULL,
  jaccard_similarity REAL NOT NULL,
  shared_tokens_sample TEXT NOT NULL, -- JSON array
  signature_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_campaign_clusters_name ON campaign_clusters(cluster_name);

CREATE TABLE IF NOT EXISTS merkle_tree_checkpoints (
  id TEXT PRIMARY KEY,
  tree_size INTEGER NOT NULL,
  root_hash TEXT NOT NULL,
  signed_head TEXT NOT NULL, -- JSON representation of Signed Tree Head
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_merkle_checkpoints_size ON merkle_tree_checkpoints(tree_size);
