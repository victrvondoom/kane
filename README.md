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

- Pass = exit code `0` **and** a `run_end` event **and** a passing status. Anything else is not a pass.
- Not authenticated, did-not-start, timeout, cancelled, exit/status mismatch → **no evidence** (unverified).
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

Deploy it anywhere that runs a long-lived container with Chrome (Fly.io, Render, Railway, a VM).
Serverless platforms are not suitable: the engine spawns browser processes that run for minutes.

## Demo scenario (3 minutes)

The repo ships a sample store, **Northwind Outfitters** (`demo-app/`): registration, login,
product catalogue, cart, coupon, checkout confirmation, order history. It contains one genuine
bug: coupon `SAVE10` is accepted and the discount line is shown, but the order total does not
change (`demo-app/pricing.js`). The unit test for the discount maths passes anyway — exactly the
gap SHIPPROOF exists to close.

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

23 tests: unit tests for requirement decomposition, outcome classification and the release gate,
plus integration tests that boot the real HTTP server and SQLite and spawn a child process per
criterion. In the test-suite only, the Kane binary is swapped for `tests/fixtures/fake-kane.js`
so outcomes are deterministic; the product itself has no simulated mode.

## Security notes

- Passwords: scrypt. Sessions: random 256-bit token, stored hashed, `HttpOnly` + `SameSite=Lax` cookie.
- All project, run, evidence and repair-task routes check ownership; cross-tenant access returns 404.
- CSP without inline script; all user content rendered as text nodes.
- Kane credentials come from the server environment only; secret variables are write-only and redacted.
- The server asks Kane CLI to browse whatever URL a signed-in user registers. Run it on a network
  where that is acceptable, or restrict sign-ups.

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
