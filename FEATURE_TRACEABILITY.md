# FEATURE TRACEABILITY

| Source | Original Capability | Integrated Module | Functional Status | Test Evidence |
|---|---|---|---|---|
| **Steps Writer** | Natural-language test objective decomposition | `server/steps-writer.js` | Complete | `tests/steps-writer.test.js` |
| **Steps Writer** | Precondition & ordered browser step structure generation | `server/steps-writer.js` | Complete | `tests/steps-writer.test.js` |
| **Steps Writer** | Positive, negative & regression scenario typing | `server/steps-writer.js` | Complete | `tests/steps-writer.test.js` |
| **Steps Writer** | Immutable specification versioning | `server/steps-writer.js` | Complete | `tests/steps-writer.test.js` |
| **Steps Writer** | Direct synthesis of Kane CLI objective prompt | `server/steps-writer.js` | Complete | `tests/steps-writer.test.js` |
| **Gatekeeper** | Lockfile & package manifest parsing | `server/gatekeeper.js` | Complete | `tests/gatekeeper.test.js` |
| **Gatekeeper** | Lockfile poisoning detection (mismatched tarball URL) | `server/gatekeeper.js` | Complete | `tests/gatekeeper.test.js` |
| **Gatekeeper** | Untrusted source & non-registry URL detection | `server/gatekeeper.js` | Complete | `tests/gatekeeper.test.js` |
| **Gatekeeper** | Install script & hook threat evaluation | `server/gatekeeper.js` | Complete | `tests/gatekeeper.test.js` |
| **Gatekeeper** | Security policy gate (`ALLOWED`, `BLOCKED`, `REQUIRES_REVIEW`) | `server/gatekeeper.js` | Complete | `tests/gatekeeper.test.js` |
| **Playtest Agent** | Kane failure extraction & context framing | `server/playtest.js` | Complete | `tests/playtest.test.js` |
| **Playtest Agent** | Independent browser failure reproduction | `server/playtest.js` | Complete | `tests/playtest.test.js` |
| **Playtest Agent** | Confirmed defect vs unconfirmed transient noise distinction | `server/playtest.js` | Complete | `tests/playtest.test.js` |
| **Playtest Agent** | Evidence card & reproduction timeline synthesis | `server/playtest.js` | Complete | `tests/playtest.test.js` |
| **OQED** | Native toolchain discovery (`doctor` for clang, gcc, binutils) | `server/oqed.js` | Complete | `tests/oqed.test.js` |
| **OQED** | C/C++ target eligibility inspection | `server/oqed.js` | Complete | `tests/oqed.test.js` |
| **OQED** | Formal equivalence verification gating (never fake optimization) | `server/oqed.js` | Complete | `tests/oqed.test.js` |
| **Kane CLI** | Multi-step agent browser test execution | `server/kane.js` | Complete | `tests/integration.test.js` |
| **Kane CLI** | NDJSON stream parsing & exit status agreement | `server/kane.js` | Complete | `tests/hardening.test.js` |
| **Kane CLI** | Evidence artifact collection (screenshots, logs) | `server/kane.js` | Complete | `tests/proof.test.js` |
| **Coding Agent Bridge** | Automated code repair on failure with bounded retries | `server/coding-agent.js` | Complete | `tests/autonomous-loop.test.js` |
| **Orchestrator** | 10-stage autonomous lifecycle state machine | `server/orchestrator.js` | Complete | `tests/autonomous-loop.test.js` |
| **Orchestrator** | Process interruption recovery & history preservation | `server/orchestrator.js` | Complete | `tests/autonomous-loop.test.js` |
| **Demo Experience** | Judge/Evaluator 1-click autonomous loop demo & controls | `public/app.js`, `public/autonomous.js` & `server/routes-autonomous.js` | Complete | `tests/autonomous-loop.test.js` |
