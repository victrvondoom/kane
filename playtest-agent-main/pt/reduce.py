"""Find a shorter replay that preserves the report's deterministic hooks."""
import json
from pathlib import Path

from pt import judge as J
from pt import replay as R
from pt import yes_no


NO_SYMPTOM = "No deterministic symptom for this report: no hook fired"
LAST_RULE = "last hook to fire before the report step"


def _prefix(actions_by_step, upto):
    if type(upto) is not int or not 0 <= upto <= len(actions_by_step):
        raise ValueError("Report step is outside the saved action list")
    return actions_by_step[:upto]


def _hits(driver):
    read = getattr(driver, "bug_hits", None)
    hits = read() if callable(read) else None
    return {int(k): v for k, v in hits.items()} if isinstance(hits, dict) else {}


def hook_steps(actions_by_step, upto, bugs, driver_cls):
    """Map hooks to the zero based action index where they first become True."""
    steps = _prefix(actions_by_step, upto)
    driver = driver_cls(bugs=bugs)
    fired = {}
    try:
        for i, acts in enumerate(steps):
            driver.execute(acts)
            for hook, value in _hits(driver).items():
                if value is True:
                    fired.setdefault(hook, i)
    finally:
        driver.close()
    if not fired:
        raise ValueError(NO_SYMPTOM)
    return fired


def holds(steps, bugs, driver_cls, target):
    """Check all target hooks at the end of one fresh replay."""
    driver = driver_cls(bugs=bugs)
    try:
        R.restore(driver, steps, len(steps))
        hits = _hits(driver)
        return all(hits.get(hook) is True for hook in target)
    finally:
        driver.close()


def reduce(actions_by_step, upto, bugs, driver_cls, target, max_replays=40):
    """Remove chunks of action indexes, caching checks within the search budget."""
    actions = _prefix(actions_by_step, upto)
    if type(max_replays) is not int or max_replays < 0:
        raise ValueError("Replay budget must be zero or greater")
    if not target:
        raise ValueError("At least one target hook is required")
    kept = tuple(range(upto))
    cache, replays, budget_hit = {}, 0, False
    parts = min(2, len(kept))
    while kept:
        removed = False
        for part in range(parts):
            start, stop = part * len(kept) // parts, (part + 1) * len(kept) // parts
            candidate = kept[:start] + kept[stop:]
            if candidate not in cache:
                if replays >= max_replays:
                    budget_hit = True
                    break
                cache[candidate] = holds([actions[i] for i in candidate], bugs, driver_cls, target)
                replays += 1
            if cache[candidate]:
                kept = candidate
                parts = min(len(kept), max(2, parts - 1))
                removed = True
                break
        if budget_hit:
            break
        if removed:
            continue
        if parts == len(kept):
            break
        parts = min(len(kept), parts * 2)
    return {"kept": list(kept), "replays": replays, "budget_hit": budget_hit}


def _reports(old, checked, reports):
    eligible = {i: rep for i, rep in enumerate(checked)
                if rep.get("confirmed") is True and rep.get("status") != "rejected"}
    indexes = list(eligible) if reports is None else list(dict.fromkeys(reports))
    if any(i not in eligible for i in indexes):
        raise ValueError("Select only confirmed reports that were not rejected")
    selected = [(i, eligible[i]) for i in indexes]
    for _, rep in selected:
        _prefix(old["actions_by_step"], rep.get("step"))
    return selected


def reduce_run(run, output_dir, driver_cls, reports=None, hook=None, max_replays=40, client=None):
    """Reduce confirmed reports and save independent verification and replay evidence."""
    run, output_dir = Path(run), Path(output_dir)
    if output_dir.exists():
        raise ValueError("Choose a fresh reduction output folder")
    if type(max_replays) is not int or max_replays < 0:
        raise ValueError("Replay budget must be zero or greater")
    old = json.loads((run / "result.json").read_text(encoding="utf-8"))
    checked = json.loads((run / "confirm.json").read_text(encoding="utf-8"))
    selected = _reports(old, checked, reports)
    output_dir.mkdir(parents=True)
    bugs, actions, rows = old["bugs_on"], old["actions_by_step"], []
    for i, report in selected:
        step = report["step"]
        fired = hook_steps(actions, step, bugs, driver_cls)
        if hook is not None:
            if hook not in fired:
                raise ValueError(f"Target hook {hook} did not fire before the report step")
            target, rule = [hook], "given"
        else:
            latest = max(fired.values())
            target, rule = sorted(h for h, first in fired.items() if first == latest), LAST_RULE
        search = reduce(actions, step, bugs, driver_cls, target, max_replays)
        kept_actions = [actions[n] for n in search["kept"]]
        first_check = holds(kept_actions, bugs, driver_cls, target)
        second_check = holds(kept_actions, bugs, driver_cls, target)
        trace = R.replay_trace(kept_actions, len(kept_actions), bugs, driver_cls, last=12)
        R.save_trace(trace, output_dir / f"trace_{i}")
        strip = J.filmstrip(J.pick_frames(trace["frames"], 12), tile_w=480)
        (output_dir / f"reduce_strip_{i}.jpg").write_bytes(strip)
        judge = None
        if client is not None:
            judge = yes_no.ask(client, report, trace["frames"][0], trace["frames"][-1],
                               label=f"{output_dir.name}:reduce{i}")
        rows.append({"index": i, "title": report.get("title", ""), "step": step,
                     "original_steps": step, "reduced_steps": len(kept_actions), **search,
                     "budget": max_replays, "target_hooks": target, "target_rule": rule,
                     "verified": first_check and second_check, "judge": judge,
                     "actions_by_step": kept_actions})
    result = {"run": str(run), "game_id": old["game_id"], "bugs_on": bugs, "reports": rows,
              "cost_usd": sum(row["judge"]["cost_usd"] for row in rows if row["judge"]),
              "note": "smallest found within the replay budget; not proven minimal"}
    (output_dir / "reduce.json").write_text(json.dumps(result, indent=1, ensure_ascii=False), encoding="utf-8")
    return result


def add_parser(sub):
    parser = sub.add_parser("reduce", help="find a shorter replay of confirmed reports")
    parser.add_argument("folder")
    parser.add_argument("--report", type=int, nargs="+", action="extend", default=None)
    parser.add_argument("--hook", type=int, default=None)
    parser.add_argument("--max-replays", type=int, default=40)
    parser.add_argument("--judge", action="store_true")
    parser.add_argument("--name", required=True)


def run_cli(args, root):
    from pt import guard
    from pt.adapter import make

    if Path(args.name).name != args.name or args.name in (".", ".."):
        raise ValueError("Name must be a folder name")
    output = Path(root) / "data" / "runs" / args.name
    if output.exists():
        raise ValueError("Choose a fresh reduction output folder")
    if args.max_replays < 0:
        raise ValueError("Replay budget must be zero or greater")
    old = json.loads((Path(args.folder) / "result.json").read_text(encoding="utf-8"))
    checked = json.loads((Path(args.folder) / "confirm.json").read_text(encoding="utf-8"))
    _reports(old, checked, args.report)
    bad = guard.problems()
    if bad:
        print("BLOCKED, no browser started: " + "; ".join(bad))
        return 1
    guard.take_lock()
    try:
        client = None
        if args.judge:
            from trials.common import load_client
            client = load_client("playtest-agent")
        result = reduce_run(args.folder, output,
                            driver_cls=lambda bugs="": make(old["game_id"], bugs=bugs),
                            reports=args.report, hook=args.hook, max_replays=args.max_replays, client=client)
        for row in result["reports"]:
            print(f'Report {row["index"]}: {row["original_steps"]} -> {row["reduced_steps"]} steps; '
                  f'smallest found in {row["replays"]} replays; verified={row["verified"]}')
        return 0
    finally:
        guard.release_lock()
