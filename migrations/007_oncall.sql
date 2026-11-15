-- Voice on-call engineering agent: sessions, transcript, incidents, evidence ledger, checks, authorizations.
-- Additive only. No audio is ever stored here; transcripts are redacted before they are written.
CREATE TABLE IF NOT EXISTS oncall_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  mode TEXT NOT NULL,                              -- voice | text
  permission_level TEXT NOT NULL,                  -- read_only | engineering
  status TEXT NOT NULL,                            -- active | ended
  voice_provider TEXT,
  voice_state TEXT NOT NULL DEFAULT 'idle',        -- idle | connecting | live | reconnecting | closed | failed
  provider_session_id TEXT,
  provider_store INTEGER NOT NULL DEFAULT 0,       -- 1 only with operator opt-in AND explicit user consent
  voice_seconds INTEGER NOT NULL DEFAULT 0,
  end_reason TEXT,
  evidence_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_oncall_sessions_user ON oncall_sessions(user_id, id);

CREATE TABLE IF NOT EXISTS oncall_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id INTEGER REFERENCES oncall_sessions(id) ON DELETE SET NULL,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL, description TEXT NOT NULL,
  environment TEXT, symptoms TEXT, impact TEXT, timeframe TEXT, expected_outcome TEXT,
  stage TEXT NOT NULL DEFAULT 'understand',        -- understand | investigate | diagnose | repair | verify | deliver | closed
  status TEXT NOT NULL DEFAULT 'open',             -- open | resolved | mitigated | unresolved | interrupted
  diagnosis_json TEXT, plan_json TEXT,
  repo_dir TEXT, worktree TEXT, branch TEXT, base_branch TEXT, base_sha TEXT, head_sha TEXT,
  pushed_sha TEXT, pr_url TEXT, pr_number INTEGER,
  outcome TEXT, summary TEXT,
  report_json TEXT, report_md TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_oncall_incidents_user ON oncall_incidents(user_id, id);

CREATE TABLE IF NOT EXISTS oncall_transcript (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES oncall_sessions(id) ON DELETE CASCADE,
  incident_id INTEGER REFERENCES oncall_incidents(id) ON DELETE SET NULL,
  speaker TEXT NOT NULL,                           -- user | agent | system
  source TEXT NOT NULL,                            -- voice | text | engineer
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oncall_transcript ON oncall_transcript(session_id, id);

-- Ordered, resumable activity stream for a session (Server-Sent Events replay from any id).
CREATE TABLE IF NOT EXISTS oncall_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES oncall_sessions(id) ON DELETE CASCADE,
  incident_id INTEGER, ts TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oncall_events ON oncall_events(session_id, id);

-- Evidence ledger: one row per tool execution. Findings, diagnoses and reports may only cite these refs.
CREATE TABLE IF NOT EXISTS oncall_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES oncall_sessions(id) ON DELETE CASCADE,
  incident_id INTEGER REFERENCES oncall_incidents(id) ON DELETE SET NULL,
  ref TEXT NOT NULL,                               -- E-1, E-2 ... unique within the session
  tool TEXT NOT NULL, tier TEXT NOT NULL,
  input_json TEXT NOT NULL, ok INTEGER NOT NULL, summary TEXT NOT NULL,
  output TEXT NOT NULL, sha256 TEXT NOT NULL, duration_ms INTEGER, created_at TEXT NOT NULL,
  UNIQUE (session_id, ref)
);
CREATE INDEX IF NOT EXISTS idx_oncall_evidence_incident ON oncall_evidence(incident_id, id);

CREATE TABLE IF NOT EXISTS oncall_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL REFERENCES oncall_incidents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                              -- fact | hypothesis
  status TEXT NOT NULL DEFAULT 'open',             -- open | confirmed | rejected (hypotheses only)
  statement TEXT NOT NULL, evidence_refs TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oncall_timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL REFERENCES oncall_incidents(id) ON DELETE CASCADE,
  at TEXT NOT NULL, description TEXT NOT NULL, evidence_refs TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
);

-- Every command the agent ran against the repository, with the exact tree it ran on.
CREATE TABLE IF NOT EXISTS oncall_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL REFERENCES oncall_incidents(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,                             -- verify | proof_red | proof_green
  kind TEXT NOT NULL, target TEXT, command TEXT NOT NULL,
  status TEXT NOT NULL,                            -- passed | failed | timeout | error | cancelled
  exit_code INTEGER, tree_sha TEXT, evidence_ref TEXT, output_tail TEXT, duration_ms INTEGER, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oncall_checks ON oncall_checks(incident_id, id);

-- Production actions never run on the agent's (or the voice channel's) say-so: a signed-in approver decides here.
CREATE TABLE IF NOT EXISTS oncall_authorizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES oncall_sessions(id) ON DELETE CASCADE,
  incident_id INTEGER REFERENCES oncall_incidents(id) ON DELETE SET NULL,
  action TEXT NOT NULL, params_hash TEXT NOT NULL, detail_json TEXT NOT NULL, reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',          -- pending | approved | denied | expired | used
  requested_at TEXT NOT NULL, expires_at TEXT NOT NULL, decided_at TEXT, decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_oncall_auth ON oncall_authorizations(session_id, id);
