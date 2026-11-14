"""Judge v2 offline check (bars in docs/BUILD-PLAN.md section 3.1). Needs a browser: run only when `python -m pt.guard` says OK.
true8: the 8 reports from the trial, replayed on the buggy build.  neg8: the same 8 replayed on the CLEAN build.  false6: claims written in advance."""
import json, sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from common import ROOT, load_client, save_json
from pt import guard, judge as J, replay as R

TRACES = ROOT / "data" / "judge_traces"
client = load_client("playtest-agent")
runs = {n: json.loads((ROOT / f"data/runs/{n}/result.json").read_text(encoding="utf-8")) for n in ("hunt1", "hunt2")}
items = []
for n, r in runs.items():
    for i, rep in enumerate(r["reports"]):
        items.append({"set": "true8", "id": f"{n}:{i}", "run": n, "bugs": "1,2,3,4,5", "rep": rep})
        items.append({"set": "neg8", "id": f"{n}:{i}", "run": n, "bugs": "", "rep": rep})
for c in json.loads((ROOT / "docs/false-claims.json").read_text())["claims"]:
    items.append({"set": "false6", "id": f"{c['run']}:{c['step']}", "run": c["run"], "bugs": "1,2,3,4,5", "rep": {**c, "step": c["step"]}})
out = []
locked = False
try:
    for it in items:
        acts = runs[it["run"]]["actions_by_step"]
        tdir = TRACES / (it["set"] + "_" + it["id"].replace(":", "_"))
        t = R.load_trace(tdir)
        if t is None:                      # a browser is needed only for traces not saved yet
            bad = guard.problems()
            if bad:
                sys.exit("BLOCKED, no browser started: " + "; ".join(bad))
            if not locked:
                guard.take_lock(); locked = True
            rr = R.reproducible(acts, it["rep"]["step"], it["bugs"])
            t = {**rr["trace"], "reproducible": rr["reproducible"]}
            R.save_trace(t, tdir)
        rr = {"reproducible": t["reproducible"], "trace": t}
        diff = J.state_diff(t["states"][0], t["states"][-1])
        v = J.judge(client, it["rep"], t["frames"], diff, label=f"{it['set']}:{it['id']}")
        row = {"set": it["set"], "id": it["id"], "title": it["rep"]["title"], "reproducible": rr["reproducible"], "judge_yes": v["confirmed"], "incomplete": v.get("incomplete"),
               "confirmed": bool(rr["reproducible"] and v["confirmed"]), "evidence": v["evidence"], "diff": diff, "cost_usd": v["cost_usd"], "bug_hits": t["bug_hits"]}
        out.append(row)
        print(row["set"], row["id"], "CONFIRMED" if row["confirmed"] else "no", "|", row["title"][:50], "|", row["evidence"][:90], flush=True)
finally:
    if locked:
        guard.release_lock()
sm = {s: sum(r["confirmed"] for r in out if r["set"] == s) for s in ("true8", "neg8", "false6")}
print("true8 confirmed", sm["true8"], "of 8 (bar 7+) | neg8", sm["neg8"], "of 8 (bar 0) | false6", sm["false6"], "of 6 (bar 0) | cost", round(sum(r["cost_usd"] for r in out), 3))
save_json(ROOT / "docs/receipts/judge-eval.json", {"summary": sm, "rows": out})
