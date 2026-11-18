# Remaining risks

1. **Live Kane is unverified.** No credentials are configured (`LT_USERNAME`, `LT_ACCESS_KEY` empty). Until a real `kane-cli run` is executed through the gate, the verdicts are only as good as the adapter's contract with Kane 0.10.6, which has been checked against the recorded unauthenticated output but not against a successful run. Fix: provide credentials, run `shipproof verify`.
2. **Bash edits to protected files are detected at completion, not prevented.** `PreToolUse` covers the Edit, Write, MultiEdit and NotebookEdit tools only.
3. **`NEEDS_HUMAN` allows the stop.** After three blocks the turn ends with an explicit NOT VERIFIED record. Nothing prevents someone from ignoring that record. The record is in `.shipproof/state`, and `shipproof` does not yet surface it.
4. **Full-tree fingerprinting on every prompt and stop.** Large repositories will be slow. Not measured.
5. **`watch` is untested.** It was written from the design, not run against file changes.
6. **Demo criterion is weak.** The demo spec requires `total === 72` regardless of the coupon, which the agent noticed. A real spec needs the checkout UI and the coupon field.
7. **The Stop hook runs verification synchronously.** Each Kane criterion can take up to the configured timeout (240 s by default). The hook timeout is 900 s.
8. **Headless Claude runs cost money.** The demonstration was capped at $1 with `--max-budget-usd`.
9. **The release gate and the agent gate are separate code paths** (see AD-9).
10. **Not investigated:** the competitor source code (see `competitor-feature-matrix.md`).
