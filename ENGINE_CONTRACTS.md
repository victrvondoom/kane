# Engine Integration Contracts & Worker Protocol Specification

This document specifies the communication contracts, invocation lifecycle, process isolation rules, input/output schemas, and error taxonomy for the SHIPPROOF multi-engine architecture.

---

## 1. Multi-Engine Architecture Overview

```text
+-------------------------------------------------------------+
|                 SHIPPROOF NODE.JS BACKEND                   |
| (API Routes, SQLite State Store, Autonomous Orchestrator)   |
+-------------------------------------------------------------+
                              |
                   invokeEngineWorker()
        [Explicit subprocess args, NO shell concatenation]
        [stdin: Machine-readable JSON | stdout: Response JSON]
        [stderr: Diagnostics | Hard timeout & Process cancellation]
                              |
       +----------------------+----------------------+
       |                      |                      |
       v                      v                      v
+--------------+      +----------------+      +--------------+
|  Gatekeeper  |      | Playtest Agent |      |     OQED     |
| Worker (Py)  |      |  Worker (Py)   |      | Worker (Py)  |
+--------------+      +----------------+      +--------------+
       |                      |                      |
       +----------------------+----------------------+
                              |
                              v
                 +--------------------------+
                 |  SAE Interpretability    |
                 |  Engine (9 Layers) (Py)  |
                 +--------------------------+
```

---

## 2. Standard JSON Worker Protocol

Every Python worker conforms to the standard JSON protocol over `stdin` and `stdout`:

### 2.1 Standard Request Payload (stdin)
```json
{
  "executionId": "b18b4169-1c94-432d-94bb-11357fae1d93",
  "correlationId": "exec-104",
  "action": "<action_name>",
  "workspaceDir": "/canonical/path/to/project/workspace",
  "payload": {
    /* Action-specific arguments */
  }
}
```

### 2.2 Standard Success Response (stdout)
```json
{
  "ok": true,
  "executionId": "b18b4169-1c94-432d-94bb-11357fae1d93",
  "data": {
    /* Action-specific response */
  },
  "error": null
}
```

### 2.3 Standard Failure Response (stdout)
```json
{
  "ok": false,
  "executionId": "b18b4169-1c94-432d-94bb-11357fae1d93",
  "data": null,
  "error": "Error description message"
}
```

---

## 3. Engine-Specific Contracts

### 3.1 Gatekeeper Worker (`server/gatekeeper-worker.py`)

#### Action: `scan_workspace`
- **Input:**
  - `lockfilePath` *(optional string)*: Explicit path to lockfile.
  - `lockfileContent` *(optional string)*: Raw text content of lockfile.
- **Output:**
  - `verdict` *(string)*: `ALLOWED` | `SUSPICIOUS` | `BLOCKED` | `REQUIRES_REVIEW`.
  - `summary` *(string)*: Human and machine-readable verdict summary.
  - `packageCount` *(integer)*: Total count of dependencies analyzed.
  - `findings` *(array of objects)*:
    - `name` *(string)*: Package name.
    - `version` *(string)*: Package version.
    - `severity` *(string)*: `critical` | `high` | `medium` | `low`.
    - `kind` *(string)*: Threat category (`lifecycle_script`, `tarball_mismatch`, `malicious_package`, `osv_advisory`).
    - `message` *(string)*: Detailed threat explanation.
    - `rule` *(string)*: Fired rule identifier.

#### Action: `investigate`
- **Input:**
  - `tool` *(string)*: `read` | `search` | `decode` | `strings`.
  - `targetPath` *(string)*: File or directory target relative to workspace.
  - `params` *(object)*:
    - For `read`: `{ file, start, count }`
    - For `search`: `{ query }`
    - For `decode`: `{ text, mode: "base64"|"hex" }`
    - For `strings`: `{ file, minLength }`
- **Output:**
  - Controlled excerpts with line numbers, extracted strings, or decoded payloads. All paths bounded to target tree.

---

### 3.2 Playtest Agent Worker (`server/playtest-worker.py`)

#### Action: `judge_replay`
- **Input:**
  - `title` *(string)*: Criterion or failure title.
  - `expected` *(string)*: Expected assertion behavior.
  - `actual` *(string)*: Observed discrepancy.
  - `initialState` *(object)*: Initial application DOM/data snapshot.
  - `finalState` *(object)*: Post-execution application state.
  - `actions` *(array of strings)*: Interaction steps replayed.
  - `reproduced` *(boolean)*: Whether the isolated replay failed identically.
- **Output:**
  - `status` *(string)*: `CONFIRMED` | `NOT_REPRODUCIBLE` | `INCONCLUSIVE`.
  - `confirmed` *(boolean)*: True only if independently reproduced.
  - `verdict` *(string)*: `YES` | `NO`.
  - `explanation` *(string)*: Cited visual and state diff justification.
  - `stateDiff` *(array of strings)*: Observed DOM and data divergence lines.
  - `filmstripCount` *(integer)*: Number of visual keyframes.
  - `dossier` *(object or null)*:
    - `defectTitle` *(string)*
    - `expectedBehavior` *(string)*
    - `actualBehavior` *(string)*
    - `reproductionSteps` *(array of strings)*
    - `suspectedLocation` *(string)*
    - `confidence` *(string)*: `HIGH` | `MEDIUM` | `LOW`
    - `evidenceQuotes` *(array of strings)*
    - `recommendedInvestigation` *(string)*

---

### 3.3 OQED Worker (`server/oqed-worker.py`)

#### Action: `evaluate`
- **Input:**
  - `nativeFiles` *(array of strings)*: List of C/C++ target files detected.
  - `toolchainReady` *(boolean)*: System toolchain readiness check.
- **Output:**
  - `eligible` *(boolean)*: True only if native targets exist and host is Linux x86-64.
  - `supportedEnvironment` *(boolean)*: Environment support flag.
  - `status` *(string)*: `PROVEN_EQUIVALENT` | `TESTED_NOT_PROVEN` | `UNKNOWN` | `ENVIRONMENT_UNSUPPORTED`.
  - `candidates` *(array of objects)*:
    - `targetFunction` *(string)*
    - `file` *(string)*
    - `baselineCycles` *(float)*
    - `optimizedCycles` *(float)*
    - `speedupRatio` *(float)*
    - `equivalenceStatus` *(string)*
    - `diffAsm` *(string)*
    - `oqedLockEntry` *(string)*
    - `smtVerification` *(object)*: Z3 proof status, solver time, counterexample (if unproven).

---

### 3.4 SAE Interpretability Engine (`server/sae/sae_engine.py`)

#### Action: `analyze_prompt`
- **Input:**
  - `modelName` *(string)*
  - `selectedLayers` *(array of integers)*: `[0, 1, 2, 3, 4, 5, 6, 7, 8]`
  - `saeType` *(string)*: `TopK` | `JumpReLU`
  - `hiddenDim` *(integer)*: Default 64
  - `featuresDim` *(integer)*: Default 256
  - `kSparsity` *(integer)*: Default 16
  - `prompt` *(string)*
- **Output:**
  - `layers` *(object mapping layer index -> layer data)*:
    - `layerIndex` *(integer)*
    - `firedCount` *(integer)*
    - `tokenFeatures` *(array of token activation entries)*
    - `topFiringFeatures` *(array of top feature activations)*
  - `crossLayerEdges` *(array of DAG connections)*:
    - `sourceLayer` *(integer)*
    - `sourceFeature` *(integer)*
    - `targetLayer` *(integer)*
    - `targetFeature` *(integer)*
    - `coactivationScore` *(float)*
    - `relationshipType` *(string)*: `DIRECT_PROGRESSION` | `MODULATION` | `ABSTRACTIVE_MERGE`

#### Action: `steer`
- **Input:**
  - `featureIndex` *(integer)*
  - `layerIndex` *(integer)*
  - `prompt` *(string)*
  - `coefficient` *(float)*: E.g., +3.0, -2.0
  - `intervention` *(string)*: `activation_clamping` | `activation_addition` | `ablation`
- **Output:**
  - `baselineOutput` *(string)*
  - `steeredOutput` *(string)*
  - `semanticDriftScore` *(float)*
  - `sideEffectScore` *(float)*

#### Action: `evaluate_quality`
- **Input:**
  - `modelName` *(string)*
  - `selectedLayers` *(array of integers)*: `[0, 1, 2, 3, 4, 5, 6, 7, 8]`
  - `saeType` *(string)*
- **Output:**
  - Dictionary mapping each layer `0..8` to quality metrics:
    - `reconstructionLoss` *(float)*
    - `explainedVariance` *(float)*: Fractional variance explained $R^2 \in [0, 1]$
    - `l0Sparsity` *(float)*: Average number of active features per token
    - `deadFeatureFraction` *(float)*: Fraction of features that never fire

---

## 4. Subprocess Execution & Security Invariants

1. **No Shell Concatenation:** Process execution is strictly performed using argument arrays (`child_process.spawn([executable, ...args])`).
2. **Credential Redaction:** API keys (`spk_*`), tokens, and database passwords in stderr/stdout are filtered and sanitized before logging or persistence.
3. **Bounded Workspaces:** Workers operate strictly within canonical project directories (`data/workspaces/project-<pid>`). Symlinks escaping the root trigger immediate execution termination with a `WorkspaceError`.
4. **Hard Timeouts:** Every worker execution has an explicit ceiling (15s to 45s). Timed-out processes receive `SIGKILL` (or Windows process tree kill via `taskkill /F /T /PID`).
