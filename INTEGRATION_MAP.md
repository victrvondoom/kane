# INTEGRATION MAP

This map defines how each imported capability is integrated into the existing application architecture without replacing or breaking any established functionality.

| Imported Source | Original Capability | Existing Integration Location | Adapter / Service | API Endpoint / Event | Automated Verification |
|---|---|---|---|---|---|
| **Steps Writer** | Natural-language requirement to structured scenario generation | `server/requirements.js` & `server/routes-proof.js` | `server/steps-writer.js` | `POST /api/projects/:pid/specifications`, `GET /api/projects/:pid/specifications` | `tests/steps-writer.test.js` |
| **Gatekeeper** | Lockfile auditing, supply chain malware detection, install hook analysis | `server/netpolicy.js` & pre-flight hooks | `server/gatekeeper.js` | `POST /api/projects/:pid/security/scan`, `GET /api/projects/:pid/security/latest` | `tests/gatekeeper.test.js` |
| **Playtest Agent** | Browser defect reproduction, replay verification, evidence packaging | `server/runner.js` & `server/gate.js` | `server/playtest.js` | `POST /api/projects/:pid/investigations/reproduce`, `GET /api/projects/:pid/investigations/:id` | `tests/playtest.test.js` |
| **OQED** | Native x86-64 assembly optimization and SMT formal equivalence proof | Isolated native engine | `server/oqed.js` | `GET /api/system/oqed`, `POST /api/projects/:pid/optimize` | `tests/oqed.test.js` |
| **Kane CLI** | Authoritative browser acceptance verification | `server/kane.js` & `server/runner.js` | `server/kane.js` | `POST /api/projects/:pid/runs`, `GET /api/runs/:id` | `tests/integration.test.js`, `tests/proof.test.js` |
| **Coding Agent Bridge** | Automated code repair on failure with bounded retries | `server/runner.js` & `server/gate.js` | `server/coding-agent.js` | `POST /api/projects/:pid/repairs/trigger` | `tests/autonomous-loop.test.js` |
| **Central Orchestrator** | End-to-end autonomous state machine & lifecycle loop | `server/app.js` & `server/index.js` | `server/orchestrator.js` | `POST /api/projects/:pid/loop/start`, `GET /api/projects/:pid/loop/:execId/stream` | `tests/autonomous-loop.test.js` |

---

## Data Model Extensions (Migration `004_autonomous_loop.sql`)

1. **`test_specifications`**:
   - `id`, `project_id`, `spec_key`, `title`, `objective`, `category`, `scenario_type`, `version`, `preconditions`, `steps`, `expected`, `kane_objective`, `created_at`, `updated_at`.
2. **`test_spec_versions`**:
   - `id`, `spec_id`, `version`, `content_json`, `created_at`.
3. **`security_scans`**:
   - `id`, `project_id`, `commit_sha`, `verdict`, `summary`, `findings_json`, `package_count`, `created_at`.
4. **`playtest_investigations`**:
   - `id`, `project_id`, `run_id`, `result_id`, `criterion_key`, `defect_status`, `diagnosis`, `reproduced`, `evidence_json`, `created_at`.
5. **`agent_executions`**:
   - `id`, `project_id`, `task_description`, `status`, `current_stage`, `retry_count`, `active_run_id`, `spec_id`, `scan_id`, `investigation_id`, `created_at`, `updated_at`.
6. **`agent_repair_attempts`**:
   - `id`, `execution_id`, `attempt_number`, `patch_summary`, `changed_files_json`, `status`, `created_at`.

