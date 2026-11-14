"""Replay judge v2: determinism check, filmstrip, state difference, a verdict that must quote evidence. No network, no browser."""
import io
import json
import base64
import hashlib
import pytest
from PIL import Image
from pt import judge as J
from pt import replay as R

DEFAULT_PROMPT_SHA = "01822c6711d1d9db4714b7f8101d5da8fd0d4c697b4e95711fe76189939ebc2d"


def jpg(color, size=(64, 36)):
    b = io.BytesIO(); Image.new("RGB", size, color).save(b, "JPEG"); return b.getvalue()


def test_state_diff_keeps_unchanged_values_as_evidence():
    d = J.state_diff({"coins": 3, "boots": False, "x": 10.0}, {"coins": 0, "boots": False, "x": 55.0})
    assert "coins: 3 -> 0" in d and "x: 10 -> 55" in d
    assert "boots: False -> False (unchanged)" in d


def test_state_diff_includes_added_and_removed_keys():
    d = J.state_diff({"old": None, "same": 2}, {"new": True, "same": 2})
    assert "old: None -> <missing>" in d
    assert "new: <missing> -> True" in d
    assert "same: 2 -> 2 (unchanged)" in d


def test_state_diff_handles_missing_state():
    assert J.state_diff(None, {"a": 1}) == []
    assert J.state_diff({"a": 1}, None) == []


def test_pick_frames_even_and_includes_last():
    fr = list(range(20))
    got = J.pick_frames(fr, 8)
    assert len(got) == 8 and got[-1] == 19 and got[0] == 0 and got == sorted(got)
    assert J.pick_frames([1, 2, 3], 8) == [1, 2, 3]


def test_filmstrip_is_one_jpeg_with_a_grid():
    img = Image.open(io.BytesIO(J.filmstrip([jpg((i * 20, 0, 0)) for i in range(8)], cols=4, tile_w=64)))
    assert img.format == "JPEG" and img.size[0] == 4 * 64 and img.size[1] >= 2 * 36


def test_states_equal_tolerance():
    assert J.states_equal({"x": 100, "coins": 3}, {"x": 101.5, "coins": 3}, tol=2)
    assert not J.states_equal({"x": 100, "coins": 3}, {"x": 100, "coins": 2}, tol=2)
    assert not J.states_equal({"x": 100}, {"x": 110}, tol=2)
    assert J.states_equal(None, None)


def test_verdict_needs_quoted_evidence():
    assert J.parse_verdict('{"verdict":"YES","evidence":"coins went 3 to 0 and boots stayed false"}') == (True, "coins went 3 to 0 and boots stayed false")
    assert J.parse_verdict('{"verdict":"YES","evidence":""}')[0] is False
    assert J.parse_verdict('{"verdict":"NO","evidence":"the door opened and the player walked through"}')[0] is False
    assert J.parse_verdict("YES it looks wrong")[0] is False
    assert J.parse_verdict("")[0] is False


def test_prompt_carries_claim_and_state_lines():
    p = J.build_prompt({"title": "Shop takes coins", "expected": "boots", "actual": "no boots"}, ["coins: 3 -> 0"])
    assert "Shop takes coins" in p and "coins: 3 -> 0" in p and "evidence" in p


def test_prompt_explains_window_and_requires_a_temporal_comparison():
    p = J.build_prompt({}, ["active: False -> False (unchanged)"])
    assert "first and last" in p and "whole replay window" in p
    assert "last action:" not in p
    assert "expected_change" in p and "observed_change" in p and "gap" in p
    assert "correct behaviour" in p
    assert "unchanged" in p


def test_prompt_does_not_treat_missing_state_as_no_change():
    assert "State unavailable" in J.build_prompt({}, [])


def test_prompt_accepts_reported_inputs_as_context_but_requires_observed_effects():
    p = J.build_prompt({}, [])
    assert "reported inputs as replay context" in p
    assert "verify the claimed outcome" in p


def test_prompt_distinguishes_a_missing_transient_event_from_a_missing_lasting_effect():
    p = J.build_prompt({}, [])
    assert "brief response may occur between sampled frames" in p
    assert "absence from samples does not prove it never occurred" in p
    assert "lasting effect" in p


class FakeD:
    seq = 0

    def __init__(self, bugs="", drift=0):
        self.n, self.drift = 0, drift

    def screenshot(self):
        return jpg((self.n * 10, 0, 0))

    def state(self):
        return {"x": self.n * 10 + self.drift, "coins": 1}

    def execute(self, acts):
        self.n += 1

    def close(self):
        pass


def test_replay_trace_collects_frames_and_states():
    t = R.replay_trace([[{}]] * 6, 5, "1", driver_cls=FakeD, last=3)
    assert len(t["frames"]) == 4 and len(t["states"]) == 4        # the state before the last 3 actions, then after each
    assert t["states"][-1]["x"] == 50


def test_replay_trace_starts_after_the_last_reload_so_the_strip_shows_one_game():
    steps = [[{}], [{}], [{"type": "reload"}], [{}], [{}], [{}]]
    t = R.replay_trace(steps, 5, "1", driver_cls=FakeD, last=12)
    assert [s["x"] for s in t["states"]] == [30, 40, 50]          # after the reload (3 actions done), then after each later one
    assert R.replay_trace(steps, 3, "1", driver_cls=FakeD, last=12)["states"] == [{"x": 30, "coins": 1}]


def test_reproducible_when_two_replays_agree():
    class Drift(FakeD):
        def __init__(self, bugs=""):
            FakeD.seq += 1
            super().__init__(bugs, drift=0 if FakeD.seq % 2 else 30)
    ok = R.reproducible([[{}]] * 4, 4, "1", driver_cls=FakeD)
    bad = R.reproducible([[{}]] * 4, 4, "1", driver_cls=Drift)
    assert ok["reproducible"] is True and bad["reproducible"] is False


class Seq:
    """A fake client that answers with a list of responses in order and records the token limit it was given."""
    def __init__(self, answers):
        self.answers, self.limits, self.extras = list(answers), [], []

    def responses(self, inp, model=None, max_output_tokens=0, label="", reserve_usd=0, extra=None):
        self.limits.append(max_output_tokens); self.extras.append(extra)
        a = self.answers.pop(0)
        return {"output_text": a[1], "status": a[0], "_cost_usd": 0.01, "_latency_s": 1.0}


def _frames():
    return [jpg((i * 30, 0, 0)) for i in range(3)]


def test_judge_retries_once_with_more_room_when_the_answer_was_cut_off():
    c = Seq([("incomplete", ""), ("completed", '{"verdict":"YES","evidence":"the door stayed in the frame after it opened"}')])
    v = J.judge(c, {"title": "t", "expected": "e", "actual": "a"}, _frames(), ["x: 1 -> 2"])
    assert v["confirmed"] is True and c.limits[1] > c.limits[0] and v["cost_usd"] == 0.02 and v["incomplete"] is False
    assert all(extra == {"reasoning": {"effort": "low"}, "temperature": 0} for extra in c.extras)


def test_judge_marks_incomplete_when_the_retry_is_cut_off_too():
    c = Seq([("incomplete", ""), ("incomplete", "")])
    v = J.judge(c, {"title": "t", "expected": "e", "actual": "a"}, _frames(), [])
    assert v["confirmed"] is False and v["incomplete"] is True


def test_judge_asks_for_low_reasoning_and_a_generous_limit():
    c = Seq([("completed", '{"verdict":"NO","evidence":"nothing wrong in any frame"}')])
    J.judge(c, {"title": "t", "expected": "e", "actual": "a"}, _frames(), [])
    assert c.limits[0] >= 6000 and c.extras[0] == {"reasoning": {"effort": "low"}, "temperature": 0}


def test_judge_shows_twelve_large_frames_including_both_endpoints(monkeypatch):
    frames = [jpg((i * 10, 0, 0)) for i in range(13)]
    shown = []
    original = J.filmstrip

    def capture(selected, **kwargs):
        shown.extend(selected)
        return original(selected, **kwargs)

    monkeypatch.setattr(J, "filmstrip", capture)
    c = Seq([("completed", '{"verdict":"NO","evidence":"no clear discrepancy"}')])
    v = J.judge(c, {}, frames, [])
    assert len(shown) == 12 and shown[0] == frames[0] and shown[-1] == frames[-1]
    strip = Image.open(io.BytesIO(v["strip"]))
    assert strip.width == 4 * 480 and strip.height == 3 * 270


def test_trace_round_trip_on_disk(tmp_path):
    t = {"frames": [jpg((1, 2, 3)), jpg((4, 5, 6))], "states": [{"x": 1}, {"x": 2}], "bug_hits": {"1": True}}
    R.save_trace(t, tmp_path / "tr")
    back = R.load_trace(tmp_path / "tr")
    assert back["frames"] == t["frames"] and back["states"] == t["states"] and back["bug_hits"] == {"1": True}
    assert R.load_trace(tmp_path / "missing") is None


@pytest.mark.parametrize("a,b,same", [({"x": 1}, {"x": 3}, True),
    ({"coins": 1}, {"coins": 2}, False), ({}, None, False), (None, {}, False)])
def test_compare_replays_prefers_states(a, b, same):
    assert J.compare_replays({"states": [a], "frames": []}, {"states": [b], "frames": []}) == {
        "compared": True, "method": "state", "same": same}


def test_two_filmstrips_reach_client_and_default_prompt_is_unchanged():
    class Capture(Seq):
        def responses(self, inp, **kwargs):
            self.content = inp[0]["content"]
            return super().responses(inp, **kwargs)
    report = {"title": "t", "expected": "e", "actual": "a"}
    client = Capture([("completed", '{"verdict":"NO","evidence":"door opens"}')])
    J.judge(client, report, _frames(), [], second_frames=None)
    assert hashlib.sha256(client.content[0]["text"].encode()).hexdigest() == DEFAULT_PROMPT_SHA
    client.answers = [("completed", '{"verdict":"YES","evidence":"both doors stay closed"}')]
    verdict = J.judge(client, report, _frames(), [], second_frames=[jpg("white")])
    assert [part["type"] for part in client.content] == ["input_text", "input_image", "input_image"]
    assert "Answer YES only if both replays show the reported symptom." in client.content[0]["text"]
    for part, key in zip(client.content[1:], ("strip", "strip_b")):
        assert base64.b64decode(part["image_url"].split(",")[1]) == verdict[key]
    with pytest.raises(ValueError, match="video"):
        J.judge(client, report, _frames(), [], judge_input="video", second_frames=_frames())


def test_picture_comparison_uses_final_frames_grey_mean_and_unrounded_limit():
    def png(image):
        stream = io.BytesIO()
        image.save(stream, "PNG")
        return stream.getvalue()
    black = png(Image.new("L", (64, 36), 0))
    red = png(Image.new("RGB", (128, 72), "red"))
    grey = png(Image.new("L", (64, 36), 76))
    assert J.compare_replays({"frames": [black, red]}, {"frames": [grey]})["difference"] == 0
    image = Image.new("L", (64, 36), 8)
    trace = {"frames": [black]}
    assert J.compare_replays(trace, {"frames": [png(image)]})["same"] is True
    image.putpixel((0, 0), 9)
    comparison = J.compare_replays(trace, {"frames": [png(image)]})
    assert comparison["difference"] == 8.0 and comparison["same"] is False
