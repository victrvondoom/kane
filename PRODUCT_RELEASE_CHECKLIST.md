# Product release checklist

- [x] `npm test` green (116 pass, 1 pre-existing skip).
- [x] Browser workspace test at 1280 and 390 widths.
- [x] No horizontal overflow on checked routes at 390 px.
- [x] Permissions enforced by the server (reader escalation → 403).
- [x] Sign-out clears the drawer state (`resetAgent`).
- [ ] HawkScan security scan — not run: `hawk` CLI and HAWK_API_KEY unavailable in this session, no `stackhawk.yml`.
- [ ] Widths 360–1440 beyond the verified two; existing data tables at phone width.
- [ ] Voice from the drawer (not built).
- [ ] Left persistent navigation (not built).
- [ ] Push to `vsrupeshkumar/clever-mccarthy-s2exjq` — pending write access (see final report).
