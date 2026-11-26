# 10x task plan (session 2026-11-26)

Request: move SHIPPROOF toward a complete implementation: finished structure, a polished design,
and no static UI claims (every status and number comes from the running system).

## Confirmed findings so far (evidence in findings.md)

- F1 (P0): The SPA crashes on load: `installPaletteShortcut is not defined`. Merge `1056e00` dropped the
  imports of agent-workspace.js, command-palette.js, investigation.js, watch.js, and the `<link>`s for
  workspace.css and depth.css. Every browser user gets a blank page. This is the root cause of the 7 browser
  test "TimeoutError"s that earlier sessions recorded as environmental.
- F2: The Gatekeeper worker always spawns system `python3`, never the sub-project's uv environment, so
  `httpx` is missing and the engine reports itself unavailable.
- F3: `/system/public` hardcodes "ACTIVE" for Gatekeeper, Playtest, OQED and SAE; the landing page hardcodes
  "ACTIVE" tags and a "Real-time telemetry" panel that renders no telemetry.
- F4: The release-state machine (prior plan, Phase 3) and the SVG proof graph (Phase 6) were planned and never built.

## Phases

A. Investigation (parallel, read-only): frontend static-content audit, backend honesty/data audit.
B. Synthesis: decisions.md.
C. Implementation, in order of user impact:
   1. Fix F1; add guardrails so it cannot recur (ESLint `no-undef` + browser boot smoke test).
   2. Fix F2 (venv-aware interpreter resolution) + `npm run setup:engines`.
   3. CI workflow running lint + engine setup + the full suite.
   4. Live engine health probes; landing/header/dashboard render live status and stats only.
   5. Release-state machine with an audited transition table (backend + API + tests).
   6. Interactive SVG proof graph with explicit missing-link nodes.
   7. Design system overhaul (tokens, light/dark, components, landing, dashboard), verified by screenshots.
   8. Accurate docs: status numbers that match the test run, remove empty reports.
D. Verification: full suite, lint, runtime checks, desktop + mobile screenshots. verification.md.
