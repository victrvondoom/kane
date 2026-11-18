# Competitive Gap Analysis

## Sources and how far I verified them

| Source | What I read | Verified? |
|---|---|---|
| TestMu AI blog, "The Kane CLI Hackathon Winners" (published 2026-09-19) | Full article, scraped | Yes |
| TestMu AI Kane CLI page (`testmuai.com/kane-cli/`) | Search excerpt only | Excerpt |
| Devpost "Kane CLI Hack Day" (`kane-cli-hack-day.devpost.com`) | Search excerpt only: in-person, one day, judged in a panel, 3-minute demo and 2 minutes of questions | Excerpt; rules not read in full |
| Other public Kane CLI projects | Not searched beyond the above | **No** |

What is not known: the full judging rubric of the online event beyond the four dimensions named in the winners post
(ships, verified, closed loop, craft), and the eligibility rules for either event. Eligibility is not asserted here.

## The competitive field, as published

The online hackathon ran 19–31 August 2026 with 69 submissions. The winners post says every project was scored on the same
four dimensions the mission uses. The three winners:

| Place | Project | What it does with Kane CLI | Closest overlap with SHIPPROOF |
|---|---|---|---|
| Gold | demo.studio (Sam Felix) | Kane as the build loop, the runtime that performs walkthroughs, and the tester of the tool itself | Low: different product (demo video generation) |
| Silver | GuardianKane (Abhinav Pangaria) | A Claude Code Stop-hook gate: a task cannot be "done" until Kane replays a generated test and a defect sweep passes. Three attempts, then escalation to a human. Also: PRD-to-task tracker, scope guard, secret scan, file locks, live dashboard | **High**: same core claim, "the coding agent cannot stop until a real browser agrees" |
| Bronze | KANE vs. ABLE (Christine Lall) | An adversarial escape room. A builder agent creates a solvable dungeon; Kane solves it independently; failure evidence drives a repair; Kane re-verifies | **Medium-high**: the same closed loop (claim, independent verify, failure evidence, repair, re-verify) |

Sources of overlap are GuardianKane's gate and KANE vs. ABLE's loop. Both are demonstrated on a real browser with Kane.
SHIPPROOF has to be measured against those two specifically.

## Where SHIPPROOF is different (code-verified, see BASELINE_AUDIT.md)

| Differentiator | Evidence in code | Status |
|---|---|---|
| Verdict and dossier are computed server-side, from stored execution rows, never from an agent's word | `server/gate.js`, `server/proof.js` `computeDecision` | Real |
| A signed, self-verifying dossier (Ed25519 over canonical payload with section hashes and evidence hashes) that a third party can check offline | `server/proof.js` `buildDossier`, `server/keys.js`, `scripts/verify-dossier.mjs` | Real. The signing key is server-held, so a judge must trust the server operator or check the public key against a published one. |
| Repair tasks close only when a passing execution of the same criterion text completes | `server/gate.js` `syncRepairTask` | Real |
| Repair work happens in an isolated git worktree on a fresh branch, with guarded paths | `server/oncall/git.js` `createWorktree` | Real in code; not run end to end here |
| Change impact and evidence freshness tied to commits and changed paths | `server/proof.js` `impactOf`, `freshnessFor`; `server/impact-graph.js` | Real |

## Where SHIPPROOF is behind (must close before a demo)

| Gap | Why it matters for judging | Closest competitor |
|---|---|---|
| The release states the mission names are not an enforced state machine. `NOT_VERIFIED` does not exist in code. | "Verified" must be the output of a state machine, not a label | Not applicable: this is a SHIPPROOF requirement |
| No in-IDE or agent-side gate. A coding agent can keep editing without SHIPPROOF stopping it. | GuardianKane's gate blocks the agent at the moment it claims "done". SHIPPROOF only judges after a push or a manual run. | GuardianKane |
| The demo repair is scripted. `coding-agent.js` swaps a known line from a hardcoded table. | A judge who reads the code sees a demo patch, not an agent investigation. This undermines the "closed loop" claim. | KANE vs. ABLE, whose fix came from a repair agent |
| The autonomous engineer has never been run against a real Kane failure in this environment | "Closed loop" must be demonstrated, not described | KANE vs. ABLE (recorded run) |
| No recorded real Kane run is in the repository | Judges look for captured executions. The repo has screenshots that come from a machine without Kane. | Both |
| The proof graph is stacked panels, not a graph | The mission asks for a memorable, inspectable graph | None of the three are documented with one |
| Duplicated algorithm suites (`server/algorithms` and my modules) | A judge who opens the code sees two implementations of one idea | None |
| Ochiai and NSGA-II did not beat baselines | Honest, but must be presented as experimental, not as features | None |

## Positioning statement, and what it can and cannot claim

Supportable now: "SHIPPROOF refuses to mark a release verified until the server has real Kane execution rows that
satisfy the gate, and it signs an evidence dossier that anyone can verify."

**Not supportable yet**, and must not be said: "the agent repaired the defect autonomously and Kane confirmed it" (no
recorded run exists), "fully autonomous" (the demo repair is scripted), "unlike GuardianKane, SHIPPROOF gates the
agent" (SHIPPROOF does not gate the agent in-session).

## Competition-relevant mandatory items (status only; not verified or completed here)

| Item | Status |
|---|---|
| Public repository | **Not verified as public.** The repository is reachable from this session with the session's GitHub access; its visibility to anonymous users was not checked. |
| Repository creation date eligibility | **Not verified.** The repository's creation date was not checked. Do not claim eligibility until it is. |
| Real Kane CLI run, captured | **Not done.** No `kane-cli`, no credentials in this environment. |
| Captured failed and successful executions | **Not done.** |
| Functional end-to-end demo | **Not done** in the form the mission describes. |
| YouTube demonstration | **Not done.** A human must record it. |
| Required public launch posts | **Not done.** A human must publish them. |
| Accurate README and architecture | In progress. README updated on the algorithm work; release-gate documentation pending. |

Winners' demos on YouTube exist (linked from the blog) and are the benchmark for what a judge expects to watch.
