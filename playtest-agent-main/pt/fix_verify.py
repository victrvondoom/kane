"""Recheck a saved patch against current hooks without proposing a new patch."""
import hashlib
from pathlib import Path

from game.build_buggy import hook_anchors, instrument
from pt import fix, regress, replay
from pt.fix_build import ROOT, copy_driver


def _write(path, value):
    fix._write(path, value)


def verify_run(run_dir, goal_run, report_index, try_number, name, note="", dry=False,
               client=None, source_path=None, driver_factory=None):
    run = Path(run_dir)
    old, goal, selected = fix._inputs(run, goal_run, 1)
    reports = dict(selected)
    if report_index not in reports:
        raise ValueError(f"Report {report_index} is not a selected report")
    attempt = run / "fixes" / str(report_index) / "attempts" / str(try_number)
    patched_path = attempt / "index-buggy-view.html"
    if not patched_path.is_file():
        raise ValueError(f"Saved patched page is missing: {patched_path}")
    source_path = Path(source_path) if source_path is not None else run / "fixes" / "source.html"
    if not source_path.is_file():
        raise ValueError(f"Original page is missing: {source_path}")
    out = run / "fix-verify" / name
    if out.exists():
        raise ValueError(f"Output folder already exists: {out}")
    out.mkdir(parents=True)
    source, patched = source_path.read_text(encoding="utf-8"), patched_path.read_text(encoding="utf-8")
    baseline_path = out / "baseline.html"
    baseline_path.write_text(instrument(source), encoding="utf-8", newline="\n")
    factory = driver_factory or copy_driver
    _, goal_won_before = regress._goal_trace(
        goal["actions_by_step"], "", lambda bugs="": factory(baseline_path, bugs=bugs))
    report = reports[report_index]
    baseline = replay.replay_trace(old["actions_by_step"], report["step"], "",
                                   driver_cls=lambda bugs="": factory(baseline_path, bugs=bugs))
    replay.save_trace(baseline, out / "baseline")
    active = sorted(int(k) for k, v in fix._hooks(baseline["bug_hits"]).items()
                    if k in {str(n) for n in range(1, 6)} and v is True)
    served = instrument(patched)
    target = out / "index.html"
    target.write_text(served, encoding="utf-8", newline="\n")
    unknown = [n for n in active if n not in hook_anchors(patched)]
    row = {"report_index": report_index, "title": report.get("title", ""), "step": report["step"],
           "applied": True, "bug_gone": False, "quote": "", "goal_won": False,
           "goal_won_before": goal_won_before, "proved": False, "line_changed_judge_fixed": False,
           "baseline_hooks": active, "cleared_hooks": [], "unknown_hooks": unknown,
           "hook": "unknown" if unknown else "", "hooks_clear": False, "why": "",
           "failure": "", "cost_usd": 0.0, "source_patch": str(attempt),
           "patch_sha256": hashlib.sha256(patched.encode("utf-8")).hexdigest(),
           "new_patch_written": False, "note": note or ""}
    if dry:
        error = ""
        try:
            trace = replay.replay_trace(old["actions_by_step"], report["step"], "",
                                        driver_cls=lambda bugs="": factory(target, bugs=bugs))
            replay.save_trace(trace, out / "replay")
            replay_ok = True
            patched_hooks = fix._hooks(trace["bug_hits"])
        except Exception as exc:
            replay_ok, patched_hooks, error = False, {}, str(exc)[:1000]
        _write(out / "dry.json", {"replay_ok": replay_ok, "error": error,
                                    "patched_hooks": patched_hooks, "baseline_hooks": active,
                                    "unknown_hooks": unknown})
        return {"row": row, "exit_code": 0 if replay_ok else 1}
    if client is None:
        raise ValueError("A client is required unless --dry is used")
    fix._verify(row, client, report, old, goal, goal_run, target, factory, out,
                f"{run.name}:fixverify{report_index}:try{try_number}")
    _write(out / "verdict.json", row)
    print(" ".join(f"{key}={row.get(key, '')}" for key in
                    ("proved", "bug_gone", "hooks_gone", "hooks_not_measured",
                     "line_changed_judge_fixed", "failure", "cost_usd")))
    return {"row": row, "exit_code": 0}


def run_cli(args):
    from pt import guard
    from trials.common import load_client
    bad = guard.problems()
    if bad:
        print("BLOCKED, no browser started: " + "; ".join(bad))
        return 1
    guard.take_lock()
    try:
        client = None if args.dry else load_client("playtest-agent")
        result = verify_run(args.folder, args.goal_run, args.report, args.try_number, args.name,
                            note=args.note or "", dry=args.dry, client=client)
        return result["exit_code"]
    finally:
        guard.release_lock()
