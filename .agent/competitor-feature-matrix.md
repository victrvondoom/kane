# Competitor feature matrix

Status of this file: **the competitor source-code study was not performed in this session.** No competitor repository was cloned or read. The rows below record what SHIPPROOF does today against each capability the mission names, so the gaps are visible. A competitor's capability is listed as "not investigated" rather than assumed.

| Capability (competitor) | SHIPPROOF status (verified in this session) |
| --- | --- |
| Agent completion enforcement via hooks (Kane Signoff) | Implemented: `UserPromptSubmit` baseline, `PreToolUse` protected-file denial, `Stop` gate with Kane verification. Tested with the real Claude Code hook protocol (headless run). Signoff's own code not compared. |
| Requirement-to-test generation (DocProof) | Not implemented. Criteria are written by hand in `.shipproof/criteria.json`. |
| Pull-request verification (Proofed) | Not implemented. |
| Issue reproduction (Reenact) | Not implemented. |
| Task / fix / watch / rollback CLI (Kane Loop) | Partially: `init`, `doctor`, `verify`, `watch` (debounced), `hook`. No `fix`, `task`, `replay`, `report`, rollback. `watch` is not covered by an automated test. |
| Rule library and evidence studio (Plumb) | Not implemented. |
| Simple onboarding (Shipcheck) | Partially: `shipproof init --url` and `doctor`. No preview or UI. |
| Two-account security testing (Zelkaro) | Not implemented. |
| Differential / metamorphic testing (Fairness Auditor) | Not implemented. |
| Mutation-based test adequacy (BuildBreak) | Not implemented. |
| PRD drift and MCP server (Proofline) | Not implemented. |
| Validated domain model (Furnish) | Partially: spec is schema-validated before use; invalid specs block completion. |
| Realistic ground-truth fixtures and file workflows (PayoutFit, Kane Intake) | Not implemented. |
| One-command release gate (Checkout Gatekeeper) | Partially: `shipproof verify` exits 0/1/2/3. |
| Browser reliability benchmarks (Agent Degree) | Not implemented in this session. The existing `bench:*` scripts were not changed. |
