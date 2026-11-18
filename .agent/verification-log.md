# Verification log

All commands were run from `d:\kane cli hack` on Windows 11, Node v24.14.0, Claude Code 2.1.325, kane-cli 0.10.6.

## Automated

- `node --test tests/agentgate.test.js`: 23 pass, 0 fail, 1 skipped (the live check, which is opt-in with `SHIPPROOF_LIVE_KANE=1`).
- `npm test`: 225 pass, 0 fail, 9 skipped. The skips are 7 Playwright browser tests, 1 `kane-cli` contract test, and the live check above.

## Real execution (not fixtures)

- `kane-cli --version` → `0.10.6`. Installed with `npm install -g @testmuai/kane-cli`.
- `kane-cli balance` → "Not authenticated". `LT_USERNAME` and `LT_ACCESS_KEY` are empty in `.env`, so no Kane run against the real service was possible.
- `node cli/shipproof.js doctor` → kane-cli `not_authenticated`; `claude-code 2.1.325`; hooks not installed in the repo root; exit 1.
- Headless Claude Code run (`claude -p`, `--permission-mode acceptEdits`, `--max-budget-usd 1`) in a scratch copy of `demo/agent-gate/`, with the hooks installed:
  - The agent was asked to add `COUPON_RATE = 0.10` only.
  - The first `Stop` was blocked: `CRITERIA_FAILED`, failing step `Order total shows $80.00, expected $72.00`, evidence path. This text is in the agent's transcript.
  - The agent changed `total` and the second `Stop` returned `VERIFIED`. Two run directories exist; `blocks: 1` in session state; the pass is cached.
  - The engine for that run was the labelled test fixture, not Kane. The loop mechanics are real; the verdict source is not.

## Limits of this log

- No live Kane run has been executed against the LambdaTest service. Every Kane result above came from `tests/fixtures/fake-kane.js`, which identifies itself as a fixture.
- `shipproof watch` was run only by reading the code. It is not tested.
