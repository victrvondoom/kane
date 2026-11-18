# Implementation Plan

Scope of this plan: the mission's Phases 3–8, ordered by what judges can see and what the repository can prove.
Phases 3–8 are **not started** in this session. This plan is the decision record for the next work.

## Blockers that no code change can remove

| Blocker | Who must act | Needed for |
|---|---|---|
| `kane-cli` installed on the verification host, and `kane-cli login` or `LT_USERNAME` / `LT_ACCESS_KEY` | User | Any real Kane execution, every captured run, the recorded demo |
| `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` on the server | User | The autonomous engineering agent (real repair) |
| Decision on which repository the demo runs against | User | The repository-connection feature and the demo |
| Hackathon eligibility, repository creation-date check, YouTube recording, public launch posts | User | Submission compliance (not verifiable from the repository) |
| Confirmation of which hackathon format applies (online winners' format vs. the in-person Hack Day format with a 3-minute demo) | User | Demo length and scope |

Until the first row is resolved, nothing labelled "real Kane" can be produced by this environment.

## Phase 3 — Backend correctness and release-state model (can start now)

Goal: the seven mission states exist, are enforced by the backend, and the existing verdict maps onto them.

1. Define a transition table in `server/release-state.js`: `NOT_VERIFIED → RUNNING → (VERIFIED | FAILED | BLOCKED)`,
   `FAILED → REPAIRING → REVERIFICATION → (VERIFIED | FAILED)`, `BLOCKED` reachable from infrastructure errors only.
   Each transition names its required evidence (for example `VERIFIED` requires a passing Kane execution row for every
   mandatory criterion against the intended commit).
2. Persist the state per project and per build, with a `release_transitions` audit table. Writes go through one function.
3. Reject transitions that are not in the table with a 409. Refuse `VERIFIED` when any required row lacks evidence.
4. Make "fix applied" a transition to `REVERIFICATION` only, never to `VERIFIED`. The existing gate already closes repair
   tasks only on a passing run; the new state must agree with it.
5. Tests: every legal transition, every illegal transition, `VERIFIED` refused without evidence, `VERIFIED` refused for
   a commit other than the one executed, and state derived after a restart.

Files: `server/release-state.js` (new), `server/gate.js`, `server/proof.js`, `migrations/0NN_release_state.sql`, `tests/release-state.test.js`.

## Phase 4 — Autonomous repair and verification

Goal: an end-to-end repair loop that is the agent's own work, with bounded attempts and rollback.

1. **Replace the scripted demo repair as the demo's repair path.** `coding-agent.js` `setDefectState` remains available
   for the seeded regression trials, and must be labelled "scripted" wherever it is shown. The demo's repair must come
   from the engineering agent, which needs a credential (blocker above).
2. Bounded attempts: the existing `MAX_REPAIR_ATTEMPTS = 3` and the engineer's step limit are kept, and each attempt is
   logged in `agent_repair_attempts`.
3. Rollback: on a failed attempt, the worktree branch is discarded and the default branch is untouched. Test this with a
   forced failing attempt, not with a mock.
4. Cancellation and timeout: a test that interrupts a running engineer turn and checks that no worktree or branch survives.
5. The agent reruns the **same acceptance criterion text** through Kane. The gate, not the agent, decides the outcome.

Files: `server/oncall/engineer.js`, `server/oncall/git.js`, `server/orchestrator.js`, `tests/oncall.test.js`,
`tests/e2e-oncall.test.js`.

## Phase 5 — Evidence integrity and replay

1. **Evidence manifest.** Extend `buildDossier` with an immutable manifest: run identifier, repository and commit SHA,
   Kane CLI version, execution timestamps, criteria, execution status, raw output hashes, screenshot references,
   failure and repair history, reverification result. Deterministic serialisation, already present (`canonical`).
2. **Exports.** Add an HTML report renderer (static, offline) and keep the JSON export and the signed dossier. Do not describe
   the HTML as signed; only the JSON dossier carries a signature.
3. **Failure records.** A `failure_records` table linking execution → revision → criterion → classification → browser
   step → screenshot → console and network evidence → hypothesis → repair commit → reverification outcome → timestamps.
4. **Regression memory.** A failure is "returned" only when a later verified state regresses on the same criterion
   text. Classify `new`, `recurring`, `resolved`, `regressed`, `unverified`. Resolved requires a passing execution on a
   later revision, never a source change alone.
5. Tests: manifest hash verification, tamper detection on each section, deterministic re-serialisation across runs.

## Phase 6 — Frontend

Reuse existing components (`public/proof.js`, `public/watch.js`, `public/agent-state.js`) where they work.

1. Release proof graph: an SVG graph built from the same trace API the panels use. Each node opens its stored record.
   Missing evidence and broken links render as explicit nodes, not as omissions. This replaces the stacked panels.
2. Overview, criteria explorer, live monitor, failure workspace, repair timeline, dossier viewer, regression intelligence,
   settings. Each must render only API data. Live indicators appear only when a run is actually streaming.
3. Empty, loading and error states for every screen.

Screens are reviewed against screenshots taken from the running app, not from design files.

## Phase 7 — Benchmarks and tests

1. Consolidate the duplicate algorithm suites: decide, per algorithm, which implementation stays. `server/algorithms` and
   my modules were written independently and have not been compared. Keep `/api/algorithms` as an alias until a migration
   is justified.
2. Run the compare-against-baseline benchmarks on the consolidated code. Keep the failed Ochiai and NSGA-II results visible.
3. Add the end-to-end competition scenario test. It must use a real Kane run when credentials are present, and must say
   so when they are not. A stand-in engine must not be reported as Kane.

## Phase 8 — Deployment and demo

1. The competition scenario, written as a script with the exact commands and the exact expected output of each step.
2. A recording checklist. The recording itself and the posts are human actions.
3. Submission readiness report with each mandatory item marked verified, not assumed.

## Order of work and what can start today

| Order | Work | Can start now? |
|---|---|---|
| 1 | Phase 3: release-state model and tests | Yes, no credentials needed |
| 2 | Phase 5 items 1, 3 and 5: manifest, failure records, tests | Yes |
| 3 | Phase 7 item 1: consolidation decision on duplicate algorithm suites | Yes, decision only |
| 4 | Phase 6 item 1: proof graph | Yes, against stored data |
| 5 | Phase 4: real repair loop | **No**: needs Anthropic credential and Kane |
| 6 | Phase 7 item 3 and Phase 8: real demo | **No**: needs Kane credentials and a recording |

## What I recommend the user decide first

1. Provide credentials (or confirm the demo may run with the stand-in engine, labelled as such, until credentials arrive).
2. Confirm the hackathon format (online winners' format or the in-person Hack Day).
3. Confirm that the scripted demo repair may be kept as a labelled fallback, or that the real agent must produce the demo's repair.
