"""Compare local verdicts with the saved Spark verdicts."""
import argparse
import json
import time

from metaclient.local import LocalClient
from pt import judge as J, replay as R
from trials.common import ROOT, save_json


def compare(spark_rows, glimmer_rows):
    def index(rows):
        result = {(r["set"], r["id"]): r for r in rows}
        if len(result) != len(rows):
            raise ValueError("duplicate verdict")
        return result
    spark, glimmer = index(spark_rows), index(glimmer_rows)
    if spark.keys() != glimmer.keys():
        raise ValueError("verdicts do not match")
    rows = []
    for key, source in spark.items():
        local = glimmer[key]
        a = bool(source.get("judge_yes", source.get("confirmed")))
        b = bool(local.get("judge_yes", local.get("confirmed")))
        rows.append({**local, "title": source["title"], "spark": a, "glimmer": b, "agree": a == b})
    summary = {"agreement": sum(r["agree"] for r in rows), "total": len(rows),
               "misses": sum(r["set"] == "true8" and r["spark"] and not r["glimmer"] for r in rows),
               "false_alarms": sum(r["set"] in ("neg8", "false6") and r["glimmer"] for r in rows),
               "mean_seconds": sum(r.get("seconds", 0) for r in rows) / len(rows) if rows else 0}
    return {"rows": rows, "summary": summary}


def _read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def _inputs(rows, root=None):
    root = ROOT if root is None else root
    claims = _read(root / "docs/false-claims.json")["claims"]
    false = {(c["run"], str(c["step"])): c for c in claims}
    runs, items = {}, []
    for row in rows:
        group, ident = row["set"], row["id"]
        run, number = ident.split(":")
        if group == "false6":
            report = false[(run, number)]
        elif group in ("true8", "neg8"):
            if run not in runs:
                runs[run] = _read(root / "data/runs" / run / "result.json")
            report = runs[run]["reports"][int(number)]
        else:
            raise ValueError("unknown set: " + group)
        folder = root / "data/judge_traces" / (group + "_" + ident.replace(":", "_"))
        trace = R.load_trace(folder)
        if trace is None:
            raise FileNotFoundError("missing trace: " + str(folder))
        items.append((row, report, trace))
    return items


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8090/v1")
    parser.add_argument("--reasoning", choices=["low", "medium", "high"], default="low")
    args = parser.parse_args(argv)
    spark = _read(ROOT / "docs/receipts/judge-eval.json")["rows"]
    items = _inputs(spark)
    client = LocalClient(base_url=args.url, reasoning=args.reasoning)
    glimmer = []
    for row, report, trace in items:
        diff = J.state_diff(trace["states"][0], trace["states"][-1])
        start = time.perf_counter()
        verdict = J.judge(client, report, trace["frames"], diff, label=f"{row['set']}:{row['id']}")
        glimmer.append({"set": row["set"], "id": row["id"], "title": report["title"],
                        "judge_yes": verdict["confirmed"], "confirmed": bool(trace["reproducible"] and verdict["confirmed"]),
                        "reproducible": trace["reproducible"], "evidence": verdict["evidence"],
                        "incomplete": verdict["incomplete"], "diff": diff, "cost_usd": verdict["cost_usd"],
                        "seconds": time.perf_counter() - start})
    result = {"model": "glimmer-local", "reasoning": args.reasoning, **compare(spark, glimmer)}
    print("set | id | title | Spark | Glimmer | agree")
    for row in result["rows"]:
        print(" | ".join([row["set"], row["id"], row["title"], "YES" if row["spark"] else "NO",
                          "YES" if row["glimmer"] else "NO", "yes" if row["agree"] else "no"]))
    summary = result["summary"]
    print(f"Agreement {summary['agreement']}/{summary['total']} | Glimmer misses {summary['misses']} | "
          f"Glimmer false alarms {summary['false_alarms']} | mean seconds per call {summary['mean_seconds']:.3f}")
    save_json(ROOT / "docs/receipts/judge-glimmer.json", result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
