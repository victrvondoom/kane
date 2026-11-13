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
`run_events` (every NDJSON event and stderr chunk), `evidence`, `repair_tasks`.

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
| user cancelled | `cancelled` (ignored by the gate; earlier evidence stands) |

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

## Restart safety

On boot, results and runs left `queued`/`running` are marked `error / interrupted`. They count
as no evidence.

## Limits

- The queue is in-process and single-worker by design (one browser at a time). Scale-out would
  move it to a job table with leases.
- Evidence collection copies whatever files Kane CLI wrote (images, logs, JSON, `.evidence`
  packs), capped at 80 MB / 400 files per check.
