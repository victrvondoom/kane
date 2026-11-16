# Phase A/B findings (Continuous Watch + event monitoring)

## What already works (reuse, do not rewrite)
- `server/watch.js`: probes (engine, target, executions, criteria, process, evidence), finding lifecycle
  (new / persisting / reopened / resolved via fingerprint), derived plan, `runCheck`, `executePlan`
  (opt-in `autoRun`, single active run per project, check must be latest), `trend`, scheduled `tick`.
- Routes `/api/projects/:pid/watch*` in `server/app.js` (config, check, checks, findings, trend, execute).
- Webhook receiver `server/routes-proof.js`: rate limit per IP (120/min), HMAC-SHA256 over raw body with
  constant-time compare, delivery-id validation, per-project delivery dedup (`webhook_deliveries` UNIQUE),
  ping/push handling, audit. Only `push` is processed; other events are logged as ignored.
- Builds: `registerBuild` keyed by (project, commit, environment); `builds` table.

## What is missing
- No frontend for Watch at all (no navigation tab, no dashboard). Backend is complete but unexposed.
- Webhook handles only `push`; no `workflow_run` / `deployment_status`.
- No event lifecycle: accepted events are not queued durably; there is no event→check correlation.
- No event-trigger configuration (watch_config has only scheduled settings).
- Checks have no originating-event reference; trigger values are only `schedule` | `manual`.
- `executePlan` auto-run applies only to `schedule` checks.

## Constraints discovered
- DB helper `db.tx` is a plain BEGIN/COMMIT (not re-entrant): a transaction must not call another `db.tx`.
- `runCheck` persists inside `db.tx`; probes run before the transaction, so an interrupted probe leaves no check row.
- Single-browser design: Kane runs only via `runner.enqueue`; Watch probes never spawn Kane.
- `rateLimit(key, max, windowMs)` is in-memory per process.
