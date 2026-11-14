"""Replay a saved winning goal on the clean game with each saved fix applied."""
import hashlib
import json
from pathlib import Path

from pt import judge as J
from pt import regress
from pt.fix_build import ROOT, copy_driver
from pt.fix_patch import apply_diff, apply_edits


NOTE = "Goal replay on the clean game with each saved patch applied. No model calls."


def _attempts(fix_run):
    fixes = Path(fix_run) / "fixes"
    for report_dir in sorted((path for path in fixes.iterdir() if path.is_dir()), key=lambda p: p.name):
        attempts = report_dir / "attempts"
        if attempts.is_dir():
            for attempt in sorted((path for path in attempts.iterdir() if path.is_dir()), key=lambda p: p.name):
                yield report_dir.name, attempt


def _replay(actions, bugs, driver_factory, page):
    return regress._goal_trace(actions, bugs, lambda bugs="": driver_factory(page, bugs=bugs))


def check(fix_run, goal_run, out_dir, driver_factory=None, clean_source=ROOT / "game" / "index.html"):
    fix_run, goal_run, out_dir, clean_source = map(Path, (fix_run, goal_run, out_dir, clean_source))
    goal = json.loads((goal_run / "result.json").read_text(encoding="utf-8"))
    if goal.get("won") is not True:
        raise ValueError("Goal run must have won")
    if goal.get("game_id") != "cave-courier":
        raise ValueError("Goal run must use cave-courier")
    if out_dir.exists():
        raise ValueError("Choose a fresh goal-clean output folder")
    source = clean_source.read_text(encoding="utf-8")
    driver_factory = driver_factory or (lambda path, bugs="": copy_driver(path, bugs=bugs))
    out_dir.mkdir(parents=True)
    control = out_dir / "control" / "index.html"
    control.parent.mkdir(parents=True)
    control.write_text(source, encoding="utf-8", newline="\n")
    actions, bugs = goal.get("actions_by_step", []), goal.get("bugs_on", "")
    control_states, control_won = _replay(actions, bugs, driver_factory, control)
    rows = []
    for report, attempt in _attempts(fix_run):
        edits_path, diff_path = attempt / "edits.json", attempt / "patch.diff"
        edits = json.loads(edits_path.read_text(encoding="utf-8")) if edits_path.is_file() else []
        diff = diff_path.read_text(encoding="utf-8") if diff_path.is_file() else ""
        patch_format = "edits" if isinstance(edits, list) and edits else "diff" if diff else "none"
        row = {"report": report, "try": attempt.name, "patch_format": patch_format, "verdict": "not comparable"}
        if not control_won:
            row["reason"] = "the goal does not win on the clean game"
        else:
            try:
                patched = apply_edits(source, edits) if patch_format == "edits" else apply_diff(source, diff)
            except ValueError as exc:
                row["reason"] = "patch text not in the clean source: " + str(exc)
            else:
                page = out_dir / f"{report}-{attempt.name}" / "index.html"
                page.parent.mkdir(parents=True)
                page.write_text(patched, encoding="utf-8", newline="\n")
                try:
                    states, won = _replay(actions, bugs, driver_factory, page)
                    if won:
                        row["verdict"] = "kept the win"
                    else:
                        row["verdict"] = "breakage"
                        row["first_different_step"] = next(
                            (i for i, (a, b) in enumerate(zip(control_states, states))
                             if not J.states_equal(a, b, 2)), None)
                except Exception as exc:
                    row["verdict"] = "page broken"
                    row["error"] = str(exc)[:500]
        rows.append(row)
    verdicts = ("kept the win", "breakage", "not comparable", "page broken")
    result = {"fix_run": str(fix_run), "goal_run": str(goal_run),
              "clean_source_sha256": hashlib.sha256(source.encode("utf-8")).hexdigest(),
              "control_won": control_won, "rows": rows,
              "counts": {verdict: sum(row["verdict"] == verdict for row in rows) for verdict in verdicts},
              "cost_usd": 0, "note": NOTE}
    (out_dir / "goal-clean.json").write_text(json.dumps(result, indent=1, ensure_ascii=False), encoding="utf-8")
    return result


def add_parser(sub):
    parser = sub.add_parser("goal-clean", help="check saved fixes against a winning goal on the clean game")
    parser.add_argument("run")
    parser.add_argument("--goal-run", required=True)
    parser.add_argument("--name", required=True)


def run_cli(args, root):
    from pt import guard

    if Path(args.name).name != args.name or args.name in (".", ".."):
        raise ValueError("Name must be a folder name")
    output = Path(root) / "data" / "runs" / args.name
    if output.exists():
        raise ValueError("Choose a fresh goal-clean output folder")
    bad = guard.problems()
    if bad:
        print("BLOCKED, no browser started: " + "; ".join(bad))
        return 1
    guard.take_lock()
    try:
        result = check(args.run, args.goal_run, output)
        for verdict, count in result["counts"].items():
            print(f"{count} {verdict}")
        return 0
    finally:
        guard.release_lock()
