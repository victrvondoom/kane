# NoteVault: the TenantSeal demonstration target

NoteVault is a deliberately vulnerable multi-tenant notes app. Use it only to demonstrate TenantSeal. Never deploy it.

## Accounts (demo only, documented on purpose)

| Identity | Username | Password | Role in the demo |
| --- | --- | --- | --- |
| Owner | `alice` | `alice-demo-pass` | Plants a private note, owns it |
| Second tenant | `bob` | `bob-demo-pass` | Tries to read and overwrite Alice's note |
| Anonymous | — | — | Not signed in |

These passwords are throwaway values for this repository's demo. TenantSeal reads passwords from environment variables named in `tenantseal/config.json` and never stores them.

## Intentional defects

| Id | Where | Defect |
| --- | --- | --- |
| A | `GET /api/docs/:id` | Returns any tenant's note (no owner check) |
| B | `GET` and `POST /docs/:id/edit` | Any signed-in user can read and overwrite any tenant's note |
| C | `GET /api/docs/:id/activity` | A background endpoint leaks a content preview. The visible `GET /docs/:id` is protected, so the leak is only found by following the page's own background requests |

The owner's visible page, `GET /docs/:id`, correctly returns 404 to other tenants. The owner keeps full access in every build.

## Run the demonstration

```
npm run demo:tenant
```

This starts NoteVault in a temporary workspace, runs a TenantSeal scan (`LEAKING`), applies `fix.patch` to the workspace copy, restarts the app and scans again with a fresh canary (`SIMULATED_SEALED`). The engine is the labelled test fixture, so every verdict is SIMULATED.

## Run TenantSeal yourself

```
node demo/tenant-boundary/app.js                  # NoteVault on http://127.0.0.1:4300/
export TB_ALICE_PASSWORD=alice-demo-pass TB_BOB_PASSWORD=bob-demo-pass
mkdir -p .tenantseal && cp demo/tenant-boundary/tenantseal/config.json .tenantseal/config.json
node cli/shipproof.js tenant doctor
node cli/shipproof.js tenant scan --engine simulated   # SIMULATED, test fixture
node cli/shipproof.js tenant scan --engine kane        # real kane-cli; needs `kane-cli login`
node cli/shipproof.js tenant report
```

Exit codes: 0 sealed (live or simulated), 1 leaking, 2 unverified or misconfigured.

## Repair

`fix.patch` adds owner checks to the three defective routes and keeps the owner's access. The completion gate (`server/agentgate`) runs the same scan when a security-relevant file changes, so an agent cannot finish while the leak remains.
