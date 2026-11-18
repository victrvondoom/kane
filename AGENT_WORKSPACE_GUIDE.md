# SHIPPROOF ENGINEER & Autonomous Workspace Guide

## 1. Project Tenant Workspace Isolation
SHIPPROOF guarantees that every autonomous workflow, security inspection, reproduction replay, and native optimization is executed in an isolated, canonical project workspace.

- **Workspace Path:** `data/workspaces/project-<pid>`
- **Path Confinement:** Managed by `server/workspace.js`. All operations must pass through `safeWorkspacePath(baseDir, relativePath)`.
- **Symlink Traversal Defense:** Dangling symlinks and directory traversal escapes (`../`, `~`, `/etc`, Windows junctions) are blocked via lexical canonicalization and realpath verification.
- **Seeding:** Workspaces are automatically initialized with repository assets upon project creation without contaminating global or server root directories.

---

## 2. Multi-Engine Architecture
The platform coordinates specialized worker processes communicating over an isolated, versioned JSON protocol via standard I/O:

```text
SHIPPROOF Node.js Backend (Express)
         │
         ├── Engine Bridge (server/engine-worker.js)
         │       │
         │       ├── Gatekeeper Worker (server/gatekeeper-worker.py)
         │       │     • Full npm/pnpm/yarn lockfile auditing
         │       │     • OSV vulnerability query
         │       │     • 5-Tool forensic investigator (read, search, decode, strings, compare)
         │       │
         │       ├── Playtest Agent Worker (server/playtest-worker.py)
         │       │     • Visual filmstrip recording & keyframe capture
         │       │     • DOM state difference analysis
         │       │     • Independent judge evaluation (YES/NO reproduction verdict)
         │       │
         │       ├── OQED Superoptimizer Worker (server/oqed-worker.py)
         │       │     • Native C/C++ target discovery (.c, .cpp, .h)
         │       │     • SMT formal equivalence checking (PROVEN_EQUIVALENT, TESTED_NOT_PROVEN)
         │       │     • LLVM Machine Code Analyzer (llvm-mca) throughput modeling
         │       │     • Honest Linux x86-64 capability enforcement
         │       │
         │       └── Nine-Layer SAE Interpretability Lab (server/sae/sae_engine.py)
         │             • 9 discrete layers ([0, 1, 2, 3, 4, 5, 6, 7, 8])
         │             • TopK and JumpReLU sparsity architectures
         │             • Automatic feature firing capture & provisional labeling
         │             • Causal steering studio (clamping, addition, ablation)
         │             • Cross-layer Directed Acyclic Graph (DAG) tracing
         │             • Reconstruction quality metrics (MSE loss, FVU, R², L0, dead features)
```

---

## 3. Autonomous Execution & Verification Lifecycle
Every autonomous software engineering loop follows the strict evidence-driven lifecycle:

1. **Specification Generation:** Steps Writer decomposes tasks into atomic criteria with preconditions, actions, and expected outcomes.
2. **Security Preflight:** Gatekeeper scans lockfiles and manifests, blocking known malicious packages, poisoned tarballs, and dangerous lifecycle scripts.
3. **Execution & Verification:** Kane CLI executes the browser acceptance criteria.
4. **Failure Investigation:** If Kane fails, Playtest Agent executes an independent replay, captures visual filmstrips, diffs state, and passes evidence to the independent judge.
5. **Dossier & Repair:** Coding Agent receives an actionable defect dossier (reproduction steps, expected vs. actual, visual citations) and generates a fix branch.
6. **Re-Verification & Gate Decision:** Kane CLI re-executes the test against the modified application.

---

## 4. Absolute Release Verification Invariant
> **Critical Invariant:**
> A criterion is verified **only** when a real Kane CLI execution returns exit code `0`, a valid passing `run_end` event, and collected evidence.
> Neither an AI model, autonomous agent, OQED superoptimization result, nor Playtest investigation can override this rule.

---

## 5. Engineer UI & Assistant Controls
Open the drawer with the **Engineer** button (or `Ctrl/Cmd + K` → "SHIPPROOF ENGINEER"):

- **Typed Conversation:** Enter sends, Shift+Enter adds a line, Stop work interrupts, End conversation closes it after confirmation.
- **Context Attachment:** "Ask the engineer" attaches the active failure context as labeled fields.
- **Permissions:** Read-only by default. Privileged production actions require explicit human on-screen approval.
- **Evidence Navigation:** Clickable `E-n` badges open exact evidence records (logs, traces, filmstrips, diffs).
- **Project Scoping:** Conversations are strictly tenant-isolated to their parent project.
- **Voice Integration:** Supported via WebRTC/SDP exchange with server-held keys and barge-in support.
