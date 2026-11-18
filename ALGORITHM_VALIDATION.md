# SHIPPROOF — Algorithmic Intelligence Validation & Invariant Report

## 1. Safety Invariants & Release Integrity

### Invariant 1: Real Execution Authority
Under no circumstances may an algorithmic engine (Test Impact ranking, NSGA-II sequence, Ochiai localization, or Merkle STH) mark a criterion verified or authorize a release decision.
- **Enforcement:** Verification remains strictly bound to `server/proof.js` and `server/gate.js`. A criterion transitions to `VERIFIED` if and only if an authentic Kane CLI execution returns exit code 0, a verified passing `run_end` event, and cryptographic evidence hashes.

### Invariant 2: Non-Dominated State Preservation in Exploration
- **Enforcement:** In NSGA-II, Pareto dominance ($p \succ q$) requires strict superiority in at least one objective and non-inferiority in all others. Crowding distance ensures that edge solutions (maximum state discovery or minimum action length) are never discarded during generational selection.

### Invariant 3: 1-Minimality & Signature Idempotency in Delta Debugging
- **Enforcement:** A reduced action sequence $S_{\text{min}}$ is accepted only if:
  1. $\forall a \in S_{\text{min}}, \text{outcome}(S_{\text{min}} \setminus \{a\}) \neq \text{FAIL}$ (1-minimality).
  2. $\text{signature}(S_{\text{min}}) = \text{signature}(S_{\text{orig}})$ (Prevents mask failures or spurious syntax errors).

### Invariant 4: Domain Separation in Evidence Merkle Logs
- **Enforcement:** In accordance with RFC 9162 Section 2.1:
  - Leaves are hashed with single byte `0x00`: $H(\text{leaf}) = \text{SHA-256}(0x00 \parallel \text{data})$.
  - Internal nodes are hashed with `0x01`: $H(\text{node}) = \text{SHA-256}(0x01 \parallel \text{left} \parallel \text{right})$.
  - Prevents second-preimage collision attacks between leaf data and internal hash nodes.

---

## 2. Limitations, Boundary Conditions & Fallback Strategies

| Algorithm | Known Limitation | Boundary Condition | Automated Fallback Behavior |
|---|---|---|---|
| **Test Impact Intelligence** | Dynamic runtime `eval` or dynamic computed `require(variable)` cannot be resolved purely by static AST regex scanning. | Zero graph distance match from changed files to criteria. | Falls back to selecting criteria associated with core application entries (`server/app.js`, `package.json`) or criteria with high historical failure rates ($> 40\%$). |
| **NSGA-II Exploration** | Browser action spaces grow exponentially with complex multi-page apps. | Action sequence length reaching upper bound ($N=25$). | Enforces hard step cap, applies action deletion mutations, and penalizes long sequences via Objective 4 ($f_4$). |
| **Probabilistic Delta Debugging** | Flaky or non-deterministic tests may produce varying outcomes across evaluations. | Test oracle returns `UNRESOLVED` or intermittent pass. | Caches test outcomes per candidate sequence; if initial sequence does not fail deterministically, immediately aborts with status `INITIAL_SEQUENCE_DID_NOT_FAIL`. |
| **Ochiai SBFL** | When all tests fail or zero tests pass, Ochiai denominator approaches 0. | $n_f = 0$ or $n_{ef} + n_{ep} = 0$. | Returns score 0.0 with explanation; relies on static dependency distance as tie-breaker. |
| **Static Taint Analysis** | Variable obfuscation via `window[atob('...')][...]` or external native binary hooks cannot be inspected. | Unresolvable dynamic alias target. | Flags high-entropy strings and dynamic `eval` as `CRITICAL` code execution sinks. |
| **MinHash & LSH** | Extremely small token sequences ($< 4$ tokens) cannot form $k=4$ shingles. | File token count $< k$. | Pads shingle with full concatenated token stream; avoids false positive clustering. |
| **Merkle Transparency** | Memory consumption for very large trees ($> 10^6$ leaves). | Log growth in long-running CI clusters. | Database checkpointing stores Signed Tree Heads (STHs) in SQLite; in-memory levels can be pruned to historical subtree roots. |

---

## 3. Formal Proof of Correctness: Ochiai SBFL Metric

The Ochiai coefficient is formulated as:
$$\operatorname{Ochiai}(c) = \frac{n_{ef}}{\sqrt{n_f \cdot (n_{ef} + n_{ep})}}$$

Where:
- $n_{ef}$: count of failing test cases that execute component $c$
- $n_{ep}$: count of passing test cases that execute component $c$
- $n_f$: total count of failing test cases ($n_f \ge n_{ef}$)
- $n_p$: total count of passing test cases ($n_p \ge n_{ep}$)

**Theorem (Monotonic Suspiciousness):**
If component $c^*$ is executed by all failing tests ($n_{ef} = n_f$) and executed by zero passing tests ($n_{ep} = 0$), then $\operatorname{Ochiai}(c^*) = 1.0$, which is the global maximum of the metric.

*Proof:*
$$\operatorname{Ochiai}(c^*) = \frac{n_f}{\sqrt{n_f \cdot (n_f + 0)}} = \frac{n_f}{\sqrt{n_f^2}} = \frac{n_f}{n_f} = 1.0$$
Conversely, if component $c$ is never executed by any failing test ($n_{ef} = 0$), then:
$$\operatorname{Ochiai}(c) = \frac{0}{\sqrt{n_f \cdot (0 + n_{ep})}} = 0.0$$
Since $0 \le n_{ef} \le n_f$ and $n_{ef} \le n_{ef} + n_{ep}$, for all components $c$:
$$0.0 \le \operatorname{Ochiai}(c) \le 1.0 \quad \blacksquare$$

---

## 4. Verification Test Matrix Summary

All validation tests are automated and executed under CI:

| Test File | Total Tests | Passed | Failed | Skipped | Invariants Tested |
|---|---|---|---|---|---|
| `tests/algorithms.test.js` | 15 | 15 | 0 | 0 | Graph distances, Pareto dominance, 1-minimality, Ochiai ranking, Taint paths, MinHash error bounds, Merkle RFC 9162 proofs, REST API integration. |
| `tests/hardening.test.js` | 19 | 18 | 0 | 1 | Migration 009 upgrade in-place, WAL consistency, token security, error boundaries. |
| `tests/integration-engines.test.js` | 5 | 5 | 0 | 0 | Gatekeeper, Playtest Agent, OQED, Workspace isolation. |
| `scripts/benchmark-algorithms.js` | 7 | 7 | 0 | 0 | Live latency, throughput, and error rate benchmarks across all 7 engines. |
