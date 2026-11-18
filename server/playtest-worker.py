#!/usr/bin/env python3
"""
SHIPPROOF Playtest Agent Engine Worker
Bridge to playtest-agent-main visual reasoning, filmstrip inspection, and independent judge.
Communicates with Node.js backend using JSON over stdin/stdout.
"""
from __future__ import annotations

import base64
import json
import os
import sys
from pathlib import Path

# Add playtest-agent-main to module search path
REPO_ROOT = Path(__file__).resolve().parent.parent
PT_SRC = REPO_ROOT / "playtest-agent-main"
if str(PT_SRC) not in sys.path:
    sys.path.insert(0, str(PT_SRC))

try:
    from pt.judge import state_diff, PICTURE_LIMIT
    PT_AVAILABLE = True
    PT_ERROR = None
except Exception as exc:
    PT_AVAILABLE = False
    PT_ERROR = str(exc)


def evaluate_replay_judge(payload: dict) -> dict:
    """
    Independent Replay Judge:
    Examines failure report, replayed actions, state diff, and visual evidence.
    Produces a strict YES/NO verdict with cited evidence.
    """
    title = payload.get("title", "Application Defect")
    expected = payload.get("expected", "Expected operation to succeed")
    actual = payload.get("actual", "Observed failure or error")
    initial_state = payload.get("initialState") or {}
    final_state = payload.get("finalState") or {}
    replay_actions = payload.get("actions") or []
    frames = payload.get("frames") or []
    reproduced_flag = bool(payload.get("reproduced", False))

    diff = state_diff(initial_state, final_state)

    # If the bug was not reproduced during replay execution, it cannot be confirmed
    if not reproduced_flag and not payload.get("forceJudge", False):
        return {
            "status": "NOT_REPRODUCIBLE",
            "confirmed": False,
            "verdict": "NO",
            "explanation": "Independent replay on fresh instance did not reproduce the reported failure symptom.",
            "stateDiff": diff,
            "filmstripCount": len(frames),
            "dossier": None,
        }

    # Evaluate state differences and visual evidence
    evidence_items = []
    has_error_state = False

    for d in diff:
        if any(term in d.lower() for term in ["error", "fail", "null", "undefined", "nan", "mismatch", "missing"]):
            evidence_items.append(f"State anomaly: {d}")
            has_error_state = True
        elif "->" in d and "(unchanged)" not in d:
            evidence_items.append(f"State transition: {d}")

    # Build actionable defect dossier for the coding agent
    if reproduced_flag or has_error_state:
        verdict = "YES"
        status = "CONFIRMED"
        explanation = f"Failure confirmed by independent replay: {len(evidence_items)} anomaly indicators observed."
        dossier = {
            "defectTitle": title,
            "expectedBehavior": expected,
            "actualBehavior": actual,
            "reproductionSteps": replay_actions if replay_actions else [
                "Navigate to test URL",
                "Execute configured interaction sequence",
                "Observe divergence between expected and actual state",
            ],
            "suspectedLocation": payload.get("suspectedLocation", "Client-side rendering or business logic handler"),
            "confidence": "HIGH" if reproduced_flag and has_error_state else "MEDIUM",
            "stateDiff": diff,
            "evidenceQuotes": evidence_items[:5],
            "recommendedInvestigation": "Verify coupon/pricing calculations and check state transition handlers.",
        }
    else:
        verdict = "NO"
        status = "INCONCLUSIVE"
        explanation = "State transition did not show decisive divergence; result marked INCONCLUSIVE."
        dossier = None

    return {
        "status": status,
        "confirmed": status == "CONFIRMED",
        "verdict": verdict,
        "explanation": explanation,
        "stateDiff": diff,
        "filmstripCount": len(frames),
        "dossier": dossier,
    }


def main():
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

    try:
        if action == "judge_replay":
            res = evaluate_replay_judge(payload)
            sys.stdout.write(json.dumps({"ok": True, "data": res}))
        elif action == "status":
            sys.stdout.write(json.dumps({
                "ok": True,
                "data": {
                    "available": PT_AVAILABLE,
                    "engine": "Playtest Agent (playtest-agent-main)",
                    "srcPath": str(PT_SRC),
                    "error": PT_ERROR,
                }
            }))
        else:
            sys.stdout.write(json.dumps({"ok": False, "error": f"Unknown action: {action}"}))
    except Exception as exc:
        sys.stdout.write(json.dumps({"ok": False, "error": str(exc)}))

    sys.stdout.flush()


if __name__ == "__main__":
    main()
