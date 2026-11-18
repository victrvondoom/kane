# TenantSeal: architecture, verification and limits

## What it proves

A user must not read, enumerate, modify or access another tenant's private resources through the application's UI or exposed endpoints. A scan plants a fresh canary as the owner, discovers the related routes from the browser evidence, probes as a second tenant and as an anonymous visitor, attempts a cross-tenant write, and confirms the outcome from the owner's view.

## Architecture decisions

- **AD-T1. Browser actions go through the existing Kane adapter** (`server/kane.js`: `runKane`, `classify`, `collectEvidence`). TenantSeal adds no second CLI wrapper.
- **AD-T2. Verdicts come from HAR evidence, not from the engine's self-report.** A canary in the response body of a request the probe made is the leak signal. An engine that says "passed" without network evidence is unverified (`missing_evidence`).
- **AD-T3. Route discovery reads the HAR** that Kane records for the owner's ordinary session (the approach used by Zelkaro, MIT licence; the implementation here is independent). Same-origin only; ids are normalised to `:id` templates; request headers are never kept.
- **AD-T4. Failure categories are kept apart.** A failed sign-in is INCONCLUSIVE; a timeout or environment fault is ERROR; a 404 or 401 counts as BLOCKED only when the route was actually requested and the canary is absent.
- **AD-T5. A tamper is confirmed from the owner's view**, never from the write's status code.
- **AD-T6. Owner control gates the release.** Owner lockout yields INCONCLUSIVE with `releaseBlocking: true`, so a policy that denies everyone cannot be SEALED.
- **AD-T7. Simulated results are labelled.** The engine kind is part of every scan (`SIMULATED_SEALED` vs `SEALED`). `--engine kane` never falls back to the fixture; `--engine simulated` refuses any binary that does not identify as the fixture.
- **AD-T8. Trusted definitions are protected.** `.tenantseal/config.json` and `server/tenantseal/**` are in the protected set of the completion gate. Run output (`.tenantseal/runs`, `scans`, `state`) is excluded from fingerprints so it cannot trigger or mask a change.
- **AD-T9. The gate maps the scan onto its own result shape.** SEALED or SIMULATED_SEALED passes, LEAKING fails with the evidence path, anything else is unverified. The agent receives the same dossier a human would read.

## Verification (this session)

- `tests/tenantseal.test.js`: 22 tests. Configuration validation and credential handling; HAR parsing and discovery; every verdict rule; engine refusal; reporting with no credentials; full scans of the vulnerable build (LEAKING), the repaired build (SIMULATED_SEALED, fresh canary), an owner-locking build (never sealed), and a wrong password (unverified). All use the test fixture.
- `tests/tenantseal-gate.test.js`: the completion gate blocks a security-relevant change with the LEAKING dossier, then accepts the repaired build. Protection of the scanner and configuration. `npm run demo:tenant` end to end.
- Full project suite: 250 pass, 0 fail, 9 skipped (Playwright and kane-cli contract tests plus the opt-in live check).

## Limits (stated plainly)

- **No live Kane run has happened.** `kane-cli` 0.10.6 is installed but not logged in (`kane-cli balance` → not authenticated; `LT_USERNAME` and `LT_ACCESS_KEY` are empty). Every scan in this repository used the labelled test fixture. The live command is `node cli/shipproof.js tenant scan --engine kane` after `kane-cli login`. Expect the real HAR format to differ from the fixture's: response bodies must be present in the evidence for the canary test to work. This has not been verified against a real run.
- **Discovery depends on what the browser requests.** A route the owner's session never touches is not discovered; `discovery.manualRoutes` exists for that case and is labelled `configured`.
- **Tamper tests are one write per discovered mutation route, on the same record.** Several write routes are tested in sequence with distinct tokens.
- **Not done:** the release-engine integration with the database (see AD-9 in `architecture-decisions.md`). TenantSeal results feed the file-based completion gate only; they are not stored in the project's release decision tables. The Evidence Room UI is not built. Report signing uses a SHA-256 digest, not the existing ed25519 keys in `server/keys.js`.
- **Live-run cost:** a real scan runs roughly 14 to 40 browser executions, each billed by Kane. `limits.maxRuns` caps them.
- **The Stop hook is synchronous.** A real scan can take minutes; the hook timeout is 900 s.
