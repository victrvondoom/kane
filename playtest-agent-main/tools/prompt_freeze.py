"""Hashes of the agent prompt and every player and judge setting, frozen until the holdout bench run.

python -m tools.prompt_freeze write   writes bench/holdout/PROMPT-FREEZE.json (the hashes, the date, the commit)
python -m tools.prompt_freeze check   exit 1 and names what changed
The check that runs on every suite: tests/test_prompt_freeze.py."""
import hashlib
import inspect
import json
import subprocess
import sys
import argparse
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FREEZE = ROOT / "bench" / "holdout" / "PROMPT-FREEZE.json"


def _h(value):
    text = value if isinstance(value, str) else json.dumps(value, sort_keys=True, default=str)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def snapshot():
    from pt import cli, judge, loop, replay, vision
    hunt = vars(cli.parse(["hunt", "x"]))
    hunt.pop("name")
    parts = {
        "loop.SYSTEM": loop.SYSTEM, "loop.RELOAD_NOTE": loop.RELOAD_NOTE, "loop.LOOK_PLAN": loop.LOOK_PLAN, "loop.NOTES": loop.NOTES,
        "loop.NUDGE": loop.NUDGE, "loop.TOOLS": loop.TOOLS, "loop.CHECKLIST_TOOLS": loop.CHECKLIST_TOOLS,
        "loop.ESCALATE_TOOL": loop.ESCALATE_TOOL, "loop.LOOK_PLAN_FIELDS": loop.LOOK_PLAN_FIELDS, "loop.NOTES_FIELD": loop.NOTES_FIELD,
        "loop.tools_for": inspect.getsource(loop.tools_for), "loop.run_episode": inspect.getsource(loop.run_episode),
        "cli.hunt_text": [cli.hunt_text(60, True), cli.hunt_text(60, False)], "cli.hunt_defaults": hunt,
        "cli.goal_defaults": {k: v for k, v in vars(cli.parse(["goal", "x"])).items() if k != "name"},
        "judge.PROMPT": judge.PROMPT, "judge.judge": inspect.getsource(judge.judge), "judge.parse_verdict": inspect.getsource(judge.parse_verdict),
        "judge.build_prompt": inspect.getsource(judge.build_prompt), "judge.pick_frames": inspect.getsource(judge.pick_frames),
        "replay.reproducible": inspect.getsource(replay.reproducible), "replay.replay_trace": inspect.getsource(replay.replay_trace),
        "vision.REPORT_NOTE": vision.REPORT_NOTE,
    }
    return {k: _h(v) for k, v in parts.items()}


def write(reason, path=FREEZE):
    path = Path(path)
    previous = json.loads(path.read_text(encoding="utf-8"))
    commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    history = list(previous.get("history", []))
    history.append({k: previous[k] for k in ("why", "written", "commit", "hashes") if k in previous} | {"replaced_because": reason})
    data = {"why": "Written after the holdout bench run. Each change to frozen code since then is listed in history.",
            "written": datetime.now(timezone.utc).isoformat(timespec="seconds"), "commit": commit,
            "hashes": snapshot(), "history": history}
    path.write_text(json.dumps(data, indent=1) + "\n", encoding="utf-8")
    return path


def main(argv):
    if argv[:1] == ["write"]:
        parser = argparse.ArgumentParser(prog="python -m tools.prompt_freeze write")
        parser.add_argument("--reason", required=True)
        args = parser.parse_args(argv[1:])
        print(write(args.reason))
        return 0
    frozen = json.loads(FREEZE.read_text(encoding="utf-8"))["hashes"]
    now = snapshot()
    changed = sorted(k for k in set(frozen) | set(now) if frozen.get(k) != now.get(k))
    print("FROZEN, changed: " + ", ".join(changed) if changed else "OK: the prompt and settings match the freeze")
    return 1 if changed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
