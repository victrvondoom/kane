# Product UX audit (command-center pass)

Checked against the local checkout (HEAD c12fba2, branch vsrupeshkumar/clever-mccarthy-s2exjq). The owner's checkpoint commit 8130df3 / branch admiring-ritchie-6days8 is not present in this checkout and was not used.

| Question | Finding |
|---|---|
| Screens | Landing, sign in/up, projects, new project, project (14 tabs), run, On-call call screen, incident history, incident page, public report. |
| Routes | Hash router in `public/app.js` (`#/app`, `#/new`, `#/p/:id/:tab`, `#/run/:id`, `#/oncall`, `#/oncall/i/:id`, `/r/:token`). All still work. |
| Agent API | `/api/oncall/*` already scoped per account; no changes needed. |
| Wired controls | Verified by the browser suites; see INTERACTION_INVENTORY.md. |
| Browser-only state | Before: On-call page state lived in the page closure and was torn down on navigation. After: the engineer drawer keeps its own stream and state outside the page renderer. |
| Persistence | Sessions, transcripts, activity, evidence and incidents are persisted server-side (SQLite). |
| SSE | `/oncall/sessions/:sid/stream` replays after `Last-Event-ID`; client dedupes by id. |
| Survives SPA navigation | Before: no (call screen tore down). After: the drawer conversation survives route changes; the call screen still drops voice media on leaving (documented). |
| Voice survives navigation | No. Voice remains on the On-call screen; a persistent shell-level voice connection was not built. |
| Project context | Before: only a select on the call screen. After: breadcrumb + page project is passed to the drawer; a new conversation is linked to it; switching projects asks before replacing. |
| Errors | Drawer shows server errors in a role=alert notice; SSE reconnects with backoff. |
| Narrow screens | Before: header carried 7+ links. After: bottom navigation + Search; header reduced to Engineer/Search/status under 760px. |
| Horizontal overflow | Checked at 390px on projects, project and On-call routes: none (see MOBILE_RESPONSIVE_REPORT.md). |
| Operations that need another screen | Asking the engineer about a repair task or incident used to require copying identifiers; now one click attaches the record. |
