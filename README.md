# SHIPPROOF

**Don't trust what your coding agent says. Verify what it ships.**

SHIPPROOF is an evidence-backed release verification platform for AI-generated software.
You give it a live application URL and requirements in plain language. It breaks them into
atomic acceptance criteria, runs each one in a real browser through
[Kane CLI](https://www.testmuai.com/docs/kane-cli-introduction), stores what actually happened,
turns failures into repair tasks, re-verifies fixes, and only then signs the release.

Built for the Kane CLI hackathon. Kane CLI is the verification engine — nothing in this
product can mark a criterion as verified except a `kane-cli run` that exits `0` with a passing
`run_end` event.

## What it does

| Module | What you get |
|---|---|
| Project workspace | Projects per app URL, recent runs, overall gate status |
| Requirement intelligence | Plain-language requirements → atomic criteria with stable IDs (`AC-001`…), typed functional / visual / persistence |
| Kane CLI execution engine | One `kane-cli run "<objective>" --agent --headless --url … --timeout …` per criterion; NDJSON, exit code, stdout, stderr and evidence files persisted |
| Evidence dashboard | Totals, criteria × runs matrix, live execution log, screenshots and files Kane wrote, durations, history |
| Failure-to-fix loop | Repair task per genuine failure (expected vs observed, failing step, evidence, agent-ready prompt); "fix applied" triggers a Kane re-run; failed and passing runs are both kept |
| Release gate | Verified only if every mandatory criterion has a passing execution against its current text; shareable read-only report |

### Gate rules (enforced in `server/kane.js` and `server/gate.js`)

- Pass = exit code `0` **and** a `run_end` event **and** a passing status **and** at least one collected evidence artifact. Anything else is not a pass.
- Kane unavailable, not authenticated, network error, did-not-start, timeout, interrupted, exit/status mismatch, pass without evidence → **no evidence** (unverified), each shown as its own state.
- The latest execution wins: a newer failure or errored re-run replaces an older pass. A user-cancelled check is ignored.
- A failed mandatory criterion → **release blocked**.
- Evidence is bound to the criterion text. Edit the text and the criterion goes back to *not tested*.
- A criterion with an open failure cannot be reworded, made optional or archived.
- There is no manual "mark as passed".

## Quick start

Requires Node 22.5+ and Chrome/Chromium on the machine that runs the server.

```bash
npm install
```

```bash
npm install -g @testmuai/kane-cli
```

```bash
kane-cli login
```

```bash
cp .env.example .env
```

```bash
npm start
```

Open http://localhost:4000. The pill in the top bar shows the real Kane CLI version and whether
it is signed in. For servers and CI, set `LT_USERNAME` and `LT_ACCESS_KEY` in the environment
instead of `kane-cli login`; they are passed to Kane CLI only and are redacted from every stored
log and API response.

The SQLite database and evidence files live in `DATA_DIR` (default `./data`). Migrations in
`migrations/` are applied automatically on start (`npm run migrate` applies them on their own).

### Docker

```bash
docker build -t shipproof .
```

```bash
docker run -p 4000:4000 -v shipproof-data:/data -e LT_USERNAME=... -e LT_ACCESS_KEY=... shipproof
```

Or with Compose (named volume, health check, graceful stop):

```bash
docker compose up -d --build
```

Deploy it anywhere that runs a long-lived container with Chrome (Fly.io, Render, Railway, a VM).
Serverless platforms are not suitable: the engine spawns browser processes that run for minutes.
Production checklist, backup/restore and rollback: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Demo scenario (3 minutes)

The repo ships a sample store, **Northwind Outfitters** (`demo-app/`): registration, login,
product catalogue, cart, coupon, checkout confirmation, order history. It contains one genuine
bug: coupon `SAVE10` is accepted and the discount line is shown, but the order total does not
change (`demo-app/pricing.js`). The unit test for the discount maths passes anyway — exactly the
gap SHIPPROOF exists to close.

The demo store runs on `localhost`, so the server must allow private targets: `ALLOW_PRIVATE_TARGETS=1`
(already set in `.env.example`; copy it to `.env`).

Terminal 1:

```bash
npm start
```

Terminal 2 (restarts automatically when the code changes):

```bash
npm run demo:app
```

| Time | Step |
|---|---|
| 0:00 | Landing page → the pitch: "done", compiles and unit-tests-pass are not evidence. Sign up. |
| 0:20 | **New verification project** → **Load demo scenario**. URL and six requirements fill in; the preview shows them becoming `AC-001…AC-006`. Create. |
| 0:40 | **Run full verification**. The live view streams Kane CLI's NDJSON steps as the real browser registers, logs in, browses, adds to cart. |
| 1:20 | `AC-005` fails: total shows $80.00, expected $72.00. Gate stamp: **RELEASE BLOCKED**. Open the check: failing step, screenshots, stdout/stderr, exit code 1. |
| 1:45 | **Failure analysis** → repair task `RT-1`: expected vs observed, evidence, **Copy repair task** (the prompt for a coding agent). Try to edit `AC-005` — refused. |
| 2:05 | Apply the real fix in terminal 3: `npm run demo:fix` (a one-line patch to `pricing.js`; the store reloads). |
| 2:15 | **Fix applied → re-verify**. Kane CLI re-runs `AC-005` and passes. `RT-1` closes, linked to the passing run. |
| 2:35 | **Release report**: **RELEASE VERIFIED**, execution trail per criterion (red → green for `AC-005`), both runs in history. Create the shareable link and open it signed-out. |

```bash
npm run demo:fix
```

Reset the store to the buggy build for another take:

```bash
npm run demo:break
```

## Proof intelligence (Layer 3)

SHIPPROOF tracks *which version* of the application each piece of evidence verified.

- **Proof graph** — Project → Build → Requirement → Criterion version → Execution → Events → Evidence → Repair task → Verifying run → Release decision, all as linked rows. Editing a criterion appends an immutable version; executions keep pointing at the version they ran. Browse it in **Proof explorer** (search by key, text, area, path, commit SHA, run number or evidence hash).
- **Builds and change impact** — a build is a commit + environment (+ optional deployment URL and changed files), registered by CI, the GitHub push webhook or the UI. Each criterion can declare criticality, functional areas and source-path patterns (`**`, `*`, `?`). For a build the engine reports every criterion as *affected*, *unaffected* or *unknown*, and produces a verification plan with a reason per criterion.
- **Freshness** — evidence is `CURRENT`, `STALE`, `UNVERIFIED`, `FAILED` or `BLOCKED`. A pass goes stale when a later build changes mapped files, when impact cannot be established (unmapped criterion, unknown change set, mapping edited after the fact), or when environment / engine-version / policy rules say so.
- **Stability** — classified from application outcomes only (passed / failed) of the current text: `stable_pass`, `stable_fail`, `intermittent`, or `insufficient_data` below the minimum sample (default 5). Auth, network, timeout and interruption results are counted separately and excluded.
- **Risk** — an ordinal prioritisation from listed factors (criticality, evidence state, stability, coverage gaps). Not a probability; it never changes a verdict.
- **Release policy** — versioned per project. The decision is the existing strict gate **and** the policy: it lists each blocking condition with a code, the run it refers to and the action that resolves it. No policy setting can make a failed or unexecuted mandatory criterion pass.
- **Proof dossier** — canonical JSON with criterion versions, supporting executions, engine identity, evidence SHA-256 hashes, repair history and the decision, signed with a server-held Ed25519 key. Verify offline:

```bash
node scripts/verify-dossier.mjs shipproof-dossier-<id>.json --trust-key <keyId>
```

### GitHub CI

1. Project → **Settings** → generate an API key. Add it to the repository as secret `SHIPPROOF_API_KEY`; add variable `SHIPPROOF_URL`.
2. Copy the workflow from Project → **CI** (served at `/ci/shipproof-verify.yml`) to `.github/workflows/`. Make it run after your deploy job.
3. Optional: Project → **CI** → create a webhook secret and add a GitHub webhook (push events, JSON) so builds are registered on every push.

The job runs `/ci/shipproof-ci.mjs`: register build → run the impact plan → wait → fetch the decision → exit 0 only if the release is allowed.

| Endpoint (Bearer project key) | Purpose |
|---|---|
| `POST /api/agent/builds` | register commit, environment, changed paths (idempotent) |
| `POST /api/agent/verify` | run the plan (or `mode: "full"`) for a commit |
| `GET /api/agent/runs/:id` | run status and per-criterion results |
| `GET /api/agent/decision?commitSha=` | recorded release decision with blocking conditions |
| `POST /api/webhooks/github/:projectId` | GitHub push webhook (HMAC-SHA256, one-time delivery ids) |

## Coding-agent API

Generate a project API key under **Settings → Coding-agent access**.

```
GET  /api/agent/repair-tasks                      open tasks incl. a ready-to-use prompt
POST /api/agent/repair-tasks/:id/fix-applied      {"note":"…"} → queues a Kane re-run
POST /api/agent/runs                              {"mode":"failed"} or {} for a full run
GET  /api/agent/gate                              verdict, reasons, per-criterion status
Authorization: Bearer spk_…
```

## Tests

```bash
npm test
```

54 tests in six files:

- `unit.test.js` — requirement decomposition, outcome classification, release gate.
- `integration.test.js` — real HTTP server + SQLite + one child process per criterion: auth, isolation,
  failure → repair → re-verify, share links, agent API.
- `hardening.test.js` — migration upgrade of a v1 database, target (SSRF) policy, adapter contract
  (including a captured real `kane-cli 0.10.4` unauthenticated run and a check that the installed CLI
  still documents every flag the adapter uses), malformed output, crashes, stream resume, pagination,
  restart recovery, audit trail, and the fail → real code fix → pass loop against the demo store.
- `proof.test.js` — criterion versions, build registration, change impact, freshness, stability, policy decisions, signed webhook
  deliveries and replays, the CI client end to end, dossier signing and tamper detection.
- `e2e-proof.test.js` — the Layer 3 interfaces in Chromium.
- `e2e.test.js` — the whole journey through the UI in Chromium (skipped if Playwright is absent),
  including refresh mid-run, a second account, revocation and phone-width layout checks.

**What is and is not real in the tests.** No test uses Kane CLI credentials. Two test-only stand-in
engines live in `tests/fixtures/`: `fake-kane.js` (scripted outcomes) and `store-check-kane.js`
(makes real HTTP requests to the demo store and passes or fails on what the store returns). Both
report a version containing `fixture`; the server then shows the engine state as *test stand-in*, tags
every such result "Test fixture", and prints a warning on any report that contains one. The product
has no simulated mode and never falls back to a stand-in.

### Real Kane CLI smoke test

On a machine that is signed in to Kane CLI and can reach TestMu AI:

```bash
npm run kane:smoke -- https://example.com/ "The page shows the heading \"Example Domain\"."
```

It runs the same adapter as the server and prints the exit code, the `run_end` event, how SHIPPROOF
classifies the run, and which evidence files were collected.

## Security notes

- Target policy: loopback/private application URLs are refused unless `ALLOW_PRIVATE_TARGETS=1`; link-local/metadata addresses always; re-checked at run time.
- Public report links and agent API keys are stored as SHA-256 hashes, shown once, revocable; links can expire.
- Evidence files are addressed by random ids and served only to the owning account.
- Sensitive actions (keys, links, runs, criterion edits, repair declarations) are written to an append-only audit log.
- Passwords: scrypt. Sessions: random 256-bit token, stored hashed, `HttpOnly` + `SameSite=Lax` cookie.
- All project, run, evidence and repair-task routes check ownership; cross-tenant access returns 404.
- CSP without inline script; all user content rendered as text nodes.
- Kane credentials come from the server environment only; secret variables are write-only and redacted.
- Residual risks: the target policy checks the registered URL, not redirects or links the browser follows
  afterwards — run the container in a network segment without access to internal services. Sign-up is
  open; rate limiting is in-memory per process. This has had no external security review.

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Continuous watch

A per-project health check of the verification system itself, run on a schedule or on demand. Each check measures
variables from live data, turns every abnormal one into a finding (`variable` → `scenario` → `cause`, with an
`origin` of harness / environment / application / evidence / process), tracks findings across checks
(new, persisting, reopened, resolved) and derives the next workflow from them. Harness and environment problems
gate the workflow: no verification is started while they are open.

| Endpoint | Purpose |
|---|---|
| `GET/PUT /api/projects/:pid/watch` | Schedule (`enabled`, `intervalMinutes`), `autoRun`, per-project `thresholds` |
| `POST /api/projects/:pid/watch/check` | Run a check now |
| `GET /api/projects/:pid/watch/checks`, `/findings?status=`, `/trend` | History, finding ledger, variable series |
| `POST /api/projects/:pid/watch/checks/:cid/execute` | Start the automatic step of the latest check's plan |

`autoRun` is off by default: a scheduled check only starts verification runs (which spend engine credits) when it is on.
