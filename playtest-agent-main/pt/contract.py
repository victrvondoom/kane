"""Draft, approve and check bounded rules against recorded actions."""
import copy
import json
import math
from datetime import datetime, timezone
from pathlib import Path

from metaclient.client import output_text, wonder_cost
from pt.seal import digest


FIELDS = ("rule", "trigger", "checks", "within", "objective")
CHANGES = ("decreases", "increases", "becomes")
OPS = ("equals", "decreases_by", "increases_by", "unchanged")
VALUE = {"type": ["number", "boolean", "string", "null"]}


def _object(properties):
    return {"type": "object", "properties": properties,
            "required": list(properties), "additionalProperties": False}


FORMAT = {"type": "json_schema", "name": "acceptance_contract", "strict": True,
          "schema": _object({
              "rule": {"type": "string"},
              "trigger": _object({"key": {"type": "string"},
                                  "change": {"type": "string", "enum": list(CHANGES)}, "value": VALUE}),
              "checks": {"type": "array", "minItems": 1, "items": _object({
                  "key": {"type": "string"}, "op": {"type": "string", "enum": list(OPS)}, "value": VALUE})},
              "within": {"type": "integer", "minimum": 0, "maximum": 3},
              "objective": {"type": "string"}})}


def _number(value):
    return type(value) in (int, float) and math.isfinite(value)


def _scalar(value):
    return value is None or type(value) in (str, bool) or _number(value)


def validate(contract, state_keys):
    """Return problems without executing anything from the contract."""
    if not isinstance(contract, dict):
        return ["contract must be an object"]
    problems = []
    if set(contract) != set(FIELDS):
        problems.append("contract fields must be rule, trigger, checks, within, objective")
    for key in ("rule", "objective"):
        if not isinstance(contract.get(key), str) or not contract[key].strip():
            problems.append(key + " must be a plain sentence")
    within = contract.get("within")
    if type(within) is not int or not 0 <= within <= 3:
        problems.append("within must be an integer from 0 to 3")
    checks = contract.get("checks")
    if not isinstance(checks, list) or not checks:
        problems.append("checks must contain at least one check")
        checks = []
    for label, row, op, allowed in [("trigger", contract.get("trigger"), "change", CHANGES)] + [
            (f"checks[{i}]", row, "op", OPS) for i, row in enumerate(checks)]:
        if not isinstance(row, dict):
            problems.append(label + " must be an object")
            continue
        if set(row) != {"key", op, "value"}:
            problems.append(label + " has invalid fields")
        if not isinstance(row.get("key"), str) or row["key"] not in state_keys:
            problems.append(label + " unknown key: " + str(row.get("key")))
        if row.get(op) not in allowed:
            problems.append(label + " unknown " + op + ": " + str(row.get(op)))
        if not _scalar(row.get("value")):
            problems.append(label + " value must be a number, bool, string or null")
        if row.get(op) in ("decreases_by", "increases_by") and not _number(row.get("value")):
            problems.append(label + " value must be numeric for " + row[op])
    return problems


def draft(client, rule, state_keys, label):
    """Make one structured proposal, retaining the text and cost for review."""
    prompt = (
        "Draft an acceptance contract for the designer's rule. Use only the supplied state keys. "
        "Return only the fixed JSON vocabulary. No code. The trigger is the first matching change "
        "between consecutive states. Checks compare the state before that step with the state "
        "after trigger step plus within (0 to 3). decreases and increases compare numbers; becomes "
        "equals value after but not before. equals compares the final value; decreases_by and "
        "increases_by compare the exact numeric difference; unchanged compares both values. "
        "Write a plain objective telling the player how to reach the trigger.\nRule: " + rule
        + "\nState keys with example values: " + json.dumps(state_keys, ensure_ascii=False))
    body = {"input": [{"role": "user", "content": [{"type": "input_text", "text": prompt}]}],
            "reasoning": {"effort": "low"}, "max_output_tokens": 16000, "text": {"format": FORMAT}}
    response = client.wonder(body, label=label,
                             reserve_usd=wonder_cost(len(prompt.encode("utf-8")) + 1000, 16000) + .005)
    if response.get("status") == "incomplete":
        raise ValueError("draft failed: out of output tokens")
    text = output_text(response)
    try:
        contract = json.loads(text)
        problems = validate(contract, state_keys)
    except (ValueError, TypeError):
        contract, problems = {}, ["model text is not valid JSON"]
    row = dict(contract) if isinstance(contract, dict) else {}
    row.update(status="invalid" if problems else "draft", rule=rule,
               model_text=text, cost_usd=response.get("_cost_usd", 0))
    if problems:
        row["problems"] = problems
    return row


def _read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _write(path, value):
    Path(path).write_text(json.dumps(value, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


def _contract(row):
    return {key: row.get(key) for key in FIELDS}


def _keys(contract):
    checks = contract.get("checks")
    rows = [contract.get("trigger")] + (checks if isinstance(checks, list) else [])
    return [row.get("key") for row in rows if isinstance(row, dict)]


def approve(folder, by):
    """Record the person's approval of the current contract fields."""
    path = Path(folder) / "contract.json"
    row = _read(path)
    contract = _contract(row)
    if row.get("status") == "invalid" or validate(contract, _keys(contract)):
        raise ValueError("Cannot approve an invalid contract")
    if not by.strip():
        raise ValueError("Approval needs a name")
    row.update(status="approved", by=by, time=datetime.now(timezone.utc).isoformat(), sha256=digest(contract))
    _write(path, row)
    return row


def _equal(left, right):
    # JSON booleans are distinct from numbers, even though Python equates True and 1.
    return (type(left) is type(right) or _number(left) and _number(right)) and left == right


def check(contract, states):
    """Check the first trigger using only observed state values."""
    contract = _contract(contract)
    problems = validate(contract, _keys(contract))
    result = {"outcome": "untested", "trigger_step": None, "before": {}, "after": {},
              "checks": [], "reason": "trigger never happened"}
    if problems:
        result["reason"] = "invalid contract: " + "; ".join(problems)
        return result
    trigger = contract["trigger"]
    key, change = trigger["key"], trigger["change"]
    for step in range(1, len(states)):
        before, after = states[step - 1] or {}, states[step] or {}
        left, right = before.get(key), after.get(key)
        if left is None or right is None:
            result["reason"] = "missing observation: " + key
            return result
        happens = (_equal(right, trigger["value"]) and not _equal(left, trigger["value"])) if change == "becomes" else (
            _number(left) and _number(right) and (right < left if change == "decreases" else right > left))
        if not happens:
            continue
        result.update(trigger_step=step, before=before)
        end = step + contract["within"]
        if end >= len(states):
            result["reason"] = "recording ends before check step"
            return result
        after = states[end] or {}
        result["after"] = after
        # Missing values in any state read cannot produce a pass or a fail.
        missing = [key for state in states[:step + 1] + [after]
                   for key in _keys(contract) if not state or state.get(key) is None]
        for item in contract["checks"]:
            key, op, value = item["key"], item["op"], item["value"]
            left, right = before.get(key), after.get(key)
            ok = None
            if left is not None and right is not None:
                if op == "equals":
                    ok = _equal(right, value)
                elif op == "unchanged":
                    ok = _equal(left, right)
                else:
                    ok = _number(left) and _number(right) and _equal(
                        left - right if op == "decreases_by" else right - left, value)
            result["checks"].append({**item, "seen_before": left, "seen_after": right, "ok": ok})
        if missing:
            result["reason"] = "missing observation: " + ", ".join(sorted(set(missing)))
        else:
            passed = all(item["ok"] for item in result["checks"])
            result.update(outcome="pass" if passed else "fail",
                          reason="all checks satisfied" if passed else "check failed: " + ", ".join(
                              item["key"] for item in result["checks"] if not item["ok"]))
        return result
    if any(not state or any(state.get(key) is None for key in _keys(contract)) for state in states):
        result["reason"] = "missing observation"
    return result


def states_of(actions_by_step, bugs, driver_cls):
    """Replay the entire action list once and retain independent state snapshots."""
    driver = driver_cls(bugs=bugs)
    try:
        states = [copy.deepcopy(driver.state())]
        for actions in actions_by_step:
            driver.execute(actions)
            states.append(copy.deepcopy(driver.state()))
        return states
    finally:
        driver.close()


def add_parser(sub):
    parser = sub.add_parser("contract-draft", help="draft a rule for review")
    parser.add_argument("name")
    parser.add_argument("--rule", required=True)
    parser.add_argument("--keys-from", required=True)
    parser = sub.add_parser("contract-approve", help="approve a reviewed contract")
    parser.add_argument("name")
    parser.add_argument("--by", required=True)
    parser = sub.add_parser("contract-check", help="check a contract on saved actions")
    parser.add_argument("name")
    parser.add_argument("runs", nargs="+")


def run_cli(args, root):
    if not args.name or Path(args.name).name != args.name or args.name in (".", ".."):
        raise ValueError("Name must be a folder name")
    folder = Path(root) / "data" / "contracts" / args.name
    if args.cmd == "contract-draft":
        if folder.exists():
            raise ValueError("Contract folder already exists")
        keys = _read(Path(args.keys_from) / "result.json").get("final_state")
        if not isinstance(keys, dict) or not keys:
            raise ValueError("Run has no final_state keys")
        from trials.common import load_client
        row = draft(load_client("playtest-agent"), args.rule, keys, args.name + ":contract")
        folder.mkdir(parents=True)
        _write(folder / "contract.json", row)
        print(json.dumps(row, indent=1, ensure_ascii=False))
        print(f"Not approved. Review it, then: python -m pt contract-approve {args.name} --by YOU")
        return 0
    if args.cmd == "contract-approve":
        approve(folder, args.by)
        print("Approved " + args.name)
        return 0
    row = _read(folder / "contract.json")
    if row.get("status") != "approved":
        raise ValueError("Contract must be approved")
    if row.get("sha256") != digest(_contract(row)):
        raise ValueError("Contract changed after approval")
    from pt import guard
    from pt.adapter import make
    bad = guard.problems()
    if bad:
        print("BLOCKED, no browser started: " + "; ".join(bad))
        return 1
    guard.take_lock()
    try:
        for run in args.runs:
            run = Path(run)
            old = _read(run / "result.json")
            states = states_of(old["actions_by_step"], old["bugs_on"],
                               lambda bugs: make(old["game_id"], bugs=bugs))
            result = check(row, states)
            _write(folder / f"check-{run.name}.json", result)
            print(f'{run.name}: {result["outcome"]} ({result["reason"]})')
        return 0
    finally:
        guard.release_lock()
