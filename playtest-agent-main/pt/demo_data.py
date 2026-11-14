"""One view of saved and live demo runs, without starting a client or driver."""
import json
import os
from pathlib import Path


def load(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def action_words(actions):
    words = []
    for action in actions:
        kind = action.get("type", "")
        if kind == "keypress":
            words.append(" + ".join(str(k).capitalize() for k in action.get("keys", [])))
        elif kind == "click":
            words.append(f"Click at {action.get('x', '?')}, {action.get('y', '?')}")
        elif kind:
            words.append(kind.replace("_", " ").capitalize())
    return ", ".join(words)


def run_view(folder, result, prefix, checks=None, repo=None):
    """Build the same fields while play is in progress and after files are saved."""
    folder = Path(folder)
    checks = load(folder / "confirm.json", []) if checks is None else list(checks)
    log = {}
    for row in list(result.get("log", [])):
        log.setdefault(row["step"], []).append(row)
    shots = {int(p.stem[1:]): p.name for p in folder.glob("s[0-9][0-9][0-9].jpg")}
    steps, total = [], 0.0
    for step in sorted(log.keys() | shots.keys()):
        rows = log.get(step, [])
        total += sum(row.get("cost", 0) or 0 for row in rows)
        acts = [c.get("args", {}) for row in rows for c in row.get("calls", []) if c.get("name") == "act"]
        steps.append({"step": step, "shot": prefix + shots[step] if step in shots else "",
                      "look": "\n".join(a["look"] for a in acts if a.get("look")),
                      "words": "\n".join(row["text"] for row in rows if row.get("text")),
                      "actions": action_words([action for a in acts for action in a.get("actions", [])]),
                      "cost_total": round(total, 8)})
    cards = []
    reports = list(result.get("reports", []))
    for index, report in enumerate(reports):
        check = checks[index] if index < len(checks) else {}
        try:
            judge = json.loads(check.get("judge") or "{}")
        except (ValueError, TypeError):
            # Saved raw replies are capped at 400 characters. Confirmation keeps
            # the parsed verdict and full evidence separately before that cut.
            judge = {"verdict": "YES" if check.get("confirmed") is True else "NO",
                     "evidence": check.get("evidence", "")}
        if not isinstance(judge, dict):
            judge = {}
        quote = judge.get("evidence", "")
        quote = quote.strip() if isinstance(quote, str) else ""
        replayed = check.get("reproducible")
        line = ("Replayed twice: same end both times" if replayed is True else
                "Replayed twice: the ends differed, set aside" if replayed is False else "")
        strip = f"strip_{index}.jpg"
        cards.append({"title": report.get("title", ""), "expected": report.get("expected", ""),
                      "seen": report.get("actual", ""), "step": report.get("step"),
                      "strip": prefix + strip if (folder / strip).is_file() else "",
                      "replays": line, "judge_yes": str(judge.get("verdict", "")).strip().upper() == "YES" and bool(quote),
                      "judge_quote": quote})
    confirmed = sum(check.get("confirmed") is True for check in checks[:len(reports)])
    links = {"report": prefix + "report.html"}
    if (folder / "console.html").is_file():
        links["console"] = prefix + "console.html"
    repo = os.environ.get("DEMO_REPO_URL", "") if repo is None else repo
    if repo:
        links["repo"] = repo
    return {"title": result.get("game") or "Live run", "steps": steps, "cards": cards,
            "summary": {"filed": len(reports), "confirmed": confirmed, "set_aside": len(reports) - confirmed,
                        "steps": result.get("steps", 0), "cost_usd": result.get("cost_usd", 0),
                        "seconds": result.get("seconds", 0)}, "links": links}
