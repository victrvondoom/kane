# INTEGRATION PLAN — KANE CLI × STEPS WRITER × GATEKEEPER × PLAYTEST AGENT × OQED

## 1. Executive Summary & Objective

This project extends **SHIPPROOF** (the Kane CLI Hackathon application) into a complete, evidence-backed autonomous engineering system. It coordinates four specialized capabilities:
1. **Steps Writer**: Specification & Test Generation Engine.
2. **Gatekeeper**: Supply-Chain Security & Preflight Inspection Engine.
3. **Kane CLI**: Authoritative Browser Verification Engine.
4. **Playtest Agent**: Failure Reproduction, Evidence Collection & Defect Investigation Engine.
5. **OQED**: Native x86-64 C/C++ Optimization & SMT Equivalence Proof Engine (isolated native service).

Together with the **Coding Agent Adapter** and **Central Orchestration State Machine**, this creates the autonomous loop:
`CODING AGENT → TEST SPECIFICATION (STEPS WRITER) → SECURITY GATE (GATEKEEPER) → KANE CLI → VERIFICATION EVIDENCE → FAILURE ANALYSIS (PLAYTEST AGENT) → AGENT REPAIR → KANE REVERIFICATION → RELEASE DECISION (VERIFIED)`.

---

## 2. Non-Destructive Integration Principles

1. **Preserve Existing Architecture**: The existing Express backend, Node SQLite WAL database, and Vanilla JS single-page frontend remain authoritative.
2. **No Fake Integrations**: Every capability executes actual code and produces verifiable, stored evidence in SQLite.
3. **Strict Separation of Authoritative Roles**:
   - Kane CLI is the **authoritative** browser release verification engine.
   - Playtest Agent is an **investigative and reproduction** assistant; it never fabricates or overrides Kane results.
   - Gatekeeper is the **authoritative preflight security gate**; untrusted packages/code cannot proceed automatically.
   - OQED is strictly an **x86-64 native code optimizer**; it is never misrepresented as a JavaScript optimizer.
4. **Resilience & Idempotence**: State machine persists workflow runs, handles crashes gracefully, and recovers in-flight workflows on server restart.

---

## 3. Component Architecture & Responsibilities

### A. Steps Writer (`server/steps-writer.js`)
- Decomposes tasks/requirements into structured, executable verification specifications.
- Properties:
  - Persistent ID (`SPEC-xxxx`) & semantic versioning (`v1, v2...`).
  - Preconditions (setup requirements, auth, mock data).
  - Ordered test steps (action type, target selector, value, timeout).
  - Expected outcomes & required browser assertions.
  - Scenario classification: `positive`, `negative`, `regression`, `edge_case`.
  - Links to acceptance criteria (`AC-xxx`).
  - Synthesizes exact Kane CLI objective prompts.

### B. Gatekeeper Security Engine (`server/gatekeeper.js`)
- Evaluates package manifests (`package.json`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`).
- Integrates both direct Python `gatekeeper` audit inspection and high-performance native JavaScript security rules.
- Detection vectors:
  - Poisoned lockfile entries (tampered resolved URL vs package name).
  - Untrusted sources (arbitrary Git/HTTP URLs outside verified npm/yarn registries).
  - Missing integrity SHA-512 hashes.
  - Dangerous install hooks (`preinstall`, `postinstall`, `install`).
  - Known vulnerable / malicious package names (OSV database lookup).
- Verdict states: `ALLOWED`, `BLOCKED`, `REQUIRES_REVIEW`, `INCONCLUSIVE`.

### C. Playtest Agent Failure Investigation Engine (`server/playtest.js`)
- Receives failing Kane test executions.
- Extracts failing step, errorKind, console logs, and visual evidence.
- Constructs reproducible test scenario sequence.
- Executes independent reproduction against the target app.
- Classifies outcome: `CONFIRMED_DEFECT` vs `UNCONFIRMED_TRANSIENT`.
- Generates structured defect dossier with timeline, state change, and screenshot references for the Coding Agent.

### D. OQED Native Optimization Engine (`server/oqed.js`)
- Discovers system toolchain availability via OQED doctor (`clang`, `gcc`, `as`, `nm`, `objdump`, `llvm-mca`).
- Detects whether project contains eligible native C/C++ source code.
- If native code and toolchain are available: generates asm candidates, executes testing and SMT equivalence proofs (Z3/angr).
- If native code or toolchain is absent: reports `UNAVAILABLE_NO_NATIVE_TARGETS` or `UNAVAILABLE_TOOLCHAIN_MISSING` with honest explanation. Never fakes optimization.

### E. Coding Agent & Feedback Bridge (`server/coding-agent.js`)
- Discovers and communicates with coding agents (Antigravity SDK / local autonomous patch engine).
- Formats repair prompt with failure dossier (failing step, expected vs observed, Playtest findings, source files).
- Applies verified patch to target application files within authorized project workspace.
- Enforces maximum 3 repair iterations before escalating to `NEEDS_HUMAN_APPROVAL`.

### F. Central Orchestration State Machine (`server/orchestrator.js`)
- Manages end-to-end lifecycle:
  `IDLE → SPECIFICATION_READY → SECURITY_CHECK → BUILDING → VERIFYING → ANALYSING_FAILURE → REPAIRING → REVERIFYING → REGRESSION_CHECK → VERIFIED → RELEASE_READY`
- Persists state in `agent_executions` and `workflow_steps` tables.
- Emits real-time SSE events for frontend streaming.
- Restores interrupted runs upon server restart.

---

## 4. Frontend Integration & Judge Demo Experience

- Adds an interactive **Autonomous Loop Demo** modal and dedicated **Autonomous** navigation tab (`#/p/:id/loop`).
- Zero redesign: preserves all existing typography (`IBM Plex Mono`, `IBM Plex Sans`), layout, dark/amber accents, and CSS styles.
- One-click judge workflow to run, inspect, break, repair, and verify the live loop on Northwind Outfitters.

---

## 5. Execution Milestones

- **Phase 1**: Architecture mapping & database migration (`004_autonomous_loop.sql`).
- **Phase 2**: Module implementation (Steps Writer, Gatekeeper, Playtest, OQED, Coding Agent).
- **Phase 3**: Central Orchestrator & state machine.
- **Phase 4**: API routing & frontend UI integration.
- **Phase 5**: Comprehensive test suite & automated verification.

