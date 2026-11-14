from pt import replay as R
import io

import pytest
from PIL import Image


def picture(level):
    stream = io.BytesIO()
    Image.new("RGB", (128, 72), (level,) * 3).save(stream, "PNG")
    return stream.getvalue()


@pytest.mark.parametrize("a,b,expected", [
    (10, 12, {"compared": True, "method": "pictures", "same": True, "difference": 2.0}),
    (0, 255, {"compared": True, "method": "pictures", "same": False, "difference": 255.0}),
    (None, None, {"compared": False, "method": "none", "same": None}),
])
def test_reproducible_compares_pictures_or_declines(monkeypatch, a, b, expected):
    traces = [{"states": [None], "frames": [picture(v)] if v is not None else []}
              for v in (a, b)]
    source = iter(traces)
    monkeypatch.setattr(R, "replay_trace", lambda *args, **kwargs: next(source))
    result = R.reproducible([], 0, "")
    assert result["reproducible"] is expected["same"]
    assert result["comparison"] == expected
    assert result["trace"] is traces[0] and result["trace_b"] is traces[1]


class D:
    made = []

    def __init__(self, bugs=""):
        self.executed, self.bugs = [], bugs
        D.made.append(self)

    def screenshot(self):
        return b"s%d" % len(self.executed)

    def execute(self, acts):
        self.executed.append(acts)

    def close(self):
        pass


def test_replay_runs_steps_up_to_the_report():
    D.made.clear()
    first, last = R.replay([[{"a": 1}], [{"a": 2}], [{"a": 3}]], 2, "1,2", driver_cls=D)
    assert D.made[0].executed == [[{"a": 1}], [{"a": 2}]] and D.made[0].bugs == "1,2"
    assert first == b"s0" and last == b"s2"


def test_verdict_parse():
    assert R.parse_verdict("YES. The door is open but the player is blocked.") is True
    assert R.parse_verdict("no, nothing wrong") is False
    assert R.parse_verdict("") is False
    assert R.parse_verdict("Not sure") is False


def test_replay_trace_records_refused_actions_every_step():
    class Refusing(D):
        def execute(self, acts):
            self.executed.append(acts)
            self.action_note = "key refused: escape, allowed: enter, esc"
    trace = R.replay_trace([[{"key": "escape"}], [{"key": "escape"}]], 2, "", Refusing)
    assert trace["refused"] == [{"step": 1, "note": "key refused: escape, allowed: enter, esc"},
                                {"step": 2, "note": "key refused: escape, allowed: enter, esc"}]


@pytest.mark.parametrize("note,report,expected", [
    ("key refused: escape, allowed: enter", {"title": "Escape does not close Draw Pile view"}, ["escape"]),
    ("key refused: escape, allowed: enter", {"title": "Esc does nothing"}, ["escape"]),
    ("key refused: esc, allowed: enter", {"title": "Escape"}, ["esc"]),
    ("key refused: a, allowed: enter", {"actual": "a card costs 3"}, []),
    ("key refused: a, allowed: enter", {"actual": "the A key does nothing"}, ["a"]),
])
def test_named_refused_matches_only_report_inputs(note, report, expected):
    assert R.named_refused(report, {"refused": [{"step": 1, "note": note}]}) == expected


def test_driver_without_action_note_has_no_refusals():
    assert R.replay_trace([[{"a": 1}]], 1, "", D)["refused"] == []


def test_step_gaps_uses_first_row_caps_skips_bad_rows_and_omits_last():
    assert R.step_gaps([
        {"step": 1, "t": 1}, {"step": 1, "t": 5}, {"step": 2, "t": 30},
        {"step": 3, "t": 29}, {"step": "bad", "t": 40}, {"step": 4, "t": None},
    ]) == {1: 10.0, 2: 0.0}
    assert R.step_gaps([]) == {}
    assert R.step_gaps(None) == {}


def test_replay_trace_paces_by_remaining_gap_and_keeps_frame_before_sleep(monkeypatch):
    calls = []
    ticks = iter([1.0, 1.4, 2.0, 2.1])
    monkeypatch.setattr(R.time, "monotonic", lambda: next(ticks))

    class Paced(D):
        paced_replay = True
        def execute(self, acts): calls.append("execute")
        def screenshot(self): calls.append("screenshot"); return b"frame"
        def state(self): calls.append("state"); return {}
        def sleep(self, seconds): calls.append(("sleep", seconds))

    trace = R.replay_trace([[{"a": 1}], [{"a": 2}]], 2, "", Paced, last=2, gaps={0: 1, 1: 4})
    assert calls[:5] == ["screenshot", "state", "execute", "screenshot", "state"]
    assert calls[5][0] == "sleep" and calls[5][1] == pytest.approx(0.6, abs=0.05)
    assert trace["paces"] == [{"step": 0, "gap": 1, "pause": 0.6}]
    assert calls[6:] == [
                     "execute", "screenshot", "state"]


def test_replay_trace_only_paces_when_enabled_and_gaps_truthy(monkeypatch):
    monkeypatch.setattr(R.time, "monotonic", lambda: 10.0)
    class Paced(D):
        paced_replay = True
        def __init__(self, bugs=""): super().__init__(bugs); self.sleeps = []
        def sleep(self, seconds): self.sleeps.append(seconds)
    R.replay_trace([[{}], [{}]], 2, "", Paced, gaps={0: 1})
    assert Paced.made[-1].sleeps == [1]
    assert R.replay_trace([[{}], [{}]], 2, "", Paced, gaps={0: 1})["paces"] == [
        {"step": 0, "gap": 1, "pause": 1}]
    class Ordinary(D):
        def __init__(self, bugs=""): super().__init__(bugs); self.sleeps = []
        def sleep(self, seconds): self.sleeps.append(seconds)
    ordinary = R.replay_trace([[{}], [{}]], 2, "", Ordinary, gaps={0: 1})
    assert Ordinary.made[-1].sleeps == []
    assert ordinary["paces"] == []
    R.replay_trace([[{}], [{}]], 2, "", Paced, gaps=None)
    assert Paced.made[-1].sleeps == []


def test_replay_trace_uses_time_sleep_when_driver_sleep_is_none(monkeypatch):
    called = []
    monkeypatch.setattr(R.time, "sleep", lambda seconds: called.append(seconds))
    class NoneSleeper(D):
        paced_replay = True
        sleep = None
    trace = R.replay_trace([[{}], [{}]], 2, "", NoneSleeper, gaps={0: 0.75})
    assert called == [pytest.approx(0.75, abs=0.05)]
    assert trace["paces"] == [{"step": 0, "gap": 0.75, "pause": 0.75}]


def test_reproducible_passes_gaps_to_both_replays(monkeypatch):
    calls = []
    monkeypatch.setattr(R, "replay_trace", lambda *a, **kw: calls.append(kw) or {"frames": [], "states": []})
    monkeypatch.setattr("pt.judge.compare_replays", lambda *a: {"same": True, "compared": True})
    gaps = {2: 3.0}
    R.reproducible([], 3, "", gaps=gaps)
    assert len(calls) == 2 and all(c["gaps"] is gaps for c in calls)


def test_replay_drivers_pacing_capability_is_scoped():
    from pt.pcgame import PcGameAdapter
    from pt.android import AndroidAdapter
    from pt.adapter import Adapter
    assert PcGameAdapter.paced_replay is True
    assert AndroidAdapter.paced_replay is True
    assert "paced_replay" not in Adapter.__dict__
    pytest.importorskip("vizdoom")
    import pt.doom as doom
    assert not any("paced_replay" in cls.__dict__ for cls in doom.__dict__.values() if isinstance(cls, type))
