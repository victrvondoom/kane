"""Compare saved Spark judge cases with Spark Open through Fireworks."""
import argparse
import base64
import json
import re
import sys
import time

from metaclient.client import output_text
from metaclient.fireworks import MODEL, FireworksClient, FireworksLedger, FireworksStop, key_available, read_key
from metaclient.ledger import CapReached
from pt import judge as J
from trials import judge_compare
from trials.common import ROOT, save_json

# docs/receipts/judge-eval.json: true8 are positives; neg8 and false6 are negatives.
EVAL_TRUTH = {"true8": True, "neg8": False, "false6": False}
# docs/CHESS-RUN-2026-10-30.md: reports 0 through 7 replayed YES, YES and were fixed; the saved actions did not lead to report 8, so its replay shows no symptom.
CHESS_TRUTH = {i: i < 8 for i in range(9)}
# docs/STS2-RUN-2026-10-30.md: g-3 is positive; the two decoy runs are negative.
STS2_TRUTH = {"sts2-room-g-3": True, "sts2-room-g-decoy-1b": False, "sts2-room-g-decoy2-1": False}
# docs/RESULTS.md, holdout rows and the reanalysis row: ho1 reports 0, 1 and 3 found and confirmed; report 4 reported but not confirmed; report 2 and ho1-clean report 0 are false reports.
HOLDOUT_TRUTH = {"ho1": {0: True, 1: True, 2: False, 3: True, 4: True}, "ho1-clean": {0: False}}


def _read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def _case(group, ident, report, diff, strip, spark, truth):
    report = {k: report.get(k, "") for k in ("title", "expected", "actual")}
    return {"set": group, "id": ident, "title": report["title"], "report": report,
            "diff": diff, "strip": strip, "spark": bool(spark), "truth": bool(truth)}


def load_cases(root=ROOT, groups=None):
    cases = []
    if groups is None or groups & EVAL_TRUTH.keys():
        rows = _read(root / "docs/receipts/judge-eval.json")["rows"]
        rows = [row for row in rows if groups is None or row["set"] in groups]
        for row, report, trace in judge_compare._inputs(rows, root=root):
            cases.append(_case(row["set"], row["id"], report, J.state_diff(trace["states"][0], trace["states"][-1]),
                               J.filmstrip(J.pick_frames(trace["frames"], 12), tile_w=480), row["judge_yes"], EVAL_TRUTH[row["set"]]))
    if groups is None or "chess" in groups:
        chess = root / "data/runs/pc2-react-chess/replay-check"
        for row in _read(chess / "summary.json")["reports"]:
            index = row["index"]
            for attempt in row["tries"]:
                number = attempt["try"]
                folder = chess / f"report-{index}/try-{number}"
                states = _read(folder / "meta.json")["states"]
                cases.append(_case("chess", f"r{index}:t{number}", row["report"], J.state_diff(states[0], states[-1]),
                                   (folder / "strip.jpg").read_bytes(), attempt["verdict"] == "YES", CHESS_TRUTH[index]))
    for group, rules in (("sts2", STS2_TRUTH), ("holdout", HOLDOUT_TRUTH)):
        if groups is not None and group not in groups:
            continue
        for run, truth in rules.items():
            folder = root / "data/runs" / run
            for i, row in enumerate(_read(folder / "confirm.json")):
                cases.append(_case(group, f"{run}:{i}", row, row["state_change"], (folder / f"strip_{i}.jpg").read_bytes(),
                                   row["confirmed"], truth[i] if isinstance(truth, dict) else truth))
    return cases


def ask(client, case, max_tokens=6000):
    inp = [{"role": "user", "content": [
        {"type": "input_text", "text": J.build_prompt(case["report"], case["diff"])},
        {"type": "input_image", "image_url": "data:image/jpeg;base64," + base64.b64encode(case["strip"]).decode()}]}]
    cost, prompt_tokens, completion_tokens = 0.0, 0, 0
    for room in (max_tokens, 15000):
        response = client.responses(inp, max_output_tokens=room, label=f"{case['set']}:{case['id']}",
                                    extra={"reasoning": {"effort": client.reasoning}, "temperature": 0})
        cost += response["_cost_usd"]
        usage = response["usage"]
        prompt_tokens += usage.get("prompt_tokens", 0)
        completion_tokens += usage.get("completion_tokens", 0)
        text = output_text(response)
        incomplete = response.get("status") == "incomplete"
        if not incomplete:
            break
    ok, evidence = (False, "") if incomplete else J.parse_verdict(text)
    return {"confirmed": ok, "evidence": evidence, "raw": text[:400], "incomplete": incomplete,
            "cost_usd": cost, "prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens}


def _summary(rows):
    def stats(items):
        return {"total": len(items), **{key: sum(r[key] for r in items) for key in ("agree", "open_right", "spark_right", "incomplete")},
                "misses": sum(r["truth"] and not r["open"] for r in items),
                "false_alarms": sum(not r["truth"] and r["open"] for r in items),
                "cost_usd": sum(r["cost_usd"] for r in items),
                "mean_seconds": sum(r["seconds"] for r in items) / len(items) if items else 0}
    return {**{group: stats([r for r in rows if r["set"] == group]) for group in dict.fromkeys(r["set"] for r in rows)},
            "all": stats(rows)}


def _print(receipt):
    print("set | id | title | Spark | Open | truth")
    for row in receipt["rows"]:
        print(" | ".join([row["set"], row["id"], row["title"], *["YES" if row[k] else "NO" for k in ("spark", "open", "truth")]]))
    print(json.dumps(receipt["summary"], indent=1))


def main(argv=None):
    from pt.env import load_local_env
    load_local_env()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--effort", choices=("low", "medium", "high"), default="low")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--sets")
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", args.tag):
        parser.error("tag must be a short name using letters, digits, underscores or hyphens")
    if args.limit is not None and args.limit < 0:
        parser.error("limit must be nonnegative")
    groups = set(args.sets.split(",")) if args.sets else None
    if groups and groups - {*EVAL_TRUTH, "chess", "sts2", "holdout"}:
        parser.error("unknown set")
    if args.limit != 0 and not key_available():
        print("Muse Spark Open needs your own Fireworks key. Set FIREWORKS_API_KEY. Nothing was spent.", file=sys.stderr)
        return 2
    path = ROOT / f"docs/receipts/spark-open-judge-{args.tag}.json"
    receipt = _read(path) if path.exists() else {"model": MODEL, "effort": args.effort, "temperature": 0, "rows": [], "stop": None}
    if receipt["model"] != MODEL or receipt["effort"] != args.effort or receipt["temperature"] != 0:
        parser.error("receipt settings differ; use a new tag")
    done = {(r["set"], r["id"]) for r in receipt["rows"]}
    try:
        cases = [c for c in load_cases(ROOT, groups) if (c["set"], c["id"]) not in done]
    except FileNotFoundError as exc:
        print(f"Missing {exc.filename or exc}: unzip the release's run zips into data/runs/.", file=sys.stderr)
        return 2
    if args.limit is not None:
        cases = cases[:args.limit]
    ledger = FireworksLedger()
    client = FireworksClient(read_key(), ledger) if cases else None
    if client is not None:
        client.reasoning = args.effort
        ledger = client.ledger

    def save():
        receipt["summary"] = _summary(receipt["rows"])
        receipt["ledger_total_usd"] = ledger.spent()
        save_json(path, receipt)

    receipt["stop"] = None
    for case in cases:
        start = time.perf_counter()
        try:
            result = ask(client, case)
        except (FireworksStop, CapReached) as exc:
            receipt["stop"] = {"status": getattr(exc, "status", 0), "text": str(exc)}
            save()
            _print(receipt)
            print(str(exc))
            return 3
        yes = result.pop("confirmed")
        receipt["rows"].append({k: case[k] for k in ("set", "id", "title", "spark", "truth")} | {
            "open": yes, "agree": yes == case["spark"], "open_right": yes == case["truth"],
            "spark_right": case["spark"] == case["truth"], "seconds": time.perf_counter() - start, **result})
        save()
    save()
    _print(receipt)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
