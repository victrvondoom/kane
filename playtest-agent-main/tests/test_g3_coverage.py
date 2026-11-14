import json
from pathlib import Path

import pytest

from test_i4_bench import fixture_run, put


def test_coverage_threshold_cli_exits_by_coverage(tmp_path, capsys):
    from bench import score

    run, key = fixture_run(tmp_path)
    result = json.loads((run / "result.json").read_text())
    reports = result["reports"]
    rows = json.loads((run / "confirm.json").read_text())
    # Four distinct bugs matched by reports at steps 4, 5, 8, and 100.
    (run / "replay_trace.json").write_text(json.dumps([
        {"step": 0, "bug_hits": {"1": True}},
        {"step": 5, "bug_hits": {"2": True}},
        {"step": 8, "bug_hits": {"3": True}},
        {"step": 100, "bug_hits": {"4": True}},
    ]))
    rows[:] = [{"step": s, "confirmed": True} for s in (4, 5, 8, 100)]
    reports[:] = [{"step": s} for s in (4, 5, 8, 100)]
    put(run, "result.json", result)
    put(run, "confirm.json", rows)
    assert score.main([str(run), "--sealed", str(key)]) == 0
    got = json.loads(capsys.readouterr().out)
    assert (got["coverage"], got["min_coverage"], got["coverage_pass"]) == (0.8, 0.8, True)


def test_coverage_failures_and_override(tmp_path, capsys):
    from bench import score

    run, key = fixture_run(tmp_path)
    (run / "replay_trace.json").write_text(json.dumps([
        {"step": 4, "bug_hits": {"1": True}},
        {"step": 5, "bug_hits": {"2": True}},
        {"step": 8, "bug_hits": {"3": True}},
    ]))
    put(run, "confirm.json", [{"step": s, "confirmed": True} for s in (4, 5, 8)])
    put(run, "result.json", {"game_id": "fake", "reports": [{"step": s} for s in (4, 5, 8)]})
    assert score.main([str(run), "--sealed", str(key)]) == 1
    got = json.loads(capsys.readouterr().out)
    assert (got["coverage"], got["coverage_pass"]) == (0.6, False)
    assert score.main([str(run), "--sealed", str(key), "--min-coverage", "0.6"]) == 0
    capsys.readouterr()


def test_false_reports_and_missing_data_exit(tmp_path, capsys):
    from bench import score

    run, key = fixture_run(tmp_path)
    clean = tmp_path / "clean"
    put(clean, "result.json", {"bugs_on": ""})
    put(clean, "confirm.json", [{"confirmed": True}])
    assert score.main([str(run), "--sealed", str(key), "--clean", str(clean)]) == 1
    capsys.readouterr()
    (run / "replay_trace.json").unlink()
    assert score.main([str(run), "--sealed", str(key)]) == 2
    assert "are needed to score coverage" in capsys.readouterr().out


def test_min_coverage_rejects_out_of_range(tmp_path):
    from bench import score

    run, key = fixture_run(tmp_path)
    with pytest.raises(SystemExit) as error:
        score.main([str(run), "--sealed", str(key), "--min-coverage", "1.5"])
    assert error.value.code == 1
