# FEATURE TRACEABILITY

| Source | Original Capability | Integrated Module | Functional Status | Test Evidence |
|---|---|---|---|---|
| **Steps Writer** | Natural-language test objective decomposition | `server/steps-writer.js` | Complete | `tests/steps-writer.test.js` |
| **Steps Writer** | Precondition & ordered browser step structure generation | `server/steps-writer.js` | Complete | `tests/steps-writer.test.js` |
| **Steps Writer** | Positive, negative & regression scenario typing | `server/steps-writer.js` | Complete | `tests/steps-writer.test.js` |
| **Steps Writer** | Immutable specification versioning | `server/steps-writer.js` | Complete | `tests/steps-writer.test.js` |
| **Steps Writer** | Direct synthesis of Kane CLI objective prompt | `server/steps-writer.js` | Complete | `tests/steps-writer.test.js` |
| **Gatekeeper Fast** | Fast preliminary lockfile & package manifest parsing | `server/gatekeeper.js` | Complete | `tests/gatekeeper.test.js` |
| **Gatekeeper Engine** | Full package intelligence, lockfile auditing (`npm`, `pnpm`, `yarn`) & OSV advisories | `server/gatekeeper-worker.py`, `server/gatekeeper-bridge.js` | Complete | `tests/integration-engines.test.js` |
| **Gatekeeper Investigator** | 5-Tool forensic investigator (`read`, `search`, `decode`, `strings`) with citation validation | `server/gatekeeper-worker.py`, `server/gatekeeper-bridge.js` | Complete | `tests/integration-engines.test.js` |
| **Playtest Agent Fast** | Kane failure extraction & context framing | `server/playtest.js` | Complete | `tests/playtest.test.js` |
| **Playtest Agent Worker** | Visual filmstrip recording, DOM state difference analysis, and actionable defect dossier | `server/playtest-worker.py`, `server/playtest-bridge.js` | Complete | `tests/integration-engines.test.js` |
| **Playtest Independent Judge**| Independent replay judge with cited visual evidence (`YES`/`NO` verdict) | `server/playtest-worker.py`, `server/playtest-bridge.js` | Complete | `tests/integration-engines.test.js` |
| **OQED Diagnostics** | Native toolchain discovery (`doctor` for clang, gcc, binutils) | `server/oqed.js` | Complete | `tests/oqed.test.js` |
| **OQED Optimization** | SMT formal equivalence verification, candidate ranking, honest Linux/x86_64 constraint handling | `server/oqed-worker.py`, `server/oqed-bridge.js` | Complete | `tests/integration-engines.test.js` |
| **SAE Lab (9 Layers)** | TopK & JumpReLU sparse autoencoder activation hooks across 9 discrete layers | `server/sae/sae_engine.py`, `server/sae/sae-bridge.js` | Complete | `tests/integration-engines.test.js` |
| **SAE Registry** | Calibrated firing thresholds, provisional labels, and human/model provenance tracking | `server/sae/sae_engine.py`, `server/sae/sae-bridge.js` | Complete | `tests/integration-engines.test.js` |
| **SAE Inter-Layer DAG** | Cross-layer feature correspondence graph distinguishing correlation from causation | `server/sae/sae_engine.py`, `server/sae/sae-bridge.js` | Complete | `tests/integration-engines.test.js` |
| **SAE Steering Studio** | Causal interventions (`activation_clamping`, `activation_addition`, `ablation`) with drift metrics | `server/sae/sae_engine.py`, `server/sae/sae-bridge.js` | Complete | `tests/integration-engines.test.js` |
| **SAE Quality Metrics** | Reconstruction loss, explained variance ($R^2$), $L_0$ sparsity, and dead feature fraction across 9 layers | `server/sae/sae_engine.py`, `server/sae/sae-bridge.js` | Complete | `tests/integration-engines.test.js` |
| **Workspace Isolation** | Canonical tenant isolation, boundary enforcement, and symlink traversal defense | `server/workspace.js` | Complete | `tests/integration-engines.test.js` |
| **Kane CLI** | Multi-step agent browser test execution | `server/kane.js` | Complete | `tests/integration.test.js` |
| **Kane CLI** | NDJSON stream parsing & exit status agreement | `server/kane.js` | Complete | `tests/hardening.test.js` |
| **Kane CLI** | Evidence artifact collection (screenshots, logs) | `server/kane.js` | Complete | `tests/proof.test.js` |
| **Coding Agent Bridge** | Automated code repair on failure with bounded retries | `server/coding-agent.js` | Complete | `tests/autonomous-loop.test.js` |
| **Orchestrator** | 10-stage autonomous lifecycle state machine with multi-engine integration | `server/orchestrator.js` | Complete | `tests/autonomous-loop.test.js` |
| **Orchestrator** | Process interruption recovery & history preservation | `server/orchestrator.js` | Complete | `tests/autonomous-loop.test.js` |
| **Demo Experience** | Judge/Evaluator 1-click autonomous loop demo & controls | `public/app.js`, `public/autonomous.js` & `server/routes-autonomous.js` | Complete | `tests/autonomous-loop.test.js` |

## Command Center & UI Suite

| Capability | Where | Verified by |
|---|---|---|
| Persistent SHIPPROOF ENGINEER drawer (text) | `public/agent-workspace.js` | `tests/e2e-workspace.test.js` |
| Activity dedupe and replay | `public/agent-state.js` | `tests/agent-workspace.test.js` |
| Command palette (Ctrl/⌘K) | `public/command-palette.js` | `tests/e2e-workspace.test.js` |
| Supply Chain (Gatekeeper) View & Investigator | `public/autonomous.js` | Manual UI & Integration tests |
| Playtest Studio & Filmstrips | `public/autonomous.js` | Manual UI & Integration tests |
| OQED Native Optimizer Studio | `public/autonomous.js` | Manual UI & Integration tests |
| SAE Interpretability Lab (9 Layers) | `public/autonomous.js` | Manual UI & Integration tests |
| Phone bottom navigation | `public/app.js`, `public/workspace.css` | `tests/e2e-workspace.test.js` |
