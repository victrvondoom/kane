"""Confirm a bug report by replay: run the recorded actions up to the report on a fresh page, then ask Spark if the symptom shows."""
import base64
import re
import time
from metaclient.client import output_text

# Longer waits were model time, not time the game needed.
MAX_GAP_S = 10.0


def step_gaps(log):
    """Return the elapsed time between the first rows for successive steps."""
    if not isinstance(log, list):
        return {}
    first = {}
    for row in log:
        if not isinstance(row, dict):
            continue
        step, stamp = row.get("step"), row.get("t")
        if (isinstance(step, bool) or not isinstance(step, (int, float)) or
                isinstance(stamp, bool) or not isinstance(stamp, (int, float))):
            continue
        first.setdefault(step, stamp)
    steps = list(first)
    return {step: min(MAX_GAP_S, max(0.0, first[next_step] - first[step]))
            for step, next_step in zip(steps, steps[1:])}

PROMPT = ("A tester reported a bug in a small platformer.\nTitle: {title}\nExpected: {expected}\nSaw: {actual}\n"
          "Image 1 is the game at the start. Image 2 is the game after the same actions were replayed on a fresh page. "
          "Does image 2 show the reported problem? Answer YES or NO first, then one short reason.")


def restore(driver, actions_by_step, upto):
    for acts in actions_by_step[:upto]:
        driver.execute(acts)


def replay(actions_by_step, upto, bugs, driver_cls=None, info=None):
    """Returns (first screenshot, last screenshot)."""
    if driver_cls is None:
        from pw.driver import Driver as driver_cls
    d = driver_cls(bugs=bugs)
    try:
        first = d.screenshot()
        restore(d, actions_by_step, upto)
        last = d.screenshot()
        if info is not None and hasattr(d, 'bug_hits'):
            info['bug_hits'], info['state'] = d.bug_hits(), d.state()
        return first, last
    finally:
        d.close()


def parse_verdict(text):
    m = re.match(r"\s*(yes|no)\b", text or "", re.I)
    return bool(m and m.group(1).lower() == "yes")


def _img(b):
    return {"type": "input_image", "image_url": "data:image/jpeg;base64," + base64.b64encode(b).decode()}


def confirm(client, report, first, last, label="confirm"):
    txt = PROMPT.format(title=report.get("title", ""), expected=report.get("expected", ""), actual=report.get("actual", ""))
    inp = [{"role": "user", "content": [{"type": "input_text", "text": txt}, _img(first), _img(last)]}]
    d = client.responses(inp, max_output_tokens=1500, label=label, reserve_usd=0.03)
    t = output_text(d)
    return parse_verdict(t), t, d["_cost_usd"]


def replay_trace(actions_by_step, upto, bugs, driver_cls=None, last=12, gaps=None):
    """Run actions 1 to `upto`. Keep a frame and the state before the last `last` actions and after each of them.
    A reload starts a fresh game, so the kept frames start after the last reload: the judge sees one game, not two."""
    if driver_cls is None:
        from pw.driver import Driver as driver_cls
    d = driver_cls(bugs=bugs)
    frames, states, refused, paces = [], [], [], []
    try:
        start = max(0, upto - last)
        for i, acts in enumerate(actions_by_step[:upto]):
            if any(isinstance(a, dict) and a.get("type") == "reload" for a in acts):
                start = max(start, i + 1)
        for i, acts in enumerate(actions_by_step[:upto]):
            if i == start:
                frames.append(d.screenshot()); states.append(d.state() if hasattr(d, "state") else None)
            paced = bool(gaps) and getattr(d, "paced_replay", False)
            started = time.monotonic() if paced else None
            d.execute(acts)
            elapsed = time.monotonic() - started if paced else 0
            note = getattr(d, "action_note", "")
            if isinstance(note, str) and note:
                refused.append({"step": i + 1, "note": note})
            if i >= start:
                frames.append(d.screenshot()); states.append(d.state() if hasattr(d, "state") else None)
            if paced and i < min(upto, len(actions_by_step)) - 1:
                pause = max(0.0, gaps.get(i, 0) - elapsed)
                sleeper = getattr(d, "sleep", None) or time.sleep
                sleeper(pause)
                paces.append({"step": i, "gap": round(gaps.get(i, 0), 2), "pause": round(pause, 2)})
        if not frames:
            frames.append(d.screenshot()); states.append(d.state() if hasattr(d, "state") else None)
        hits = d.bug_hits() if hasattr(d, "bug_hits") else None
        return {"frames": frames, "states": states, "bug_hits": hits, "refused": refused, "paces": paces}
    finally:
        d.close()


def reproducible(actions_by_step, upto, bugs, driver_cls=None, last=12, tol=2, gaps=None):
    """Keep two fresh replays and compare final states or pictures. Return None if neither can be compared."""
    from pt.judge import compare_replays
    a = replay_trace(actions_by_step, upto, bugs, driver_cls, last, gaps=gaps)
    b = replay_trace(actions_by_step, upto, bugs, driver_cls, last, gaps=gaps)
    comparison = compare_replays(a, b, tol)
    return {"reproducible": comparison["same"] if comparison["compared"] else None,
            "trace": a, "trace_b": b, "comparison": comparison}


def refused_inputs(trace):
    names = []
    for item in trace.get("refused", []) if isinstance(trace, dict) else []:
        note = item.get("note", "") if isinstance(item, dict) else ""
        for match in re.finditer(r"(?:key|action) refused: ([^,;]+)", str(note), re.I):
            name = match.group(1).strip()
            if name and name not in names:
                names.append(name)
    return names


def named_refused(report, *traces):
    text = " ".join(str(report.get(key, "")) for key in ("title", "expected", "actual"))
    found = []
    for name in (name for trace in traces for name in refused_inputs(trace)):
        if name.lower() in ("escape", "esc"):
            matched = re.search(r"(?<![A-Za-z0-9])(?:escape|esc)(?![A-Za-z0-9])", text, re.I)
        elif len(name) == 1:
            matched = re.search(rf"(?:\bkey\s+{re.escape(name)}\b|\b{re.escape(name)}\s+key\b)", text, re.I)
        else:
            matched = re.search(rf"(?<![A-Za-z0-9]){re.escape(name)}(?![A-Za-z0-9])", text, re.I)
        if matched and name not in found:
            found.append(name)
    return found


def save_trace(trace, folder):
    """Keep a replay trace on disk so the judge can be tuned later without a browser."""
    import json
    from pathlib import Path
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    for i, f in enumerate(trace["frames"]):
        (folder / f"f{i:02d}.jpg").write_bytes(f)
    (folder / "meta.json").write_text(json.dumps({"n": len(trace["frames"]), "states": trace["states"], "bug_hits": trace.get("bug_hits"), "reproducible": trace.get("reproducible")}), encoding="utf-8")


def load_trace(folder):
    import json
    from pathlib import Path
    folder = Path(folder)
    try:
        meta = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
    except OSError:
        return None
    return {"frames": [(folder / f"f{i:02d}.jpg").read_bytes() for i in range(meta["n"])], "states": meta["states"], "bug_hits": meta.get("bug_hits"), "reproducible": meta.get("reproducible")}
