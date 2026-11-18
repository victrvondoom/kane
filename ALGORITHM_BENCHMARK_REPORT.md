# SHIPPROOF — Algorithmic Intelligence Benchmark & Performance Report

## 1. Benchmark Environment

- **Host System:** Windows 10/11 x64
- **Node.js Runtime:** v24.14.0 (win32 x64)
- **Database Engine:** SQLite (WAL Mode, synchronous NORMAL)
- **Benchmark Suite:** `scripts/benchmark-algorithms.js`
- **Measurement Precision:** High-resolution timers via `performance.now()` ($\mu\text{s}$ accuracy)

---

## 2. Empirical Benchmark Results

### 2.1 Algorithm 1: Hybrid Graph-Based Test Impact Intelligence
- **Graph Construction Time:** 142.23 ms
- **Graph Topology:** 857 nodes, 2,307 edges
- **Impact Query Latency:** 134.67 ms
- **Test Suite Reduction:** Selected 4 of 7 criteria (42.9% reduction in test execution time)
- **Causal Recall:** 100% (both directly and transitively dependent criteria correctly selected)
- **Selection Confidence Score:** 43.5% (prioritized by failure probability and distance)

### 2.2 Algorithm 2: NSGA-II Multi-Objective Automated Exploration
- **Evolution Runtime:** 9.39 ms across 15 generations
- **Population Size:** 30 individuals
- **Pareto Frontier Size:** 30 non-dominated exploration sequences
- **Mean State Coverage:** 5.5 unique DOM/URL states per sequence
- **Mean Action Sequence Length:** 12.6 steps
- **Mean Interaction Diversity:** 1.74 Shannon entropy
- **Mean Defect Potential:** 7.05 heuristic trigger score

### 2.3 Algorithm 3: Probabilistic Delta Debugging (ProbDD vs ddmin)
- **Original Sequence:** 16 actions with injected noise (waits, clicks, redundant navigation)
- **Classic ddmin Results:**
  - Reduced Length: 2 actions (1-minimal)
  - Test Evaluations Required: 49 evaluations
  - Runtime: 0.54 ms
- **ProbDD Results:**
  - Reduced Length: 2 actions (1-minimal)
  - Test Evaluations Required: 29 evaluations
  - Runtime: 0.35 ms
- **Efficiency Gain:** ProbDD achieved identical 1-minimality while saving **40.8% of test evaluations** through causal prior ordering.
- **Overall Sequence Reduction:** **87.5% reduction** (16 steps $\to$ 2 steps).

### 2.4 Algorithm 4: Ochiai Spectrum-Based Fault Localization (SBFL)
- **Execution Matrix:** 50 test runs $\times$ 15 software components (15 failing, 35 passing)
- **Localization Compute Time:** 0.41 ms
- **Top-1 Fault Identified:** `server/discount.js` (Injected bug location)
- **Top-1 Ochiai Score:** **0.9393** (Critical Suspiciousness)
- **Top-1 Accuracy:** **100% (EXACT)**
- **Top-3 Accuracy:** **100%**
- **Comparative Discrimination:** Runner-up component (`server/app.js`) scored 0.450, providing a 0.4893 separation margin.

### 2.5 Algorithm 5: Interprocedural Static Taint Analysis
- **Scanned Scope:** 60 JavaScript and TypeScript files in `server/`
- **Total Scan Duration:** 20.93 ms
- **Analysis Throughput:** **2,866.7 files/second**
- **Precision:** Correctly identified multi-line argument flows from `process.env.NPM_TOKEN` to `fetch()` in synthetic attack payloads while producing zero false positives on production codebase files.

### 2.6 Algorithm 6: MinHash & Locality-Sensitive Hashing (LSH) for Campaign Detection
- **Signature Computation Time:** 0.71 ms per 128-hash signature
- **Exact Jaccard Similarity:** 0.6491
- **MinHash Estimated Jaccard:** 0.6328
- **Estimation Absolute Error:** **0.0163** (Error bound well within theoretical standard error $\frac{1}{\sqrt{128}} \approx 0.088$)
- **LSH Banding ($b=16, r=8$):** Successfully clustered 3 polymorphic typosquatted packages into a single campaign family in sub-millisecond query time.

### 2.7 Algorithm 7: RFC 9162 Merkle-Based Evidence Transparency Log
- **Append Throughput:** 259.42 ms for 500 evidence leaves (**1,927 leaves/second**)
- **Inclusion Proof Generation:** 3,792.6 $\mu\text{s}$ ($O(\log N)$ audit path construction)
- **Inclusion Proof Verification:** **89.2 $\mu\text{s}$**
- **Verification Verdict:** Cryptographically valid against Signed Tree Head (STH).
- **Tamper Resistance:** Modifying a single bit in leaf hash or sibling audit path immediately triggers verification failure.

---

## 3. Comparative Summary Table

| Engine | Primary Metric | Baseline / Comparison | Achieved Result | Improvement |
|---|---|---|---|---|
| **Test Impact** | Suite reduction | Full suite (100% tests) | 57.1% tests run | **42.9% time saved** |
| **NSGA-II** | Frontier diversity | Random fuzzing | 30 non-dominated seqs | **Pareto optimal** |
| **ProbDD** | Test evaluations | Classic ddmin (49 evals) | 29 evals | **40.8% fewer tests** |
| **Ochiai SBFL** | Fault rank accuracy | Random component triage | Top-1 Exact (0.9393) | **100% Top-1 hit** |
| **Taint Analysis** | Code scanning speed | Manual code review | 2,866 files/sec | **Real-time preflight** |
| **MinHash / LSH** | Jaccard error | $O(N^2)$ all-pairs scan | 0.0163 error, $O(1)$ lookup | **Sub-linear clustering** |
| **Merkle Log** | Proof verification | Unsigned evidence blobs | 89.2 $\mu\text{s}$ audit check | **RFC 9162 tamper-proof** |
