"""Validate report attribution supplied by a human grader."""
import json
from pathlib import Path


def graded_rows(grades, rows, reports, ids, label):
    if not isinstance(grades, list) or len(rows) != len(reports):
        raise ValueError(f"Hand grades {label}: report index coverage does not match the run")
    indexed = {}
    for grade in grades:
        if not isinstance(grade, dict):
            raise ValueError(f"Hand grades {label}: expected a report row")
        index = grade.get("index")
        if type(index) is not int or index < 0 or index >= len(rows) or index in indexed:
            raise ValueError(f"Hand grades {label}: extra or duplicate report index {index}")
        indexed[index] = grade
    if set(indexed) != set(range(len(rows))):
        raise ValueError(f"Hand grades {label}: missing report index")
    from bench.score import confirmed
    matches, unconfirmed = [], set()
    for index, row in enumerate(rows):
        grade = indexed[index]
        title = reports[index].get("title", "")
        if grade.get("title") != title or row.get("title", title) != title:
            raise ValueError(f"Hand grades {label}: title differs at report index {index}")
        if grade.get("confirmed") is not confirmed(row):
            raise ValueError(f"Hand grades {label}: confirmed status differs at report index {index}")
        if "bug_id" not in grade:
            raise ValueError(f"Hand grades {label}: missing bug_id at report index {index}")
        bug = grade["bug_id"]
        if bug is not None and (type(bug) not in (int, str) or str(bug) not in ids):
            raise ValueError(f"Hand grades {label}: unknown bug_id at report index {index}")
        bug = str(bug) if bug is not None else None
        if confirmed(row):
            matches.append({"report_index": index, "step": row.get("step", reports[index].get("step")),
                            "bug_id": bug, "candidates": []})
        elif bug is not None:
            unconfirmed.add(bug)
    return matches, unconfirmed


def hand_score(path, root, run, result, rows, ids, clean):
    grades = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(grades, dict):
        raise ValueError("Hand grades must be an object")
    def run_path(field):
        value = grades.get(field)
        if not isinstance(value, str) or not value:
            raise ValueError(f"Hand grades need {field}")
        return (root / value).resolve()
    if run_path("run") != run.resolve():
        raise ValueError("Hand grades run path does not match the run")
    matches, unconfirmed = graded_rows(grades.get("reports"), rows, result.get("reports", []), ids, "reports")
    found = {m["bug_id"] for m in matches if m["bug_id"] is not None}
    clean_path = grades.get("clean_run")
    clean_false = None
    if clean_path is not None or clean is not None:
        graded_clean = run_path("clean_run")
        if clean is not None and graded_clean != Path(clean).resolve():
            raise ValueError("Hand grades clean_run path does not match the clean run")
        clean = graded_clean
        clean_result = json.loads((clean / "result.json").read_text(encoding="utf-8"))
        clean_rows = json.loads((clean / "confirm.json").read_text(encoding="utf-8"))
        if clean_result.get("bugs_on") != "":
            raise ValueError("Hand grades clean run must have bugs_on set to an empty string")
        clean_matches, _ = graded_rows(grades.get("clean_reports"), clean_rows,
                                       clean_result.get("reports", []), [], "clean reports")
        clean_false = len(clean_matches)
    elif grades.get("clean_reports", []) != []:
        raise ValueError("Hand grades clean reports need a clean run")
    expected = {"planted": len(ids), "found_confirmed": len(found),
                "false_reports": sum(m["bug_id"] is None for m in matches),
                "clean_false_reports": clean_false}
    for field, value in expected.items():
        actual = grades.get(field)
        if field not in grades or actual != value or (value is not None and type(actual) is not int):
            raise ValueError(f"Hand grades total {field} does not match the rows")
    for field, value in {"found_ids": found, "reported_not_confirmed_ids": unconfirmed - found,
                         "missed_ids": set(ids) - found - unconfirmed}.items():
        actual = grades.get(field)
        if (not isinstance(actual, list) or any(type(i) not in (int, str) for i in actual)
                or len(actual) != len(value) or {str(i) for i in actual} != value):
            raise ValueError(f"Hand grades total {field} does not match the rows")
    return {**expected, "source": "hand grades", "matches": matches,
            "matched_bug_ids": [i for i in ids if i in found],
            "clean_run": str(clean) if clean is not None else None}
