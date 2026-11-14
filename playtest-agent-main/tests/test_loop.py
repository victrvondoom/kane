"""The agent loop with a fake model and a fake game. No network, no browser."""
import json
import pytest
from pt import loop as Lp


class FakeDriver:
    def __init__(self, won_after=None):
        self.executed, self.n, self.won_after = [], 0, won_after

    def screenshot(self):
        return b"\xff\xd8fake"

    def execute(self, actions):
        self.executed.extend(actions); self.n += 1

    def state(self):
        return {"won": self.won_after is not None and self.n >= self.won_after}


class FakeClient:
    def __init__(self, script, cost=0.01):
        self.script, self.i, self.cost, self.bodies = script, 0, cost, []

    def wonder(self, body, label="", reserve_usd=0.3, timeout=300):
        self.bodies.append((body, reserve_usd))
        out = self.script[min(self.i, len(self.script) - 1)]; self.i += 1
        return {"id": f"r{self.i}", "output": out, "usage": {"input_tokens": 3000, "output_tokens": 100}, "_cost_usd": self.cost, "_latency_s": 1.0}


def act(actions, cid="c"):
    return [{"type": "function_call", "name": "act", "call_id": cid, "arguments": json.dumps({"actions": actions})}]


def rep(title, cid="r"):
    return [{"type": "function_call", "name": "report_bug", "call_id": cid, "arguments": json.dumps({"title": title, "expected": "e", "actual": "a"})}]


def test_parse_calls():
    calls = Lp.parse_calls(act([{"type": "wait"}]) + rep("x"))
    assert [c["name"] for c in calls] == ["act", "report_bug"]
    assert calls[0]["args"]["actions"][0]["type"] == "wait"


def test_stops_when_game_is_won():
    d = FakeDriver(won_after=2)
    c = FakeClient([act([{"type": "keypress", "keys": ["right"]}])] * 5)
    r = Lp.run_episode(c, d, goal="g", max_steps=10, max_seconds=100, max_usd=1.0)
    assert r["stop"] == "won" and r["steps"] == 2


@pytest.mark.parametrize("note,expected", [("key refused: escape", "key refused: escape"), (None, "done"), ("", "done")])
def test_act_output_uses_driver_note_or_done(note, expected):
    class Driver(FakeDriver):
        def execute(self, actions):
            super().execute(actions)
            if note is not None:
                self.action_note = note
    client = FakeClient([act([{"type": "keypress", "keys": ["escape"]}]), []])
    result = Lp.run_episode(client, Driver(), "g", max_steps=1)
    assert result["log"][0]["calls"][0]["output"] == expected


def test_stops_at_cost_limit():
    d = FakeDriver()
    c = FakeClient([act([{"type": "wait"}])] * 20, cost=0.3)
    r = Lp.run_episode(c, d, goal="g", max_steps=10, max_seconds=100, max_usd=0.5)
    assert r["stop"] == "cost" and r["cost_usd"] <= 0.9


def test_stops_at_step_limit():
    d = FakeDriver()
    c = FakeClient([act([{"type": "wait"}])] * 20)
    r = Lp.run_episode(c, d, goal="g", max_steps=3, max_seconds=100, max_usd=5)
    assert r["stop"] == "steps" and r["steps"] == 3


def test_model_can_finish_with_a_message():
    d = FakeDriver()
    c = FakeClient([act([{"type": "wait"}]), [{"type": "message", "content": [{"type": "output_text", "text": "done"}]}]])
    r = Lp.run_episode(c, d, goal="g", max_steps=10, max_seconds=100, max_usd=5)
    assert r["stop"] == "model" and r["final_text"] == "done"


def test_bug_report_records_the_step():
    d = FakeDriver()
    c = FakeClient([act([{"type": "wait"}], "a1"), act([{"type": "wait"}], "a2"), rep("door stuck"), [{"type": "message", "content": [{"type": "output_text", "text": "end"}]}]])
    r = Lp.run_episode(c, d, goal="g", max_steps=10, max_seconds=100, max_usd=5)
    assert r["reports"][0]["title"] == "door stuck" and r["reports"][0]["step"] == 2
    assert len(r["actions_by_step"]) == 2


def test_next_request_carries_previous_response_and_a_new_screenshot():
    d = FakeDriver()
    c = FakeClient([act([{"type": "wait"}]), [{"type": "message", "content": [{"type": "output_text", "text": "x"}]}]])
    Lp.run_episode(c, d, goal="g", max_steps=10, max_seconds=100, max_usd=5, history="server")
    body2 = c.bodies[1][0]
    assert body2["previous_response_id"] == "r1"
    kinds = [i.get("type") or i.get("role") for i in body2["input"]]
    assert "function_call_output" in kinds and "user" in kinds


def test_own_history_is_the_default_and_sends_the_whole_turn_list():
    # a call that points at the server's stored chain waited about 10 s; the same runs sending their own history waited about 2 s
    d = FakeDriver()
    c = FakeClient([act([{"type": "wait"}], "a1"), act([{"type": "wait"}], "a2"), [{"type": "message", "content": [{"type": "output_text", "text": "x"}]}]])
    r = Lp.run_episode(c, d, goal="g", max_steps=10, max_seconds=100, max_usd=5)
    first, third = c.bodies[0][0], c.bodies[2][0]
    assert first.get("store") is False and "previous_response_id" not in first
    assert third.get("store") is False and "previous_response_id" not in third
    kinds = [i.get("type") or i.get("role") for i in third["input"]]
    assert kinds == ["user", "function_call", "function_call_output", "user", "function_call", "function_call_output", "user"]
    assert r["fallbacks"] == 0


def test_own_history_replays_reasoning_and_commentary_and_logs_the_summary():
    # Meta's Responses guide: replay the encrypted reasoning item, keep phase on commentary, ask with include
    first = [{"type": "reasoning", "id": "rs_1", "summary": [{"type": "summary_text", "text": "The door is left."}], "encrypted_content": "ENC1"},
             {"type": "message", "role": "assistant", "phase": "commentary", "content": [{"type": "output_text", "text": "Going left."}]}] + act([{"type": "wait"}], "a1")
    d = FakeDriver()
    c = FakeClient([first, [{"type": "message", "content": [{"type": "output_text", "text": "x"}]}]])
    r = Lp.run_episode(c, d, goal="g", max_steps=10, max_seconds=100, max_usd=5, summary="auto")
    body1, body2 = c.bodies[0][0], c.bodies[1][0]
    assert body1["include"] == ["reasoning.encrypted_content"] and body1["reasoning"]["summary"] == "auto"
    items = body2["input"]
    assert {"type": "reasoning", "summary": [], "encrypted_content": "ENC1"} in items
    msg = next(i for i in items if i.get("role") == "assistant")
    assert msg["phase"] == "commentary"
    kinds = [i.get("type") or i.get("role") for i in items]
    assert kinds.index("reasoning") < kinds.index("function_call")
    assert r["log"][0]["thinking"] == "The door is left."


def test_server_history_never_sends_include():
    d = FakeDriver()
    c = FakeClient([act([{"type": "wait"}]), [{"type": "message", "content": [{"type": "output_text", "text": "x"}]}]])
    Lp.run_episode(c, d, goal="g", max_steps=10, max_seconds=100, max_usd=5, history="server")
    assert all("include" not in b for b, _ in c.bodies[1:])        # include with previous_response_id is an HTTP 400


def test_look_plan_asks_for_look_plan_then_act():
    d = FakeDriver()
    c = FakeClient([[{"type": "message", "content": [{"type": "output_text", "text": "x"}]}]] * 2)
    Lp.run_episode(c, d, goal="g", max_steps=1, max_seconds=100, max_usd=5, look_plan=True)
    Lp.run_episode(c, d, goal="g", max_steps=1, max_seconds=100, max_usd=5)
    on, off = c.bodies[0][0]["instructions"], c.bodies[1][0]["instructions"]
    assert "look" in on and "plan" in on and "look" not in off
    # in the probe (tprobe) the model wrote no text when only the instructions asked, so the act call itself carries the fields
    act_on = c.bodies[0][0]["tools"][0]["parameters"]
    act_off = c.bodies[1][0]["tools"][0]["parameters"]
    assert {"look", "plan"} <= set(act_on["properties"]) and {"look", "plan"} <= set(act_on["required"])
    assert "look" not in act_off["properties"]
    assert list(act_on["properties"])[:2] == ["look", "plan"]        # written before the actions


def test_the_frames_of_each_action_go_in_the_log():
    class Spans(FakeDriver):
        def execute(self, actions):
            super().execute(actions)
            self.last_spans = [{"from": 10, "held_to": 25, "to": 29}]

    r = Lp.run_episode(FakeClient([act([{"type": "keypress", "keys": ["right"]}])]), Spans(), "Try", max_steps=1)
    assert r["log"][0]["spans"] == [{"from": 10, "held_to": 25, "to": 29}]


def test_reserve_grows_with_input():
    d = FakeDriver()
    c = FakeClient([act([{"type": "wait"}])] * 3)
    Lp.run_episode(c, d, goal="g", max_steps=3, max_seconds=100, max_usd=5)
    assert c.bodies[1][1] > 0


def test_lost_server_state_falls_back_to_a_stateless_resend():
    from metaclient.client import ApiError

    class Flaky(FakeClient):
        def wonder(self, body, label="", reserve_usd=0.3, timeout=300):
            if self.i == 1 and "previous_response_id" in body and not getattr(self, "failed", False):
                self.failed = True
                raise ApiError(400, '{"error":{"message":"referenced response not found or expired"}}')
            return super().wonder(body, label, reserve_usd, timeout)

    d = FakeDriver()
    c = Flaky([act([{"type": "wait"}], "a1"), act([{"type": "wait"}], "a2"), [{"type": "message", "content": [{"type": "output_text", "text": "end"}]}]])
    r = Lp.run_episode(c, d, goal="g", max_steps=10, max_seconds=100, max_usd=5, history="server")
    assert r["stop"] == "model" and r["steps"] == 2
    retry = c.bodies[1][0]                      # the call after the failure
    assert "previous_response_id" not in retry and retry.get("store") is False
    kinds = [i.get("type") or i.get("role") for i in retry["input"]]
    assert kinds.count("function_call") == 1 and kinds.count("function_call_output") == 1 and kinds[0] == "user"
    assert r["fallbacks"] == 1


def test_should_stop_callback_ends_the_run():
    d = FakeDriver()
    c = FakeClient([act([{"type": "wait"}])] * 10)
    calls = {"n": 0}

    def stop():
        calls["n"] += 1
        return "memory" if calls["n"] >= 2 else None
    r = Lp.run_episode(c, d, goal="g", max_steps=10, max_seconds=100, max_usd=5, should_stop=stop)
    assert r["stop"] == "memory" and r["steps"] == 2


def test_state_text_is_sent_only_when_asked():
    class SD(FakeDriver):
        def state(self):
            return {"coins": 2, "won": False}
    for flag in (False, True):
        d = SD()
        c = FakeClient([act([{"type": "wait"}]), [{"type": "message", "content": [{"type": "output_text", "text": "x"}]}]])
        Lp.run_episode(c, d, goal="g", max_steps=10, max_seconds=100, max_usd=5, observe_state=flag)
        text = json.dumps(c.bodies[1][0]["input"])
        assert ("coins" in text) is flag
    first = json.dumps(c.bodies[0][0]["input"])
    assert "coins" in first                                   # the first turn shows it too when asked


def test_no_state_means_no_state_line():
    d = FakeDriver()
    c = FakeClient([act([{"type": "wait"}]), [{"type": "message", "content": [{"type": "output_text", "text": "x"}]}]])
    class NoState(FakeDriver):
        def state(self): return None
    Lp.run_episode(c, NoState(), goal="g", max_steps=10, max_seconds=100, max_usd=5, observe_state=True)
    assert "State:" not in json.dumps(c.bodies[1][0]["input"])


def test_click_tool_only_for_click_games():
    kb = Lp.tools_for("Keys: left, right, space")
    assert "click" not in kb[0]["parameters"]["properties"]["actions"]["items"]["properties"]["type"]["enum"]
    ck = Lp.tools_for("Tap or click on the screen.")
    it = ck[0]["parameters"]["properties"]["actions"]["items"]["properties"]
    assert "click" in it["type"]["enum"] and "x" in it and "y" in it
    assert "click" not in Lp.TOOLS[0]["parameters"]["properties"]["actions"]["items"]["properties"]["type"]["enum"]


@pytest.mark.parametrize("controls", ["Swipe to move.", "Click and SWIPE."])
def test_swipe_tool_coordinates(controls):
    props = Lp.tools_for(controls, checklist=True)[0]["parameters"]["properties"]["actions"]["items"]["properties"]
    assert "swipe" in props["type"]["enum"]
    for field in ("x", "y", "x2", "y2", "ms"):
        assert props[field]["type"] == "integer"
    for text in ("Keys: left, right", "Click the screen"):
        props = Lp.tools_for(text)[0]["parameters"]["properties"]["actions"]["items"]["properties"]
        assert "swipe" not in props["type"]["enum"]
        assert "x2" not in props and "y2" not in props
    assert Lp.tools_for("Keys: left, right") == Lp.TOOLS


@pytest.mark.parametrize("narrate", [False, True])
def test_narration_prompt_and_log(narrate):
    text = "I see a door. I will try opening it."
    message = [{"type": "message", "content": [{"type": "output_text", "text": text}]}]
    client = FakeClient([message + act([{"type": "wait"}]), message])
    result = Lp.run_episode(client, FakeDriver(), "Try", narrate=narrate)
    prompt = "Before each action, say one short sentence about what you see and what you will try."
    assert (prompt in client.bodies[0][0]["instructions"]) is narrate
    assert [entry["text"] for entry in result["log"]] == [text, text]


def test_log_keeps_the_whole_text_and_the_raw_call():
    # the run video shows the model's own words and its tool call exactly as sent, so nothing is cut here
    message = [{"type": "message", "content": [{"type": "output_text", "text": "a" * 250},
                                               {"type": "output_text", "text": "b" * 250}]}]
    result = Lp.run_episode(FakeClient([message]), FakeDriver(), "Try")
    assert result["log"][0]["text"] == "a" * 250 + "b" * 250
    assert result["final_text"] == "a" * 250 + "b" * 250
    raw = '{"actions": [{"type": "keypress", "keys": ["right"]}]}'
    result = Lp.run_episode(FakeClient([[{"type": "function_call", "name": "act", "call_id": "c", "arguments": raw}]]), FakeDriver(), "Try", max_steps=1)
    assert result["log"][0]["calls"][0]["raw"] == raw


@pytest.mark.parametrize("resuming", [False, True])
def test_log_timestamps(monkeypatch, resuming):
    import itertools
    ticks = itertools.count()
    monkeypatch.setattr(Lp.time, "time", lambda: 100 + next(ticks) * .1234)
    old = {"seconds": 8.0, "log": [{"step": 0, "t": 7.5}]} if resuming else None
    message = [{"type": "message", "content": [{"type": "output_text", "text": "done"}]}]
    client = FakeClient([act([{"type": "wait"}]), rep("Door"), message])
    result = Lp.run_episode(client, FakeDriver(), "Try", initial=old)
    times = [entry["t"] for entry in result["log"]]
    assert all(isinstance(t, float) and t == round(t, 2) for t in times)
    assert times == sorted(times)
    assert times[-3] == (8.25 if resuming else .25)


def test_result_records_when_the_run_started():
    import time as _t
    before = _t.time()
    r = Lp.run_episode(FakeClient([[{"type": "message", "content": [{"type": "output_text", "text": "done"}]}]]), FakeDriver(), "go", sink={})
    assert before <= r["started_at"] <= _t.time()


def _jpeg(w, h):
    import io
    from PIL import Image
    b = io.BytesIO()
    Image.new("RGB", (w, h), "white").save(b, format="JPEG")
    return b.getvalue()


class PointerDriver(FakeDriver):
    controls = "Tap with click on the screen. You can also swipe."

    def screenshot(self):
        return _jpeg(540, 1200)


def test_pointer_games_are_told_the_screenshot_size_every_turn():
    c = FakeClient([act([{"type": "wait"}]), [{"type": "message", "content": [{"type": "output_text", "text": "done"}]}]])
    Lp.run_episode(c, PointerDriver(), "go")
    for body, _ in c.bodies:
        texts = " ".join(p["text"] for m in body["input"] if m.get("role") == "user" for p in m["content"] if p.get("type") == "input_text")
        assert "Screenshot size: 540 by 1200 pixels" in texts


def test_keyboard_games_get_no_size_note():
    c = FakeClient([[{"type": "message", "content": [{"type": "output_text", "text": "done"}]}]])
    Lp.run_episode(c, FakeDriver(), "go")
    assert "Screenshot size" not in json.dumps(c.bodies[0][0]["input"])


@pytest.mark.parametrize("prior", [0, 8])
def test_shot_time_is_for_the_image_sent_with_each_turn(monkeypatch, prior):
    clock = [100.0]
    monkeypatch.setattr(Lp.time, "time", lambda: clock[0])
    class Driver(FakeDriver):
        def screenshot(self):
            clock[0] += 2
            return super().screenshot()
    class Client(FakeClient):
        def wonder(self, *args, **kwargs):
            clock[0] += 3
            return super().wonder(*args, **kwargs)
    client = Client([act([{"type": "wait"}]), rep("Door"), []])
    r = Lp.run_episode(client, Driver(), "Try", initial={"seconds": prior})
    shots = [e["shot_t"] for e in r["log"]]
    assert shots == [prior, prior + 5, prior + 10]
    assert shots == sorted(shots)
    assert all(e["shot_t"] <= e["t"] for e in r["log"])
    assert all(e["shot_t"] == round(e["shot_t"], 2) for e in r["log"])


def test_shot_ticks_belong_to_sent_image():
    class Driver(FakeDriver):
        def tick(self): return self.n * 9
    client = FakeClient([act([{"type": "wait"}]), act([{"type": "wait"}]), []])
    result = Lp.run_episode(client, Driver(), "Try")
    assert [e["shot_tick"] for e in result["log"]] == [0, 9, 18]
    assert result["final_tick"] == 18
    result = Lp.run_episode(FakeClient([[]]), FakeDriver(), "Try")
    assert "shot_tick" not in result["log"][0]
    assert "final_tick" not in result


def test_log_text_falls_back_to_the_clients_thought():
    class Thinking(FakeClient):
        def wonder(self, body, label="", reserve_usd=0.3, timeout=300):
            r = super().wonder(body, label, reserve_usd, timeout)
            r["_thought"] = "I will try the door."
            return r
    c = Thinking([act([{"type": "wait"}]), [{"type": "message", "content": [{"type": "output_text", "text": "done"}]}]])
    r = Lp.run_episode(c, FakeDriver(), "go", sink={})
    assert r["log"][0]["text"] == "I will try the door."
    assert r["log"][1]["text"] == "done"


def test_reload_is_offered_only_when_asked():
    enum = lambda t: t[0]["parameters"]["properties"]["actions"]["items"]["properties"]["type"]["enum"]
    assert "reload" not in enum(Lp.tools_for("Arrows move."))
    t = Lp.tools_for("Arrows move.", reload=True)
    assert "reload" in enum(t) and "reload" in t[0]["description"]


def test_reload_reaches_the_driver_and_is_kept_for_replay():
    d = FakeDriver()
    c = FakeClient([act([{"type": "reload"}]), []])
    r = Lp.run_episode(c, d, goal="g", max_steps=5, max_seconds=100, max_usd=1.0, reload=True)
    assert d.executed == [{"type": "reload"}] and r["actions_by_step"] == [[{"type": "reload"}]]
    assert "reload" in json.dumps(c.bodies[0][0]["tools"])


def test_an_early_stop_gets_a_nudge_and_play_goes_on():
    d = FakeDriver()
    c = FakeClient([act([{"type": "wait"}]), [], act([{"type": "wait"}]), []])
    r = Lp.run_episode(c, d, goal="g", max_steps=10, max_seconds=100, max_usd=1.0, nudges=1)
    assert r["steps"] == 2 and r["stop"] == "model"
    nudge = json.dumps(c.bodies[2][0]["input"])
    assert "9 steps" in nudge and "not tested" in nudge
    assert r["nudges"] == 1


def test_no_nudge_by_default_or_when_no_steps_are_left():
    c = FakeClient([act([{"type": "wait"}]), [], act([{"type": "wait"}])])
    assert Lp.run_episode(c, FakeDriver(), goal="g", max_steps=10, max_seconds=100, max_usd=1.0)["steps"] == 1
    c = FakeClient([act([{"type": "wait"}]), [], act([{"type": "wait"}])])
    r = Lp.run_episode(c, FakeDriver(), goal="g", max_steps=1, max_seconds=100, max_usd=1.0, nudges=1)
    assert r["steps"] == 1 and r["stop"] == "steps"


def test_notes_field_comes_after_plan_and_is_required():
    """t-doom3 lost 14 of its last 40 steps to places it had already been (docs/DOOM-LOST.md)."""
    d = FakeDriver()
    c = FakeClient([[{"type": "message", "content": [{"type": "output_text", "text": "x"}]}]] * 2)
    Lp.run_episode(c, d, goal="g", max_steps=1, max_seconds=100, max_usd=5, look_plan=True, notes=True)
    Lp.run_episode(c, d, goal="g", max_steps=1, max_seconds=100, max_usd=5, look_plan=True)
    on, off = c.bodies[0][0], c.bodies[1][0]
    params = on["tools"][0]["parameters"]
    assert list(params["properties"])[:3] == ["look", "plan", "notes"]
    assert "notes" in params["required"]
    assert "notes" in on["instructions"] and "not explored" in on["instructions"]
    assert "notes" not in off["tools"][0]["parameters"]["properties"]
    assert "notes" not in off["instructions"]
