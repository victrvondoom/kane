# End-to-end scenarios

| Scenario | Status | How to run |
| --- | --- | --- |
| A. Functional failure → agent repair → same test passes | Demonstrated with the fixture engine and a real Claude Code agent. Live Kane not run. | Copy `demo/agent-gate/` to a scratch folder, write `fixture-state.json` as `{"mode":"eval","expectTotal":72}`, run `node <repo>/cli/shipproof.js hook install` in the copy, then run `claude -p` in the copy with `KANE_CLI_BIN` set to `tests/fixtures/fake-kane.js`, `FAKE_KANE_STATE` set to the state file and `FAKE_APP_DIR` set to the copy. |
| A (live). Same, with real Kane | Blocked on credentials. | Set `LT_USERNAME` and `LT_ACCESS_KEY` in `.env` (or run `kane-cli login`), start the demo app on `http://127.0.0.1:4100/`, then run `shipproof verify` and the scenario above without the fixture variables. |
| B. Security (two accounts, cross-user leak) | Not started | |
| C. Pull request assurance | Not started | |
| D. Requirements drift | Not started | |
