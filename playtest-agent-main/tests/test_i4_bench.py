import ast
import json
from pathlib import Path

import pytest


def put(folder, name, value):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / name).write_text(json.dumps(value), encoding="utf-8")


def fixture_run(tmp_path):
    run = tmp_path / "hunt"
    key = tmp_path / "SEALED-bugs.json"
    key.write_text(json.dumps({"bugs": [{"id": str(i)} for i in range(1, 6)]}), encoding="utf-8")
    put(run, "result.json", {"game_id": "fake", "bug_hits": {"1": True, "2": True, "3": False},
                             "reports": [{"step": s} for s in (4, 5, 3, 20, 8, 4)]})
    put(run, "confirm.json", [{"step": s, "confirmed": c} for s, c in
                              ((4, True), (5, True), (3, True), (20, True), (8, False), (4, True))])
    put(run, "replay_trace.json", [{"step": 3, "bug_hits": {"1": False, "2": False}},
                                    {"step": 4, "bug_hits": {"1": True, "2": False}},
                                    {"step": 8, "bug_hits": {"1": True, "2": True}}])
    return run, key


def test_scoring_timing_duplicates_false_and_clean(tmp_path):
    from bench.score import score
    run, key = fixture_run(tmp_path)
    clean = tmp_path / "clean"
    put(clean, "result.json", {"bugs_on": "", "reports": [{"step": 1}]})
    put(clean, "confirm.json", [{"step": 1, "confirmed": True}])
    got = score(run, sealed_path=key, clean=clean, window_steps=3)
    assert got["found_confirmed"] == 1
    assert got["planted"] == 5
    assert got["false_reports"] == 2
    assert got["clean_false_reports"] == 1
    assert got["matched_bug_ids"] == ["1"]
    assert json.loads((run / "score.json").read_text()) == got


def test_flag_only_fallback_is_explicit(tmp_path):
    from bench.score import score
    run, key = fixture_run(tmp_path)
    (run / "replay_trace.json").unlink()
    got = score(run, sealed_path=key)
    assert got["found_confirmed"] is None
    assert got["flags_fired"] == ["1", "2"]
    assert got["needs"] == "hand grades in bench/fake/grades/hunt.json"
    assert got["false_reports"] is None
    assert all(m["bug_id"] is None and m["candidates"] == [] for m in got["matches"])
    assert "flag-only" in got["timing"]
    assert got["clean_false_reports"] is None


def hand_graded_run(tmp_path, monkeypatch):
    from bench import score
    monkeypatch.setattr(score, "ROOT", tmp_path)
    run, key = fixture_run(tmp_path)
    (run / "replay_trace.json").unlink()
    reports = [{"title": f"Report {i}", "step": i} for i in range(5)]
    put(run, "result.json", {"game_id": "holdout", "reports": reports,
                              "bug_hits": {str(i): True for i in range(1, 6)}})
    put(run, "confirm.json", [{**r, "confirmed": i != 4} for i, r in enumerate(reports)])
    clean = tmp_path / "clean"
    put(clean, "result.json", {"bugs_on": "", "reports": [{"title": "Clean report"}]})
    put(clean, "confirm.json", [{"title": "Clean report", "confirmed": True}])
    grades = {"run": "hunt", "clean_run": "clean", "reports": [
        {"index": i, "title": r["title"], "confirmed": i != 4, "bug_id": bug}
        for i, (r, bug) in enumerate(zip(reports, [1, 4, None, 5, 3]))],
        "clean_reports": [{"index": 0, "title": "Clean report", "confirmed": True, "bug_id": None}],
        "planted": 5, "found_confirmed": 3, "found_ids": [1, 4, 5],
        "reported_not_confirmed_ids": [3], "missed_ids": [2],
        "false_reports": 1, "clean_false_reports": 1}
    folder = tmp_path / "bench" / "holdout" / "grades"
    put(folder, "hunt.json", grades)
    return run, key, clean, folder, grades


def test_all_flags_are_not_findings(tmp_path):
    from bench.score import score
    run, key = fixture_run(tmp_path)
    (run / "replay_trace.json").unlink()
    put(run, "result.json", {"game_id": "fake", "bug_hits": dict.fromkeys("12345", True),
                              "reports": [{"title": "Unrelated complaint"}] * 6})
    got = score(run, sealed_path=key)
    assert got["found_confirmed"] is None
    assert got["flags_fired"] == list("12345")


def test_hand_grades_supply_printed_score(tmp_path, monkeypatch, capsys):
    from bench import score
    run, key, clean, _, _ = hand_graded_run(tmp_path, monkeypatch)
    assert score.main([str(run), "--sealed", str(key), "--clean", str(clean)]) == 1
    got = json.loads(capsys.readouterr().out)
    assert (got["found_confirmed"], got["false_reports"], got["clean_false_reports"]) == (3, 1, 1)
    assert got["source"] == "hand grades"
    assert got["matched_bug_ids"] == ["1", "4", "5"]


@pytest.mark.parametrize("problem", ["missing", "extra", "duplicate", "title", "confirmed", "bug_id", "totals", "clean"])
def test_invalid_hand_grades_fail(tmp_path, monkeypatch, problem):
    from bench.score import score
    run, key, clean, folder, grades = hand_graded_run(tmp_path, monkeypatch)
    if problem == "missing":
        grades["reports"].pop(0)
    elif problem == "extra":
        grades["reports"].append({**grades["reports"][0], "index": 9})
    elif problem == "duplicate":
        grades["reports"].append(grades["reports"][0])
    elif problem in ("title", "confirmed", "bug_id"):
        grades["reports"][0][problem] = {"title": "Other run", "confirmed": False, "bug_id": 99}[problem]
    elif problem == "totals":
        grades["found_confirmed"] = 5
    else:
        grades["clean_reports"] = []
    put(folder, "hunt.json", grades)
    with pytest.raises(ValueError, match="Hand grades.*" + ("report index" if problem in ("missing", "extra", "duplicate", "clean") else "")):
        score(run, sealed_path=key, clean=clean)


def test_sealed_key_is_opened_only_in_scorer():
    root = Path(__file__).resolve().parents[1]
    users = []
    for package in ("bench", "pt"):
        for path in (root / package).rglob("*.py"):
            if "holdout" in path.relative_to(root).parts:
                continue
            tree = ast.parse(path.read_text(encoding="utf-8"))
            if any(isinstance(node, ast.Constant) and isinstance(node.value, str)
                   and "SEALED-bugs.json" in node.value for node in ast.walk(tree)):
                users.append(path.relative_to(root).as_posix())
    assert users == ["bench/score.py"]


def test_runner_uses_normal_cli_and_identical_hunt_prompt(tmp_path, monkeypatch, capsys):
    from bench import run, score
    from pt import cli
    seen = []
    prompts = []
    def fake_main(args):
        parsed = cli.parse(args)
        seen.append(parsed)
        if parsed.cmd == "hunt":
            prompts.append(cli.run_settings(parsed, "ignored", reload=True)["goal"].encode())
        return 0
    monkeypatch.setattr(cli, "main", fake_main)
    monkeypatch.setattr(score, "main", lambda args: 0)
    monkeypatch.setattr(run, "RUNS", tmp_path)
    assert run.main(["holdout", "--name", "ho1", "--max-steps", "37", "--notes", "--model", "glimmer-local"]) == 0
    assert [a.cmd for a in seen] == ["hunt", "confirm", "hunt", "confirm"]
    assert seen[0].bugs == "1,2,3,4,5"
    assert seen[2].clean and seen[2].bugs == ""
    assert seen[1].model == seen[3].model == "glimmer-local"
    normal = cli.parse(["hunt", "ordinary", "--game", "holdout", "--max-steps", "37", "--notes", "--model", "glimmer-local"])
    expected = cli.run_settings(normal, "ignored", reload=True)["goal"].encode()
    assert prompts == [expected, expected]
    assert "-m pt hunt" in capsys.readouterr().out


def test_runner_stops_on_cli_failure(tmp_path, monkeypatch):
    from bench import run
    from pt import cli
    seen = []
    monkeypatch.setattr(run, "RUNS", tmp_path)
    monkeypatch.setattr(cli, "main", lambda args: seen.append(args) or 1)
    assert run.main(["holdout", "--name", "failed"]) == 1
    assert len(seen) == 1


def test_real_cli_prompt_bytes_with_fake_client(tmp_path, monkeypatch):
    import copy
    from bench import run, score
    from pt import adapter, cli, guard
    from trials import common

    bodies = []
    class Client:
        def wonder(self, body, **kwargs):
            bodies.append(copy.deepcopy(body))
            return {"id": "fake", "output": [{"type": "function_call", "name": "act", "call_id": "a",
                     "arguments": '{"actions": [{"type": "wait"}]}'}],
                    "usage": {"input_tokens": 1}, "_cost_usd": 0, "_latency_s": 0}

    class Driver:
        controls, name, goal = "arrows", "Fake", "Walk"
        def screenshot(self): return b"fake image"
        def execute(self, actions): pass
        def state(self): return {}
        def won(self): return False
        def bug_hits(self): return {}
        def close(self): pass
        def reload(self): pass

    monkeypatch.setattr(cli, "ROOT", tmp_path)
    monkeypatch.setattr(run, "RUNS", tmp_path / "data" / "runs")
    monkeypatch.setattr(adapter, "make", lambda *a, **kw: Driver())
    monkeypatch.setattr(common, "load_client", lambda *a: Client())
    monkeypatch.setattr(guard, "problems", lambda *a: [])
    monkeypatch.setattr(guard, "take_lock", lambda: None)
    monkeypatch.setattr(guard, "release_lock", lambda: None)
    monkeypatch.setattr(guard, "must_stop", lambda *a: False)
    key = tmp_path / "fake-key.json"
    key.write_text(json.dumps({"bugs": list("12345")}))
    def fake_key_score(args):
        score.score(args[0], clean=args[2], sealed_path=key)
        return 0
    monkeypatch.setattr(score, "main", fake_key_score)
    assert cli.main(["hunt", "direct", "--game", "holdout", "--bugs", "1,2,3,4,5", "--max-steps", "1"]) == 0
    assert run.main(["holdout", "--name", "bench1", "--max-steps", "1"]) == 0
    assert len(bodies) == 3
    prompts = [json.dumps({"instructions": body["instructions"], "input": body["input"]},
                          ensure_ascii=False).encode("utf-8") for body in bodies]
    assert prompts[0] == prompts[1] == prompts[2]


def test_scorer_cli_prints_the_written_score(tmp_path, capsys):
    from bench import score
    run, key = fixture_run(tmp_path)
    assert score.main([str(run), "--sealed", str(key), "--window-steps", "3"]) == 1
    assert json.loads(capsys.readouterr().out) == json.loads((run / "score.json").read_text())


def test_clean_build_is_verified(tmp_path):
    from bench.score import score
    run, key = fixture_run(tmp_path)
    clean = tmp_path / "clean"
    put(clean, "result.json", {"bugs_on": "1"})
    put(clean, "confirm.json", [])
    with pytest.raises(ValueError, match="clean run"):
        score(run, sealed_path=key, clean=clean)


def test_multiple_distinct_bugs_count_once_each(tmp_path):
    from bench.score import score
    run, key = fixture_run(tmp_path)
    put(run, "confirm.json", [{"step": 4, "confirmed": True}, {"step": 8, "confirmed": True},
                              {"step": 8, "confirmed": True}, {"step": 20, "confirmed": True},
                              {"step": 4, "confirmed": True, "reproducible": False}])
    got = score(run, sealed_path=key, window_steps=3)
    assert got["found_confirmed"] == 2
    assert got["false_reports"] == 1


@pytest.mark.parametrize("flags", [["--bugs", "2"], ["--clean"], ["--game=holdout"]])
def test_runner_refuses_changed_benchmark_flags(flags):
    from bench.run import main
    with pytest.raises(SystemExit) as error:
        main(["holdout", "--name", "example", *flags])
    assert error.value.code == 2


def test_runner_refuses_existing_run(tmp_path, monkeypatch):
    from bench import run
    monkeypatch.setattr(run, "RUNS", tmp_path)
    (tmp_path / "existing-clean").mkdir()
    with pytest.raises(SystemExit) as error:
        run.main(["holdout", "--name", "existing"])
    assert error.value.code == 2
