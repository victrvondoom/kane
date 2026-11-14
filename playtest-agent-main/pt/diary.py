"""python -m pt diary RUN: one Spark call turns a run's own logged lines into a first person playtest diary.

Rule for each diary line the model writes (the harness checks it, the model's word is not enough):
- its step must be a step of the run (a logged step, or 0 to the run's step count), else it is rejected;
- if it carries a quote, the quote (case and spacing ignored) must appear in that same step's own logged lines, else it is rejected.
Rejected lines are kept in diary.json with the reason and counted, never shown as diary."""
import json
import re
from pathlib import Path

from metaclient.client import output_text

KINDS = (("look", "saw"), ("plan", "plan"), ("notes", "notes"))

PROMPT = ("Below are the logged lines of one game test run, in step order: what the tester saw, planned, said and reported. "
          "Write a short first person playtest diary from them: what I tried, where I got stuck, what worked, and what I would "
          "tell the developer. Use only these lines. Every diary line is about one step. When you quote the log, copy the words "
          "exactly into quote. Answer with JSON only, in this shape: "
          '{"lines": [{"step": 3, "text": "...", "quote": "optional exact words from that step"}]}\n\nRun log:\n')


def run_lines(result):
    """The run's own lines, each tied to its step, in step order."""
    out = []
    for entry in result.get("log") or []:
        step = entry.get("step", 0)
        for call in entry.get("calls") or []:
            if call.get("name") == "act":
                args = call.get("args") or {}
                out += [{"step": step, "kind": kind, "text": args[key]} for key, kind in KINDS if isinstance(args.get(key), str) and args[key].strip()]
        if entry.get("thinking"):
            out.append({"step": step, "kind": "thought", "text": entry["thinking"]})
        if entry.get("text"):
            out.append({"step": step, "kind": "said", "text": entry["text"]})
    for rep in result.get("reports") or []:
        out.append({"step": rep.get("step", 0), "kind": "reported",
                    "text": f'{rep.get("title", "")}. Expected: {rep.get("expected", "")}. Saw: {rep.get("actual", "")}'})
    for item in result.get("checklist") or []:
        if item.get("done"):
            out.append({"step": item.get("step", 0), "kind": "ticked", "text": f'{item.get("text", "")}. Evidence: {item.get("evidence", "")}'})
    return sorted(out, key=lambda x: x["step"])        # stable: within a step the log order stays


def prompt(lines):
    return PROMPT + "\n".join(f'Step {x["step"]}, {x["kind"]}: {x["text"]}' for x in lines)


def _norm(text):
    return " ".join(str(text).lower().split())


def check(diary_lines, lines, steps=None):
    """Split the model's lines into (kept, rejected) by the rule in this module's docstring."""
    known = {x["step"] for x in lines} | set(range((steps or 0) + 1))
    kept, rejected = [], []
    for line in diary_lines:
        step = line.get("step") if isinstance(line, dict) else None
        if type(step) is not int or step not in known:
            rejected.append({"line": line, "why": "no such step in the run"})
            continue
        quote = line.get("quote")
        if quote and _norm(quote) not in _norm(" ".join(x["text"] for x in lines if x["step"] == step)):
            rejected.append({"line": line, "why": "the quote is not in that step's own lines"})
            continue
        kept.append({"step": step, "text": str(line.get("text", "")), **({"quote": quote} if quote else {})})
    return kept, rejected


def parse(text):
    """The model's lines and a parse error (or None). Accepts JSON with prose around it."""
    m = re.search(r"\{.*\}", text or "", re.S)
    try:
        lines = json.loads(m.group(0) if m else text)["lines"]
        if not isinstance(lines, list):
            raise ValueError("lines is not a list")
        return lines, None
    except (ValueError, KeyError, TypeError) as e:
        return [], f"{type(e).__name__}: {str(e)[:120]}"


def write(folder, client, max_output_tokens=2500):
    folder = Path(folder)
    result = json.loads((folder / "result.json").read_text(encoding="utf-8"))
    lines = run_lines(result)
    inp = [{"role": "user", "content": [{"type": "input_text", "text": prompt(lines)}]}]
    d = client.responses(inp, max_output_tokens=max_output_tokens, label=f"{folder.name}:diary", reserve_usd=0.05,
                         extra={"reasoning": {"effort": "low"}})
    raw, error = parse(output_text(d))
    kept, rejected = check(raw, lines, result.get("steps"))
    for x in kept:
        x["frame"] = f's{x["step"]:03d}.jpg'
    data = {"run": folder.name, "lines": kept, "rejected": rejected, "rejected_count": len(rejected),
            "cost_usd": d.get("_cost_usd"), "parse_error": error, "rule": __doc__.split("\n\n", 1)[1].strip()}
    (folder / "diary.json").write_text(json.dumps(data, indent=1), encoding="utf-8")
    md = [f"# Playtest diary: {folder.name}", ""] + [f'- Step {x["step"]}: {x["text"]} ([frame]({x["frame"]}))' for x in kept]
    if rejected:
        md += ["", f"{len(rejected)} line(s) rejected: see diary.json."]
    (folder / "diary.md").write_text("\n".join(md) + "\n", encoding="utf-8")
    return folder / "diary.json"


def load(folder):
    try:
        return json.loads((Path(folder) / "diary.json").read_text(encoding="utf-8")).get("lines") or []
    except (OSError, ValueError, AttributeError):
        return []
