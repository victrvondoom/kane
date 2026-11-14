"""confirm_run: replay every report of a run, judge it with v2, write confirm.json and one filmstrip per report. Fakes only."""
import io
import json
import pytest
from PIL import Image
from pt import confirm as C


def jpg(c):
    b = io.BytesIO(); Image.new("RGB", (64, 36), c).save(b, "JPEG"); return b.getvalue()


class D:
    def __init__(self, bugs=""):
        self.n = 0

    def screenshot(self): return jpg((self.n * 20 % 255, 0, 0))
    def state(self): return {"x": self.n * 10, "coins": self.n}
    def execute(self, a): self.n += 1
    def bug_hits(self): return {"1": True}
    def close(self): pass


class Client:
    def __init__(self, answer): self.answer, self.calls = answer, 0

    def responses(self, inp, model=None, max_output_tokens=0, label="", reserve_usd=0, extra=None):
        self.calls += 1
        return {"output_text": self.answer, "_cost_usd": 0.02, "_latency_s": 1.0}


def run_dir(tmp_path, reports):
    d = tmp_path / "run"; d.mkdir()
    (d / "result.json").write_text(json.dumps({"kind": "hunt", "bugs_on": "1", "reports": reports, "actions_by_step": [[{"type": "wait"}]] * 8}))
    return d


def test_confirm_run_derives_gaps_from_result_log_and_passes_them(tmp_path, monkeypatch):
    run = run_dir(tmp_path, [{"title": "t", "step": 2}])
    result = json.loads((run / "result.json").read_text())
    result["log"] = [{"step": 1, "t": 2.0}, {"step": 2, "t": 5.0}]
    (run / "result.json").write_text(json.dumps(result))
    observed = []
    monkeypatch.setattr(C.R, "reproducible", lambda *a, **kw: observed.append(kw) or {
        "trace": {"frames": [jpg((0, 0, 0))], "states": [None]}, "trace_b": {},
        "reproducible": None, "comparison": {"compared": False}})
    C.confirm_run(run, Client("no"), driver_cls=D, write=False)
    assert observed[0]["gaps"] == {1: 3.0}


def test_confirm_row_includes_both_replay_pacing_lists(tmp_path, monkeypatch):
    run = run_dir(tmp_path, [{"title": "t", "step": 2}])
    monkeypatch.setattr(C.R, "reproducible", lambda *a, **kw: {
        "trace": {"frames": [jpg((0, 0, 0))], "states": [None], "paces": [{"step": 0, "gap": 1.0, "pause": 0.7}]},
        "trace_b": {"paces": [{"step": 1, "gap": 2.0, "pause": 1.5}]},
        "reproducible": None, "comparison": {"compared": False}})
    row = C.confirm_run(run, Client("no"), write=False)[0]
    assert row["pacing"] == {"a": [{"step": 0, "gap": 1.0, "pause": 0.7}],
                             "b": [{"step": 1, "gap": 2.0, "pause": 1.5}]}


def test_confirm_row_defaults_missing_pacing_to_empty_lists(tmp_path, monkeypatch):
    run = run_dir(tmp_path, [{"title": "t", "step": 2}])
    monkeypatch.setattr(C.R, "reproducible", lambda *a, **kw: {
        "trace": {"frames": [jpg((0, 0, 0))], "states": [None]}, "trace_b": {},
        "reproducible": None, "comparison": {"compared": False}})
    row = C.confirm_run(run, Client("no"), write=False)[0]
    assert row["pacing"] == {"a": [], "b": []}


def test_confirmed_report_is_written_with_strip_and_evidence(tmp_path):
    d = run_dir(tmp_path, [{"title": "t", "expected": "e", "actual": "a", "step": 5}])
    rows = C.confirm_run(d, Client('{"verdict":"YES","evidence":"coins went 0 to 5 in the last frames"}'), driver_cls=D)
    assert rows[0]["confirmed"] is True and rows[0]["reproducible"] is True
    assert "coins went" in rows[0]["evidence"] and rows[0]["cost_usd"] == 0.02
    assert (d / "strip_0.jpg").exists()
    saved = json.loads((d / "confirm.json").read_text())
    assert saved[0]["title"] == "t" and saved[0]["step"] == 5
    assert saved[0]["status"] == "confirmed"


def test_a_no_verdict_is_not_confirmed(tmp_path):
    d = run_dir(tmp_path, [{"title": "t", "expected": "e", "actual": "a", "step": 3}])
    rows = C.confirm_run(d, Client('{"verdict":"NO","evidence":"nothing wrong visible"}'), driver_cls=D)
    assert rows[0]["confirmed"] is False and rows[0]["reproducible"] is True
    assert rows[0]["status"] == "rejected"


def test_not_reproducible_skips_the_judge(tmp_path):
    class Drift(D):
        seq = 0
        def __init__(self, bugs=""):
            Drift.seq += 1
            super().__init__(bugs); self.off = 0 if Drift.seq % 2 else 50
        def state(self): return {"x": self.n * 10 + self.off, "coins": self.n}
    d = run_dir(tmp_path, [{"title": "t", "expected": "e", "actual": "a", "step": 4}])
    c = Client('{"verdict":"YES","evidence":"quoted evidence here"}')
    rows = C.confirm_run(d, c, driver_cls=Drift)
    assert rows[0]["reproducible"] is False and rows[0]["confirmed"] is False and c.calls == 0
    assert rows[0]["status"] == "rejected"


def test_no_reports_gives_an_empty_list(tmp_path):
    d = run_dir(tmp_path, [])
    assert C.confirm_run(d, Client("x"), driver_cls=D) == []
    assert json.loads((d / "confirm.json").read_text()) == []


def test_confirm_saves_elapsed_seconds_per_report(tmp_path, monkeypatch):
    d = run_dir(tmp_path, [{"title": "t", "expected": "e", "actual": "a", "step": 5}])
    ticks = iter([10.0, 12.26])
    monkeypatch.setattr(C.time, "monotonic", lambda: next(ticks))
    rows = C.confirm_run(d, Client('{"verdict":"YES","evidence":"evidence"}'), driver_cls=D)
    assert rows[0]["seconds"] == 2.3


@pytest.mark.parametrize("levels,reproducible,status,calls", [
    ((0, 0), True, "confirmed", 1), ((0, 255), False, "rejected", 0),
    ((None, None), None, "not compared", 0)])
def test_picture_comparison_controls_confirmation(tmp_path, monkeypatch, levels, reproducible, status, calls):
    traces = iter({"states": [None], "frames": [jpg((v,) * 3)] if v is not None else []}
                  for v in levels)
    monkeypatch.setattr(C.R, "replay_trace", lambda *args, **kwargs: next(traces))
    run = run_dir(tmp_path, [{"title": "t", "step": 1}])
    client = Client('{"verdict":"YES","evidence":"the door remains closed in both"}')
    row = C.confirm_run(run, client)[0]
    assert row["reproducible"] is reproducible
    assert row["status"] == status and client.calls == calls
    assert row["comparison"]["method"] == ("none" if reproducible is None else "pictures")
    assert row["cost_usd"] == (.02 if calls else 0)
    assert row["confirmed"] is bool(calls)
    assert (run / "strip_0_b.jpg").exists() is bool(calls)


def test_state_confirmation_keeps_second_strip(tmp_path):
    run = run_dir(tmp_path, [{"title": "t", "step": 1}])
    row = C.confirm_run(run, Client('{"verdict":"YES","evidence":"coins change in both replays"}'), driver_cls=D)[0]
    assert row["comparison"] == {"compared": True, "method": "state", "same": True}
    assert (run / "strip_0_b.jpg").is_file()


@pytest.mark.parametrize("judge_input", ["strip", "video"])
def test_named_refused_input_stops_confirmation(tmp_path, monkeypatch, judge_input):
    run = run_dir(tmp_path, [{"title": "Escape does not close Draw Pile view", "expected": "Escape stays open", "actual": "Escape is ignored", "step": 1}])
    traces = iter([
        {"frames": [jpg((0, 0, 0)), jpg((1, 1, 1))], "states": [{"x": 0}, {"x": 1}], "bug_hits": None,
         "refused": [{"step": 1, "note": "key refused: escape, allowed: enter, esc"}]},
        {"frames": [jpg((0, 0, 0)), jpg((1, 1, 1))], "states": [{"x": 0}, {"x": 1}], "bug_hits": None, "refused": []},
    ])
    def replay(*args, **kwargs): return next(traces)
    monkeypatch.setattr(C.R, "replay_trace", replay)
    client = Client('{"verdict":"YES","evidence":"yes"}')
    row = C.confirm_run(run, client, judge_input=judge_input)[0]
    assert row["status"] == "input refused in replay"
    assert row["refused_inputs"] == ["escape"] and row["confirmed"] is False
    assert row["cost_usd"] == 0.0 and client.calls == 0
    assert not (run / "strip_0.jpg").exists()


def test_refusal_outside_report_words_does_not_stop_confirmation(tmp_path, monkeypatch):
    run = run_dir(tmp_path, [{"title": "Planisphere heals twice", "step": 1}])
    traces = iter([{"frames": [jpg((0, 0, 0)), jpg((1, 1, 1))], "states": [{"x": 0}, {"x": 1}], "refused": [{"step": 1, "note": "key refused: escape, allowed: enter"}]},
                   {"frames": [jpg((0, 0, 0)), jpg((1, 1, 1))], "states": [{"x": 0}, {"x": 1}], "refused": []}])
    monkeypatch.setattr(C.R, "replay_trace", lambda *a, **k: next(traces))
    client = Client('{"verdict":"YES","evidence":"yes"}')
    row = C.confirm_run(run, client)[0]
    assert row["status"] == "rejected" and row["refused_inputs"] == [] and client.calls == 1
