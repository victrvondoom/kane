# Mobile and responsive report

Breakpoint: 760px. Phones get the bottom bar (Projects, Engineer, On-call, More) and a full-height drawer; the header keeps the brand, Engineer, Search and a compact engine status.

Verified (Playwright, Chromium, `tests/e2e-workspace.test.js`):
- 390 × 844: no horizontal overflow on `#/app`, `#/p/:id`, `#/oncall`; bottom bar present with four targets ≥ 44 px; drawer 390 px wide and full height; composer and Send button on screen.
- 1280 × 860 desktop: drawer overlays the page (does not reduce content width); breadcrumb visible.

Screenshots (docs/screenshots/): `phone-projects.png`, `phone-drawer.png`, `phone-project.png`, `desktop-drawer-conversation.png`.

Not verified: 360, 375, 393, 430, 768, 1024, 1440 widths, on-screen keyboard behaviour on real devices (the `visualViewport` lift is implemented but not browser-tested), and existing tables/code-diff views at phone width beyond the three routes above.
