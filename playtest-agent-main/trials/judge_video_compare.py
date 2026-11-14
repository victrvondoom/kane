"""Compare fresh strip and video Spark verdicts on all 22 saved traces. Paid; no replay."""
import argparse
from collections import Counter

from pt import judge as J
from trials.common import ROOT, load_client, save_json
from trials.judge_compare import _inputs, _read


def judge_pairs(client, items, clips):
    """Yield paired verdicts using the same prompt, parser and saved evidence."""
    for (row, report, trace), clip in zip(items, clips, strict=True):
        diff = J.state_diff(trace["states"][0], trace["states"][-1])
        label = f"video-compare:{row['set']}:{row['id']}"
        strip = J.judge(client, report, trace["frames"], diff, label=label + ":strip")
        video = J.judge(client, report, trace["frames"], diff, label=label + ":video", judge_input="video", video_bytes=clip)
        a, b = strip["confirmed"], video["confirmed"]
        yield {"set": row["set"], "id": row["id"], "title": report["title"],
               "reproducible": trace["reproducible"], "strip": a, "video": b, "agree": a == b,
               "strip_evidence": strip["evidence"], "video_evidence": video["evidence"],
               "strip_incomplete": strip["incomplete"], "video_incomplete": video["incomplete"],
               "cost_usd": strip["cost_usd"] + video["cost_usd"]}


def main(argv=None):
    argparse.ArgumentParser(description=__doc__).parse_args(argv)
    rows = _read(ROOT / "docs/receipts/judge-eval.json")["rows"]
    if Counter(row["set"] for row in rows) != {"true8": 8, "neg8": 8, "false6": 6}:
        raise ValueError("Need all 22 verdicts: true8, neg8, false6")
    if len({(row["set"], row["id"]) for row in rows}) != 22:
        raise ValueError("Duplicate verdict")
    items = _inputs(rows, root=ROOT)  # Check every saved trace before loading credentials or spending.
    from pt.judge_video import encode
    clips = [encode(J.pick_frames(trace["frames"], 12)) for _, _, trace in items]
    client = load_client("playtest-agent")
    out = []
    print("set | id | strip | video | agree")
    for row in judge_pairs(client, items, clips):
        out.append(row)
        print(f"{row['set']} | {row['id']} | {row['strip']} | {row['video']} | {row['agree']}", flush=True)
        save_json(ROOT / "docs/receipts/judge-video-compare.json", {
            "rows": out, "summary": {"agreement": sum(r["agree"] for r in out), "total": len(out),
                                      "cost_usd": sum(r["cost_usd"] for r in out)}})
    print(f"Agreement {sum(r['agree'] for r in out)}/{len(out)} | cost ${sum(r['cost_usd'] for r in out):.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
