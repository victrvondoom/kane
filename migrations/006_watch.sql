-- Continuous watch: periodic health checks of a project's verification system, tracked over time.
CREATE TABLE IF NOT EXISTS watch_config (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  interval_minutes INTEGER NOT NULL DEFAULT 60,
  auto_run INTEGER NOT NULL DEFAULT 0,          -- 1 = a scheduled check may start verification runs (spends engine credits)
  thresholds_json TEXT NOT NULL DEFAULT '{}',
  next_due_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS watch_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL,                         -- schedule | manual
  health TEXT NOT NULL,                          -- healthy | degraded | blocked
  variables_json TEXT NOT NULL,                  -- every measured variable of this check
  plan_json TEXT NOT NULL,                       -- workflow derived from this check's findings
  counts_json TEXT NOT NULL,
  started_run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL, finished_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_watch_checks ON watch_checks(project_id, id);
CREATE TABLE IF NOT EXISTS watch_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  variable TEXT NOT NULL, scenario TEXT NOT NULL, cause TEXT NOT NULL, origin TEXT NOT NULL, severity TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open',           -- open | resolved
  occurrences INTEGER NOT NULL DEFAULT 1,
  first_check_id INTEGER, last_check_id INTEGER,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, resolved_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_watch_finding ON watch_findings(project_id, fingerprint);
