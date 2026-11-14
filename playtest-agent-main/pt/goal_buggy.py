"""Replay a saved goal on patched buggy pages with other planted bugs repaired."""
import argparse
import hashlib
import json
from pathlib import Path

from pt import judge as J
from pt.fix_build import ROOT, copy_driver
from pt.fix_patch import apply_diff, apply_edits
from pt.goal_clean import _attempts, _replay


HAND_FIXES = ROOT / "game" / "hand_fixes.json"
NOTE = "Goal replay on the buggy view with hand fixes for other planted bugs. No model calls."


def _hand_fix(source, fixes, target=None):
    for bug in range(1, 6):
        if bug == target:
            continue
        try:
            source = apply_edits(source, fixes[str(bug)])
        except ValueError as exc:
            raise ValueError(f"hand fix {bug} does not apply: {exc}") from exc
    return source


def check(fix_run, goal_run, out_dir, targets, driver_factory=None,
          view=ROOT / "game" / "index-buggy-view.html", targets_source=None):
    fix_run, goal_run, out_dir, view = map(Path, (fix_run, goal_run, out_dir, view))
    goal = json.loads((goal_run / "result.json").read_text(encoding="utf-8"))
    if goal.get("won") is not True:
        raise ValueError("Goal run must have won")
    if goal.get("game_id") != "cave-courier":
        raise ValueError("Goal run must use cave-courier")
    if out_dir.exists():
        raise ValueError("Choose a fresh goal-buggy output folder")
    if not isinstance(targets, dict) or any(
            not isinstance(report, str) or not report or type(bug) is not int or bug not in range(1, 6)
            for report, bug in targets.items()):
        raise ValueError("Targets must map report folder names to bug numbers 1 to 5")
    source_bytes, hand_bytes = view.read_bytes(), HAND_FIXES.read_bytes()
    source = source_bytes.decode("utf-8").replace("\r\n", "\n")
    fixes = json.loads(hand_bytes.decode("utf-8"))["fixes"]
    control_source = _hand_fix(source, fixes)
    driver_factory = driver_factory or (lambda path, bugs="": copy_driver(path, bugs=bugs))
    out_dir.mkdir(parents=True)
    control = out_dir / "control" / "index.html"
    control.parent.mkdir()
    control.write_text(control_source, encoding="utf-8", newline="\n")
    actions, bugs = goal.get("actions_by_step", []), goal.get("bugs_on", "")
    control_error = None
    try:
        control_states, control_won = _replay(actions, bugs, driver_factory, control)
    except Exception as exc:
        control_states, control_won = [], False
        control_error = str(exc)[:500]
    rows = []
    for report, attempt in _attempts(fix_run):
        edits_path, diff_path = attempt / "edits.json", attempt / "patch.diff"
        row = {"report": report, "try": attempt.name, "patch_format": "none", "verdict": "not comparable"}
        try:
            edits = json.loads(edits_path.read_text(encoding="utf-8")) if edits_path.is_file() else []
            diff = diff_path.read_text(encoding="utf-8") if diff_path.is_file() else ""
            row["patch_format"] = "edits" if isinstance(edits, list) and edits else "diff" if diff else "none"
        except (ValueError, OSError) as exc:
            row["reason"] = "cannot read saved patch: " + str(exc)
        if not control_won:
            row["reason"] = "control with all hand fixes does not win"
        elif report not in targets:
            row["reason"] = "no planted bug target for report " + report
        elif "reason" not in row:
            try:
                patched = apply_edits(source, edits) if row["patch_format"] == "edits" else apply_diff(source, diff)
            except ValueError as exc:
                row["reason"] = "patch text not in the buggy view: " + str(exc)
            else:
                try:
                    patched = _hand_fix(patched, fixes, targets[report])
                except ValueError as exc:
                    row["reason"] = str(exc)
                else:
                    page = out_dir / f"{report}-{attempt.name}" / "index.html"
                    page.parent.mkdir(parents=True)
                    page.write_text(patched, encoding="utf-8", newline="\n")
                    try:
                        states, won = _replay(actions, bugs, driver_factory, page)
                        row["verdict"] = "kept the win" if won else "breakage"
                        if not won:
                            row["first_different_step"] = next(
                                (i for i, (a, b) in enumerate(zip(control_states, states))
                                 if not J.states_equal(a, b, 2)), None)
                    except Exception as exc:
                        row["verdict"] = "page broken"
                        row["error"] = str(exc)[:500]
        rows.append(row)
    verdicts = ("kept the win", "breakage", "not comparable", "page broken")
    result = {"fix_run": str(fix_run), "goal_run": str(goal_run), "targets": targets,
              "targets_source": str(targets_source) if targets_source is not None else None,
              "view_sha256": hashlib.sha256(source_bytes).hexdigest(),
              "hand_fixes_sha256": hashlib.sha256(hand_bytes).hexdigest(),
              "control_won": control_won, "rows": rows,
              "counts": {verdict: sum(row["verdict"] == verdict for row in rows) for verdict in verdicts},
              "cost_usd": 0, "note": NOTE}
    if control_error is not None:
        result["control_error"] = control_error
    (out_dir / "goal-buggy.json").write_text(json.dumps(result, indent=1, ensure_ascii=False), encoding="utf-8")
    return result


def _targets(text):
    result = {}
    try:
        for pair in text.split(","):
            report, number = (part.strip() for part in pair.split("="))
            bug = int(number)
            if not report or report in result or bug not in range(1, 6):
                raise ValueError
            result[report] = bug
    except ValueError as exc:
        raise argparse.ArgumentTypeError("Targets must look like 0=1,1=5 with bug numbers 1 to 5") from exc
    return result


def add_parser(sub):
    parser = sub.add_parser("goal-buggy", help="check saved fixes on the buggy view with other bugs repaired")
    parser.add_argument("run")
    parser.add_argument("--goal-run", required=True)
    parser.add_argument("--targets", required=True, type=_targets)
    parser.add_argument("--targets-source", required=True)
    parser.add_argument("--name", required=True)


def run_cli(args, root):
    from pt import guard

    if Path(args.name).name != args.name or args.name in (".", ".."):
        raise ValueError("Name must be a folder name")
    output = Path(root) / "data" / "runs" / args.name
    if output.exists():
        raise ValueError("Choose a fresh goal-buggy output folder")
    bad = guard.problems()
    if bad:
        print("BLOCKED, no browser started: " + "; ".join(bad))
        return 1
    guard.take_lock()
    try:
        result = check(args.run, args.goal_run, output, args.targets, targets_source=args.targets_source)
        for verdict, count in result["counts"].items():
            print(f"{count} {verdict}")
        return 0
    finally:
        guard.release_lock()
