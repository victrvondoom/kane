-- Quality layer 2: hashed share tokens with expiry, opaque evidence ids, engine identity,
-- explicit repair-task causality, audit trail. Additive only — existing rows are preserved.
ALTER TABLE projects ADD COLUMN share_token_hash TEXT;
ALTER TABLE projects ADD COLUMN share_created_at TEXT;
ALTER TABLE projects ADD COLUMN share_expires_at TEXT;
CREATE UNIQUE INDEX projects_share_hash ON projects(share_token_hash);
ALTER TABLE evidence ADD COLUMN uid TEXT;
CREATE UNIQUE INDEX evidence_uid ON evidence(uid);
ALTER TABLE results ADD COLUMN engine TEXT;
ALTER TABLE repair_tasks ADD COLUMN origin_run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL;
ALTER TABLE repair_tasks ADD COLUMN fix_declared_at TEXT;
ALTER TABLE repair_tasks ADD COLUMN fix_declared_by TEXT;
ALTER TABLE repair_tasks ADD COLUMN verify_run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL;
ALTER TABLE repair_tasks ADD COLUMN closed_at TEXT;
CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  actor TEXT NOT NULL, action TEXT NOT NULL, entity TEXT, entity_id INTEGER,
  detail TEXT NOT NULL DEFAULT '{}', request_id TEXT
);
CREATE INDEX audit_project ON audit_events(project_id, id);
CREATE INDEX runs_project ON runs(project_id, id);
