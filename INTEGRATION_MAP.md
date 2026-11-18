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
| **Gatekeeper Full Worker** | Full package intelligence, lockfiles, OSV & 5-tool forensic investigator | `gatekeeper-main/` | `server/gatekeeper-worker.py` & `server/gatekeeper-bridge.js` | `POST /api/projects/:pid/security/scan`, `POST /api/projects/:pid/security/investigate`, `GET /api/projects/:pid/security/audits` | `tests/integration-engines.test.js` |
| **Playtest Agent Worker** | Visual filmstrip captures, state diffing, independent replay judge & defect dossiers | `playtest-agent-main/` | `server/playtest-worker.py` & `server/playtest-bridge.js` | `POST /api/projects/:pid/investigations/reproduce`, `GET /api/projects/:pid/playtest/filmstrips` | `tests/integration-engines.test.js` |
| **OQED Optimization Worker** | SMT formal equivalence verification, candidate ranking & Linux constraint handling | `oqed-main/` | `server/oqed-worker.py` & `server/oqed-bridge.js` | `GET /api/projects/:pid/oqed/eligibility`, `POST /api/projects/:pid/oqed/optimize` | `tests/integration-engines.test.js` |
| **SAE Interpretability Lab** | TopK & JumpReLU SAEs across 9 discrete layers, DAG tracking, causal steering, and reconstruction quality metrics | Standalone 9-Layer Engine | `server/sae/sae_engine.py` & `server/sae/sae-bridge.js` | `POST /api/sae/analyze`, `GET /api/sae/features`, `PATCH /api/sae/features/:fid`, `GET /api/sae/graph`, `POST /api/sae/steer`, `GET /api/sae/evaluations` | `tests/integration-engines.test.js` |
| **Tenant Workspace Isolation** | Bounded canonical project workspaces with symlink traversal defense | Project File Subsystem | `server/workspace.js` | Internal workspace resolution | `tests/integration-engines.test.js` |

---

## Data Model Extensions (Migration `008_engine_integrations_and_sae.sql`)

1. **`project_workspaces`**:
   - `id`, `project_id`, `workspace_path`, `is_isolated`, `created_at`, `updated_at`.
2. **`gatekeeper_audits`**:
   - `id`, `project_id`, `scan_id`, `package_name`, `package_version`, `spec_type`, `risk_level`, `details_json`, `created_at`.
3. **`playtest_filmstrips`**:
   - `id`, `investigation_id`, `frame_seq`, `image_path`, `action_taken`, `state_diff_json`, `judge_observation`, `created_at`.
4. **`oqed_optimizations`**:
   - `id`, `project_id`, `target_function`, `source_file`, `baseline_cycles`, `optimized_cycles`, `speedup_ratio`, `equivalence_status`, `smt_verification_json`, `diff_asm`, `oqed_lock_entry`, `created_at`.
5. **`sae_models`**:
   - `id`, `name`, `model_id`, `total_layers` (9), `selected_layers_json`, `hidden_dim`, `features_dim`, `sae_type`, `k_sparsity`, `created_at`.
6. **`sae_features`**:
   - `id`, `model_id`, `layer_index`, `feature_index`, `activation_frequency`, `mean_magnitude`, `max_magnitude`, `firing_threshold`, `provisional_label`, `label_status`, `label_confidence`, `label_provenance`, `activating_examples_json`, `contrasting_examples_json`, `created_at`, `updated_at`.
7. **`sae_feature_edges`**:
   - `id`, `source_feature_id`, `target_feature_id`, `coactivation_score`, `cosine_similarity`, `relationship_type`, `created_at`.
8. **`sae_steering_experiments`**:
   - `id`, `feature_id`, `prompt`, `steering_coefficient`, `intervention_method`, `baseline_output`, `steered_output`, `semantic_drift_score`, `side_effect_score`, `created_at`.
9. **`sae_layer_evaluations`**:
   - `id`, `model_id`, `layer_index`, `reconstruction_loss`, `explained_variance`, `l0_sparsity`, `dead_feature_fraction`, `evaluated_at`.


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

