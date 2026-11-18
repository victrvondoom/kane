# Implementation status (as of this session)

Legend: **Done** = implemented and exercised by an automated test or a recorded real run. **Partial** = some of it works, the rest is missing. **Not started** = no implementation.

## P0

| Item | Status | Evidence |
| --- | --- | --- |
| 1. Claude Code agent-completion gate | Done (fixture engine) | `tests/agentgate.test.js`; headless Claude Code run (see verification log) |
| 2. Protected verification specifications | Done | `PreToolUse` denial and `Stop` fingerprint tests |
| 3. Repair and unchanged-test re-verification | Partial | The agent repairs using the gate's feedback (real run). Re-verification of the unchanged criterion: tested. Rollback to last green snapshot: not implemented. Autonomous repair through `server/oncall`: not connected to the gate. |
| 4. Functional CLI and local watch | Partial | `init`, `doctor`, `verify`, `hook`, `watch`. `watch` has no automated test. No `fix`, `task`, `replay`, `report`. |
| 5. GitHub PR checks | Not started | |
| 6. Evidence room and before/after replay | Not started | Evidence files are stored per run; no viewer. |
| 7. End-to-end competition demonstration | Partial | Scripted by hand in a scratch copy of `demo/agent-gate/`; the red→repair→green loop was recorded. Not a committed script. Live Kane not run (see remaining risks). |

## P1

| Item | Status |
| --- | --- |
| GitHub issue reproduction | Not started |
| Two-account security assurance | Not started |
| Differential testing | Not started |
| PRD and README requirement extraction | Not started |
| Requirement drift detection | Not started |
| MCP server | Not started |
| Credit accounting | Partial: `creditsConsumed` is recorded from Kane's `run_end` when present, otherwise `null`. Nothing is estimated. |
| Mutation-based test adequacy | Not started |

## Fixes made to existing code in this session

- `server/kane.js`: bare `kane-cli` on Windows now resolves to the package entry point (the `.cmd` shim could not be spawned). Version-probe failures now report "present but did not report its version" instead of "not found".
- `tests/fixtures/fake-kane.js`: added an `eval` mode that checks the application's real code. Test fixture only.
- `cli/shipproof.js` and `package.json`: the `shipproof` command and script.
