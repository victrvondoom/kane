# Command-center architecture

One application, one engineering agent, one backend.

- `public/agent-state.js` — pure state rules (activity dedupe, snapshot authority, project identity, structured context). No DOM, unit-tested.
- `public/agent-workspace.js` — SHIPPROOF ENGINEER controller and drawer. Mounted once on `document.body`, outside `#app`, so route renders do not destroy it. Owns one EventSource at a time.
- `public/command-palette.js` — Ctrl/⌘K palette and the phone "Search/More" entry. Destinations are static; project results come from `GET /api/projects`.
- `public/app.js` — shell: header, bottom navigation (phones), breadcrumbs (`crumb`, set by the project page), `ensureAgent` on each render.
- `public/oncall.js` — "Ask the engineer about this incident" on the incident page.
- `public/workspace.css` — shell, drawer, bottom bar, palette, touch and reduced-motion rules. Breakpoint 760px.

Backend: unchanged. The drawer uses the existing On-call endpoints (`/api/oncall/status`, `/sessions`, `/sessions/:sid`, `/message`, `/interrupt`, `/permission`, `/authorizations/:aid`, `/end`, `/stream`, `/evidence/:ref`).

Session lifecycle: `ensureAgent` restores an active account session on load; `startConversation` creates a text session (confirming before replacing a different project's session); the stream reconnects with `Last-Event-ID`; `endConversation` ends it after confirmation. Sign-out calls `resetAgent`.

Project context: each project page sets `setAgentProject`. The drawer shows "This page" and "Conversation" projects separately.

Not built here: left persistent sidebar, project-switch API, shell-level voice, recent-runs search. See AGENT_WORKSPACE_GUIDE.md.
