# Architecture decisions (agent completion gate)

**AD-1. The acceptance specification is a file: `.shipproof/criteria.json`.**
Stable IDs, criterion text, path scopes and the target URL live in one versioned file. It is protected, so the agent cannot change it. The server database still owns release decisions; the gate does not write to it.

**AD-2. Kane is reached only through the existing adapter `server/kane.js`.**
The gate calls `runKane`, `classify`, `collectEvidence` and `kaneStatus`. Nothing reimplements the NDJSON parsing or classification. A pass requires an exit-0 `run_end` with `passed` and, by default, evidence files.

**AD-3. Fail closed.** Missing baseline, invalid spec, protected edits, missing criteria, failures, and unverified outcomes all block. An internal error in the gate blocks too.

**AD-4. Blocking is bounded per turn (default 3).** After the bound the stop is allowed only as `NEEDS_HUMAN` with the message "NOT VERIFIED", and the session records it. The next user turn resets the budget. Rationale: an infinite loop is worse than an honest unresolved record.

**AD-5. Environment failures are never defects.** Authentication, network, missing binary, and incompatible engine outcomes are reported as unverified with an explicit "this is an environment problem" message. They never produce `CRITERIA_FAILED`.

**AD-6. Protection is enforced in two places.** `PreToolUse` refuses direct edits to protected paths before they happen. `Stop` compares fingerprints, so changes made through Bash are caught before completion. Neither layer runs Kane for tampered specifications.

**AD-7. Hook installation edits only its own handlers.** Handlers are recognised by a marker in their command. Other settings are preserved, a backup is written first, and the result is re-read and validated.

**AD-8. Windows: bare `kane-cli` is run through its package entry point.** npm's `kane-cli.cmd` shim cannot be spawned directly; `resolveEngineBin` in `server/kane.js` runs the package's JS entry with Node. This also fixes the same defect in the existing server.

**AD-9. Open question: two gates.** The release gate (`server/gate.js`, database-backed) and the agent gate (file-backed, per turn) can disagree in principle. Today the agent gate is a pre-completion check; it is not a release decision. Unifying them is not done.
