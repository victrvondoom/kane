-- Layer 3: proof graph, builds, change impact, freshness, policies, decisions, dossiers. Additive only.
CREATE TABLE criterion_versions (
  id INTEGER PRIMARY KEY, criterion_id INTEGER NOT NULL REFERENCES criteria(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, text TEXT NOT NULL, text_hash TEXT NOT NULL, category TEXT NOT NULL,
  mandatory INTEGER NOT NULL, criticality TEXT NOT NULL, areas TEXT NOT NULL, paths TEXT NOT NULL,
  content_hash TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (criterion_id, version)
);
ALTER TABLE criteria ADD COLUMN criticality TEXT NOT NULL DEFAULT 'medium';
ALTER TABLE criteria ADD COLUMN areas TEXT NOT NULL DEFAULT '[]';
ALTER TABLE criteria ADD COLUMN paths TEXT NOT NULL DEFAULT '[]';
ALTER TABLE criteria ADD COLUMN version_id INTEGER REFERENCES criterion_versions(id);
CREATE TABLE builds (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  commit_sha TEXT NOT NULL, branch TEXT, environment TEXT NOT NULL DEFAULT 'default', build_identifier TEXT,
  app_url TEXT, source TEXT NOT NULL, message TEXT, changed_paths TEXT NOT NULL DEFAULT '[]',
  paths_known INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE (project_id, commit_sha, environment)
);
CREATE INDEX builds_project ON builds(project_id, id);
ALTER TABLE runs ADD COLUMN build_id INTEGER REFERENCES builds(id) ON DELETE SET NULL;
ALTER TABLE results ADD COLUMN criterion_version_id INTEGER REFERENCES criterion_versions(id);
ALTER TABLE results ADD COLUMN build_id INTEGER REFERENCES builds(id) ON DELETE SET NULL;
ALTER TABLE results ADD COLUMN environment TEXT;
ALTER TABLE results ADD COLUMN policy_version INTEGER;
ALTER TABLE evidence ADD COLUMN sha256 TEXT;
CREATE TABLE policy_versions (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, rules TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (project_id, version)
);
ALTER TABLE projects ADD COLUMN webhook_secret_enc TEXT;
ALTER TABLE projects ADD COLUMN webhook_environment TEXT NOT NULL DEFAULT 'default';
CREATE TABLE webhook_deliveries (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  delivery_id TEXT NOT NULL, event TEXT NOT NULL, outcome TEXT NOT NULL, build_id INTEGER REFERENCES builds(id) ON DELETE SET NULL,
  detail TEXT, received_at TEXT NOT NULL, UNIQUE (project_id, delivery_id)
);
CREATE TABLE release_decisions (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  build_id INTEGER REFERENCES builds(id) ON DELETE SET NULL, policy_version INTEGER NOT NULL,
  verdict TEXT NOT NULL, decision TEXT NOT NULL, requested_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX decisions_project ON release_decisions(project_id, id);
CREATE TABLE dossiers (
  id INTEGER PRIMARY KEY, uid TEXT NOT NULL UNIQUE, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  build_id INTEGER REFERENCES builds(id) ON DELETE SET NULL, decision_id INTEGER REFERENCES release_decisions(id) ON DELETE SET NULL,
  verdict TEXT NOT NULL, payload_sha256 TEXT NOT NULL, document TEXT NOT NULL, created_at TEXT NOT NULL
);
