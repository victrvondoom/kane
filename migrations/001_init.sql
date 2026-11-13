CREATE TABLE users (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  pass_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE projects (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, app_url TEXT NOT NULL, context TEXT NOT NULL DEFAULT '',
  criteria_seq INTEGER NOT NULL DEFAULT 0, share_token TEXT UNIQUE, api_key_hash TEXT UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE project_variables (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL, value TEXT NOT NULL, secret INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, key)
);
CREATE TABLE requirements (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  text TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE criteria (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requirement_id INTEGER REFERENCES requirements(id) ON DELETE SET NULL,
  key TEXT NOT NULL, text TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'functional',
  mandatory INTEGER NOT NULL DEFAULT 1, archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (project_id, key)
);
CREATE TABLE runs (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  trigger TEXT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
);
CREATE TABLE results (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  criterion_id INTEGER NOT NULL REFERENCES criteria(id) ON DELETE CASCADE,
  criterion_key TEXT NOT NULL, criterion_text TEXT NOT NULL, text_hash TEXT NOT NULL,
  status TEXT NOT NULL, error_kind TEXT, exit_code INTEGER, signal TEXT,
  objective TEXT, command TEXT, kane_status TEXT, summary TEXT, one_liner TEXT, reason TEXT,
  final_state TEXT, failing_step TEXT, test_url TEXT, session_dir TEXT, credits REAL,
  stdout TEXT, stderr TEXT, started_at TEXT, finished_at TEXT, duration_ms INTEGER
);
CREATE INDEX results_run ON results(run_id);
CREATE INDEX results_criterion ON results(criterion_id, id);
CREATE TABLE run_events (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  result_id INTEGER, ts TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE INDEX run_events_run ON run_events(run_id, id);
CREATE TABLE evidence (
  id INTEGER PRIMARY KEY, result_id INTEGER NOT NULL REFERENCES results(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, name TEXT NOT NULL, rel_path TEXT, url TEXT, mime TEXT, size INTEGER
);
CREATE INDEX evidence_result ON evidence(result_id);
CREATE TABLE repair_tasks (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  criterion_id INTEGER NOT NULL REFERENCES criteria(id) ON DELETE CASCADE,
  source_result_id INTEGER NOT NULL REFERENCES results(id) ON DELETE CASCADE,
  status TEXT NOT NULL, expected TEXT NOT NULL, observed TEXT NOT NULL, diagnosis TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 1, fix_note TEXT, verified_result_id INTEGER,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
