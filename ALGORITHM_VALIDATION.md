# Algorithm Validation

## Method

- **Ground truth.** For the test-impact and fault-localization benchmarks, truth is measured from this repository's own
  Node test suite under V8 coverage (`benchmarks/algorithm-intelligence/truth.json`). Execution cost is measured from a
  separate uninstrumented run. Infra-only failures (browser timeouts, refused connections) are classified from TAP
  output and excluded from spectra.
- **Synthetic data.** Exploration, reduction and the seeded-defect application model use synthetic models with known
  answers (`playtest-agent-main/pt/search_model.py`, synthetic failing sequences). MinHash variants are synthetic
  derivations of real files. Each report says which dataset it uses.
- **Held-out data.** The only tuning-like comparison (exploration ablation) was calibrated on seeds 101–110 and reported on
  seeds 1–10. The reported held-out result is given whichever variant wins.
- **Determinism.** Every stochastic component takes a seed. Repeat runs with the same seed return identical results
  (verified by tests for NSGA-II, ProbDD and selection).
- **Failure cases.** Each benchmark reports its failures, not only its wins: budget exhaustion, undetected mutants,
  undetected defects, the pessimistic tie rule for Ochiai, and LSH recall loss at low similarity.

## Test results

`npm test` (Node, 190 tests): **182 pass, 7 fail, 1 skipped.** The 7 failures are browser (Playwright) end-to-end tests
failing with `TimeoutError`. They fail identically on the untouched baseline (155 tests: 147 pass, 7 fail, 1 skipped),
so they predate this work. The 35 new tests all pass.

| File | Tests | Covers |
|---|---|---|
| `tests/impact-graph.test.js` | 12 | Masking, specifier scanning, resolution, closure chains, tiers, fallbacks, budget, determinism |
| `tests/fault-localization.test.js` | 8 | Ochiai formula, hand-computed ranking, exclusions, fallback, mutation-site and pessimistic-rank helpers |
| `tests/transparency.test.js` | 11 | RFC 9162 proofs for all small trees, tamper cases, rewritten-history rejection, checkpoint signing |
| `tests/algorithm-selection-api.test.js` | 4 | Selection route: explanation, mandatory retention, fallback, input validation, owner isolation |

Python:

| Suite | Result | Notes |
|---|---|---|
| `gatekeeper-main/tests/test_minhash.py` | 9 passed | New |
| `playtest-agent-main/tests/test_probdd.py` | 11 passed | New |
| `playtest-agent-main/tests/test_search_nsga2.py` | 18 passed | New |
| Gatekeeper full suite | 296 passed, 7 failed, 14 errors | Failures are `test_guard.py` (fail identically on untouched HEAD) and `modal` import errors (package not installed in the environment). None involve new code. |
| Playtest full suite | not run | Browser-dependent; only the new suites were run. |

## Limits

- Coverage truth is loaded-module truth, not fault truth. A module that is loaded but irrelevant to a defect still counts.
- The graph misses child processes that a test spawns with a path string; a few truth pairs are therefore unreachable
  by static analysis. In this repository the static graph still missed no truth pairs at the module level.
- Ochiai was tested only at test-file granularity. Results do not transfer to finer spectra.
- No benchmark used production data. No benchmark measured a third-party claim.
