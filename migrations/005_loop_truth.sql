-- Loop truth: every claimed transition, replay and regression trial is backed by a persisted record.
ALTER TABLE playtest_investigations ADD COLUMN classification TEXT;
ALTER TABLE playtest_investigations ADD COLUMN replay_run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL;
ALTER TABLE playtest_investigations ADD COLUMN replay_result_id INTEGER REFERENCES results(id) ON DELETE SET NULL;
ALTER TABLE playtest_investigations ADD COLUMN replay_status TEXT;

ALTER TABLE agent_executions ADD COLUMN auto_repair INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_executions ADD COLUMN mutation_authorized INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_executions ADD COLUMN criterion_id INTEGER REFERENCES criteria(id) ON DELETE SET NULL;
ALTER TABLE agent_executions ADD COLUMN decision_id INTEGER REFERENCES release_decisions(id) ON DELETE SET NULL;
ALTER TABLE agent_executions ADD COLUMN failure_class TEXT;
ALTER TABLE agent_executions ADD COLUMN regression_status TEXT;
ALTER TABLE agent_executions ADD COLUMN regression_trial_id INTEGER;
ALTER TABLE agent_executions ADD COLUMN reason TEXT;

ALTER TABLE agent_repair_attempts ADD COLUMN file_hashes_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agent_repair_attempts ADD COLUMN source_result_id INTEGER REFERENCES results(id) ON DELETE SET NULL;
ALTER TABLE agent_repair_attempts ADD COLUMN verify_run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL;
ALTER TABLE agent_repair_attempts ADD COLUMN outcome TEXT;
-- One record per attempt number: a duplicate repair submission cannot create a second attempt.
DELETE FROM agent_repair_attempts WHERE id NOT IN (SELECT MIN(id) FROM agent_repair_attempts GROUP BY execution_id, attempt_number);
CREATE UNIQUE INDEX IF NOT EXISTS uq_repair_attempt ON agent_repair_attempts(execution_id, attempt_number);

CREATE TABLE IF NOT EXISTS agent_execution_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id INTEGER NOT NULL REFERENCES agent_executions(id) ON DELETE CASCADE,
  ts TEXT NOT NULL,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_exec_events ON agent_execution_events(execution_id, id);

-- Regression trials run against isolated copies of the demo store. They are stored apart from
-- `results` so a deliberately broken trial can never become a criterion's release evidence.
CREATE TABLE IF NOT EXISTS regression_trials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  execution_id INTEGER REFERENCES agent_executions(id) ON DELETE SET NULL,
  criterion_id INTEGER REFERENCES criteria(id) ON DELETE SET NULL,
  criterion_key TEXT,
  defect_key TEXT NOT NULL,
  outcome TEXT NOT NULL,            -- detected | missed | inconclusive | not_run
  reason TEXT,
  engine TEXT,
  engine_kind TEXT,                 -- kane-cli | test-fixture | unknown
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_regression_project ON regression_trials(project_id, id);
CREATE TABLE IF NOT EXISTS regression_trial_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trial_id INTEGER NOT NULL REFERENCES regression_trials(id) ON DELETE CASCADE,
  variant TEXT NOT NULL,            -- control | defect
  defect_present INTEGER NOT NULL,  -- independent ground truth, measured from the trial copy itself
  ground_truth_json TEXT NOT NULL,
  target_url TEXT,
  status TEXT NOT NULL,             -- passed | failed | error | timeout | not_executed
  error_kind TEXT,
  exit_code INTEGER,
  command TEXT,
  summary TEXT,
  reason TEXT,
  engine TEXT,
  credits REAL,
  duration_ms INTEGER,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_regression_runs ON regression_trial_runs(trial_id);
