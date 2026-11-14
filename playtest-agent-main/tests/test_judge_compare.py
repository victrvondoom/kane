import json

import pytest

from metaclient.local import LocalClient
from pt import replay
from trials import judge_compare as C
from test_judge import jpg


def row(group, ident, yes, seconds=1):
    return {"set": group, "id": ident, "title": ident, "judge_yes": yes, "confirmed": yes, "seconds": seconds}


def test_compare_matches_by_set_and_id():
    spark = [row("true8", "a", True), row("true8", "b", False), row("neg8", "a", False), row("false6", "c", False)]
    glimmer = [row("false6", "c", False, 4), row("neg8", "a", True, 3), row("true8", "b", False, 2), row("true8", "a", False, 1)]
    result = C.compare(spark, glimmer)
    assert result["summary"] == {"agreement": 2, "total": 4, "misses": 1, "false_alarms": 1, "mean_seconds": 2.5}
    assert [r["agree"] for r in result["rows"]] == [False, True, False, True]
    assert result["rows"][0]["spark"] is True and result["rows"][0]["glimmer"] is False
    assert C.compare([], [])["summary"]["mean_seconds"] == 0


def test_compare_rejects_missing_or_duplicate_rows():
    with pytest.raises(ValueError):
        C.compare([row("true8", "a", True)], [])
    with pytest.raises(ValueError):
        C.compare([row("true8", "a", True)] * 2, [row("true8", "a", True)])


@pytest.fixture
def saved_inputs(tmp_path, monkeypatch):
    monkeypatch.setattr(C, "ROOT", tmp_path)
    rows = []
    reports = [{"title": f"Report {i}", "expected": "Change", "actual": "Same", "step": i} for i in range(8)]
    run = tmp_path / "data/runs/hunt1"
    run.mkdir(parents=True)
    (run / "result.json").write_text(json.dumps({"reports": reports}))
    docs = tmp_path / "docs"
    (docs / "receipts").mkdir(parents=True)
    claims = [{"run": "hunt1", "step": i + 10, "title": f"Claim {i}", "expected": "Same", "actual": "Change"} for i in range(6)]
    (docs / "false-claims.json").write_text(json.dumps({"claims": claims}))
    for group, count in (("true8", 8), ("neg8", 8), ("false6", 6)):
        for i in range(count):
            ident = f"hunt1:{i if group != 'false6' else i + 10}"
            rows.append(row(group, ident, group == "true8"))
            replay.save_trace({"frames": [jpg((0, 0, 0))], "states": [{"coins": 1}], "reproducible": True},
                              tmp_path / "data/judge_traces" / (group + "_" + ident.replace(":", "_")))
    (docs / "receipts/judge-eval.json").write_text(json.dumps({"rows": rows}))
    return tmp_path


def test_main_with_fake_client(saved_inputs, monkeypatch, capsys):
    calls, constructors = [], []
    def http(url, payload, timeout):
        calls.append(payload)
        return {"choices": [{"message": {"role": "assistant", "content": '{"verdict":"NO","evidence":"Coins stayed at one"}'}}]}
    def client(**kwargs):
        constructors.append(kwargs)
        return LocalClient(http=http, **kwargs)
    monkeypatch.setattr(C, "LocalClient", client)
    assert C.main(["--url", "http://localhost:8090/v1", "--reasoning", "high"]) == 0
    receipt = json.loads((saved_inputs / "docs/receipts/judge-glimmer.json").read_text())
    assert receipt["model"] == "glimmer-local" and len(receipt["rows"]) == 22
    assert receipt["summary"]["agreement"] == 14 and receipt["summary"]["misses"] == 8
    assert receipt["summary"]["false_alarms"] == 0 and receipt["summary"]["mean_seconds"] >= 0
    assert len(calls) == 22 and all(p["chat_template_kwargs"]["reasoning_strength"] == "high" for p in calls)
    assert "Expected: Change" in calls[0]["messages"][0]["content"][0]["text"]
    assert "coins: 1 -> 1" in calls[0]["messages"][0]["content"][0]["text"]
    output = capsys.readouterr().out
    assert all(word in output for word in ("Spark", "Glimmer", "agree", "true8", "neg8", "false6", "14/22"))
    assert constructors[0]["reasoning"] == "high"


def test_missing_trace_fails_before_client(saved_inputs, monkeypatch):
    trace = saved_inputs / "data/judge_traces/false6_hunt1_15/meta.json"
    trace.unlink()
    monkeypatch.setattr(C, "LocalClient", lambda **kw: pytest.fail("client started"))
    monkeypatch.setattr(replay, "reproducible", lambda *a, **kw: pytest.fail("replay started"))
    with pytest.raises(FileNotFoundError, match="false6_hunt1_15"):
        C.main([])
    assert not (saved_inputs / "docs/receipts/judge-glimmer.json").exists()
