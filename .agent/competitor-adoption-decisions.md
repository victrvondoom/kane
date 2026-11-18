# Competitor adoption decisions

| Idea | Source | Decision | Reason |
| --- | --- | --- | --- |
| Stop hook that blocks completion until checks pass | Kane Signoff (design, from its description) | Adopted and implemented | Central differentiator. Implemented with fail-closed rules and a bounded retry count. |
| Protected acceptance specifications | Signoff (description) | Adopted and implemented | Enforced twice: `PreToolUse` denies direct edits, `Stop` detects changes made through Bash. |
| Debounced watch that re-verifies impacted criteria | Kane Loop (description) | Adopted and implemented | `shipproof watch`. Not yet covered by an automated test. |
| Verification cache keyed to source scope | Kane Loop, Plumb (description) | Adopted in a narrower form | Reuse requires the same criterion text, source scope, target URL and engine. |
| Conservative impact when no criterion maps | Original design | Adopted | Unmapped application changes run every criterion. |
| Documentation changes do not trigger Kane runs | Original design | Adopted | Stated as a requirement in the mission; implemented in `isRelevantPath`. |
| Requirement extraction from PRDs and READMEs (DocProof, Proofline) | Competitors | Deferred | Not started. |
| Pull-request checks (Proofed) | Competitor | Deferred | Requires GitHub integration and a repository to test against. |
| Issue reproduction (Reenact) | Competitor | Deferred | Requires GitHub access and live Kane credentials. |
| Two-account security assurance (Zelkaro) | Competitor | Deferred | Requires disposable staging accounts. |
| MCP server (Proofline) | Competitor | Deferred | Not started. |
| Differential and mutation testing (Fairness Auditor, BuildBreak) | Competitors | Deferred | Not started. |
