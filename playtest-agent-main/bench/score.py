"""Score confirmed reports against the sealed planted bug ids."""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MATCH_WINDOW_STEPS = 5
MIN_COVERAGE = 0.8  # 80%: the hunt bar, 4 of 5 planted bugs


def read_json(path):
    return Path(path).read_text(encoding="utf-8")


def bug_ids(sealed_path):
    key = json.loads(read_json(sealed_path))
    bugs = key.get("bugs", key) if isinstance(key, dict) else key
    ids = list(bugs) if isinstance(bugs, dict) else [b["id"] if isinstance(b, dict) else b for b in bugs]
    ids = [str(ident) for ident in ids]
    if len(ids) != 5 or len(set(ids)) != 5:
        raise ValueError("The benchmark key must contain five distinct bug ids")
    return ids


def confirmed(row):
    return row.get("reproducible") is not False and (row.get("confirmed") is True or
           ("confirmed" not in row and row.get("status") == "confirmed"))


def hit_steps(run, result):
    """Only explicit per-step hit flags establish timing. Final trace flags cannot."""
    path = run / "replay_trace.json"
    trace = json.loads(read_json(path)) if path.is_file() else result.get("replay_trace")
    if trace is None:
        return None
    if isinstance(trace, dict):
        trace = trace.get("steps", [])
    hits = {}
    timed = False
    for entry in trace:
        step = entry.get("step")
        flags = entry.get("bug_hits", entry.get("__bugHit"))
        if not isinstance(step, int) or isinstance(step, bool) or step < 0 or not isinstance(flags, dict):
            raise ValueError("Replay trace entries need a nonnegative step and bug_hits flags")
        timed = True
        for ident, value in flags.items():
            if value is True:
                hits[str(ident)] = min(step, hits.get(str(ident), step))
    return hits if timed else None


def score(run, *, sealed_path=None, clean=None, window_steps=MATCH_WINDOW_STEPS,
          min_coverage=MIN_COVERAGE):
    if window_steps < 0:
        raise ValueError("The match window must be nonnegative")
    if not 0 <= min_coverage <= 1:
        raise ValueError("Minimum coverage must be between 0 and 1")
    run = Path(run)
    result = json.loads(read_json(run / "result.json"))
    rows = json.loads(read_json(run / "confirm.json"))
    if sealed_path is None:
        game = result.get("game_id")
        if game not in ("holdout", "cave-courier"):
            raise ValueError("Give sealed_path for this game")
        filename = "SEALED-bugs.json" if game == "holdout" else "bugs.json"
        sealed_path = ROOT / "bench" / game / filename
    ids = bug_ids(sealed_path)
    hits = hit_steps(run, result)
    flags = result.get("bug_hits") or {}
    matches, found = [], set()
    for index, row in enumerate(rows):
        if not confirmed(row):
            continue
        report = result.get("reports", [])[index] if index < len(result.get("reports", [])) else {}
        step = row.get("step", report.get("step"))
        if hits is None:
            candidates = []
        else:
            if not isinstance(step, int) or isinstance(step, bool) or step < 0:
                raise ValueError("Confirmed reports need a nonnegative step for timed scoring")
            candidates = [ident for ident in ids if ident in hits and 0 <= step - hits[ident] <= window_steps]
            candidates.sort(key=lambda ident: step - hits[ident])
        # One report credits at most one bug. A repeated report may credit the same bug again.
        match = candidates[0] if candidates else None
        if match is not None:
            found.add(match)
        matches.append({"report_index": index, "step": step, "bug_id": match, "candidates": candidates})
    clean_false = None
    if clean is not None:
        clean = Path(clean)
        clean_result = json.loads(read_json(clean / "result.json"))
        if clean_result.get("bugs_on") != "":
            raise ValueError("The clean run must have bugs_on set to an empty string")
        clean_false = sum(confirmed(row) for row in json.loads(read_json(clean / "confirm.json")))
    scored = {"run": str(run), "clean_run": str(clean) if clean is not None else None,
              "planted": len(ids), "found_confirmed": len(found) if hits is not None else None,
              "matched_bug_ids": [i for i in ids if i in found],
              "false_reports": sum(m["bug_id"] is None for m in matches) if hits is not None else None,
              "clean_false_reports": clean_false, "flags_fired": [i for i in ids if flags.get(i) is True],
              "window_steps": window_steps, "timing": "replay trace" if hits is not None else
              "flag-only: hit steps unavailable; timing and report attribution cannot be verified",
              "matches": matches}
    game = result.get("game_id", "unknown")
    if not isinstance(game, str) or Path(game).name != game or game in (".", ".."):
        raise ValueError("The game id must be a single folder name")
    grades_name = f"bench/{game}/grades/{run.name}.json"
    grades_path = ROOT / grades_name
    if grades_path.is_file():
        from bench.grades import hand_score
        scored.update(hand_score(grades_path, ROOT, run, result, rows, ids, clean))
    elif hits is None:
        scored["needs"] = "hand grades in " + grades_name
    found_confirmed = scored["found_confirmed"]
    scored["coverage"] = round(found_confirmed / scored["planted"], 3) if found_confirmed is not None else None
    scored["min_coverage"] = min_coverage
    scored["coverage_pass"] = scored["coverage"] >= min_coverage if scored["coverage"] is not None else None
    (run / "score.json").write_text(json.dumps(scored, indent=2) + "\n", encoding="utf-8")
    return scored


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", nargs="?", default=str(ROOT / "data" / "runs" / "ho1"))
    parser.add_argument("--clean")
    parser.add_argument("--sealed", type=Path)
    parser.add_argument("--window-steps", type=int, default=MATCH_WINDOW_STEPS)
    parser.add_argument("--min-coverage", type=float, default=MIN_COVERAGE)
    args = parser.parse_args(argv)
    clean = args.clean
    if clean is None:
        sibling = Path(args.run).with_name(Path(args.run).name + "-clean")
        if sibling.is_dir():
            clean = sibling
    try:
        scored = score(args.run, sealed_path=args.sealed, clean=clean, window_steps=args.window_steps,
                       min_coverage=args.min_coverage)
    except (OSError, ValueError, KeyError) as error:
        parser.exit(1, str(error) + "\n")
    print(json.dumps(scored, indent=2))
    if scored["coverage_pass"] is None:
        print(scored["needs"] + " are needed to score coverage.")
        return 2
    return 1 if (not scored["coverage_pass"] or scored["false_reports"] > 0 or
                 (scored["clean_false_reports"] or 0) > 0) else 0


if __name__ == "__main__":
    raise SystemExit(main())
