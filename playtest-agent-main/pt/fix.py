"""Propose repairs to a baked game and prove each one on a separate copy."""
import hashlib
import json
from pathlib import Path

from game.build_buggy import hook_anchors, instrument
from metaclient.client import output_text, wonder_cost
from pt import regress, replay
from pt.fix_build import ROOT, copy_driver
from pt.fix_patch import apply_diff, apply_edits
from pt.fix_rules import hook_result


FORMAT = {"type": "json_schema", "name": "game_patch", "strict": True,
          "schema": {"type": "object", "properties": {
              "edits": {"type": "array", "items": {"type": "object", "properties": {
                  "search": {"type": "string"}, "replace": {"type": "string"}},
                  "required": ["search", "replace"], "additionalProperties": False}},
              "diff": {"type": "string"}, "why": {"type": "string"}},
              "required": ["edits", "diff", "why"], "additionalProperties": False}}
FIX_MAX_OUT = 16000
FIX_EFFORT = "low"


def _read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _write(path, value):
    Path(path).write_text(json.dumps(value, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


def _inputs(run, goal_run, max_tries):
    if type(max_tries) is not int or max_tries < 1:
        raise ValueError("max-tries must be a positive integer")
    old, goal = _read(run / "result.json"), _read(Path(goal_run) / "result.json")
    if old.get("kind") != "hunt" or old.get("game_id") != "cave-courier-buggy":
        raise ValueError("Fix needs a hunt on cave-courier-buggy")
    if old.get("bugs_on"):
        raise ValueError("Fix needs the baked build with no extra bug flags")
    if (goal.get("kind") != "goal" or goal.get("game_id") != "cave-courier"
            or goal.get("won") is not True or goal.get("bugs_on")):
        raise ValueError("goal-run must be a saved winning goal on clean cave-courier")
    for result in (old, goal):
        if not isinstance(result.get("actions_by_step"), list):
            raise ValueError("Run is missing saved actions")
    checked = _read(run / "confirm.json")
    selected = [(i, row) for i, row in enumerate(checked)
                if row.get("confirmed") is True and row.get("status") != "rejected"
                and row.get("reproducible") is not False]
    for _, row in selected:
        step = row.get("step")
        if type(step) is not int or not 0 <= step <= len(old["actions_by_step"]):
            raise ValueError("Confirmed report step is outside the saved action list")
    return old, goal, selected


def _proposal(client, source, report, failure, label):
    details = {k: report.get(k, "") for k in ("title", "expected", "actual", "step", "evidence")}
    prompt = (
        "Repair this game problem. Return search and replace edits and a one line why. "
        "Each search must be copied exactly from the original file: a few whole lines that occur once. "
        "Edits apply in order. The diff may be \"\" when edits is given; otherwise provide a unified diff "
        "against index-buggy-view.html with edits set to [].\n"
        "Change only index-buggy-view.html. Repair the behavior and preserve the rest of the game. "
        "Do not hide a symptom, disable "
        "the game, fake a win, or add a switch to turn off the baked bugs. "
        "The harness checks the reported symptom on new frames and replays a clean winning path.\n"
        "Confirmed report (actual is what the tester saw, evidence is the judge's quote):\n"
        + json.dumps(details, ensure_ascii=False) + "\nPrevious attempt failure: " + (failure or "None")
        + "\nOriginal index-buggy-view.html (use this original for every attempt):\n" + source)
    body = {"input": [{"role": "user", "content": [{"type": "input_text", "text": prompt}]}],
            "max_output_tokens": FIX_MAX_OUT, "reasoning": {"effort": FIX_EFFORT},
            "text": {"format": FORMAT}}
    # UTF-8 bytes bound the text token count. MetaClient reserves before sending.
    response = client.wonder(body, label=label,
                             reserve_usd=wonder_cost(len(prompt.encode("utf-8")) + 1000, FIX_MAX_OUT) + .005)
    return response


def _hooks(hits):
    return {str(k): v for k, v in hits.items()} if isinstance(hits, dict) else {}


def _verify(row, client, report, old, goal, goal_run, target, factory, trial, label):
    driver = lambda bugs="": factory(target, bugs=bugs)
    try:
        trace = replay.replay_trace(old["actions_by_step"], report["step"], "", driver_cls=driver)
    except Exception as exc:
        row["failure"] = "Patched replay failed: " + str(exc)[:1000]
        return
    replay.save_trace(trace, trial / "replay")
    # Keep model failures outside the driver exception handler. Its ledger owns failed calls.
    verdict = regress.judge(client, report, trace, label=label)
    (trial / "strip.jpg").write_bytes(verdict.pop("strip"))
    row.update({"bug_gone": verdict["verdict"] == "fixed", "quote": verdict["quote"],
                "judge": verdict["judge"], "state_change": verdict["state_change"]})
    row["cost_usd"] += verdict["cost_usd"]
    hits, active = _hooks(trace["bug_hits"]), row["baseline_hooks"]
    row["patched_hooks"] = hits
    row["cleared_hooks"] = [n for n in active if n not in row["unknown_hooks"] and hits.get(str(n)) is False]
    row["hooks_clear"] = bool(active) and row["cleared_hooks"] == active
    comparison = hook_result({n: True for n in active}, hits, verdict["verdict"])
    row.update({k: v for k, v in comparison.items() if k != "verdict"})
    before, after = set(active), set(row["hooks_after"])
    hooks_ok = bool(row["hooks_gone"]) and not row["hooks_not_measured"] and not after - before
    row["hook"] = "unknown" if row["unknown_hooks"] else not row["hooks_clear"]
    goal_error = ""
    try:
        states, won = regress._goal_trace(goal["actions_by_step"], "", driver)
    except Exception as exc:
        states, won, goal_error = [], False, str(exc)[:1000]
    row["goal_won"] = won
    _write(trial / "goal.json", {"run": str(goal_run), "won": won, "states": states, "error": goal_error})
    failures = []
    if not row["bug_gone"]:
        failures.append("report still there or no new quote: " + row["quote"])
    if not row["hooks_gone"]:
        failures.append("no hook went away")
    failures.extend(f"hook {n} not measured after the patch" for n in row["hooks_not_measured"])
    failures.extend(f"new hook {n} fired" for n in sorted(after - before))
    goal_ok = won or not row["goal_won_before"]
    if not goal_ok:
        failures.append("goal won before and lost after" + (": " + goal_error if goal_error else ""))
    row["failure"] = "; ".join(failures)
    row["proved"] = row["bug_gone"] and hooks_ok and goal_ok
    row["line_changed_judge_fixed"] = bool(
        row["hooks_not_measured"] and row["bug_gone"] and not after - before and goal_ok
        and all(n in row["unknown_hooks"] and hits.get(str(n)) is None
                for n in row["hooks_not_measured"]))


def fix_run(run_dir, client, goal_run, max_tries=3, source_path=None, driver_factory=None):
    """All model calls go through the client ledger; all patches stay in fixes/."""
    run = Path(run_dir)
    old, goal, selected = _inputs(run, goal_run, max_tries)
    source_path = Path(source_path) if source_path is not None else ROOT / "game" / "index-buggy-view.html"
    source = source_path.read_text(encoding="utf-8")
    factory = driver_factory or copy_driver
    folder = run / "fixes"
    folder.mkdir()  # A fresh folder avoids overwriting any earlier proof or linked path.
    (folder / "source.html").write_text(source, encoding="utf-8", newline="\n")
    baseline_path = folder / "baseline.html"
    baseline_path.write_text(instrument(source), encoding="utf-8", newline="\n")
    goal_states, goal_won_before = regress._goal_trace(
        goal["actions_by_step"], "", lambda bugs="": factory(baseline_path, bugs=bugs))
    _write(folder / "goal-before.json", {"won": goal_won_before, "states": goal_states})
    rows = []
    for index, report in selected:
        dest = folder / str(index)
        dest.mkdir()
        baseline = replay.replay_trace(old["actions_by_step"], report["step"], "",
                                       driver_cls=lambda bugs="": factory(baseline_path, bugs=bugs))
        replay.save_trace(baseline, dest / "baseline")
        active = sorted(int(k) for k, v in _hooks(baseline["bug_hits"]).items()
                        if k in {str(n) for n in range(1, 6)} and v is True)
        failure, cost, attempts = "", 0.0, []
        for attempt in range(1, max_tries + 1):
            trial = dest / "attempts" / str(attempt)
            trial.mkdir(parents=True)
            row = {"report_index": index, "title": report.get("title", ""), "step": report["step"],
                   "applied": False, "bug_gone": False, "quote": "", "goal_won": False,
                   "goal_won_before": goal_won_before,
                   "proved": False, "line_changed_judge_fixed": False,
                   "baseline_hooks": active, "cleared_hooks": [],
                   "unknown_hooks": [], "hook": "unknown",
                   "hooks_clear": False, "why": "", "failure": "", "cost_usd": 0.0}
            response = _proposal(client, source, report, failure, f"{run.name}:fix{index}:try{attempt}")
            row["cost_usd"] += response["_cost_usd"]
            diff = ""
            try:
                if response.get("status") == "incomplete":
                    usage = response.get("usage") or {}
                    details = usage.get("output_tokens_details") or {}
                    reasoning_tokens = details.get("reasoning_tokens", "unknown")
                    raise ValueError(f"out of output tokens ({reasoning_tokens} reasoning)")
                parsed = json.loads(output_text(response))
                if (response.get("status") == "incomplete" or not isinstance(parsed, dict)
                        or set(parsed) != {"edits", "diff", "why"} or not isinstance(parsed["diff"], str)
                        or not isinstance(parsed["edits"], list)
                        or not isinstance(parsed["why"], str) or not parsed["why"].strip()
                        or len(parsed["why"].splitlines()) != 1):
                    raise ValueError("Invalid structured patch response")
                diff, row["why"] = parsed["diff"], parsed["why"]
                if parsed["edits"]:
                    row["patch_format"] = "edits"
                    patched = apply_edits(source, parsed["edits"])
                elif diff:
                    row["patch_format"] = "diff"
                    patched = apply_diff(source, diff)
                else:
                    raise ValueError("no edits and no diff")
                served = instrument(patched)
                row["unknown_hooks"] = [n for n in active if n not in hook_anchors(patched)]
                row["applied"] = True
            except (ValueError, TypeError) as exc:
                row["failure"] = "Patch rejected: " + str(exc)
            (trial / "patch.diff").write_text(diff, encoding="utf-8", newline="\n")
            (dest / "patch.diff").write_text(diff, encoding="utf-8", newline="\n")
            if row.get("patch_format") == "edits":
                _write(trial / "edits.json", parsed["edits"])
                _write(dest / "edits.json", parsed["edits"])
            target = dest / "index.html"
            target.unlink(missing_ok=True)
            if row["applied"]:
                (trial / "index-buggy-view.html").write_text(patched, encoding="utf-8", newline="\n")
                target.write_text(served, encoding="utf-8", newline="\n")
                (trial / "index.html").write_text(served, encoding="utf-8", newline="\n")
                _verify(row, client, report, old, goal, goal_run, target, factory, trial,
                        f"{run.name}:fix{index}:verify{attempt}")
            cost += row["cost_usd"]
            _write(trial / "verdict.json", row)
            attempts.append({"try": attempt, "applied": row["applied"], "proved": row["proved"],
                             "failure": row["failure"], "cost_usd": row["cost_usd"],
                             "patch_format": row.get("patch_format")})
            row.update({"tries": attempt, "cost_usd": cost, "attempts": list(attempts)})
            _write(dest / "verdict.json", row)
            failure = row["failure"]
            if row["proved"]:
                break
        rows.append(row)
        handoff = dest / "needs_human.json"
        if row["proved"]:
            handoff.unlink(missing_ok=True)
        else:
            question = (f'The fix did not pass its checks after {row["tries"]} tries. '
                        "Please look at the bug and the attempts.")
            _write(handoff, {"report_index": index, "title": report.get("title", ""),
                             "tries": row["tries"], "failure": row["failure"], "question": question})
        result = _result(run, goal_run, source, selected, rows)
        _write(run / "fix.json", result)
    result = _result(run, goal_run, source, selected, rows)
    _write(run / "fix.json", result)
    return result


def _result(run, goal_run, source, selected, rows):
    needs_human = [r["report_index"] for r in rows if not r["proved"]]
    return {"run": str(run), "goal_run": str(goal_run), "build": "cave-courier-buggy",
            "source_sha256": hashlib.sha256(source.encode("utf-8")).hexdigest(),
            "fixed": sum(r["proved"] for r in rows), "total": len(selected), "reports": rows,
            "line_changed_judge_fixed": sum(r["line_changed_judge_fixed"] for r in rows),
            "cost_usd": sum(r["cost_usd"] for r in rows), "needs_human": needs_human}


def summary(result):
    return f'{result["fixed"]} of {result["total"]} fixed and proved'


def run_cli(args):
    from pt import guard, report
    from trials.common import load_client
    bad = guard.problems()
    if bad:
        print("BLOCKED, no browser started: " + "; ".join(bad))
        return 1
    _inputs(Path(args.folder), args.goal_run, args.max_tries)
    if (Path(args.folder) / "fixes").exists():
        raise ValueError("Choose a hunt run without existing fixes")
    guard.take_lock()
    try:
        result = fix_run(args.folder, load_client("playtest-agent"), args.goal_run, max_tries=args.max_tries)
        report.write(args.folder)
        print(summary(result))
        return 0
    finally:
        guard.release_lock()
