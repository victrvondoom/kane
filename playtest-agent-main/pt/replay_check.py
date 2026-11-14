"""Judge each fresh replay of a saved report independently."""
import copy
import json
from pathlib import Path

from metaclient.ledger import CapReached
from pt import judge as J
from pt import replay as R


def _save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")


def _selection(saved, report, times):
    if type(times) is not int or times < 2:
        raise ValueError("--times must be at least 2")
    reports = saved.get("reports", [])
    if report is not None and (type(report) is not int or not 0 <= report < len(reports)):
        raise ValueError("--report must be a saved report index (starting at 0)")
    selected = list(enumerate(reports)) if report is None else [(report, reports[report])]
    for _, rep in selected:
        step = rep.get("step")
        if type(step) is not int or not 0 <= step <= len(saved["actions_by_step"]):
            raise ValueError("Report step is outside the saved action list")
    return selected


def _factory(saved, client, output):
    from pt.adapter import config_path, load_config
    cfg = saved.get("game_config") or load_config(config_path(saved["game_id"]))
    _save(output / "config.json", cfg)

    def fresh(bugs=""):
        config = copy.deepcopy(cfg)
        if config["type"] == "pcgame":
            from pt.pcgame import PcGameAdapter
            return PcGameAdapter(config, sam_client=client)
        if config["type"] == "android":
            from pt.android import AndroidAdapter
            return AndroidAdapter(config, sam_client=client)
        if config["type"] == "doom":
            from pt.doom import DoomAdapter
            return DoomAdapter(config)
        from pt.adapter import WebAdapter
        return WebAdapter(config, bugs=bugs, sam_client=client)

    return fresh


def _trace(actions, bugs, driver_cls, folder, last=12):
    """Keep the report window and partial evidence even when an action fails."""
    trace = {"frames": [], "states": [], "bug_hits": None}
    executed = []
    driver = None
    try:
        driver = driver_cls(bugs=bugs)
        start = max(0, len(actions) - last)
        for i, acts in enumerate(actions):
            if any(isinstance(a, dict) and a.get("type") == "reload" for a in acts):
                start = max(start, i + 1)

        def capture():
            trace["frames"].append(driver.screenshot())
            trace["states"].append(driver.state() if hasattr(driver, "state") else None)

        for i, acts in enumerate(actions):
            if i == start:
                capture()
            executed.append(acts)
            driver.execute(acts)
            if i >= start:
                capture()
        if not trace["frames"]:
            capture()
        if hasattr(driver, "bug_hits"):
            trace["bug_hits"] = driver.bug_hits()
        return trace
    finally:
        try:
            if driver is not None:
                driver.close()
        finally:
            R.save_trace(trace, folder)
            _save(folder / "actions.json", executed)


def check_run(folder, client, driver_cls=None, report=None, times=2):
    """Return and save judge verdicts; state equality never establishes repeatability."""
    folder = Path(folder)
    saved = json.loads((folder / "result.json").read_text(encoding="utf-8"))
    selected = _selection(saved, report, times)
    output = folder / "replay-check"
    if output.exists():
        raise ValueError("Replay check already exists; preserve it before running again")
    output.mkdir()
    if driver_cls is None:
        driver_cls = _factory(saved, client, output)
    summary = {"game_id": saved["game_id"], "times": times, "reports": [], "cost_usd": 0.0}
    for index, rep in selected:
        row = {"index": index, "report": rep, "title": rep.get("title", ""), "step": rep["step"],
               "tries": [], "result": "replay failed", "cost_usd": 0.0}
        summary["reports"].append(row)
        actions = saved["actions_by_step"][:rep["step"]]
        for number in range(1, times + 1):
            target = output / f"report-{index}" / f"try-{number}"
            attempt = {"try": number, "verdict": None, "reason": "", "cost_usd": 0.0}
            ledger = getattr(client, "ledger", None)
            spent_before = None
            try:
                if ledger is not None:
                    spent_before = ledger.spent()
                trace = _trace(actions, saved.get("bugs_on", ""), driver_cls, target)
                diff = J.state_diff(trace["states"][0], trace["states"][-1])
                verdict = J.judge(client, rep, trace["frames"], diff,
                                  label=f"{folder.name}:replay-check:{index}:{number}")
                attempt.update(verdict="YES" if verdict["confirmed"] else "NO",
                               reason=verdict["evidence"], raw=verdict["raw"],
                               incomplete=verdict["incomplete"], cost_usd=verdict["cost_usd"])
                (target / "strip.jpg").write_bytes(verdict["strip"])
            except Exception as error:
                attempt["error"] = f"{type(error).__name__}: {error}"
                if isinstance(error, CapReached):
                    summary["stop"] = attempt["error"]
            if spent_before is not None:
                # Include sensor calls and reserves charged for failed judge calls.
                attempt["cost_usd"] = ledger.spent() - spent_before
            row["cost_usd"] += attempt["cost_usd"]
            summary["cost_usd"] += attempt["cost_usd"]
            row["tries"].append(attempt)
            _save(target / "verdict.json", attempt)
            _save(output / "summary.json", summary)
            if "error" in attempt:
                break
        if not any("error" in attempt for attempt in row["tries"]):
            yes = sum(attempt["verdict"] == "YES" for attempt in row["tries"])
            row["result"] = "repeatable" if yes == times else "seen once" if yes else "not repeated"
        _save(output / "summary.json", summary)
        if "stop" in summary:
            break
    _save(output / "summary.json", summary)
    return summary


def add_parser(sub):
    parser = sub.add_parser("replay-check", help="judge each report on separate fresh replays")
    parser.add_argument("folder")
    parser.add_argument("--report", type=int, default=None, help="saved report index (starting at 0)")
    parser.add_argument("--times", type=int, default=2)


def run_cli(args):
    from pt import guard
    from trials.common import load_client
    saved = json.loads((Path(args.folder) / "result.json").read_text(encoding="utf-8"))
    _selection(saved, args.report, args.times)
    bad = guard.problems()
    if bad:
        print("BLOCKED: " + "; ".join(bad))
        return 1
    guard.take_lock()
    try:
        summary = check_run(args.folder, load_client("playtest-agent"), report=args.report, times=args.times)
        for row in summary["reports"]:
            errors = [attempt["error"] for attempt in row["tries"] if "error" in attempt]
            print(f'Report {row["index"]}: {row["result"]} | {row["title"]}'
                  + (" | " + "; ".join(errors) if errors else ""))
        return int(any(row["result"] == "replay failed" for row in summary["reports"]))
    finally:
        guard.release_lock()
