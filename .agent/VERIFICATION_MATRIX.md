# Verification Matrix

Each row says what claim is made, how it was checked, and the result. Result meanings:

- **Executed here**: run in this environment, output recorded.
- **Traced only**: read in code, not executed.
- **Blocked**: needs a credential, software or a human action that is not available.
- **Not implemented**: the mission asks for it; it does not exist.

## Product claims

| # | Claim | Check | Result |
|---|---|---|---|
| P1 | Kane CLI runs one browser check per acceptance criterion and classifies the outcome | `server/kane.js` read; unit tests of `classify()` | Traced; `classify()` unit tests pending (see T1). Real `kane-cli run` **blocked**: no binary, no credentials. |
| P2 | A criterion passes only with exit 0, a passing `run_end` event and at least one evidence artifact | Read `classify()` | Traced |
| P3 | The release verdict is computed from stored execution rows on every request | Read `gate.js`, `proof.js` `computeDecision` | Traced; covered by `tests/proof.test.js` (run pending, T1) |
| P4 | A repair task closes only on a passing execution of the same criterion text | Read `gate.js` `syncRepairTask` | Traced |
| P5 | The mission's seven release states are enforced in the backend | Grep for `NOT_VERIFIED`, `RUNNING`, `REPAIRING`, `REVERIFICATION`, `BLOCKED`, `VERIFIED` | **Not implemented.** `NOT_VERIFIED` appears 0 times; the others appear only as strings. |
| P6 | A dossier is signed and verifiable offline | Read `buildDossier`, `keys.js` `verifyDossier`, `scripts/verify-dossier.mjs` | Traced. Ed25519 signature generation and verification exist in code. Not run here against a real dossier. |
| P7 | Evidence files are hashed and checked in the dossier | Read `buildDossier` integrity states | Traced |
| P8 | Repairs run in an isolated git worktree | Read `server/oncall/git.js` `createWorktree` | Traced. Not run end to end: needs an Anthropic credential. |
| P9 | The engineering agent repairs real code from a Kane failure | Read `coding-agent.js` | **Partly false as stated.** The demo "repair" is `setDefectState`, a scripted line swap from a hardcoded table. The agent path (P8) is not run here. |
| P10 | A proof graph shows requirement → criterion → execution → … | Read `public/proof.js` | **Partly.** Stacked panels, not a graph, not interactive. |
| P11 | Failure records combine revision, classification, step, screenshot, console/network, hypothesis, repair commit and reverification | Grep for a failure-record structure | **Not implemented.** Pieces exist in separate tables. |
| P12 | Regression memory detects a returned defect | Read `server/regression.js` | **Partly.** Trials inject seeded demo defects only; they do not track real failures across revisions. |
| P13 | Test-impact selection exposed as an API, with tests | `tests/impact-graph.test.js`, `tests/algorithm-selection-api.test.js` (run pending, T1) | Traced; tests were passing on the algorithm branch (12 + 4) |
| P14 | Two algorithm implementations are consistent | Not compared | **Unknown.** Two suites exist (`server/algorithms` and my modules). |
| P15 | Ochiai localizes seeded defects better than chance | `benchmarks/algorithm-intelligence/sbfl.json` | **False on this benchmark**: mean rank 39 of 51, random 26. Reported as experimental. |
| P16 | NSGA-II explores better than random sampling | `benchmarks/algorithm-intelligence/explore-and-reduce.json` | **False on the synthetic model**: 2.3 defects per seed vs 2.6 for random. Reported as experimental. |
| P17 | ProbDD-style reduction needs fewer replays than the existing reducer | same file, `reduce` section | **True on synthetic oracles**: 33.7 vs 42.9 replays, same final length. |
| P18 | Impact selection finds indirect dependencies that mapping misses | `benchmarks/algorithm-intelligence/impact.json` | **True on this repository**: recall 1.00 vs 0.07. Unbounded plan executes every test here. |
| P19 | The demo defect is caught by Kane, not by a hardcoded expected failure | `demo-app/pricing.js` defect exists; no Kane run recorded | **Not demonstrated.** No captured Kane execution exists. |

## Test claims

| # | Claim | Check | Result |
|---|---|---|---|
| T1 | Existing Node suite on `main` (`1d1a70c`) | `npm test`, log at `/home/user/scratch/main-baseline.log` | **Pending at time of writing.** Partial so far: three browser failures. Final numbers recorded below. |
| T2 | Previously merged algorithm tests pass | `node --test tests/impact-graph.test.js tests/fault-localization.test.js tests/transparency.test.js tests/algorithm-selection-api.test.js` | Ran on the pre-merge branch: 35 pass. Re-run on `main` is included in T1. |
| T3 | Python algorithm suites pass | `playtest-agent-main/tests/test_search_nsga2.py`, `test_probdd.py`; `gatekeeper-main/tests/test_minhash.py` | Ran on the pre-merge branch: 18, 11 and 9 pass. Not re-run on `main`. |
| T4 | Seven browser end-to-end tests fail for environment reasons | Log of T1 | Pre-existing on the baseline; `TimeoutError` from Playwright |
| T5 | Real Kane execution tests | None exist that run `kane-cli` | **Blocked** |
| T6 | Autonomous repair end-to-end test | `tests/e2e-oncall.test.js` exists | **Blocked**: needs Anthropic credential and Kane |
| T7 | Release-state transition tests | Does not exist | **Not implemented** |
| T8 | Evidence hash tamper tests | `tests/proof.test.js` dossier tests exist | Traced; pending T1 |
| T9 | Concurrent execution tests | Not traced | **Unknown** |
| T10 | Browser startup failure and missing-credential tests | `server/kane.js` has explicit classification for missing binary and auth; tests not traced | Traced for classification; test coverage **unknown** |

## Submission claims (not verifiable from the repository)

| # | Requirement | Status |
|---|---|---|
| S1 | Public repository | **Unverified** for anonymous visibility |
| S2 | Repository creation date eligibility | **Unverified**; not checked |
| S3 | Reproducible setup | Setup steps exist in README; not executed from a clean machine in this session |
| S4 | Real Kane CLI run | **Blocked** |
| S5 | Captured failed and successful executions | **Not done** |
| S6 | Functional end-to-end demo | **Not done** |
| S7 | YouTube demonstration | **Not done**; human action |
| S8 | Required public launch posts | **Not done**; human action |
| S9 | Accurate README and architecture | In progress |

## Competition readiness

Not scored. A numeric score would rest on the blocked items above, and inventing one would misstate the position.
