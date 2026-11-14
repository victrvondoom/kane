"""Render saved replay and patch checks with only their public observations."""
import html
import json
import re


def _text(value):
    text = str(value)
    text = re.sub(r"(?:[A-Za-z]:[\\/]|\\\\|(?<![\w/])/)[^\s\"<>]+", "[local path]", text)
    return html.escape(text, quote=True)


def _load(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def replays(confirmation):
    if not confirmation:
        return ""
    refused = confirmation.get("refused_inputs") or []
    if refused:
        names = ", ".join(_text(name) for name in refused)
        return f"<p>Input refused in replay: {names}. The game never got it, so this report was not judged.</p>"
    comparison = confirmation.get("comparison")
    if isinstance(comparison, dict):
        if not comparison.get("compared"):
            return "<p>Not compared</p>"
        method = comparison.get("method")
        if method in ("state", "pictures"):
            result = "same" if comparison.get("same") else "different"
            text = f"Two replays compared by {method}: {result}"
            if method == "pictures" and "difference" in comparison:
                text += f" (difference {comparison['difference']})"
            return f"<p>{_text(text)}</p>"
    elif confirmation.get("reproducible") is True and not confirmation.get("state_change"):
        return "<p>Older check: replays not compared</p>"
    return ""


def _check(value):
    """Ignore commands, paths and unstructured output in saved command results."""
    if not isinstance(value, dict):
        return ""
    fields = {key: value[key] for key in ("read", "expected", "returncode") if key in value}
    try:
        output = json.loads(value.get("stdout", ""))
    except (ValueError, TypeError):
        output = None
    if isinstance(output, dict):
        fields.update({key: output[key] for key in ("read", "expected") if key in output})
    return ", ".join(f"{'exit code' if key == 'returncode' else key} {_text(item)}"
                     for key, item in fields.items())


def _patches(run, index, report):
    parts = []
    # Use the full result when present, otherwise its public copy, once per file.
    stems = sorted({p.name.split(".")[0] for p in run.glob("fix-any-*.json")
                    if re.fullmatch(r"fix-any-\d+(?:\.public)?\.json", p.name)})
    for stem in stems:
        path = run / (stem + ".json")
        if not path.is_file():
            path = run / (stem + ".public.json")
        fix = _load(path, {})
        if not isinstance(fix, dict) or fix.get("report_index") != index:
            continue
        confirmation = fix.get("confirmation")
        if isinstance(confirmation, dict) and "title" in confirmation and confirmation["title"] != report.get("title"):
            continue
        parts.append(f'<div class="patch-check"><h4>Patch comparison</h4><p>{_text(fix.get("result", ""))}</p>')
        for attempt in fix.get("attempts", []):
            parts.append(f'<p>Try {_text(attempt.get("try", ""))}</p>')
            for key, label in (("control", "Patch off"), ("replay_check", "Patch on")):
                if key in attempt:
                    parts.append(f"<p>{label}: {_check(attempt[key])}</p>")
            for number, check in enumerate(attempt.get("checks", []), 1):
                parts.append(f"<p>Normal check {number}: {_check(check)}</p>")
            judge = attempt.get("judge")
            if isinstance(judge, dict):
                parts.append(f'<p>Judge: {_text(judge.get("verdict", ""))}. {_text(judge.get("reason", ""))}</p>')
        parts.append(f'<p><a href="{stem}.diff">Patch diff</a></p></div>')
    return "".join(parts)


def _reads(run):
    value = _load(run / "replay-reads.json", [])
    rows = value.get("rows", []) if isinstance(value, dict) else value
    if not isinstance(rows, list) or not rows:
        return ""
    fields = list(dict.fromkeys(key for row in rows if isinstance(row, dict) for key in row))
    if not fields:
        return ""
    head = "".join(f"<th>{_text(key)}</th>" for key in fields)
    body = "".join("<tr>" + "".join(f'<td>{_text(row.get(key, ""))}</td>' for key in fields) + "</tr>"
                   for row in rows if isinstance(row, dict))
    return f"<h4>Replay reads</h4><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>"


def saved_checks(run, index, report):
    parts = []
    summary = _load(run / "replay-check/summary.json", {})
    for row in summary.get("reports", []):
        if row.get("index") != index:
            continue
        parts.append("<h4>Repeat runs</h4>")
        for attempt in row.get("tries", []):
            number = attempt.get("try")
            if type(number) is not int or number < 1:
                continue
            target = f"replay-check/report-{index}/try-{number}/strip.jpg"
            parts.append(f'<p><a href="{target}">Try {number}</a>: {_text(attempt.get("verdict", ""))}</p>')
    parts.append(_patches(run, index, report))
    if index == 0:
        parts.append(_reads(run))
    return "".join(parts)
