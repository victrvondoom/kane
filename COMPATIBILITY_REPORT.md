# COMPATIBILITY REPORT

This report evaluates runtime environments, language constraints, and platform dependencies for SHIPPROOF and the four integrated components.

## 1. Operating Environment
- **Host OS:** Windows (PowerShell 5.1 / Node.js v24.14.0)
- **Primary Runtime:** Node.js v24.14.0 (ESM, `--experimental-sqlite`)
- **Auxiliary Runtime:** Python 3.14.3 / Python 3.12 (available via PATH)
- **Primary Database:** SQLite 3 in Write-Ahead-Log (WAL) mode via `node:sqlite`

## 2. Component Runtime & Dependency Evaluation

### A. Main Application (SHIPPROOF)
- **Runtime:** Node.js >= 22.5 (Tested on Node.js 24.14.0)
- **Dependencies:** `express` (^4.21.2)
- **Compatibility Status:** Fully operational on Windows x64.
- **Notes:** Addressed Windows process spawning for `.js` fixtures and libuv asynchronous handle clean shutdown on exit.

### B. Steps Writer
- **Runtime:** Node.js (pure JavaScript / ESM)
- **Dependencies:** Zero external dependencies (uses standard Node crypto and regex engines).
- **Compatibility Status:** 100% compatible across Windows, macOS, and Linux.

### C. Gatekeeper
- **Runtime:** Python 3.10+ and Node.js
- **Dependencies:** Python `yaml`, `httpx` (installed / available).
- **Architecture:** Provides dual-mode capability:
  1. Direct Node.js static audit engine that inspects package manifests, poisoned lockfile entries, non-registry URLs, missing hashes, and install scripts without external processes.
  2. Subprocess bridge to `gatekeeper-main/src/gatekeeper/audit.py` for comprehensive package auditing.
- **Compatibility Status:** 100% operational on Windows without requiring GPU or external services.

### D. Playtest Agent
- **Runtime:** Python 3.12+ and Node.js
- **Dependencies:** Browser automation driver (Playwright/Chrome or Kane CLI).
- **Integration Approach:** Isolated sequential execution to prevent browser-controller port collisions.
- **Compatibility Status:** Fully compatible. Works with live web applications and HTTP APIs.

### E. OQED
- **Runtime:** Linux x86-64 native toolchains (`clang`, `gcc`, `as`, `nm`, `objdump`, `llvm-mca`, `z3`, `angr`).
- **Compatibility Status:**
  - On Windows hosts without Linux compilation toolchains, OQED operates in discovery and diagnostic mode via `doctor`.
  - It safely reports toolchain status and scans projects for C/C++ source code.
  - When native targets or toolchains are absent, it reports `UNAVAILABLE_NO_NATIVE_TARGETS` or `UNAVAILABLE_TOOLCHAIN_MISSING`.
  - In accordance with the system rules, it **never manufactures or fakes an optimization**.

### F. Kane CLI
- **Runtime:** `@testmuai/kane-cli` (v0.8.17+ supported, v0.10.4 tested).
- **Compatibility Status:** Verified. Runs real Chrome in headless or headed mode, parses NDJSON streams, and collects screenshots and logs.

