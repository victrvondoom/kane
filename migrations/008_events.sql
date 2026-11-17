-- Event-triggered continuous monitoring (additive). Existing Watch configurations keep their meaning:
-- every event subscription defaults to OFF, so enabling scheduled monitoring never enables event monitoring.
ALTER TABLE watch_config ADD COLUMN events_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE watch_config ADD COLUMN events_workflow_run INTEGER NOT NULL DEFAULT 0;   -- GitHub Actions workflow_run completions
ALTER TABLE watch_config ADD COLUMN events_deployment INTEGER NOT NULL DEFAULT 0;     -- GitHub deployment_status changes

-- Durable ledger of accepted lifecycle events. A row exists only after the delivery passed signature, header and
-- payload validation, so RECEIVED/VALIDATED are transient steps inside one transaction, never stored states.
CREATE TABLE IF NOT EXISTS watch_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  delivery_id TEXT NOT NULL,                     -- X-GitHub-Delivery: idempotency key
  source TEXT NOT NULL,                          -- github_workflow_run | github_deployment
  action TEXT,                                   -- workflow_run.action or deployment_status action
  external_state TEXT,                           -- workflow conclusion, or deployment state
  state TEXT NOT NULL,                           -- QUEUED | PROCESSING | COMPLETED | IGNORED | FAILED
  reason TEXT NOT NULL,                          -- why it was accepted, ignored or failed (short, no payload)
  repository TEXT,                               -- owner/name as sent by GitHub (validated)
  workflow_name TEXT, external_id INTEGER,       -- workflow name; workflow run id or deployment id
  branch TEXT, commit_sha TEXT, environment TEXT, target_url TEXT, description TEXT,
  build_id INTEGER REFERENCES builds(id) ON DELETE SET NULL,
  occurred_at TEXT,                              -- timestamp from the payload (validated), when present
  received_at TEXT NOT NULL,
  not_before TEXT,                               -- retry backoff: not processed before this instant
  attempts INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,         -- redeliveries with the same delivery id (never re-processed)
  last_duplicate_at TEXT,
  processing_started_at TEXT, processed_at TEXT,
  check_id INTEGER REFERENCES watch_checks(id) ON DELETE SET NULL,
  error TEXT,                                    -- redacted, truncated failure detail
  UNIQUE (project_id, delivery_id)
);
CREATE INDEX IF NOT EXISTS idx_watch_events_state ON watch_events(state, id);
CREATE INDEX IF NOT EXISTS idx_watch_events_project ON watch_events(project_id, id);

-- Every event-triggered check references the event that caused it. The unique index makes an event able to
-- produce at most one check, even if the worker is interrupted and retried.
ALTER TABLE watch_checks ADD COLUMN event_id INTEGER REFERENCES watch_events(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_watch_check_event ON watch_checks(event_id) WHERE event_id IS NOT NULL;

-- Finding lifecycle detail for the dashboard: how many times a resolved finding came back.
ALTER TABLE watch_findings ADD COLUMN reopens INTEGER NOT NULL DEFAULT 0;
