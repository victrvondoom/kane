# Interaction inventory (new and changed controls)

| Element | User action | Actual result | Backend/API | Permission | Test |
|---|---|---|---|---|---|
| Header "✦ Engineer" / bottom "Engineer" | Open/close drawer | Drawer toggles; status refreshed | `GET /api/oncall/status` on open | signed in | e2e-workspace |
| Header "Search" / bottom "More" / Ctrl+K | Open palette | Native dialog with projects and destinations | `GET /api/projects` | signed in | e2e-workspace |
| Palette item | Navigate or run | Hash route change, or openAgent / judge demo / sign out | route, demo, logout | as item | e2e-workspace (navigation) |
| Start conversation | Create text session | Conversation starts; stream attaches | `POST /api/oncall/sessions` (mode text) | signed in; disabled with notice if not enabled or no reasoning credentials | e2e-workspace |
| Permission select | Change level | Level changes or 403 notice | `POST …/permission` | server: role tier | e2e-workspace (owner raises; reader 403 via API) |
| Send / Enter | Send message | Transcript updates from server | `POST …/message` | active session | e2e-workspace |
| Stop work | Interrupt engineer | Stopped or "not running" toast | `POST …/interrupt` | active session | not browser-tested |
| End conversation | End after confirmation | Status "Conversation ended" | `POST …/end` | active session | e2e-workspace |
| Approve / Deny | Decide production action | Authorization decided | `POST …/authorizations/:aid` | server: approver role | not browser-tested |
| Evidence chip (E-n) | Open evidence | Dialog with output and sha256 | `GET …/evidence/:ref` | session owner | unit (refs), not browser-tested |
| Attached context chip ✕ | Remove attachment | Attachment cleared | none | — | not browser-tested |
| Ask the engineer (repair task) | Attach failure context, open drawer | Context chip in composer | none until send | signed in | not browser-tested |
| Ask the engineer about this (incident) | Attach incident context | Context chip in composer | none until send | signed in | not browser-tested |
| Breadcrumb links | Navigate | Project / tab routes | none | — | e2e-workspace (text) |
| Drawer Expand / ✕ | Resize / close | Layout change / close; Escape closes | none | — | e2e-workspace (Escape) |
| Judge demo, New project, Sign out (header and palette) | As before | Unchanged behaviour | existing | existing | existing suites |
