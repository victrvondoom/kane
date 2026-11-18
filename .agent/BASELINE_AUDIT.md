# Baseline Audit

Audited revision: `origin/main` at `1d1a70c` (merge of PR #12). Every status below is tied to code I read on this
revision. "Verified" means I ran it here; "traced" means I read the code path but did not run it; "not run" means it
needs credentials or software this environment does not have.

## Environment limits that bound every claim

| Requirement | Present here | Consequence |
|---|---|---|
| `kane-cli` binary | No (`which kane-cli` empty) | No real Kane execution is possible from this session |
| `LT_USERNAME` / `LT_ACCESS_KEY` | No | Real Kane runs cannot authenticate |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | No | The on-call engineer's reasoning loop cannot run |
| `OPENAI_API_KEY` | No | Voice on-call provider cannot run |
| Node 22.5+ | Yes (v22.23.5) | Server and tests run |
| Chromium / Playwright | Not verified here | Browser end-to-end tests fail or skip |

## What genuinely works (traced to code, with stated verification)

| Capability | Where | Status |
|---|---|---|
| Kane CLI invocation per criterion: `kane-cli run <objective> --agent --url ...`, exit code and NDJSON `run_end` parsed | `server/kane.js` (spawn at ~l.97) | **Traced.** Not run here: no binary, no credentials. Tests use a stand-in engine that is labelled as such. |
| Outcome classification (pass requires exit 0 + passing `run_end` + evidence; auth, timeout, network, no-evidence are separate error states) | `server/kane.js` `classify()` (l.41) | **Verified** by existing unit tests in `tests/unit.test.js` (run pending, see below). |
| Gate verdict computed from stored results on each request; no manual pass | `server/gate.js` `releaseGate`, `criteriaStatus` | **Traced.** Runs in tests. |
| Repair task opens on an application failure only; infra errors never open one | `server/gate.js` `syncRepairTask`, `classifyFailure` | **Traced.** |
| Repair task closes only when a passing execution of the same criterion text completes | `server/gate.js` `syncRepairTask` (l.84–91) | **Traced.** This is real backend enforcement. |
| Freshness: evidence bound to criterion text version and build change impact | `server/proof.js` `freshnessFor`, `impactOf`, `computeDecision` | **Traced.** Covered by `tests/proof.test.js`. |
| Signed proof dossier: canonical JSON, section and payload SHA-256, Ed25519 signature over the payload hash | `server/proof.js` `buildDossier` (l.374–429), `server/keys.js` (`sign`, `verifyDossier`) | **Traced and real.** `verifyDossier` re-checks hashes and the signature; `scripts/verify-dossier.mjs` exists. |
| Evidence file hashing and integrity state (`ok` / `mismatch` / `missing`) inside the dossier | `server/proof.js` `buildDossier` | **Traced.** |
| Dossier download as a file | `server/routes-proof.js` `/dossiers/:uid/download` (l.260) | **Traced.** |
| Git worktree isolation for the engineering agent: per-incident worktree on a fresh `oncall/` branch, guarded paths | `server/oncall/git.js` `createWorktree`, `scratchWorktree`; `server/oncall/tools/*` | **Traced.** Not run end to end: needs an Anthropic credential and a repository. |
| Bounded engineer loop (step and token limits, tool registry with tiers) | `server/oncall/engineer.js` (104 lines), `server/oncall/tools/registry.js` | **Traced.** Limits and the cancellation path were not verified by execution. |
| Repair attempt records with outcome and verify run | `server/orchestrator.js` (`agent_repair_attempts`, l.196, l.302) | **Traced.** |
| Demo application with a real, reproducible defect (coupon `SAVE10` leaves the total unchanged) | `demo-app/pricing.js`; `demo/fix-coupon.patch`; `npm run demo:fix` / `demo:break` | **Traced.** The patch is a real `git apply`. Running it was not verified here. |
| Repository commit intake: GitHub push and `workflow_run` webhooks, HMAC-verified, one-time delivery ids, builds registered with changed paths | `server/routes-proof.js` webhook (l.120–165), `server/events.js` | **Traced.** Changed paths come from the webhook payload only; no repository is cloned. |
| Test-impact selection (`impact-graph.js`) exposed as an authenticated route | `server/routes-proof.js` `/projects/:pid/builds/:bid/selection` | **Traced.** Covered by `tests/impact-graph.test.js` (12) and `tests/algorithm-selection-api.test.js` (4). |

## What is partially implemented

| Capability | Gap | Where |
|---|---|---|
| Release states | The mission's seven states (`NOT_VERIFIED`, `RUNNING`, `FAILED`, `REPAIRING`, `REVERIFICATION`, `VERIFIED`, `BLOCKED`) do not exist as an enforced state. The gate returns `verified / blocked / unverified` and criterion statuses `untested / verified / failed / blocked`. `NOT_VERIFIED` appears nowhere in the code. `REPAIRING` and `REVERIFICATION` appear only as strings. | `server/gate.js` `releaseGate`; `server/proof.js` `computeDecision` |
| Repair completion | `POST /repair-tasks/:tid/fix-applied` marks a task `fix_applied` on a user or agent declaration and queues a re-run. That is a request, not evidence, and the gate does not treat it as a fix. The gate only closes a task on a passing execution, which is correct, but the UI and API wording can read as if the declaration ends the repair. | `server/app.js` l.515–521, l.618 |
| Proof graph | The "graph" in `public/proof.js` is stacked panels (Requirement → Criterion → Execution …), not a graph and not interactive. It shows linked data but has no visual topology and no missing-link display beyond text. | `public/proof.js` l.48–56 |
| Failure records | Failures are stored with run, result, evidence and repair rows, but there is no failure record that combines application revision, classification, browser step, screenshot reference, console/network evidence, hypothesis, repair commit and reverification into one replayable object. | `server/gate.js`, `server/orchestrator.js` |
| Regression memory | `server/regression.js` runs *seeded* defects in an isolated demo copy against the matching criterion. It proves the engine can detect the known demo defects. It does not remember real failures across revisions. | `server/regression.js`, `server/demo-defects.js` |
| Repository connection | Commits are registered from webhook payloads or a manual API. The product does not clone a repository, select a branch, or check out a commit. | `server/routes-proof.js`, `server/workspace.js` (not traced in detail) |
| Algorithm intelligence | Two parallel implementations exist. See the duplicate-suite finding below. | `server/impact-graph.js`, `server/algorithms/*` |

## What is mocked or deterministic

| Item | Nature | Labelled? |
|---|---|---|
| `tests/fixtures/fake-kane.js`, `tests/fixtures/store-check-kane.js` | Stand-in Kane engines used by the test suite. Version string contains `fixture`; the server tags results "Test fixture". | Yes, in code and `README.md` |
| `setDefectState` in `server/demo-defects.js` and its use in `server/coding-agent.js` (l.79) | The **demo repair** swaps one known line in `demo-app/pricing.js` for another, chosen from a hardcoded `DEFECTS` table. It edits real application code, but it is a scripted patch for a predetermined defect, not an investigation by an agent. | **Not labelled as scripted in the UI or README.** This must be disclosed in the demo. |
| `server/regression.js` trials | Seeded defects with ground truth measured by the trial itself. Deterministic by design. | Yes, in code comments |
| Algorithm benchmarks | Synthetic models (`pt/search_model.py`) and repository-derived data. | Yes, in each report |

## What requires external credentials or software

- Kane CLI real execution: `kane-cli` plus `LT_USERNAME` / `LT_ACCESS_KEY` (or `kane-cli login`).
- Autonomous engineer: `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`.
- Voice on-call: `OPENAI_API_KEY`.
- GitHub integration: a webhook secret and a repository.
- Browser tests: Playwright with Chromium.

## What cannot currently be demonstrated

1. A real Kane run from this environment (no binary, no credentials).
2. An autonomous repair driven by a real model against a real Kane failure (no Anthropic credential).
3. Browser end-to-end journeys in this environment (seven known browser tests fail here; see baseline numbers below).
4. A repository-connected flow starting from a branch or commit selected in the UI.
5. Any statement about hackathon eligibility, the required public launch posts, or the YouTube demonstration. These are human actions and are not verifiable from the repository.

## Duplicate algorithm suite (finding)

Two implementations of the same algorithms now exist on `main`:

| Algorithm | My module (PR #12) | Other module (commit `43d1fb9`) | Mounted at |
|---|---|---|---|
| Test impact | `server/impact-graph.js` | `server/algorithms/test-impact-graph.js` | `/api/projects/:pid/builds/:bid/selection` (mine) and `/api/algorithms/impact/analyze` (theirs) |
| Fault localization | `server/fault-localization.js` | `server/algorithms/ochiai-localization.js` | theirs only at `/api/algorithms` |
| Test reduction | none (benchmarked against `pt/reduce.py`) | `server/algorithms/delta-debugging.js` (`ddmin`, `probDD`) | `/api/algorithms` |
| Taint analysis | none | `server/algorithms/taint-analysis.js` | `/api/algorithms` (not traced) |
| MinHash / LSH | `gatekeeper-main/src/gatekeeper/fingerprint/minhash.py` | `server/algorithms/minhash-lsh.js` | `/api/algorithms` |
| Merkle log | `server/transparency.js` | `server/algorithms/merkle-transparency.js` | `/api/algorithms` |
| NSGA-II | `playtest-agent-main/pt/search_nsga2.py` | `server/algorithms/nsga2-exploration.js` | `/api/algorithms` |

The two suites have not been compared for agreement. Neither has been benchmarked against the other. This must be
resolved in Phase 3 before any algorithm claim is made. I have not verified the correctness of the `server/algorithms`
implementations.

## Test baseline

Pending: `npm test` on `1d1a70c` is running (log: `/home/user/scratch/main-baseline.log`). Numbers will be recorded in
`VERIFICATION_MATRIX.md` once it finishes. Previously, the same suite on the pre-merge branch gave 182 pass, 7 fail
(the seven Playwright browser tests) on 190 tests.
