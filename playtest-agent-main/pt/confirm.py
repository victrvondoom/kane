"""Compare two fresh replays by state or pictures, then judge both strips with quoted evidence.
Missing comparison evidence leaves a report not compared. Video judges retain one replay.
Refused inputs named by a report are not judged."""
import json
import time
from pathlib import Path

from pt import judge as J
from pt import replay as R


def confirm_run(run_dir, client, driver_cls=None, last=12, write=True, judge_input="strip", on_check=None):
    if judge_input not in ("strip", "video"):
        raise ValueError("Unknown judge input: " + str(judge_input))
    run_dir = Path(run_dir)
    res = json.loads((run_dir / "result.json").read_text(encoding="utf-8"))
    gaps = R.step_gaps(res.get("log"))
    rows = []
    for i, rep in enumerate(res.get("reports", [])):
        started = time.monotonic()
        rr = R.reproducible(res["actions_by_step"], rep["step"], res.get("bugs_on", ""), driver_cls=driver_cls, last=last, gaps=gaps)
        refused = R.named_refused(rep, rr["trace"], rr.get("trace_b", {}))
        t = rr["trace"]
        diff = J.state_diff(t["states"][0], t["states"][-1]) if t["states"] else []
        row = {"title": rep.get("title", ""), "expected": rep.get("expected", ""), "actual": rep.get("actual", ""), "step": rep["step"],
               "reproducible": rr["reproducible"], "confirmed": False, "evidence": "", "judge": "", "cost_usd": 0.0, "state_change": diff,
               "judge_input": judge_input, "comparison": rr["comparison"], "refused_inputs": refused}
        row["pacing"] = {"a": rr["trace"].get("paces", []), "b": rr.get("trace_b", {}).get("paces", [])}
        if refused:
            row["status"] = "input refused in replay"
        elif rr["reproducible"] is True:
            options = {"judge_input": judge_input} if judge_input != "strip" else {"second_frames": rr["trace_b"]["frames"]}
            v = J.judge(client, rep, t["frames"], diff, label=f"{run_dir.name}:confirm{i}", **options)
            (run_dir / f"strip_{i}.jpg").write_bytes(v["strip"])
            if "strip_b" in v:
                (run_dir / f"strip_{i}_b.jpg").write_bytes(v["strip_b"])
            if "video" in v:
                (run_dir / f"video_{i}.mp4").write_bytes(v["video"])
            row.update({"confirmed": bool(v["confirmed"]), "evidence": v["evidence"], "judge": v["raw"], "cost_usd": v["cost_usd"]})
        if not refused:
            row["status"] = "not compared" if rr["reproducible"] is None else ("confirmed" if row["confirmed"] else "rejected")
        row["seconds"] = round(time.monotonic() - started, 1)
        rows.append(row)
        if on_check is not None:
            on_check(dict(row))
    if write:
        (run_dir / "confirm.json").write_text(json.dumps(rows, indent=1, ensure_ascii=False), encoding="utf-8")
    return rows


if __name__ == "__main__":
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from pt import guard
    from pt.adapter import make
    from trials.common import load_client
    run = Path(sys.argv[1])
    game = sys.argv[2] if len(sys.argv) > 2 else (json.loads((run / "result.json").read_text(encoding="utf-8")).get("game_id") or "cave-courier")
    bad = guard.problems()
    if bad:
        sys.exit("BLOCKED, no browser started: " + "; ".join(bad))
    guard.take_lock()
    try:
        rows = confirm_run(run, load_client("playtest-agent"), driver_cls=lambda bugs="": make(game, bugs=bugs))
    finally:
        guard.release_lock()
    for r in rows:
        print("CONFIRMED" if r["confirmed"] else ("not reproducible" if not r["reproducible"] else "not confirmed"), "|", r["title"], "|", r["evidence"][:100])
