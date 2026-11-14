"""Collect confirmed reports and build reviewable issue proposals."""
import html
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from metaclient.client import output_text

FAMILY = {"cave-courier", "cave-courier-art", "cave-courier-buggy", "cave-courier-sam"}
STOP = set("a an and are as at be been being by can could did do does for from had has have he her his i if in into is it its may might of on or our she should that the their them then there these they this those to was we were what when where which while who will with would you your".split())
PROMPT = ('Decide whether these two reports likely describe the same game defect, based only on their wording. '
          'Return strict JSON only: {{"same":"yes"|"no"|"unsure","why":"one line quoting both reports"}}.\n'
          'Report A: {a}\nReport B: {b}')


def collect(run_folders):
    occurrences, left_out = [], []
    for folder_arg in run_folders:
        folder = Path(folder_arg)
        result = json.loads((folder / "result.json").read_text(encoding="utf-8"))
        confirms = json.loads((folder / "confirm.json").read_text(encoding="utf-8")) if (folder / "confirm.json").is_file() else []
        game_id = result.get("game_id") or result.get("game") or "unknown"
        for i, report in enumerate(result.get("reports", [])):
            row = confirms[i] if i < len(confirms) and isinstance(confirms[i], dict) else {}
            confirmed = row.get("confirmed") is True and row.get("status") != "rejected"
            reproducible = row.get("reproducible") is not False
            item = {"run": folder.name, "index": i, "title": row.get("title", report.get("title", "")),
                    "expected": row.get("expected", report.get("expected", "")), "actual": row.get("actual", report.get("actual", "")),
                    "evidence": row.get("evidence", ""), "state_change": row.get("state_change", []),
                    "step": row.get("step", report.get("step")), "game_id": game_id}
            if confirmed and reproducible:
                occurrences.append(item)
            else:
                reason = "rejected" if row.get("status") == "rejected" or row.get("confirmed") is False else (
                    "not reproducible" if row.get("reproducible") is False else "unverified")
                left_out.append({**item, "reason": reason})
    return occurrences, left_out


def _words(occ):
    return {w for w in re.findall(r"[a-z0-9]+", (str(occ.get("title", "")) + " " + str(occ.get("actual", ""))).lower()) if w not in STOP}


def _family(game):
    return "cave-courier" if game in FAMILY else game


def _parse_answer(raw):
    try:
        obj = json.loads(raw)
        if isinstance(obj, dict) and obj.get("same") in ("yes", "no", "unsure") and isinstance(obj.get("why"), str):
            return obj["same"], obj["why"].strip()
    except (TypeError, ValueError):
        pass
    return "unsure", "Spark returned invalid JSON."


def propose(occurrences, client=None, max_calls=8):
    occurrences = [dict(o) for o in occurrences]
    edges, calls = [], []
    call_count = 0
    for i, a in enumerate(occurrences):
        for j in range(i + 1, len(occurrences)):
            b = occurrences[j]
            if _family(a.get("game_id")) != _family(b.get("game_id")):
                continue
            aw, bw = _words(a), _words(b)
            score = len(aw & bw) / len(aw | bw) if aw | bw else 1.0
            if score >= .6:
                status, why = "same", f"Word overlap score {score:.2f} (at least 0.60)."
            elif score < .2:
                status, why = "different", f"Word overlap score {score:.2f} (below 0.20)."
            else:
                status, why = "unsure", f"Word overlap score {score:.2f}; wording is inconclusive."
                if client is not None and call_count < max_calls:
                    label = f"issues:{a.get('run')}:{b.get('run')}"
                    response = client.responses(PROMPT.format(a=json.dumps(a, ensure_ascii=False), b=json.dumps(b, ensure_ascii=False)),
                                                max_output_tokens=2000, label=label,
                                                extra={"reasoning": {"effort": "low"}})
                    call_count += 1
                    answer, model_why = _parse_answer(output_text(response))
                    calls.append({"label": label, "same": answer, "why": model_why})
                    status, why = ("same" if answer == "yes" else "different" if answer == "no" else "unsure"), model_why
            edges.append((i, j, status, why))
    parent = list(range(len(occurrences)))
    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for i, j, status, _ in edges:
        if status == "same":
            parent[root(j)] = root(i)
    members = {}
    for i in range(len(occurrences)):
        members.setdefault(root(i), []).append(i)
    ordered = list(members.values())
    group_for = {i: f"G{n}" for n, group in enumerate(ordered, 1) for i in group}
    groups = []
    for n, indexes in enumerate(ordered, 1):
        why = [reason for i, j, state, reason in edges if state == "same" and i in indexes and j in indexes]
        unsure = set()
        for i, j, state, _ in edges:
            if state == "unsure" and ((i in indexes) != (j in indexes)):
                unsure.add(group_for[j if i in indexes else i])
        groups.append({"id": f"G{n}", "status": "proposed", "occurrences": [occurrences[i] for i in indexes],
                       "why": why, "unsure_with": sorted(unsure, key=lambda x: int(x[1:]))})
    return groups, calls


def _load(folder):
    path = Path(folder) / "issues.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    return path, data


def _html(groups):
    cards = []
    for group in groups:
        occ = group["occurrences"]
        titles = ", ".join(html.escape(str(x.get("title", ""))) for x in occ)
        details = []
        for x in occ:
            run = html.escape(str(x.get("run", "")))
            evidence = html.escape(str(x.get("evidence", "")))
            details.append(f'<li>{run}, step {html.escape(str(x.get("step", "")))}: “{evidence}” <a href="../{run}/report.html">Run report</a></li>')
        cards.append(f'<article><h2>{html.escape(group["id"])}: {titles}</h2><p>Proposed: not a proven shared cause</p><ul>{"".join(details)}</ul></article>')
    return '<!doctype html><meta charset="utf-8"><title>Proposed issues</title><h1>Proposed issues</h1>' + "\n".join(cards)


def write(folder, groups, left_out, calls):
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "issues.json").write_text(json.dumps({"groups": groups, "left_out": left_out, "calls": calls}, indent=2, ensure_ascii=False), encoding="utf-8")
    (folder / "issues.html").write_text(_html(groups), encoding="utf-8")
    return folder / "issues.html"


def accept(folder, group_id, by):
    path, data = _load(folder)
    group = next((g for g in data["groups"] if g["id"] == group_id), None)
    if group is None:
        raise ValueError("Unknown group " + group_id)
    group.update({"status": "accepted", "by": by, "time": datetime.now(timezone.utc).isoformat()})
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    (Path(folder) / "issues.html").write_text(_html(data["groups"]), encoding="utf-8")


def split(folder, group_id, occurrence):
    path, data = _load(folder)
    group = next((g for g in data["groups"] if g["id"] == group_id), None)
    if group is None:
        raise ValueError("Unknown group " + group_id)
    match = next((o for o in group["occurrences"] if f'{o.get("run")}:{o.get("index")}' == occurrence), None)
    if match is None:
        raise ValueError("Occurrence is not in " + group_id)
    group["occurrences"].remove(match)
    next_id = "G" + str(max([int(g["id"][1:]) for g in data["groups"] if re.fullmatch(r"G\d+", g["id"])] or [0]) + 1)
    data["groups"].append({"id": next_id, "status": "proposed", "occurrences": [match], "why": [], "unsure_with": []})
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    (Path(folder) / "issues.html").write_text(_html(data["groups"]), encoding="utf-8")
