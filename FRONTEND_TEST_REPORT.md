# Frontend test report

Commands:
```
npm test                              # full suite (node:test, single worker)
node --test tests/agent-workspace.test.js   # state rules (unit)
WORKSPACE_SHOTS=docs/screenshots node --test tests/e2e-workspace.test.js  # browser
```

Latest full run: 117 tests, 116 pass, 1 skipped (pre-existing skip), 0 failing.

Results of note:
- Unit (10): activity dedupe and replay, bounded log, snapshot authority, project identity, context block, composition, evidence refs.
- Browser (1, Chromium): drawer opens; conversation to the scripted engineer; no duplicate user entries; drawer and transcript survive navigation with the same document and a single session; permission raised by owner; offline/online reconnect reaches Live with no duplicate reply; Escape closes; Ctrl+K search navigates; end conversation after confirmation; reader offered read-only only and refused escalation (403); phone 390 px layout and touch targets; no page errors.
- Regression found and fixed during this pass: the drawer's root class `agent` collided with the existing `.meter.agent` on the On-call screen and broke a click in `e2e-oncall`. Renamed to `ag-drawer`.

Not covered by automation: Stop work, approvals, attached-context flow from repair tasks and incidents, phone keyboard behaviour, screenshot diffing.
