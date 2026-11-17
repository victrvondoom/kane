# SHIPPROOF — Algorithm Intelligence Plan

Status legend: **Implemented** = code + tests + measured benchmark in this repository.
**Proposed** = designed here, not implemented. See `ALGORITHM_IMPLEMENTATION_REPORT.md` for the final status.

## 0. Repository findings (inspected before designing)

| Area | What already exists | Decision |
|---|---|---|
| Change impact | `server/proof.js` `impactOf` / `impactPlan`: glob mapping of criterion `paths` against each build's `changed_paths`; unmapped or unknown change sets are treated as *unknown*, never unaffected. | Extend, do not replace. The new graph layer only **adds** candidates. |
| Test reduction | `playtest-agent-main/pt/reduce.py`: budgeted halving (ddmin-like) reduction of confirmed reports, with replay verification. Not 1-minimal, documented as "not proven minimal". | **Reuse**. ProbDD is added as an alternative strategy compared against it; `reduce.py` is not duplicated. |
| Install-hook reachability | `gatekeeper-main/src/gatekeeper/evidence/reach.py`: follows install hooks through relative `require`/`import`. | **Reuse** as the entry-point/reachability substrate for taint analysis (taint itself: proposed). |
| Build → source mapping | Criteria carry `paths` (glob list, repository-relative). Builds carry `changed_paths` + `paths_known`. There is **no** dependency graph and **no** checkout is stored by SHIPPROOF. | Dependency graph must be built from a checkout supplied by the CI caller or a local scan. |
| Execution coverage | Kane CLI drives a real browser: **no code-level coverage** is recorded for the application under test. Coverage exists only for the Node server's own test suite via `NODE_V8_COVERAGE`. | Fault localization is restricted to the server test suite (genuine V8 spectra). Application-level spectra are not invented. |
| Release cryptography | `server/keys.js` + `buildDossier`: Ed25519 signature over `payloadSha256`, per-section hashes, evidence index; `verifyDossier` re-verifies. No append-only history. | Merkle transparency (optional, secondary) adds history proofs; it must not duplicate the signature scheme. |
| Explorer | `playtest-agent-main/pt/` has a driver adapter (`make(game)`), replay, judge and report. | NSGA-II engine plugs into the adapter interface; benchmarked on a deterministic simulated application model. |
| Package fingerprints | `gatekeeper` has exact-match and rule-based triage; no near-duplicate detection. | MinHash/LSH added as a candidate generator; never a verdict. |

Existing invariants preserved: a pass requires CURRENT evidence; unknown impact never becomes unaffected; infrastructure results never count as passes; scores never change a criterion's verification state; the signed dossier is unchanged.

## 1. Hybrid graph-based test impact selection — **Critical** — `server/impact-graph.js`

- **Problem.** Running every criterion per commit is costly; mapping-only selection misses indirect regressions (a changed helper breaks a criterion whose mapping names only its caller).
- **Algorithm.** Static import graph (ES `import`/`export from`, `require`, dynamic `import()` recorded as *unresolved*), reverse breadth-first closure from changed files, criterion matching on the closure, tiered ranking (direct → transitive → unknown), historical failure rate and cost as tie-breakers, budgeted greedy selection, explicit fallback to full verification when the graph is not trustworthy.
- **Inputs.** `changedPaths` (or *unknown*), a `files` map or checkout directory, criteria with `paths`/`mandatory`/`criticality`, optional history rows (`status`, `duration_ms`), budget.
- **Outputs.** Selected criteria with tier, path chain that justified the selection, cost, and an explanation string; a fallback decision with reason; a per-commit trace.
- **Location.** `server/impact-graph.js` (pure), `tests/impact-graph.test.js`, `scripts/bench-impact.mjs`.
- **Never excluded silently.** Mandatory, critical, unknown-impact and unmapped criteria are always selected.
- **Evaluation.** Ground truth = the set of test files whose real execution (V8 coverage of the actual run) loads each changed file. Compared: full suite, direct-mapping selection, hybrid graph selection. Learned ranking is **not** implemented: the repository has no trustworthy historical outcome data to train or validate on.
- **Limitations.** Static graph misses computed paths (reported as unresolved); coverage truth is loaded-module truth, not fault truth; costs are measured wall time on this machine.

## 2. NSGA-II multi-objective exploration — **Critical** — `playtest-agent-main/pt/search_nsga2.py`

- **Problem.** Random or greedy exploration repeats low-value interactions.
- **Algorithm.** NSGA-II (Deb et al., 2002): fast non-dominated sorting, crowding-distance preservation, binary tournament on (rank, crowding), one-point crossover and typed mutation over action sequences, duplicate-path elimination by canonical hash, execution budget, seeded RNG.
- **Candidate.** A list of actions from `NAVIGATE, CLICK, TYPE, SUBMIT, SCROLL, WAIT, ASSERT, RECORD`.
- **Objectives** (all measured, none weighted together): state coverage (distinct abstract states), route/interaction coverage (distinct edges), new-state discovery, unobserved error discovery, defect-reproduction hits, action count (minimised), execution cost (minimised).
- **Evaluator.** Pluggable. The benchmark uses a deterministic simulated application model with seeded defects (synthetic). The real browser path is an adapter interface; it is **not** executed in this environment.
- **Location.** `playtest-agent-main/pt/search_nsga2.py`, `playtest-agent-main/tests/test_search_nsga2.py`, `playtest-agent-main/bench/nsga2_bench.py`.
- **Evaluation.** NSGA-II vs random sampling vs greedy frontier-first, same evaluation budget, several seeds; metrics: states, edges, unique seeded defects found, actions per defect, Pareto front size.

## 3. Probabilistic Delta Debugging — **Critical** — `playtest-agent-main/pt/probdd.py`

- **Problem.** A failing browser session can contain dozens of unnecessary actions; `reduce.py` halves chunks without learning which actions matter.
- **Algorithm.** Probabilistic delta debugging: each action keeps a probability of being failure-relevant, updated from observed outcomes of sampled subsets; candidate subsets are sampled from these probabilities; removals are accepted only when the same failure signature reproduces; the search stops at a 1-minimal fixed point or the replay budget.
- **Reuse.** Same oracle contract as `reduce.holds`; setup/auth prefix actions are pinned and never removed.
- **Evaluation.** Replays needed and reduced length vs `reduce.py` on the same synthetic oracles with a known minimal failure set; success reproduction rate.
- **Limitations.** Oracle is deterministic in tests; in production the failure signature must be re-run under the repeatability policy.

## 4. Ochiai spectrum-based fault localization — **Critical** — `server/fault-localization.js`

- **Problem.** SHIPPROOF knows *that* a criterion failed, not *which* components are associated with failures.
- **Formula.** Ochiai(c) = n_ef / sqrt(n_f · (n_ef + n_ep)), with n_ef, n_ep, n_f as defined in the assignment. Scores are 0 when the denominator is 0.
- **Spectrum.** Per test execution: pass/fail and the set of source files loaded (from V8 coverage of a real run). Infrastructure failures, timeouts and flaky executions (same test with mixed outcomes across repeats) are excluded and counted separately.
- **Scope.** Server test suite only; application-under-test spectra are not available from Kane CLI and are not invented.
- **Evaluation.** Seeded defects: small, real mutations applied to one server source file at a time; measure the rank of the mutated file (top-1 / top-3, mean reciprocal rank) against a dependency-distance baseline.
- **Location.** `server/fault-localization.js`, `tests/fault-localization.test.js`, `scripts/bench-sbfl.mjs`.

## 5. Interprocedural static taint analysis — **High** — *Proposed, not implemented*

- Designed in the plan: sources (environment, home secrets, SSH/cloud/CI credentials), sinks (HTTP, DNS, sockets, child processes), install-time roots from `reach.py`, JS/TS only.
- **Why not implemented now.** No sound JavaScript parser is available in the dependency set; a regex-level taint pass would produce findings whose precision is unmeasured and would be easy to misread as a verdict. The assignment forbids claiming soundness, and a truthful implementation needs a real AST (for example acorn) plus a labelled fixture corpus. This is recorded as the next step, not as completed work.

## 6. MinHash and LSH near-duplicate package fingerprinting — **High** — `gatekeeper-main/src/gatekeeper/fingerprint/minhash.py`

- **Algorithm.** Identifier and literal normalisation over a JavaScript token stream, token k-shingles, MinHash signatures with seeded universal hash functions, LSH banding for candidate retrieval, exact-SHA-256 fast path, Jaccard verification on candidates.
- **Output.** Campaign relationship records with the evidence used (Jaccard estimate, exact shingle Jaccard, shared publisher/endpoint fields when supplied). Similarity alone is never labelled malicious.
- **Evaluation.** Synthetic corpus: families of renamed/reformatted variants (positives) and unrelated files including shared boilerplate (negatives). Metrics: candidate recall, precision after verification, lookup comparisons vs brute force. The corpus is synthetic and labelled as such.
- **Location.** `gatekeeper-main/src/gatekeeper/fingerprint/minhash.py`, `gatekeeper-main/tests/test_minhash.py`, `gatekeeper-main/scripts/bench_minhash.py`.

## 7. Merkle evidence transparency (secondary) — `server/transparency.js`

- RFC 9162-style log: SHA-256, domain-separated leaf (0x00) and node (0x01) hashing, inclusion and consistency proofs, verification by an independent function that takes only a root and proof.
- Checkpoints are signed with the existing Ed25519 key (`keys.js`); no new signature scheme.
- No third-party timestamp anchoring is claimed.
- Status is recorded in the implementation report.

## 8. Integration and product surface

- Selection (1) runs before verification and returns a plan; Ochiai (4) ranks components for a failed repair dossier; the explorer (2, 3) feeds candidate reproductions that are still verified by the normal engine path. None can change a criterion's verification state.
- The UI "Algorithm Intelligence" section is **not** part of this change set; the HTTP surface is limited to the selection and localization endpoints if they are wired. See the implementation report for what was actually shipped.

## 9. Evaluation rules

- Synthetic, open-source and production-derived data are labelled in every benchmark.
- Deterministic seeds everywhere; results exported as JSON under `benchmarks/algorithm-intelligence/`.
- No tuning on the reported test split; where a parameter is chosen, it is chosen on a separate calibration set.
- Every number in the reports is copied from a benchmark output file.
