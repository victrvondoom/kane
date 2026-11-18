# SHIPPROOF — Advanced Algorithmic Intelligence Engineering Plan

## 1. Executive Summary & Architecture Integration

SHIPPROOF requires mathematically rigorous, research-grounded algorithms to transform its release-gate and security intelligence from reactive check execution to proactive, automated, and explainable software reliability engineering.

This plan details the design, mathematical foundations, data structures, algorithmic complexity, API contracts, and integration points for the 7 algorithmic engines integrated into SHIPPROOF:

1. **Hybrid Graph-Based Test Impact Intelligence** (Static dependency + call graph + historical outcomes + budget ranking)
2. **NSGA-II Multi-Objective Automated Exploration** (Non-dominated sorting + crowding distance + browser action sequence optimization)
3. **Probabilistic Delta Debugging (ProbDD & ddmin)** (Hypothesis-driven sequence reduction + 1-minimality + failure signature preservation)
4. **Ochiai Spectrum-Based Fault Localization (SBFL)** (Coverage matrix $\times$ outcome vector $\to$ suspiciousness ranking)
5. **Interprocedural Static Taint Analysis** (Source-to-sink reachability + alias tracking + Gatekeeper install-hook reachability)
6. **MinHash & Locality-Sensitive Hashing (LSH) for Campaign Detection** (AST tokenization + shingling + MinHash signatures + LSH banding)
7. **RFC 9162 Merkle-Based Evidence Transparency Log** (Domain-separated hashing + audit inclusion proofs + consistency proofs)

### Absolute Invariant: Real Execution Authority

In accordance with SHIPPROOF's foundational invariant:
> **A criterion is verified ONLY when a real Kane CLI execution returns exit code 0, a passing `run_end` event, and collected evidence.**

No algorithm, optimization metric, fault localization prediction, or static graph analysis is permitted to mark a criterion verified or override a failing execution. The algorithms serve to prioritize, isolate, reproduce, explain, and safeguard—never to fabricate or bypass verification.

---

## 2. Algorithm Specifications

### 2.1 Algorithm One: Hybrid Graph-Based Test Impact Intelligence

- **Problem:** Running exhaustive regression suites after every change is computationally wasteful and introduces high developer latency. Direct file-matching misses indirect semantic breaks through imports, utilities, and state managers.
- **Mathematical / Algorithmic Basis:**
  - Build directed multigraph $G = (V, E)$, where $V = V_{\text{file}} \cup V_{\text{symbol}} \cup V_{\text{test}} \cup V_{\text{criterion}}$ and $E$ represents import dependencies, call graph edges, test coverage mappings, and criterion specifications.
  - For commit delta $\Delta C = \{f_1, f_2, \dots, f_k\}$, compute transitive reachability $R(\Delta C) = \{v \in V \mid \exists p: f_i \rightsquigarrow v\}$.
  - Score candidate criteria $c \in R(\Delta C) \cap V_{\text{criterion}}$ using structural and historical weighting:
    $$S(c) = w_{\text{dist}} \cdot \frac{1}{1 + d(\Delta C, c)} + w_{\text{fail}} \cdot H_{\text{fail}}(c) + w_{\text{churn}} \cdot C_{\text{churn}}(c) + w_{\text{crit}} \cdot P(c)$$
    where $d(\Delta C, c)$ is the shortest path distance in $G$, $H_{\text{fail}}(c)$ is the historical failure rate, $C_{\text{churn}}$ is file change frequency, and $P(c)$ is release criticality.
  - Apply budget-constrained greedy selection (Knapsack formulation) when execution time budget $B_{\text{time}}$ or count budget $B_{\text{count}}$ is supplied.
- **Inputs:**
  - Workspace root directory path.
  - Changed files list $\Delta C$ (or commit diff).
  - Configurable budget: `{ maxTests, timeBudgetMs, minConfidence }`.
- **Outputs:**
  - Selected criteria list sorted by priority score.
  - Transparent structural explanation for each selection (`path`: $f \to \dots \to c$, `reason`: direct change, transitive dependency, high historical failure rate).
- **Implementation File:** `server/algorithms/test-impact-graph.js`
- **Complexity:** Graph construction $O(|V| + |E|)$, reachability query $O(|V| + |E|)$ via BFS/Dijkstra, ranking $O(|C| \log |C|)$.

---

### 2.2 Algorithm Two: NSGA-II Multi-Objective Automated Exploration

- **Problem:** Random fuzzing generates unguided browser traffic; single-metric exploration over-indexes on one behavior (e.g. shallow link clicks) while missing critical application states and error paths.
- **Mathematical / Algorithmic Basis:**
  - Model browser interaction as variable-length sequence of actions $\mathbf{a} = \langle a_1, a_2, \dots, a_m \rangle$, where $a_i \in \{\text{NAVIGATE}, \text{CLICK}, \text{TYPE}, \text{SELECT}, \text{WAIT}, \text{ASSERT}\}$.
  - Define 4 objective functions to maximize/minimize simultaneously:
    1. $f_1(\mathbf{a}) = |\text{Unique DOM States visited}|$ (Maximize state exploration)
    2. $f_2(\mathbf{a}) = \text{Entropy}(\text{Interaction Event Types})$ (Maximize action diversity)
    3. $f_3(\mathbf{a}) = \text{Defect Potential}(\mathbf{a})$ (Console errors, 4xx/5xx responses, unhandled exceptions) (Maximize)
    4. $f_4(\mathbf{a}) = \text{len}(\mathbf{a})$ (Minimize execution cost / redundancy)
  - Apply Deb et al.'s NSGA-II:
    - Fast non-dominated sorting into Pareto fronts $\mathcal{F}_1, \mathcal{F}_2, \dots, \mathcal{F}_k$.
    - Crowding distance calculation in objective space to preserve diversity along the Pareto frontier.
    - Binary tournament selection based on rank and crowding distance.
    - Genetic operators: single-point sequence splice crossover and 4 mutation types (insert action, delete action, swap parameter, mutate selector).
- **Inputs:**
  - Application entry points / routes.
  - Exploration parameter configuration: `{ populationSize, generations, maxActions, seedSequences }`.
- **Outputs:**
  - Pareto-optimal set of action sequences exploring diverse application frontiers with minimal step redundancy.
  - Objective score breakdown for each sequence on the frontier.
- **Implementation File:** `server/algorithms/nsga2-exploration.js`
- **Complexity:** $O(N \log N)$ non-dominated sorting with optimized fast sort; crowding distance $O(M \cdot N \log N)$ where $M=4$ objectives and $N$ is population size.

---

### 2.3 Algorithm Three: Probabilistic Delta Debugging (ProbDD & ddmin)

- **Problem:** Failing automated exploration traces or Playtest runs contain tens or hundreds of actions, only a fraction of which are causally related to the defect. Manual triaging is tedious and error-prone.
- **Mathematical / Algorithmic Basis:**
  - Extend classic Zeller delta debugging (`ddmin` in `playtest-agent-main/pt/reduce.py`) into Probabilistic Delta Debugging (ProbDD).
  - Assign prior probabilities $P(\text{causal} \mid a_i)$ based on action taxonomy:
    - High prior for state-mutating actions (form submission, POST triggers, state toggles).
    - Low prior for passive actions (duplicate clicks, benign waits, read-only scrolls).
  - Partition sequence into subsets ordered by ascending causal probability, testing partitions that remove low-probability actions first.
  - Guarantee 1-minimality: $\forall a \in S_{\text{min}}, \text{outcome}(S_{\text{min}} \setminus \{a\}) \neq \text{FAIL}$.
  - Strict Failure Signature Preservation:
    $$\text{signature}(S) = (\text{error\_type}, \text{failing\_selector}, \text{status\_code})$$
    A reduction is valid only if $\text{signature}(S_{\text{reduced}}) = \text{signature}(S_{\text{original}})$, preventing mask/spurious failures.
- **Inputs:**
  - Original failing action sequence $S = \langle a_1, \dots, a_n \rangle$.
  - Evaluation oracle function $\text{test}(S') \to \{\text{PASS}, \text{FAIL}, \text{UNRESOLVED}\}$.
  - Expected failure signature.
- **Outputs:**
  - 1-minimal reduced action sequence $S_{\text{min}}$.
  - Reduction statistics: original step count, reduced step count, reduction percentage, test evaluations count.
- **Implementation File:** `server/algorithms/delta-debugging.js`
- **Complexity:** Worst-case $O(n^2)$ test executions, average-case $O(n \log n)$ evaluations with probabilistic ordering.

---

### 2.4 Algorithm Four: Ochiai Spectrum-Based Fault Localization (SBFL)

- **Problem:** When regression suites fail, developers are presented with failing test names, but the underlying root-cause source code file and function remain ambiguous.
- **Mathematical / Algorithmic Basis:**
  - Construct coverage spectrum matrix $A \in \{0, 1\}^{M \times N}$ for $M$ test executions over $N$ program components (files / functions).
  - Outcome vector $\mathbf{y} \in \{\text{PASS}, \text{FAIL}\}^M$.
  - For each component $c$, compute:
    - $n_{ef}$: Number of failed tests that executed $c$
    - $n_{ep}$: Number of passed tests that executed $c$
    - $n_{f}$: Total number of failed tests
    - $n_{p}$: Total number of passed tests
  - Ochiai similarity coefficient:
    $$\operatorname{Ochiai}(c) = \begin{cases} \frac{n_{ef}}{\sqrt{n_f \cdot (n_{ef} + n_{ep})}} & \text{if } n_f \cdot (n_{ef} + n_{ep}) > 0 \\ 0 & \text{otherwise} \end{cases}$$
  - Rank components in descending order of suspiciousness. Link top-ranked components directly to the coding agent repair context and on-call diagnostics.
- **Inputs:**
  - Test execution outcomes (pass/fail per criterion/test).
  - Component coverage vectors (file-level or function-level execution traces).
- **Outputs:**
  - Ranked list of suspicious components with Ochiai scores, $n_{ef}, n_{ep}, n_f, n_p$.
  - Diagnostic explanation connecting suspicious components to failing acceptance criteria.
- **Implementation File:** `server/algorithms/ochiai-localization.js`
- **Complexity:** $O(M \cdot N)$ spectrum aggregation, $O(N \log N)$ sorting.

---

### 2.5 Algorithm Five: Interprocedural Static Taint Analysis

- **Problem:** Malicious npm packages exfiltrate secrets during install hooks or runtime through deceptive multi-step assignments, function calls, and object property flows.
- **Mathematical / Algorithmic Basis:**
  - Integrate directly with Gatekeeper's `runs_at_install` and reachable files set from `gatekeeper-main/src/gatekeeper/evidence/reach.py`.
  - Parse files into Abstract Syntax Trees (ASTs) using Babylon/Babel/Acorn.
  - Define Source-Sink lattice:
    - **Sources:** `process.env.*`, `~/.npmrc`, `~/.ssh/*`, CI tokens (`GITHUB_TOKEN`, `AWS_*`), credentials, cookie jars.
    - **Sanitizers:** Hash functions, schema validators, explicit whitelists.
    - **Sinks:** Network (`http.request`, `https.request`, `fetch`, `axios`, `net.connect`, `dns.resolve`, `dgram`), Process execution (`child_process.exec`, `execSync`, `spawn`, `eval`, `Function`), File exfiltration (`fs.writeFile`, `fs.appendFile`).
  - Interprocedural forward data-flow propagation:
    - Intraprocedural def-use chains.
    - Interprocedural call graph propagation: taint of arguments propagates into formal parameters; taint of return statements propagates to call sites.
    - Property sensitivity: tracking object fields $\text{obj}.\text{prop}$.
  - Path construction: Output exact node-by-node taint propagation path $S \to v_1 \to v_2 \to \dots \to K$.
- **Inputs:**
  - Package root or source directory.
  - Entry point files (install hooks like `install.js` and main export).
- **Outputs:**
  - Identified taint flows with source variable/expression, sink function, call stack, file paths, line numbers, and risk classification.
- **Implementation File:** `server/algorithms/taint-analysis.js`
- **Complexity:** $O(|V_{\text{AST}}| \cdot K)$ where $K$ is call graph depth; bounded recursion prevents catastrophic backtracking.

---

### 2.6 Algorithm Six: MinHash & Locality-Sensitive Hashing (LSH) for Campaign Detection

- **Problem:** Threat actors publish hundreds of typosquatted or slightly obfuscated packages sharing identical malicious payloads with renamed variables and altered formatting.
- **Mathematical / Algorithmic Basis:**
  - AST Normalization: Strip comments, normalize variable/function identifiers to canonical placeholders ($\text{VAR}_0, \text{FN}_1$), standardize literals, retain structural grammar tokens.
  - $k$-Shingling: Extract overlapping $k$-grams of normalized token stream (e.g., $k=5$).
  - MinHash Signatures:
    - Choose $m = 128$ independent hash functions $h_i(x) = (a_i \cdot x + b_i) \pmod p$.
    - Signature vector $\mathbf{s}(D) = [ \min_{s \in D} h_1(s), \dots, \min_{s \in D} h_m(s) ]$.
    - Unbiased estimator of Jaccard similarity:
      $$\Pr[s_i(D_1) = s_i(D_2)] = J(D_1, D_2) = \frac{|D_1 \cap D_2|}{|D_1 \cup D_2|}$$
  - Locality-Sensitive Hashing (LSH) Banding:
    - Divide 128-dim signature into $b = 16$ bands of $r = 8$ rows ($b \cdot r = 128$).
    - Hash each band into hash tables.
    - Probability of collision for similarity $s$:
      $$P_{\text{collision}} = 1 - (1 - s^r)^b = 1 - (1 - s^8)^{16}$$
      For $s = 0.8$, $P_{\text{collision}} \approx 0.985$. For $s = 0.2$, $P_{\text{collision}} \approx 0.00004$.
  - Cluster detection: Group candidate pairs sharing buckets and having verified Jaccard similarity above threshold $\theta \ge 0.75$.
- **Inputs:**
  - Package source files / tarballs.
  - Catalog of known package signatures.
- **Outputs:**
  - Near-duplicate cluster assignments (Campaign ID).
  - Pairwise Jaccard similarity estimates.
  - Shared structural token fingerprints.
- **Implementation File:** `server/algorithms/minhash-lsh.js`
- **Complexity:** Signature generation $O(|D| \cdot m)$, LSH candidate retrieval $O(b \cdot 1) = O(1)$ per query.

---

### 2.7 Algorithm Seven: Merkle-Based Evidence Transparency Log (RFC 9162)

- **Problem:** Evidence dossiers must be tamper-evident, verifiable by third-party auditors without sharing confidential test payloads, and provably append-only over time.
- **Mathematical / Algorithmic Basis:**
  - Implement RFC 9162 (Certificate Transparency Version 2) compliant Merkle Tree.
  - Domain separation:
    - Leaf hash: $H(\text{leaf}) = \text{SHA-256}(0x00 \parallel \text{data})$
    - Internal node hash: $H(\text{node}) = \text{SHA-256}(0x01 \parallel \text{left} \parallel \text{right})$
  - Inclusion Proof:
    - For leaf index $i$ in tree of size $N$, construct audit path $\mathcal{P}_i = \langle (d_k, \text{hash}_k) \rangle_{k=1}^{\lceil \log_2 N \rceil}$.
    - Verifier recomputes root hash in $O(\log N)$ and checks equality against Signed Tree Head (STH).
  - Consistency Proof:
    - For tree sizes $M < N$, construct proof that tree of size $M$ is an exact prefix of tree of size $N$ without reordering or mutating historical leaves.
- **Inputs:**
  - Stream of evidence artifacts (run results, Kane events, screenshots, Gatekeeper findings).
- **Outputs:**
  - Root Hash / Signed Tree Head (STH).
  - Standalone cryptographic inclusion proofs ($O(\log N)$ size).
  - Standalone consistency proofs between checkpoints.
- **Implementation File:** `server/algorithms/merkle-transparency.js`
- **Complexity:** Leaf insertion $O(\log N)$, inclusion proof generation and verification $O(\log N)$, consistency proof $O(\log N)$.

---

## 3. Database Schema Extensions

To persist algorithmic outcomes across runs and power the dynamic UI suite, we introduce migration `migrations/009_algorithmic_intelligence.sql`:

```sql
-- Test Impact Analyses
CREATE TABLE IF NOT EXISTS test_impact_analyses (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  changed_files TEXT NOT NULL, -- JSON array
  selected_criteria TEXT NOT NULL, -- JSON array of criteria with scores and reasons
  total_criteria INTEGER NOT NULL,
  selected_count INTEGER NOT NULL,
  confidence_score REAL NOT NULL,
  created_at TEXT NOT NULL
);

-- Fault Localization Runs
CREATE TABLE IF NOT EXISTS fault_localization_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT,
  total_components INTEGER NOT NULL,
  top_suspicious_components TEXT NOT NULL, -- JSON array with Ochiai metrics
  failing_criteria TEXT NOT NULL, -- JSON array
  created_at TEXT NOT NULL
);

-- Exploration & Delta Debugging Records
CREATE TABLE IF NOT EXISTS algorithm_sequence_records (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  record_type TEXT NOT NULL, -- 'nsga2_frontier' or 'delta_debugging'
  original_step_count INTEGER NOT NULL,
  reduced_step_count INTEGER NOT NULL,
  reduction_ratio REAL NOT NULL,
  signature TEXT NOT NULL,
  action_sequence TEXT NOT NULL, -- JSON array of steps
  objectives TEXT, -- JSON object
  created_at TEXT NOT NULL
);

-- Taint Analysis Findings
CREATE TABLE IF NOT EXISTS taint_analysis_findings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  package_name TEXT NOT NULL,
  source_type TEXT NOT NULL,
  sink_type TEXT NOT NULL,
  flow_path TEXT NOT NULL, -- JSON array of AST steps
  severity TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Campaign Clusters (MinHash / LSH)
CREATE TABLE IF NOT EXISTS campaign_clusters (
  id TEXT PRIMARY KEY,
  cluster_name TEXT NOT NULL,
  package_name TEXT NOT NULL,
  jaccard_similarity REAL NOT NULL,
  shared_tokens_sample TEXT NOT NULL,
  signature_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Merkle Tree Checkpoints
CREATE TABLE IF NOT EXISTS merkle_tree_checkpoints (
  id TEXT PRIMARY KEY,
  tree_size INTEGER NOT NULL,
  root_hash TEXT NOT NULL,
  signed_head TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

---

## 4. API Endpoints Contract

All endpoints will be registered under `server/routes-algorithms.js`:

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/algorithms/impact/analyze` | Computes test impact graph traversal for given changed files/commit. |
| `GET`  | `/api/algorithms/impact/history/:projectId` | Fetches historical impact selection decisions and reasoning. |
| `POST` | `/api/algorithms/nsga2/explore` | Generates Pareto-optimal browser exploration sequences. |
| `POST` | `/api/algorithms/ddmin/reduce` | Executes Probabilistic Delta Debugging on failing action sequence. |
| `POST` | `/api/algorithms/sbfl/localize` | Computes Ochiai suspiciousness ranking across test run matrix. |
| `GET`  | `/api/algorithms/sbfl/latest/:projectId` | Retrieves latest fault localization dossier. |
| `POST` | `/api/algorithms/taint/scan` | Runs interprocedural taint analysis on target package/files. |
| `POST` | `/api/algorithms/campaign/cluster` | Calculates MinHash signatures & LSH cluster matches. |
| `POST` | `/api/algorithms/transparency/append` | Appends evidence leaf to RFC 9162 Merkle log. |
| `POST` | `/api/algorithms/transparency/proof` | Generates/verifies inclusion or consistency proof. |
| `GET`  | `/api/algorithms/overview/:projectId` | Unified overview summarizing all active algorithms. |

---

## 5. UI Integration Architecture

The SHIPPROOF frontend single-page application (`public/index.html` & `public/app.js`) will be enhanced with a dedicated **Algorithm Intelligence** dashboard view:
- **Test Impact Explorer:** Interactive dependency trace visualizer showing changed file $\to$ intermediate symbols $\to$ selected criteria, with time-budget sliders.
- **Ochiai Fault Heatmap:** Ranked file list with visual suspiciousness meters ($n_{ef}, n_{ep}, \text{score}$) and code line indicators.
- **Sequence Reduction Diff:** Side-by-side comparison of original vs 1-minimal action sequence with eliminated noise steps struck through.
- **Security Taint Graph:** Flow diagram displaying sensitive source (e.g. `process.env.NPM_TOKEN`) cascading through assignments to dangerous sinks (`http.request`).
- **Campaign Cluster Map:** Visual clusters of related supply-chain packages detected via MinHash & LSH.
- **Merkle Transparency Inspector:** Live cryptographic proof verifier displaying Signed Tree Head and Merkle branch verification.

---

## 6. Evaluation, Validation & Benchmarking Methodology

To ensure production rigor, `scripts/benchmark-algorithms.js` will measure real numbers on real application data:
1. **Impact Intelligence:** Selection efficiency (reduction in test count vs full suite), recall of known regressions, execution latency.
2. **NSGA-II Exploration:** Hypervolume metric, Pareto frontier spread, time to defect discovery.
3. **ProbDD Reduction:** Reduction ratio ($1 - \frac{|S_{\text{min}}|}{|S_{\text{orig}}|}$), number of test evaluations, verification of 1-minimality and signature idempotency.
4. **Ochiai SBFL:** Top-1, Top-3, and Top-5 fault localization accuracy; comparison against random ranking baseline.
5. **Taint Analysis:** Precision and recall against synthetic and real supply-chain attack vectors, analysis duration.
6. **MinHash / LSH:** Jaccard estimation error relative to exact Jaccard, candidate pair retrieval speedup vs $O(N^2)$ all-pairs comparison.
7. **Merkle Transparency:** Tree insertion throughput, inclusion proof generation/verification latency.

All results will be documented in `ALGORITHM_IMPLEMENTATION_REPORT.md`, `ALGORITHM_BENCHMARK_REPORT.md`, and `ALGORITHM_VALIDATION.md`.
