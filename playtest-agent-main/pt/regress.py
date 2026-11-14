"""Replay checked reports on a new build and gate its regression results."""
import base64
import json
import re
from pathlib import Path

from metaclient.client import output_text
from pt import judge as J
from pt import replay as R
from pt.fix_rules import hook_result

PROMPT = (
    "Check whether a previously confirmed game problem is STILL THERE or GONE on the NEW build.\n"
    "Old report title: {title}\nExpected: {expected}\nReported symptom: {actual}\n"
    "The filmstrip and state values below are ONLY from the NEW build, after replaying the old inputs. "
    "Read frames left to right, top to bottom. The last frame is the report step. "
    "Judge this specific symptom, even if a different problem appears. "
    "Quote concrete observations from the NEW frames or NEW state values that prove your answer. "
    "Do not use the old report as evidence. Missing samples do not prove a transient event never happened. "
    "If the result is unclear or there is no quote, answer STILL THERE.\n"
    "NEW state values, first frame -> last frame:\n{state}\n"
    'Reply with JSON only: {{"verdict":"STILL THERE or GONE","evidence":"quote from NEW frames or state"}}.'
)


def judge(client, report, trace, label):
    diff = J.state_diff(trace["states"][0], trace["states"][-1])
    prompt = PROMPT.format(title=report.get("title", ""), expected=report.get("expected", ""),
                           actual=report.get("actual", ""), state="\n".join(diff) or "Unavailable; use the NEW frames.")
    strip = J.filmstrip(J.pick_frames(trace["frames"], 12), tile_w=480)
    inp = [{"role": "user", "content": [{"type": "input_text", "text": prompt},
            {"type": "input_image", "image_url": "data:image/jpeg;base64," + base64.b64encode(strip).decode()}]}]
    cost, raw, fixed, quote = 0.0, "", False, ""
    for room in (6000, 15000):
        response = client.responses(inp, max_output_tokens=room, label=label,
                                    reserve_usd=.05 if room == 6000 else .12,
                                    extra={"reasoning": {"effort": getattr(client, "reasoning", "low")}, "temperature": 0})
        cost += response["_cost_usd"]
        raw = output_text(response)
        if response.get("status") == "incomplete":
            continue
        match = re.search(r"\{.*\}", raw or "", re.S)
        try:
            parsed = json.loads(match.group(0)) if match else {}
        except ValueError:
            parsed = {}
        if isinstance(parsed, dict):
            quote = parsed.get("evidence") or ""
            quote = quote.strip() if isinstance(quote, str) else ""
            fixed = str(parsed.get("verdict", "")).strip().upper() == "GONE" and len(quote) >= 8
        break
    return {"verdict": "fixed" if fixed else "still there", "quote": quote,
            "cost_usd": cost, "judge": raw[:400], "state_change": diff, "strip": strip}


def _goal_trace(actions, bugs, driver_cls):
    driver = driver_cls(bugs=bugs)
    try:
        states = [driver.state()]
        for acts in actions:
            driver.execute(acts)
            states.append(driver.state())
        return states, bool(driver.won())
    finally:
        driver.close()


def regress_run(old_run, client, bugs, output_dir, goal_run=None, driver_cls=None, last=12,
                baseline_driver_cls=None):
    """Use only checked reports; goal replay needs no model calls."""
    if driver_cls is None:
        from pw.driver import Driver as driver_cls
    old_run, output_dir = Path(old_run), Path(output_dir)
    old = json.loads((old_run / "result.json").read_text(encoding="utf-8"))
    checked = json.loads((old_run / "confirm.json").read_text(encoding="utf-8"))
    if output_dir.exists():
        raise ValueError("Choose a fresh regression output folder")
    selected = [(i, rep) for i, rep in enumerate(checked)
                if rep.get("confirmed") is True and rep.get("status") != "rejected"]
    for _, rep in selected:
        step = rep.get("step")
        if type(step) is not int or not 0 <= step <= len(old["actions_by_step"]):
            raise ValueError("Confirmed report step is outside the saved action list")
    prior = None
    if goal_run is not None:
        prior = json.loads((Path(goal_run) / "result.json").read_text(encoding="utf-8"))
        from pt.fix_build import same_game
        if prior.get("game_id") and old.get("game_id") and not same_game(prior["game_id"], old["game_id"]):
            raise ValueError("Goal run must use the same game as the old run")
    output_dir.mkdir(parents=True)
    rows = []
    for i, rep in selected:
        before = R.replay_trace(old["actions_by_step"], rep["step"], old.get("bugs_on", ""),
                                driver_cls=baseline_driver_cls or driver_cls, last=last)
        R.save_trace(before, output_dir / f"trace_{i}_before")
        try:
            trace = R.replay_trace(old["actions_by_step"], rep["step"], bugs,
                                   driver_cls=driver_cls, last=last)
        except Exception as exc:
            rows.append({"title": rep.get("title", ""), "step": rep["step"],
                         "verdict": "page broken", "error": str(exc)[:500],
                         "cost_usd": 0, "hooks_fired": None})
            continue
        R.save_trace(trace, output_dir / f"trace_{i}")
        verdict = judge(client, rep, trace, label=f"{output_dir.name}:regress{i}")
        (output_dir / f"regress_strip_{i}.jpg").write_bytes(verdict.pop("strip"))
        comparison = hook_result(before.get("bug_hits"), trace.get("bug_hits"), verdict["verdict"])
        old_states, new_states = before["states"][:-1], trace["states"][:-1]
        first = next((i for i, (a, b) in enumerate(zip(old_states, new_states))
                      if a is not None and b is not None and not J.states_equal(a, b, 2)), None)
        if first is None and len(before["states"]) != len(trace["states"]):
            first = min(len(old_states), len(new_states))
        if first is not None:
            comparison.update({"verdict": "path changed, not comparable", "first_different": first})
        rows.append({"title": rep.get("title", ""), "step": rep["step"], **verdict,
                     **comparison, "hooks_fired": comparison["hooks_after"]})
    goal = None
    if prior is not None:
        actions = prior["actions_by_step"]
        baseline, baseline_won = _goal_trace(actions, prior.get("bugs_on", ""),
                                           baseline_driver_cls or driver_cls)
        try:
            current, won = _goal_trace(actions, bugs, driver_cls)
        except Exception as exc:
            goal = {"run": str(goal_run), "old_won": bool(prior.get("won")),
                    "baseline_replay_won": baseline_won,
                    "baseline_source": "Replay of saved actions with old bug flags on the unpatched game source",
                    "won": False, "page_broken": True, "error": str(exc)[:500],
                    "new_breakage": baseline_won, "comparable": baseline_won,
                    "first_different_step": None, "old_states": baseline, "new_states": [],
                    "cost_usd": 0.0}
            if not baseline_won:
                goal["note"] = "not comparable: the saved goal does not win on the unpatched page"
        else:
            first = next((i for i, (a, b) in enumerate(zip(baseline, current)) if not J.states_equal(a, b)), None)
            goal = {"run": str(goal_run), "old_won": bool(prior.get("won")), "baseline_replay_won": baseline_won,
                    "baseline_source": "Replay of saved actions with old bug flags on the unpatched game source",
                    "won": won, "new_breakage": baseline_won and not won, "comparable": baseline_won,
                    "first_different_step": first, "old_states": baseline, "new_states": current, "cost_usd": 0.0}
            if not baseline_won:
                goal["note"] = "not comparable: the saved goal does not win on the unpatched page"
    result = {"old_run": str(old_run), "bugs_on": bugs, "reports": rows, "goal_replay": goal,
              "counts": {"fixed": sum(r["verdict"] == "fixed" for r in rows),
                         "still there": sum(r["verdict"] == "still there" for r in rows),
                         "not comparable": sum(r["verdict"] == "path changed, not comparable" for r in rows),
                         "new breakage": sum(r["verdict"] == "new breakage" for r in rows)
                                         + int(bool(goal and goal["new_breakage"])),
                         "page broken": sum(r["verdict"] == "page broken" for r in rows)
                                        + int(bool(goal and goal.get("page_broken")))},
              "cost_usd": sum(r["cost_usd"] for r in rows)}
    (output_dir / "regress.json").write_text(json.dumps(result, indent=1, ensure_ascii=False), encoding="utf-8")
    return result


def summary(result):
    c = result["counts"]
    return (f'{c["fixed"]} fixed, {c["still there"]} still there, {c["new breakage"]} new breakage, '
            f'{c.get("not comparable", 0)} not comparable, {c.get("page broken", 0)} page broken')


def gate(folder):
    try:
        result = json.loads((Path(folder) / "regress.json").read_text(encoding="utf-8"))
        counts = result["counts"]
        counts.setdefault("not comparable", 0)
        counts.setdefault("page broken", 0)
        if any(type(counts[key]) is not int or counts[key] < 0
               for key in ("fixed", "still there", "new breakage", "not comparable", "page broken")):
            raise ValueError("Invalid regression counts")
        blocked = any(counts[key] > 0 for key in ("still there", "new breakage", "not comparable", "page broken"))
        print(("FAIL: " if blocked else "PASS: ") + summary(result))
        return int(blocked)
    except (OSError, ValueError, KeyError, TypeError):
        print("FAIL: missing or invalid regress.json")
        return 1


def run_cli(args, root):
    from datetime import datetime, timezone
    from pt import guard
    from pt.adapter import make
    from trials.common import load_client
    from pt.cli import confirm_game

    if getattr(args, "build", None) and not getattr(args, "baseline_build", None):
        raise ValueError("--build requires --baseline-build with the unpatched HTML copy")
    old = json.loads((Path(args.folder) / "result.json").read_text(encoding="utf-8"))
    game = confirm_game(args)
    if old.get("game_id") and game != old["game_id"]:
        raise ValueError("Regression must use the same game as the old run")
    name = args.name or datetime.now(timezone.utc).strftime("regress-%Y%m%d-%H%M%S-%f")
    if Path(name).name != name or name in (".", ".."):
        raise ValueError("Name must be a folder name")
    output = root / "data" / "runs" / name
    factory = lambda bugs="": make(game, bugs=bugs)
    baseline_factory = None
    if getattr(args, "baseline_build", None):
        from pt.fix_build import regression_driver
        baseline_factory = regression_driver(game, args.baseline_build)
    if getattr(args, "build", None):
        from pt.fix_build import regression_driver
        factory = regression_driver(game, args.build)
    bad = guard.problems()
    if bad:
        print("BLOCKED, no browser started: " + "; ".join(bad))
        return 1
    guard.take_lock()
    try:
        result = regress_run(args.folder, load_client("playtest-agent"), args.bugs, output,
                             goal_run=args.goal_run, driver_cls=factory, baseline_driver_cls=baseline_factory)
        if getattr(args, "build", None):
            result["build"] = str(Path(args.build).resolve())
            result["baseline_build"] = str(Path(args.baseline_build).resolve())
            (output / "regress.json").write_text(json.dumps(result, indent=1, ensure_ascii=False), encoding="utf-8")
        print(summary(result))
        return 0
    finally:
        guard.release_lock()
