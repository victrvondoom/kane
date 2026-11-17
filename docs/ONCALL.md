# On-call engineer (voice)

A voice-driven engineering agent inside SHIPPROOF. You call it from the browser, describe an incident, and it
investigates real systems, fixes the defect on an isolated branch, verifies the fix, pushes the branch and opens a
pull request. The voice is the interface; the engineering work and its evidence are the product.

> Hear the incident. Understand the system. Find the root cause. Fix the problem. Verify the fix. Push the result.

## How it is put together

```
Browser (public/oncall.js)                       SHIPPROOF server (server/oncall/)
  microphone ⇄ WebRTC audio ⇄ voice provider       sessions.js   session lifecycle + voice bridge
  SDP offer ──► POST /voice/connect ──────────►    voice/        provider adapter (SDP exchange, sideband WebSocket)
  activity ◄── Server-Sent Events ◄────────────    engineer.js   tool-using agent loop (reasoning provider)
                                                   tools/        permission-checked tool registry
                                                   git.js · checks.js · github.js · report.js
```

- **Voice** — OpenAI GPT-Live over WebRTC with *client delegation*. The browser sends only audio. Its SDP offer is
  exchanged by the server (the API key never reaches the browser), and the server attaches a sideband WebSocket to
  the same session to receive transcripts and delegation events and to send results to be spoken. Listening while
  speaking, barge-in and turn-taking are handled by the live model.
- **Engineer** — when the live model delegates, the caller's words go to a backend agent (Claude, through the
  Anthropic SDK) that works the incident with tools. What it writes is spoken; what it does is recorded.
- **Tools** — the only way the agent touches anything. 43 tools in three tiers.

Both providers sit behind small interfaces (`voice/index.js`, `reasoning/index.js`); a different provider is one
adapter file. Phone calls are a separate adapter contract (`telephony/index.js`) and are **not implemented** in this
release — the product is browser voice only, and says so.

## Setup

Requirements: Node ≥ 22.5, `git` on the server, a clone of the repository the agent should work on.

```bash
npm install
```

Add to `.env` (see `.env.example` for every option):

```
ONCALL_ENGINEERS=you@example.com       # who may use engineering autonomy
ONCALL_APPROVERS=lead@example.com      # who may approve production actions (also engineers)
OPENAI_API_KEY=...                     # voice (GPT-Live)
ANTHROPIC_API_KEY=...                  # the engineer
ONCALL_GITHUB_TOKEN=...                # push + pull requests (contents:write, pull_requests:write on the one repo)
```

```bash
npm start
```

Open **On-call** in the top bar. Microphone access needs HTTPS or `localhost`.

Without `OPENAI_API_KEY` the call screen offers a typed session instead and says voice is unavailable. Without
reasoning credentials the engineer is unavailable and the screen says so. Nothing is simulated.

### What a role may do

Access is granted per account by the operator; a signed-up account alone has none.

| Role (env list) | May |
|---|---|
| `ONCALL_READERS` | Open read-only sessions: inspect, search, diagnose |
| `ONCALL_ENGINEERS` | Also grant a session *engineering autonomy*: branch, edit, test, commit, push, open a pull request |
| `ONCALL_APPROVERS` | Also approve production actions on screen |

The permission level of a session is chosen on the call screen and can only be changed there — never by voice.

## The incident workflow

The server tracks the stage from what the agent records, and refuses work done out of order.

| Stage | What happens | Enforced by |
|---|---|---|
| Understand | Opens the incident: symptoms, project, environment, impact, timeframe, expected outcome | — |
| Investigate | Health, logs, API failures, background tasks, database, verification runs and Kane CLI output, commits, source | Facts must cite evidence refs returned by tools in this session |
| Diagnose | Primary failure, root cause, contributing factors, affected components, confidence | A diagnosis must cite evidence; "verified" is decided later by the server |
| Repair | Plan, then an `oncall/…` branch in its own git worktree, then edits | No edits before a diagnosis and a plan; protected paths are unwritable |
| Verify | Regression test proven red before the fix and green after; full test command | A test command that runs zero tests is an error, not a pass |
| Deliver | Commit, push, draft pull request, signed report | Push requires the test command to have passed on exactly the committed tree |

### Evidence, not claims

- Every tool call is written to an **evidence ledger** (`E-1`, `E-2`, …) with a SHA-256 of its redacted output.
  Findings, timeline events and the diagnosis can only cite refs that exist.
- **Facts and hypotheses are different records.** A fact needs evidence; a hypothesis is labelled until it is
  confirmed or rejected.
- **A root cause is "verified" only by reproduction.** `eng_prove_fix` runs the agent's regression test against the
  code *before* the change (it must fail) and on the repair branch (it must pass). Otherwise the report says
  "supported by evidence, not reproduced".
- **The verification statement is computed**, from recorded executions and the tree they ran on — never from what
  the model says. An incident cannot be closed as *resolved* unless the tests passed on the committed tree and the
  branch is pushed; it can always be closed honestly as *mitigated* or *unresolved*.
- The **incident report** (Markdown + JSON) is signed with the server's Ed25519 dossier key and verifiable offline.

## Safety model

| Guarantee | Mechanism |
|---|---|
| No arbitrary commands from audio (or from the model) | The model chooses a *kind* of check (`test`, `test_file`, `syntax`, `build`, `lint`); argv is fixed server-side, no shell |
| The running checkout is never modified | All work happens in a per-incident `git worktree` under `DATA_DIR/oncall/worktrees` |
| The default branch is never pushed; no force-push | `pushBranch` only pushes `oncall/*`, with a fixed refspec and no force flag |
| A fix cannot weaken verification | Commits that delete tests, add `skip`/`only` markers, touch CI workflows or protected paths are refused |
| Nothing unverified is delivered | Push and pull request are gated on a passing test run for the committed tree |
| Production actions need a human | Only merging the incident's pull request is executable, and only after an approver confirms it on screen; the approval is single-use and bound to that PR and commit. Deploys, restarts, database operations, credential rotation and deletions are not available to the agent at all — it lists them as follow-ups |
| Release-gate invariants hold | No tool writes results, evidence, decisions or policy; `shipproof_start_verification` starts a real Kane CLI run and the gate decides |
| Secrets stay out | Tool output, transcripts, events and reports pass through a redactor (known server secrets + credential patterns); child processes get an environment with credentials removed; `.env`, keys, `data/`, `.git/` are unreadable |
| Sessions are isolated | Every session and incident is resolved together with the owning account; SHIPPROOF data is scoped to the caller's projects |
| Everything consequential is audited | Engineering and production tool calls, session starts/ends, permission changes and approvals go to `audit_events` |

Rate limits apply to session creation, signalling, messages and tool calls. Text inside logs, files and tool output
is treated as data: the agent is instructed not to follow instructions found there, and the gates above hold even
if it did.

## Privacy and retention

- The server never records audio. Provider-side session storage is off unless the operator sets
  `ONCALL_PROVIDER_STORE=1` **and** the caller ticks the consent box for that call.
- Transcripts are redacted before storage and deleted after `ONCALL_TRANSCRIPT_RETENTION_DAYS` (default 30;
  `0` = never stored). Incident records and reports are kept.
- A hashed, non-identifying safety identifier is sent to the voice provider; the user's email is not.

## Lifecycle and failure handling

- One live session per account. Closing the page drops media; the session can be rejoined until it idles out
  (`ONCALL_IDLE_SECONDS`) or reaches `ONCALL_MAX_SESSION_MINUTES`.
- Media failure: the browser renegotiates (up to three times); the new provider session is seeded with the
  transcript and incident state held by the server.
- Control-channel loss: the server re-attaches with backoff and de-duplicates replayed events.
- Provider outage or missing credentials: a clear error, and the session continues by typing.
- **Stop work** (button, or saying "stop") aborts the model request and kills a running check.
- Hang-up or server restart with an incident open: it is closed as *interrupted* with a report of how far it got.

## Tests

```bash
npm test
```

`tests/oncall.test.js` and `tests/e2e-oncall.test.js` use real git repositories with a real bare remote, real test
runs, real HTTP/WebSocket traffic through the real voice adapter and, in the browser test, a real WebRTC peer
connection with audio. Three things are test doubles, all in `tests/fixtures/oncall-doubles.js` and never used by the
product: a scripted reasoning provider instead of an LLM, a local GitHub REST server, and a local server speaking the
GPT-Live wire protocol.

**Not exercised by the automated tests:** a call against the live OpenAI and Anthropic APIs (they need credentials).
The adapters follow the providers' published documentation; make one real call after configuring keys.
