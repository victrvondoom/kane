-- Failure investigations and fix verification (additive). An investigation tracks one failed Kane result toward
-- resolution. It stores references to the original run/result/evidence and snapshots of the original facts; it never
-- modifies runs, results or evidence, and never changes a Kane verdict.

CREATE TABLE IF NOT EXISTS investigations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,          -- owner who created it
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  result_id INTEGER NOT NULL REFERENCES results(id) ON DELETE CASCADE,
  criterion_id INTEGER NOT NULL,                                             -- the flow to re-verify
  criterion_key TEXT NOT NULL,
  criterion_version_id INTEGER,                                              -- text version the failure was observed under
  original_status TEXT NOT NULL,                                             -- Kane verdict snapshot at creation (immutable)
  status TEXT NOT NULL,                                                      -- lifecycle, validated server-side
  failure_json TEXT NOT NULL,                                                -- failing step, message and category (facts)
  signature TEXT NOT NULL,                                                   -- failure signature, algorithm v1
  signature_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (result_id)                                                         -- one investigation per failed result
);
CREATE INDEX IF NOT EXISTS investigations_project ON investigations(project_id, id);
CREATE INDEX IF NOT EXISTS investigations_user ON investigations(user_id, id);

-- Append-only lifecycle and activity history. Rows are never updated or deleted by the application.
CREATE TABLE IF NOT EXISTS investigation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  investigation_id INTEGER NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS investigation_events_inv ON investigation_events(investigation_id, id);

CREATE TABLE IF NOT EXISTS investigation_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  investigation_id INTEGER NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  author_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS investigation_notes_inv ON investigation_notes(investigation_id, id);

-- Each diagnosis generation is kept; refreshing never overwrites an earlier one.
CREATE TABLE IF NOT EXISTS investigation_diagnoses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  investigation_id INTEGER NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  engine TEXT NOT NULL,                                                      -- deterministic-v1
  diagnosis_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (investigation_id, generation)
);

-- A verification attempt re-runs the investigated flow through the existing runner. Attempts are never replaced.
CREATE TABLE IF NOT EXISTS investigation_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  investigation_id INTEGER NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,                                                      -- QUEUED | RUNNING | COMPLETED | FAILED
  run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
  result_id INTEGER REFERENCES results(id) ON DELETE SET NULL,
  outcome TEXT,                                                              -- FIX_VERIFIED | STILL_FAILING | ... | INCOMPARABLE | INCONCLUSIVE
  comparison_json TEXT,
  requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (investigation_id, attempt)
);
CREATE INDEX IF NOT EXISTS investigation_verifications_run ON investigation_verifications(run_id);
