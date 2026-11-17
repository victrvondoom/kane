# Algorithm Benchmark Report

Every number below is copied from a benchmark output file in `benchmarks/algorithm-intelligence/`. Each dataset is labelled.
Scripts: `scripts/bench-collect-truth.mjs`, `scripts/bench-impact.mjs`, `scripts/bench-sbfl.mjs`,
`gatekeeper-main/scripts/bench_minhash.py`, `playtest-agent-main/bench/algorithm_intelligence_bench.py`.

## 1. Hybrid graph test impact (`impact.json`)

**Dataset: repository-derived.** 51 `server/` modules changed one at a time; 25 test files as criteria. Ground truth is
the set of test files whose real run loaded the changed module (V8 coverage, `truth.json`). 2 changes are skipped because
no test loads them. Criterion mapping = each test's direct server imports.

| Strategy | Micro recall | Macro recall | Changes with full recall | Tests executed | Cost (ms share) | Missed pairs |
|---|---|---|---|---|---|---|
| full suite | 1.000 | 1.000 | 51/51 | 100.0% | 100.0% | 0 |
| direct mapping | 0.066 | 0.083 | 2/51 | 35.8% | 6.2% | 816 |
| hybrid graph (unbounded) | 1.000 | 1.000 | 51/51 | 100.0% | 100.0% | 0 |
| hybrid, budget 50% | 0.330 | 0.340 | 2/51 | 53.9% | 8.9% | 586 |
| hybrid, budget 25% | 0.073 | 0.088 | 2/51 | 36.2% | 6.2% | 810 |

Reading:
- The mapping a team would write misses 93% of the executed dependencies. The graph recovers all of them.
- **The graph does not save tests in this repository.** Almost every test transitively reaches most of `server/` through
  `db.js`/`gate.js`, so unbounded hybrid selection executes everything. The saving only appears under a budget.
- A budget cuts recall sharply: at 50% the plan keeps 33% of truth pairs; at 25% it keeps 7%. Because the required
  set (direct, mandatory, unknown) alone exceeds 25% of tests here, the 25% budget is exceeded by design, and the
  plan reports `overBudget`. Required criteria are never dropped.
- Selection time is negligible (under 0.2 ms total for the unbounded plans across 51 changes; graph build time is in the JSON).
- Not measured: historical-failure ranking (no trustworthy history exists), learned ranking (no training data), severity.

## 2. Ochiai spectrum-based fault localization (`sbfl.json`)

**Dataset: repository-derived, seeded defects.** 12 detected operator mutants out of 29 tried in 16 `server/` modules
(17 undetected by the fast tests). Spectrum: one execution per test file, components = modules loaded in measured runs
(51 components). Infra-only failures (browser timeouts) are excluded.

| Ranking | Top-1 | Top-3 | MRR | Mean rank (pessimistic ties) |
|---|---|---|---|---|
| Ochiai | 0.00 | 0.00 | 0.026 | 39.2 |
| Dependency distance (fallback, not Ochiai) | 0.00 | 0.17 | 0.184 | 9.4 |
| Random (expected) | — | — | — | 26.0 |

**Result: Ochiai did not localize the seeded defects on this spectrum, and it is worse than random.** Cause:
with one execution per test file, a mutant usually produces one or two failing executions. Every module loaded
only by the failing test then receives the same maximal score (n_ep = 0), and the pessimistic tie rule places the
mutated module deep in the tie block. This is a limit of file-level spectra. It is not evidence that Ochiai is
ineffective with statement- or test-case-level spectra, which this repository cannot produce for Kane runs.
The product must not claim fault localization from this spectrum.

## 3. MinHash / LSH near-duplicate fingerprints (`minhash.json`)

**Dataset: repository-derived base files with seeded synthetic variants.** 29 `server/*.js` files as unrelated
negatives; per base file: `rename`, `edit` (3% lines inserted), `heavy` (15%), `partial` (contiguous half). 145
entries, 290 positive pairs, 10,440 total pairs. Half of the base files share a 40-line boilerplate block (hard negatives).

| Variant | LSH candidate recall | Exact Jaccard median | Exact Jaccard min |
|---|---|---|---|
| rename | 1.000 | 1.000 | 1.000 |
| edit | 1.000 | 0.965 | 0.714 |
| heavy | 1.000 | 0.885 | 0.696 |
| partial | 0.897 | 0.585 | 0.193 |

Threshold sweep (exact Jaccard threshold, positives = same family):

| Threshold | Brute-force recall | LSH recall | Precision (both) |
|---|---|---|---|
| 0.3 | 0.983 | 0.945 | 1.000 |
| 0.4 | 0.966 | 0.945 | 1.000 |
| 0.5 | 0.928 | 0.924 | 1.000 |
| 0.6 | 0.755 | 0.755 | 1.000 |
| 0.7 | 0.669 | 0.669 | 1.000 |

Production setting (verify at 0.5): 268 relationships, 0 false-positive pairs across the boilerplate negatives.

Cost: LSH enumerated 4,694 bucket pairs and produced 317 candidates; 288 were verified. Brute force computed 10,440
exact Jaccards in 1,169 ms; fingerprinting took 5,258 ms in pure Python (the dominant cost; not optimised).

Reading: LSH loses 0.3 to 4 points of recall against brute force, concentrated at low similarity, as banding
predicts. Boilerplate sharing produced no false attribution at the 0.5 setting. The corpus is synthetic variants of one
repository and is not malicious-package data; similarity is never reported as maliciousness.

## 4. NSGA-II exploration (`explore-and-reduce.json`, `explore`)

**Dataset: synthetic.** `pt/search_model.py`: a 10-page state machine with five seeded defects. 10 seeds (1–10), 600
application runs per seed. The browser adapter is not exercised.

| Explorer | Distinct pages (of 10) | Distinct edges | Defects per seed | Defect seed hits (QTY/ORDERS/COUPON/ZIP/RACE) |
|---|---|---|---|---|
| NSGA-II | 8.6 | 49.5 | 2.3 | 6 / 10 / 3 / 4 / 0 |
| Random sampling | 8.8 | 50.5 | 2.6 | 10 / 10 / 2 / 4 / 0 |
| Novelty hill-climb | 7.7 | 30.7 | 1.1 | 4 / 7 / 0 / 0 / 0 |

**Result: NSGA-II did not beat random sampling on this model.** It beat the greedy baseline on coverage and defects,
but random sampling matched or exceeded it on pages, edges and defects. The Pareto front is larger (mean 48.8 vs 29.6),
which reflects seven objectives rather than better exploration. No strategy found `BUG_RACE` within 600 runs.
The model saturates (about 9 of 10 pages), so the coverage objectives discriminate little.

Ablation (`ablation`): removing the action-count and cost objectives. Calibration seeds 101–110: 2.3 → 2.2 defects per seed.
Held-out seeds 1–10: 2.3 → 2.7. Inconclusive; the hypothesis that action minimisation pulls search toward short
sequences is not supported on ten seeds, and it is not confirmed either.

## 5. ProbDD versus the existing reducer (`explore-and-reduce.json`, `reduce`)

**Dataset: synthetic.** 60 scenarios: sequence lengths 40, 80, 160; witness pattern lengths 3 and 4; 10 seeds each.
The oracle requires a pinned setup step and the pattern in order. Both reducers use the same oracle and a 400-replay budget.
The existing reducer is the real `pt.reduce.reduce`, driven through a fake driver with the same contract.

| Reducer | Mean final length | Mean replays | 1-minimal rate | Budget hit rate |
|---|---|---|---|---|
| ProbDD-style (`pt/probdd.py`) | 4.5 | 33.7 | 1.0 | 0.0 |
| Existing `pt.reduce.reduce` | 4.5 | 42.9 | 1.0 | 0.0 |

Minimal witness length: 4.5 on average. Both reach it. ProbDD uses 21% fewer replays on these scenarios. The
1-minimality of the existing reducer was checked separately, outside its replay count. Scenarios are small and synthetic, so this
is an efficiency signal, not a general claim.

## 6. Merkle transparency (`server/transparency.js`)

No benchmark was run. Correctness was verified exhaustively in tests: every inclusion proof for every index up to
40 leaves, and every consistency proof for every size pair up to 40 leaves; inclusion proofs for 1,000 leaves are at most
10 hashes. Proof generation and verification cost, at scale, are **not measured**.
