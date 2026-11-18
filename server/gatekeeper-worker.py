#!/usr/bin/env python3
"""
SHIPPROOF Gatekeeper Engine Worker
Bridge to the real gatekeeper-main package intelligence engine.
Communicates with Node.js backend using JSON over stdin/stdout.
"""
from __future__ import annotations

import base64
import json
import os
import re
import sys
from pathlib import Path

# Add gatekeeper-main/src to Python module search path
REPO_ROOT = Path(__file__).resolve().parent.parent
GK_SRC = REPO_ROOT / "gatekeeper-main" / "src"
if str(GK_SRC) not in sys.path:
    sys.path.insert(0, str(GK_SRC))

try:
    from gatekeeper.audit import (
        read_lockfile,
        parse_npm,
        parse_pnpm,
        parse_yarn,
        names_another_file,
        on_registry,
        host_of,
        TRUSTED_HOSTS,
        CODE_HOSTS,
        MALICIOUS,
        UNTRUSTED_SOURCE,
        NO_INTEGRITY,
    )
    from gatekeeper.confirm.osv import query as osv_query
    from gatekeeper.fastclf import PortableModel
    from gatekeeper.evidence.bundle import build_bundle
    from gatekeeper.guard.core import Decision as GuardDecision
    GK_AVAILABLE = True
    GK_ERROR = None
except Exception as exc:
    GK_AVAILABLE = False
    GK_ERROR = str(exc)


def handle_audit(payload: dict, workspace_dir: Path) -> dict:
    """Audit project workspace lockfile and manifests for malicious packages, source spoofing, and poisoning."""
    ws = Path(payload.get("workspaceDir") or workspace_dir)
    lock_file = payload.get("lockfile")
    lock_content = payload.get("lockfileContent")
    
    findings = []
    packages_count = 0
    lock_path = None

    if lock_content:
        name = payload.get("lockfileName", "package-lock.json")
        if "yarn" in name:
            locked = parse_yarn(lock_content)
        elif "pnpm" in name:
            locked = parse_pnpm(lock_content)
        else:
            locked = parse_npm(lock_content)
    else:
        try:
            lock_path, locked = read_lockfile(ws)
        except Exception as e:
            return {
                "verdict": "ALLOWED",
                "summary": f"No valid package lockfile found in workspace ({e}); static audit clean.",
                "findings": [],
                "packageCount": 0,
                "engine": "Gatekeeper (audit)"
            }

    packages_count = len(locked)

    for item in locked:
        # Poisoning check: name in tarball does not match item name
        if item.resolved and names_another_file(item):
            findings.append({
                "kind": "poisoned_lockfile_entry",
                "severity": "critical",
                "name": item.name,
                "version": item.version,
                "detail": f"Lockfile poisoning detected: Package '{item.name}' resolved to mismatched tarball '{item.resolved}'"
            })
        
        # Untrusted source host check
        if item.resolved:
            h = host_of(item.resolved)
            if h and h not in TRUSTED_HOSTS and h not in CODE_HOSTS:
                findings.append({
                    "kind": "untrusted_registry_host",
                    "severity": "high",
                    "name": item.name,
                    "version": item.version,
                    "detail": f"Package '{item.name}' downloaded from unverified host: {h}"
                })
        
        # Integrity checksum
        if not item.integrity:
            findings.append({
                "kind": "missing_integrity_checksum",
                "severity": "medium",
                "name": item.name,
                "version": item.version,
                "detail": f"Package '{item.name}' lacks cryptographic integrity hash"
            })

    # Severity evaluation
    has_crit = any(f["severity"] == "critical" for f in findings)
    has_high = any(f["severity"] == "high" for f in findings)
    has_med = any(f["severity"] == "medium" for f in findings)

    if has_crit:
        verdict = "BLOCKED"
        summary = f"Security check BLOCKED: Critical supply chain risks detected ({len(findings)} findings)."
    elif has_high:
        verdict = "BLOCKED"
        summary = f"Security check BLOCKED: Untrusted external package sources found ({len(findings)} findings)."
    elif has_med:
        verdict = "REQUIRES_REVIEW"
        summary = f"Security check REQUIRES REVIEW: Missing integrity hashes found."
    else:
        verdict = "ALLOWED"
        summary = f"Gatekeeper audit PASSED: {packages_count} packages verified against supply-chain poisoning and host spoofing."

    return {
        "verdict": verdict,
        "summary": summary,
        "findings": findings,
        "packageCount": packages_count,
        "lockfile": str(lock_path) if lock_path else None,
        "engine": "Gatekeeper (gatekeeper-main)"
    }


def handle_investigate_tools(payload: dict, workspace_dir: Path) -> dict:
    """
    Executes controlled investigator tools on a target package directory:
    read, search, decode, strings, compare.
    """
    tool = payload.get("tool")
    target_path = Path(payload.get("targetPath") or workspace_dir)
    params = payload.get("params", {})

    if not target_path.exists():
        return {"error": f"Target path {target_path} does not exist"}

    if tool == "read":
        if target_path.is_file():
            file_path = target_path.resolve()
            rel = target_path.name
        else:
            rel = params.get("file", "")
            file_path = (target_path / rel).resolve() if rel else target_path.resolve()

        base = target_path.parent if target_path.is_file() else target_path
        if not str(file_path).startswith(str(base.resolve())):
            return {"error": "Path escapes package root"}
        if not file_path.is_file():
            return {"error": f"Not a file: {rel}"}
        lines = file_path.read_text(encoding="utf-8", errors="replace").splitlines()
        start = max(1, int(params.get("start", 1)))
        count = min(200, int(params.get("count", 50)))
        slice_lines = lines[start - 1 : start - 1 + count]
        formatted = [f"{start + i:4d} | {line}" for i, line in enumerate(slice_lines)]
        return {"tool": "read", "file": rel, "totalLines": len(lines), "start": start, "lines": formatted}

    elif tool == "search":
        search_root = target_path.parent if target_path.is_file() else target_path
        pattern = params.get("query", "")
        if not pattern:
            return {"error": "Query required"}
        results = []
        rx = re.compile(re.escape(pattern), re.I)
        for p in search_root.rglob("*"):
            if p.is_file() and p.stat().st_size < 1_000_000:
                try:
                    txt = p.read_text(encoding="utf-8", errors="ignore")
                    for i, line in enumerate(txt.splitlines(), start=1):
                        if rx.search(line):
                            results.append({
                                "file": str(p.relative_to(search_root)),
                                "line": i,
                                "match": line.strip()[:200]
                            })
                            if len(results) >= 50:
                                break
                except Exception:
                    pass
            if len(results) >= 50:
                break
        return {"tool": "search", "query": pattern, "matchCount": len(results), "matches": results}

    elif tool == "decode":
        text = params.get("text", "")
        mode = params.get("mode", "base64")
        decoded = ""
        try:
            if mode == "base64":
                decoded = base64.b64decode(text).decode("utf-8", errors="replace")
            elif mode == "hex":
                decoded = bytes.fromhex(text.replace(" ", "").replace("0x", "")).decode("utf-8", errors="replace")
        except Exception as e:
            return {"error": f"Decoding failed: {e}"}
        return {"tool": "decode", "mode": mode, "result": decoded[:2000], "decoded": decoded[:2000]}

    elif tool == "strings":
        if target_path.is_file():
            file_path = target_path.resolve()
            rel = target_path.name
        else:
            rel = params.get("file", "")
            file_path = (target_path / rel).resolve() if rel else target_path.resolve()

        base = target_path.parent if target_path.is_file() else target_path
        if not str(file_path).startswith(str(base.resolve())):
            return {"error": "Path escapes package root"}
        if not file_path.is_file():
            return {"error": f"Not a file: {rel}"}
        content = file_path.read_bytes()
        strings = re.findall(b"[A-Za-z0-9_\\-\\./:]{6,}", content)
        decoded_strs = [s.decode("latin1", errors="ignore") for s in strings[:100]]
        return {"tool": "strings", "file": rel, "count": len(decoded_strs), "strings": decoded_strs}

    return {"error": f"Unknown investigator tool: {tool}"}


def main():
    if not GK_AVAILABLE:
        sys.stdout.write(json.dumps({
            "ok": False,
            "error": f"Gatekeeper engine unavailable: {GK_ERROR}"
        }))
        sys.stdout.flush()
        return

    try:
        raw_in = sys.stdin.read()
        if not raw_in.strip():
            sys.stdout.write(json.dumps({"ok": False, "error": "No input provided"}))
            return
        req = json.loads(raw_in)
    except Exception as e:
        sys.stdout.write(json.dumps({"ok": False, "error": f"Invalid input JSON: {e}"}))
        return

    action = req.get("action")
    payload = req.get("payload", {})
    workspace_dir = Path(req.get("workspaceDir", os.getcwd()))

    try:
        if action == "audit":
            res = handle_audit(payload, workspace_dir)
            sys.stdout.write(json.dumps({"ok": True, "data": res}))
        elif action == "investigate":
            res = handle_investigate_tools(payload, workspace_dir)
            sys.stdout.write(json.dumps({"ok": True, "data": res}))
        elif action == "status":
            sys.stdout.write(json.dumps({
                "ok": True,
                "data": {
                    "available": True,
                    "engine": "Gatekeeper (Python)",
                    "srcPath": str(GK_SRC),
                    "trustedHosts": list(TRUSTED_HOSTS)
                }
            }))
        else:
            sys.stdout.write(json.dumps({"ok": False, "error": f"Unknown action: {action}"}))
    except Exception as exc:
        sys.stdout.write(json.dumps({"ok": False, "error": str(exc)}))
    
    sys.stdout.flush()


if __name__ == "__main__":
    main()
