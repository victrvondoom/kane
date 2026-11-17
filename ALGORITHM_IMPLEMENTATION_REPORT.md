# Algorithm Implementation Report

Status is stated per algorithm. "Implemented" means code, tests and a measured benchmark exist. Benchmarks and their
numbers are in `ALGORITHM_BENCHMARK_REPORT.md`. Validation method and test counts are in `ALGORITHM_VALIDATION.md`.

## Summary

| # | Algorithm | Status | Where it runs | Headline measured result |
|---|---|---|---|---|
| 1 | Hybrid graph test impact | Implemented; wired to `POST /projects/:pid/builds/:bid/selection` | `server/impact-graph.js` | Recall 1.0 unbounded, but executes 100% of tests here; budgets trade recall away sharply |
| 2 | NSGA-II exploration | Implemented engine; evaluated on a synthetic model only; browser adapter not run | `playtest-agent-main/pt/search_nsga2.py`, `search_model.py` | Did not beat random sampling on the synthetic model |
| 3 | ProbDD-style reduction | Implemented; ProbDD-style heuristic, not the published algorithm | `playtest-agent-main/pt/probdd.py` | 21% fewer replays than the existing reducer, same final length, 1-minimal |
| 4 | Ochiai fault localization | Implemented; genuine V8 spectrum for the server suite only | `server/fault-localization.js` | Did not localize seeded defects on file-level spectra; worse than random |
| 5 | Interprocedural taint analysis | **Proposed, not implemented** | none | — |
| 6 | MinHash / LSH fingerprints | Implemented; not yet wired into Gatekeeper's campaign flow | `gatekeeper-main/src/gatekeeper/fingerprint/minhash.py` | LSH recall 0.92 at 0.5; 0 false-positive pairs on boilerplate negatives |
| 7 | Merkle evidence transparency | Implemented as a library; not wired into storage or dossiers | `server/transparency.js` | Correct on all small trees tested; no scale benchmark |

Existing components reused, not duplicated: `playtest-agent-main/pt/reduce.py` (the ProbDD benchmark compares against it),
`gatekeeper-main/src/gatekeeper/evidence/reach.py` (the intended entry-point substrate for taint, which is not built),
the Ed25519 signing in `server/keys.js` (checkpoint signatures reuse `keys.sign`).

## 1. Hybrid graph test impact — `server/impact-graph.js`

- **Data structures.** `buildImportGraph` returns `files`, `deps`, `rdeps` (adjacency, both directions), `unresolved`
  (files with missing relative targets or computed loads), `externalSpecifiers`.
- **Lexing.** `maskSource` blanks comments and string contents at the same offsets, so template text such as a child-process
  probe is never read as an import. Known limit: regex literals containing quote characters, and `${}` expressions inside templates.
- **Algorithm.** `reverseClosure` is a breadth-first search over reverse edges, recording a parent per file so each dependency
  chain can be printed. `selectTests` classifies each criterion as `direct`, `transitive`, `unknown`, `mandatory`, or `excluded`.
  Mandatory, critical and security criteria are never excluded. Unmapped criteria, opaque changed files (no dependency
  information) and graphs with unresolvable loads become `unknown` and run.
- **Budget.** Required criteria always run; only transitive ones are admitted greedily by chain length, historical failure
  rate, then cost. `overBudget` reports when the required set alone exceeds the budget.
- **Fallback.** Full verification when the change set is unknown or a build-level file changed (lockfiles, Dockerfile,
  workflows, migrations).
- **API.** `POST /projects/:pid/builds/:bid/selection` with `sources` (repository-relative path → text, max 3,000 files and
  5 MB) and optional `budget`. Owner-scoped. Nothing is executed.
- **Complexity.** Graph build is linear in source bytes. Closure is O(V + E) per changed set.
- **Limits.** Static only: spawned processes, computed paths and bare-specifier internals are invisible. No learned ranking.
- **Tests.** `tests/impact-graph.test.js` (12), `tests/algorithm-selection-api.test.js` (4).
- **Benchmark.** `scripts/bench-impact.mjs`, with truth from `scripts/bench-collect-truth.mjs`.

## 2. NSGA-II exploration — `playtest-agent-main/pt/search_nsga2.py`

- **Algorithm.** Fast non-dominated sorting, crowding distance, binary tournament on (rank, crowding), one-point crossover
  on action sequences, typed mutation (replace, insert, delete), duplicate sequence elimination, behavioural duplicate
  elimination during selection, exact evaluation budget, seeded RNG.
- **Objectives.** Seven, combined only by Pareto dominance: states, edges, new states, new defects, recipe progress,
  effective actions (min), cost (min). `Session(mask=...)` supports ablation.
- **Actions.** `NAVIGATE, CLICK, TYPE, SUBMIT, SCROLL, WAIT, ASSERT, RECORD` (`pt/search_model.py`). Browser-level
  mapping is not implemented here.
- **Evaluator.** `SimApp.run(actions)` returns a `Trace`. The real Playtest adapter would have to implement the same contract.
- **Tests.** `playtest-agent-main/tests/test_search_nsga2.py` (18, including each seeded defect's hand-checked witness sequence).
- **Benchmark.** `playtest-agent-main/bench/algorithm_intelligence_bench.py`.

## 3. ProbDD-style reduction — `playtest-agent-main/pt/probdd.py`

- **Algorithm.** Each removable step has a probability of being needed. Removal sets are sampled with probability proportional
  to 1 − p. Outcomes update probabilities (decay on success, learning on failure). A final deterministic pass achieves
  1-minimality. Pinned steps are never removed. Every oracle call is cached and counted against the budget.
- **Not claimed.** This is a heuristic inspired by ProbDD. Its update rules are not the published ones and its convergence
  was not analysed.
- **Tests.** `playtest-agent-main/tests/test_probdd.py` (11), including a direct 1-minimality check and budget enforcement.

## 4. Ochiai fault localization — `server/fault-localization.js`

- **Formula.** Ochiai(c) = n_ef / sqrt(n_f (n_ef + n_ep)), zero when undefined. `rankComponents` returns exact counts and the
  contributing test identifiers per component. Infra executions are excluded and counted; tests with mixed outcomes are flaky and excluded.
- **Fallback.** `dependencyFallback` orders components by import distance from failing tests, labelled as not Ochiai.
- **Spectrum source.** `scripts/bench-collect-truth.mjs`, using `NODE_V8_COVERAGE` on the server suite. Infra-only failures
  (browser timeouts, connection refusals) are classified from TAP error blocks.
- **Not wired** into the repair dossier. This is a library and benchmark, not a product feature.
- **Tests.** `tests/fault-localization.test.js` (8, including the hand-computed ranking 1.0 / 0.5 / 0.0).

## 5. Interprocedural taint analysis — not implemented

Designed in `ALGORITHM_INTELLIGENCE_PLAN.md` §5. No sound JavaScript parser is in the dependency set, and a regex-level pass
would produce unmeasured precision. This is the next step, which requires an AST dependency and a labelled fixture corpus.

## 6. MinHash / LSH — `gatekeeper-main/src/gatekeeper/fingerprint/minhash.py`

- **Normalisation.** Token stream with comments, whitespace and optional semicolons removed; literals become `S` and `N`;
  identifiers become `I` unless they carry capability meaning (`require`, `child_process`, `exec`, `fetch` and similar).
- **Algorithm.** Token 5-shingles (blake2b, stable across processes), seeded universal-hash MinHash with 128 permutations,
  32-band LSH (threshold about 0.42), exact-shingle Jaccard verification at 0.5, and exact SHA-256 fast paths
  (raw and normalised).
- **Output.** `Relationship` records with kind, estimated and exact Jaccard, and a reason that explicitly says the finding is
  shared code shape, not maliciousness.
- **Not wired** into Gatekeeper's campaign attribution. Campaign conclusions still require publisher, endpoint and install-time evidence.
- **Tests.** `gatekeeper-main/tests/test_minhash.py` (9). **Benchmark.** `gatekeeper-main/scripts/bench_minhash.py`.

## 7. Merkle evidence transparency — `server/transparency.js`

- **Algorithm.** RFC 9162 §2.1: domain-separated SHA-256 leaf (0x00) and node (0x01) hashing; tree hash; inclusion
  proofs (PATH) and consistency proofs (PROOF/SUBPROOF); standalone verifiers that take only a root and a proof.
- **Checkpoints.** `checkpoint(log, keys)` signs canonical text with the existing Ed25519 server key; `verifyCheckpoint`
  checks signature only.
- **Not claimed.** No third-party timestamping and no external anchoring. The log is in memory; persistence and
  integration with dossiers are not implemented.
- **Tests.** `tests/transparency.test.js` (11). No scale benchmark.

## Integration and product surface

- Implemented in product code: the selection route (Algorithm 1) and its library dependencies.
- Library only, with tests and benchmarks: Algorithms 2, 3, 4, 6, 7.
- **Not built:** the Algorithm Intelligence UI section; the repair-dossier link from Ochiai; the Gatekeeper campaign hookup
  for fingerprints; persistence and API for the transparency log; taint analysis.

## Limits and what did not work

- Algorithm 4 did not localize on the chosen spectrum, and the product must not claim it does.
- Algorithm 2 did not beat random sampling on its synthetic model.
- Algorithm 1 executes every test in this repository without a budget; its benefit depends on a repository with a sparser graph.
- No algorithm has been validated on production data.
