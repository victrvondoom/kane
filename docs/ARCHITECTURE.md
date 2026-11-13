# Architecture

```
Browser SPA (public/, no build step)
   │  JSON + Server-Sent Events
   ▼
Express API (server/app.js) ── auth.js (sessions) ── requirements.js (decomposition)
   │                                   │
   │ enqueue (returns 202 immediately) │ derived status
   ▼                                   ▼
runner.js  — in-process queue, one browser at a time     gate.js — criterion status, release gate, repair tasks
   │ spawn
   ▼
kane.js — `kane-cli run <objective> --agent --headless --url <app> --timeout N --max-steps M`
   │ stdout NDJSON lines ─► run_events (persisted) ─► SSE to the live view
   │ exit code / signal / stderr / run_end ─► classify() ─► results row
   │ session_dir + sealed .evidence packs ─► copied to DATA_DIR/evidence ─► evidence rows
   ▼
SQLite (node:sqlite, WAL) — migrations/001_init.sql
```

## Data model

`users`, `sessions`, `projects`, `project_variables`, `requirements`, `criteria`,
`runs`, `results` (one per criterion per run, with full stdout/stderr and exit code),
`run_events` (every NDJSON event and stderr chunk), `evidence`, `repair_tasks`
(origin run, fix declaration, verifying run, closing result), `audit_events` (append-only).

Nothing on screen is stored as a status flag. Criterion status, totals and the release verdict
are recomputed from `results` on every request (`criteriaStatus`, `releaseGate`).

## Outcome classification (`classify` in server/kane.js)

| Observation | Result |
|---|---|
| exit 0 + `run_end` + passing status | `passed` |
| exit 1 + `run_end` not passing | `failed` → repair task |
| no `run_end`, stderr says not authenticated | `error / auth` |
| no `run_end` otherwise, or exit 2 | `error / did_not_start` |
| exit 3 or watchdog kill | `timeout` |
| exit code and `run_end.status` disagree | `error / inconsistent` |
| binary missing | `error / kane_not_installed` |
| stderr shows a network/DNS/proxy error, no `run_end` | `error / network` |
| passing run but no evidence artifact collected | `error / no_evidence` |
| target URL refused by policy (engine not started) | `error / target_blocked` |
| server stopped mid-check | `error / interrupted` |
| user cancelled | `cancelled` (ignored by the gate; earlier evidence stands) |

Result lifecycle: `queued → starting` (process spawned) `→ running` (first NDJSON event) `→ passed | failed | error | timeout | cancelled`.

Compatibility: written against the agent-mode contract of kane-cli ≥ 0.8.17 (`stream_start`, `run_end`,
documented exit codes) and exercised against 0.10.4. All CLI-specific knowledge (flags, event names,
exit codes, evidence locations) is confined to `server/kane.js`.

Note: Kane CLI 0.10.4 exits `1` (not `2`) when unauthenticated, which is why authentication is
detected from the absence of `run_end` plus stderr rather than from the exit code alone.

## Failure-to-fix loop

1. A `failed` result opens (or re-opens) a repair task for that criterion with expected,
   observed (Kane summary, reason and failing step) and evidence links.
2. The task exposes a markdown prompt for a coding agent, in the UI and at `/api/agent/repair-tasks`.
3. "Fix applied" records the note and immediately queues a `repair_verify` run for that criterion.
4. Only a `passed` result closes the task, and it stores which result verified it.
   A failed re-run re-opens it and increments the failure count.
5. While a task is open the criterion's text, mandatory flag and existence are locked.

## Streaming

Every engine event is inserted into `run_events` before it is broadcast, and its row id is the SSE
event id. A client that reconnects sends `Last-Event-ID` and receives only newer rows; the UI also
de-duplicates by id and falls back to `GET /api/runs/:id/events?after=<id>` when the stream is down
or the tab was suspended. A connection that falls more than ~1 MB behind is closed and resumes from
its cursor. No progress value is computed or animated — the UI shows only persisted events and states.

## Source of truth per screen

| Screen | Endpoint(s) |
|---|---|
| Dashboard | `GET /api/projects` (projects, gate per project, metrics from execution rows, recent runs) |
| New project | `POST /api/decompose` (preview), `POST /api/projects`, `POST /api/projects/:id/requirements` |
| Project / requirement editor | `GET /api/projects/:id`, criteria `POST/PATCH/DELETE` |
| Live execution + evidence explorer | `GET /api/runs/:id`, `…/stream`, `…/events`, `…/results/:rid`, `GET /api/evidence/:uid/file` |
| Failure analysis | `repairTasks` in `GET /api/projects/:id`, `POST /api/repair-tasks/:id/fix-applied` |
| History | `GET /api/projects/:id/runs?status=&before=&limit=` |
| Release report | `GET /api/projects/:id/report`, share `POST/DELETE /api/projects/:id/share` |
| Public report | `GET /api/public/report/:token` (+ screenshots only) |
| Settings | `PATCH /api/projects/:id`, variables, API key, `GET /api/projects/:id/audit` |
| Top bar engine pill | `GET /api/system` |

## Restart safety

On boot, results and runs left `queued`/`running` are marked `error / interrupted`. They count
as no evidence.

## Limits

- The queue is in-process and single-worker by design (one browser at a time). Scale-out would
  move it to a job table with leases.
- Evidence collection copies whatever files Kane CLI wrote (images, logs, JSON, `.evidence`
  packs), capped at 80 MB / 400 files per check.

## Proof intelligence

`server/proof.js` holds the deterministic engines; `server/routes-proof.js` the HTTP surface; `server/keys.js` key material and canonical JSON.

- `computeDecision` is the only place a release verdict is produced. It takes the strict gate (`gate.js`, unchanged) and adds freshness and policy. The project header, report, agent API, CI decision and dossier all call it.
- Freshness of a pass is evaluated against the chain of builds registered (in the same environment) after the build it ran on. Any affected build, or any build whose impact cannot be established, makes it stale. The mapping in force when the evidence was produced must equal the current mapping, otherwise impact is treated as unknown.
- Glob matching is implemented without regular expressions (segment DP + two-pointer wildcard), so patterns cannot cause catastrophic backtracking.
- Webhook: HMAC-SHA256 over the raw request bytes, constant-time compare, identical 401 for unknown project / no secret / bad signature; delivery ids are unique per project and recorded in the same transaction as their effect. Secrets are AES-256-GCM encrypted at rest.
- Dossiers: payload → canonical JSON → SHA-256 → Ed25519 signature; per-section hashes localise tampering; evidence files are re-hashed at generation and flagged `mismatch` / `missing`.
- New tables (migration 003, additive): `criterion_versions`, `builds`, `policy_versions`, `webhook_deliveries`, `release_decisions`, `dossiers`; new columns pin each execution to criterion version, build, environment and policy version.

Limits: change impact is only as good as the declared path mappings; the webhook trusts GitHub's file lists for non-forced pushes; the dossier key is a single server key without rotation tooling.
