-- Migration 004: Autonomous development loop (Steps Writer, Gatekeeper, Playtest Agent, OQED, Orchestrator)

CREATE TABLE IF NOT EXISTS test_specifications (
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
CREATE INDEX IF NOT EXISTS idx_spec_project ON test_specifications(project_id);

CREATE TABLE IF NOT EXISTS test_spec_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spec_id INTEGER NOT NULL REFERENCES test_specifications(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (spec_id, version)
);
CREATE INDEX IF NOT EXISTS idx_spec_versions ON test_spec_versions(spec_id);

CREATE TABLE IF NOT EXISTS security_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  commit_sha TEXT,
  verdict TEXT NOT NULL,
  summary TEXT NOT NULL,
  findings_json TEXT NOT NULL DEFAULT '[]',
  package_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_security_project ON security_scans(project_id);

CREATE TABLE IF NOT EXISTS playtest_investigations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  result_id INTEGER REFERENCES results(id) ON DELETE SET NULL,
  criterion_key TEXT NOT NULL,
  defect_status TEXT NOT NULL,
  diagnosis TEXT NOT NULL,
  reproduced INTEGER NOT NULL DEFAULT 0,
  steps_reproduced TEXT DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_playtest_project ON playtest_investigations(project_id);

CREATE TABLE IF NOT EXISTS agent_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_description TEXT NOT NULL,
  status TEXT NOT NULL,
  current_stage TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  active_run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  spec_id INTEGER REFERENCES test_specifications(id) ON DELETE SET NULL,
  scan_id INTEGER REFERENCES security_scans(id) ON DELETE SET NULL,
  investigation_id INTEGER REFERENCES playtest_investigations(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_executions_project ON agent_executions(project_id);

CREATE TABLE IF NOT EXISTS agent_repair_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id INTEGER NOT NULL REFERENCES agent_executions(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  patch_summary TEXT NOT NULL,
  changed_files_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_repair_attempts_exec ON agent_repair_attempts(execution_id);

