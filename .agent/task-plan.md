# Plan (smallest coherent design)

DB (additive, migration 008_events.sql)
- watch_config += events_enabled, events_workflow_run, events_deployment (default 0 = off).
- watch_events: durable ledger for workflow_run / deployment_status events. UNIQUE(project_id, delivery_id).
  States persisted: QUEUED, PROCESSING, COMPLETED, IGNORED, FAILED. Receipt + validation happen before the
  row exists; invalid payloads are rejected (400) and logged in webhook_deliveries, never queued.
- watch_checks += event_id (UNIQUE when set); trigger may be 'event'.

Backend
- server/events.js: pure normalisers (validate + classify), correlation to builds (read-only, never registers
  builds), ingest (inside the webhook transaction), worker (serial, CAS claim, bounded retries with backoff,
  restart recovery), history query.
- server/watch.js: runCheck(projectId, trigger, { eventId }) marks the event COMPLETED in the SAME transaction
  that persists the check (exactly-once); event checks honour autoRun like scheduled checks.
- routes-proof.js: webhook branches workflow_run / deployment_status to events.ingest; push unchanged.
- app.js: config/events PUT, GET watch/events (merged ledger), checks include event summary.

Frontend
- public/watch.js: Watch tab (overview, findings board, remediation workflow, event activity, analytics,
  configuration). Only renders API data. Registered in Project() tabs.

Tests
- tests/events.test.js: webhook validation, dedup, lifecycle, recovery, release-integrity, rate limit.
- tests/e2e-watch.test.js: Playwright (skipped if unavailable).
