"""Challenge a report's suspected cause with one controlled action change."""
import copy
import json
from pathlib import Path

from metaclient.client import output_text, wonder_cost
from pt import judge as J
from pt import replay as R


FORMAT = {"type": "json_schema", "name": "cause_challenge", "strict": True,
          "schema": {"type": "object", "properties": {
              "rival": {"type": "string"}, "step": {"type": "integer"},
              "actions": {"type": "array", "items": {"type": "object", "properties": {
                  "type": {"type": "string", "enum": ["keypress"]},
                  "keys": {"type": "array", "items": {"type": "string"}}},
                  "required": ["type", "keys"], "additionalProperties": False}},
              "observable": {"type": "object", "properties": {
                  "key": {"type": "string"},
                  "change": {"type": "string", "enum": ["decreases", "increases", "changes"]}},
                  "required": ["key", "change"], "additionalProperties": False},
              "why": {"type": "string"}},
              "required": ["rival", "step", "actions", "observable", "why"],
              "additionalProperties": False}}


def propose(client, report, window, label):
    """Request one experiment; return its proposal, parsing problems and cost."""
    details = {k: report.get(k, "") for k in ("title", "expected", "actual", "step")}
    prompt = (
        "Challenge the suspected cause of this confirmed report. Name a plain rival cause other than a game bug. "
        "Change exactly one saved step so that the rival cause cannot happen; keep everything else the same. "
        "Use only keypress actions and keys already used in the saved run. "
        "Step indexes are zero based; the report step is the number of saved steps replayed. "
        "Name the state key whose change is the reported symptom, with decreases, increases or changes. "
        "Return the experiment, not a verdict.\nReport: " + json.dumps(details, ensure_ascii=False)
        + "\nLast saved steps and state after each: " + json.dumps(window, ensure_ascii=False)
        + "\nPrevious proposal problems: " + json.dumps(report.get("proposal_problems", [])))
    body = {"input": [{"role": "user", "content": [{"type": "input_text", "text": prompt}]}],
            "max_output_tokens": 16000, "reasoning": {"effort": "low"}, "text": {"format": FORMAT}}
    response = client.wonder(body, label=label,
                             reserve_usd=wonder_cost(len(prompt.encode("utf-8")) + 1000, 16000) + .005)
    cost = response.get("_cost_usd", 0.0)
    if response.get("status") == "incomplete":
        return {"proposal": None, "problems": ["out of output tokens"], "cost_usd": cost}
    try:
        proposal = json.loads(output_text(response))
    except (ValueError, TypeError):
        return {"proposal": None, "problems": ["invalid JSON proposal"], "cost_usd": cost}
    return {"proposal": proposal, "problems": [], "cost_usd": cost}


def validate(proposal, actions_by_step, upto, state_keys):
    """Reject malformed or uncontrolled experiments before replaying them."""
    problems = []
    if not isinstance(proposal, dict):
        return ["proposal must be an object"]
    if set(proposal) != {"rival", "step", "actions", "observable", "why"}:
        problems.append("proposal must contain exactly the required fields")
    for field in ("rival", "why"):
        if not isinstance(proposal.get(field), str) or not proposal[field].strip():
            problems.append(field + " must be a nonempty string")
    step = proposal.get("step")
    inside = type(step) is int and max(0, upto - 12) <= step < upto
    if not inside:
        problems.append("step must be inside the last 12 step window and below report step")
    known = {k for acts in actions_by_step for a in acts if isinstance(a, dict)
             for k in a.get("keys", []) if isinstance(k, str)}
    actions = proposal.get("actions")
    if not isinstance(actions, list):
        problems.append("actions must be an array of keypress objects")
    else:
        for action in actions:
            if (not isinstance(action, dict) or set(action) != {"type", "keys"}
                    or action.get("type") != "keypress" or not isinstance(action.get("keys"), list)
                    or any(not isinstance(k, str) for k in action["keys"])):
                problems.append("actions must be keypress objects with string keys")
            elif any(k not in known for k in action["keys"]):
                problems.append("replacement contains a key never used in the saved run")
        if inside and actions == actions_by_step[step]:
            problems.append("replacement must differ from saved step (nothing differs)")
    observable = proposal.get("observable")
    if not isinstance(observable, dict):
        problems.append("observable must name a state key and change rule")
    else:
        if set(observable) != {"key", "change"}:
            problems.append("observable must contain exactly key and change")
        if not isinstance(observable.get("key"), str) or observable["key"] not in state_keys:
            problems.append("unknown observable state key")
        if observable.get("change") not in ("decreases", "increases", "changes"):
            problems.append("unknown observable change rule")
    return problems


def _prefix(actions_by_step, upto):
    if type(upto) is not int or not 0 <= upto <= len(actions_by_step):
        raise ValueError("Report step is outside the saved action list")
    return actions_by_step[:upto]


def walk(actions_by_step, upto, bugs, driver_cls):
    """Keep states by action index, with -1 for the initial state, and window frames."""
    steps = _prefix(actions_by_step, upto)
    driver = driver_cls(bugs=bugs)
    states, frames = {}, []
    try:
        states[-1] = copy.deepcopy(driver.state())
        for i, actions in enumerate(steps):
            R.restore(driver, [actions], 1)
            states[i] = copy.deepcopy(driver.state())
            if i >= max(0, upto - 12):
                frames.append(driver.screenshot())
        if not frames:
            frames.append(driver.screenshot())
        return {"states": states, "frames": frames}
    finally:
        driver.close()


def symptom(states, start, end, observable):
    """Return None when the requested comparison cannot be observed."""
    before, after = states[start - 1], states[end - 1]
    if not isinstance(before, dict) or not isinstance(after, dict):
        return None
    a, b = before.get(observable["key"]), after.get(observable["key"])
    if a is None or b is None:
        return None
    if observable["change"] == "changes":
        return a != b
    if type(a) not in (int, float) or type(b) not in (int, float):
        return None
    return b < a if observable["change"] == "decreases" else b > a


def _window(trace, actions, upto):
    return [{"step": i, "actions": actions[i], "state": trace["states"][i]}
            for i in range(max(0, upto - 12), upto)]


def challenge(client, report, actions_by_step, bugs, driver_cls, max_tries=2,
              label="challenge", index=0, output_dir=None):
    """Compare repeated original and changed paths, using only state evidence."""
    if type(max_tries) is not int or max_tries < 1:
        raise ValueError("max-tries must be a positive integer")
    upto = report["step"]
    _prefix(actions_by_step, upto)
    original = walk(actions_by_step, upto, bugs, driver_cls)
    window = _window(original, actions_by_step, upto)
    state_keys = {key for state in original["states"].values() if isinstance(state, dict) for key in state}
    row = {"index": index, "title": report.get("title", ""), "step": upto, "proposals": [],
           "problems": [], "verdict": "undecided", "reason": "", "symptom_original": None,
           "symptom_changed": None, "changed_step": None, "cost_usd": 0.0,
           "original_states": window, "changed_states": []}
    changed = None
    for attempt in range(max_tries):
        details = {**report, "proposal_problems": row["problems"]}
        trial = propose(client, details, window, f"{label}:try{attempt + 1}")
        proposal = trial["proposal"]
        problems = trial["problems"] or validate(proposal, actions_by_step, upto, state_keys)
        row["proposals"].append({**trial, "problems": problems})
        row["cost_usd"] += trial["cost_usd"]
        row["problems"] = problems
        if not problems:
            break
    if row["problems"]:
        row["reason"] = "Invalid proposal: " + "; ".join(row["problems"])
    else:
        start = proposal["step"]
        row["changed_step"] = start
        altered = copy.deepcopy(actions_by_step)
        altered[start] = proposal["actions"]
        original_again = walk(actions_by_step, upto, bugs, driver_cls)
        changed = walk(altered, upto, bugs, driver_cls)
        changed_again = walk(altered, upto, bugs, driver_cls)
        row["changed_states"] = _window(changed, altered, upto)
        traces = (original, original_again, changed, changed_again)
        values = [symptom(t["states"], start, upto, proposal["observable"]) for t in traces]
        row["symptom_original"], row["symptom_changed"] = values[0], values[2]
        if not J.states_equal(original["states"][upto - 1], original_again["states"][upto - 1], 2):
            row["reason"] = "The two original walks differ at the report step"
        elif not J.states_equal(changed["states"][upto - 1], changed_again["states"][upto - 1], 2):
            row["reason"] = "The two changed walks differ at the report step"
        elif any(not J.states_equal(original["states"][i], t["states"][i], 0)
                 for t in traces[1:] for i in range(-1, start)):
            row["reason"] = "States differ before the changed step"
        elif any(v is None for v in values):
            row["reason"] = "The symptom value is unavailable on at least one walk"
        elif values[0] != values[1] or values[2] != values[3]:
            row["reason"] = "The symptom differs between repeated walks"
        elif not values[0]:
            row["reason"] = "The original path does not show the symptom"
        elif values[2]:
            row.update(verdict="supported", reason="The symptom persists after removing the proposed rival cause")
        else:
            row.update(verdict="contradicted", reason="Removing the proposed rival cause removes the symptom")
    if output_dir is not None:
        for name, trace in (("original", original), ("changed", changed)):
            if trace is not None:
                strip = J.filmstrip(J.pick_frames(trace["frames"], 12), tile_w=480)
                (Path(output_dir) / f"challenge_strip_{index}_{name}.jpg").write_bytes(strip)
    return row


def _inputs(run, reports):
    old = json.loads((Path(run) / "result.json").read_text(encoding="utf-8"))
    checked = json.loads((Path(run) / "confirm.json").read_text(encoding="utf-8"))
    eligible = {i: rep for i, rep in enumerate(checked)
                if rep.get("confirmed") is True and rep.get("status") != "rejected"}
    indexes = list(eligible) if reports is None else list(dict.fromkeys(reports))
    if any(i not in eligible for i in indexes):
        raise ValueError("Select only confirmed reports that were not rejected")
    selected = [(i, eligible[i]) for i in indexes]
    for _, report in selected:
        _prefix(old["actions_by_step"], report.get("step"))
    return old, selected


def challenge_run(run, output_dir, client, driver_cls, reports=None, max_tries=2):
    """Save a fresh reanalysis folder without changing the source reports."""
    output_dir = Path(output_dir)
    if output_dir.exists():
        raise ValueError("Choose a fresh challenge output folder")
    if type(max_tries) is not int or max_tries < 1:
        raise ValueError("max-tries must be a positive integer")
    old, selected = _inputs(run, reports)
    output_dir.mkdir(parents=True)
    rows = [challenge(client, report, old["actions_by_step"], old["bugs_on"], driver_cls,
                      max_tries=max_tries, label=f"{output_dir.name}:challenge{i}", index=i,
                      output_dir=output_dir) for i, report in selected]
    result = {"run": str(run), "game_id": old["game_id"], "bugs_on": old["bugs_on"],
              "reports": rows, "cost_usd": sum(r["cost_usd"] for r in rows),
              "note": "a reanalysis of saved reports; not a fresh holdout result"}
    (output_dir / "challenge.json").write_text(json.dumps(result, indent=1, ensure_ascii=False), encoding="utf-8")
    return result


def add_parser(sub):
    parser = sub.add_parser("challenge", help="challenge the suspected cause of confirmed reports")
    parser.add_argument("folder")
    parser.add_argument("--report", type=int, nargs="+", action="extend", default=None)
    parser.add_argument("--max-tries", type=int, default=2)
    parser.add_argument("--name", required=True)


def run_cli(args, root):
    from pt import guard
    from pt.adapter import make
    from trials.common import load_client

    if Path(args.name).name != args.name or args.name in (".", ".."):
        raise ValueError("Name must be a folder name")
    output = Path(root) / "data" / "runs" / args.name
    if output.exists():
        raise ValueError("Choose a fresh challenge output folder")
    if args.max_tries < 1:
        raise ValueError("max-tries must be a positive integer")
    old, _ = _inputs(args.folder, args.report)
    bad = guard.problems()
    if bad:
        print("BLOCKED, no browser started: " + "; ".join(bad))
        return 1
    guard.take_lock()
    try:
        result = challenge_run(args.folder, output, load_client("playtest-agent"),
                               lambda bugs="": make(old["game_id"], bugs=bugs),
                               reports=args.report, max_tries=args.max_tries)
        for row in result["reports"]:
            print(f'Report {row["index"]}: {row["verdict"]}: {row["reason"]}')
        return 0
    finally:
        guard.release_lock()
