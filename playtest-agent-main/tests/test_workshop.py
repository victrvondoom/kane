import json

import pytest

from pt import cli, loop, report
from test_loop import FakeClient, FakeDriver, act, rep


END = [{"type": "message", "content": [{"type": "output_text", "text": "Finished"}]}]


def call(name, **args):
    return [{"type": "function_call", "name": name, "call_id": name, "arguments": json.dumps(args)}]


def put(folder, name, value):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / name).write_text(json.dumps(value), encoding="utf-8")


def test_reports_start_unverified():
    result = loop.run_episode(FakeClient([rep("Door"), END]), FakeDriver(), "Try")
    assert result["reports"][0]["status"] == "unverified"


def test_checklist_records_evidence_and_replaces_items():
    client = FakeClient([call("set_checklist", items=["Old"]), call("set_checklist", items=["Door"]),
                         act([{"type": "wait"}]), call("tick", index=0, evidence="Door opened"), END])
    sink = {}
    result = loop.run_episode(client, FakeDriver(), "Try", checklist=True, sink=sink)
    assert result["checklist"] == [{"text": "Door", "done": True, "evidence": "Door opened", "step": 1}]
    assert sink["checklist"] == result["checklist"]
    assert "before you act" in client.bodies[0][0]["instructions"]
    assert [i["output"] for i in client.bodies[1][0]["input"] if i.get("type") == "function_call_output"][-1] == "noted"


@pytest.mark.parametrize("index", [-1, 2, "bad", True])
def test_bad_tick(index):
    client = FakeClient([call("set_checklist", items=["Door"]), call("tick", index=index, evidence="x"), END])
    loop.run_episode(client, FakeDriver(), "Try", checklist=True)
    outs = [i["output"] for i in client.bodies[2][0]["input"] if i.get("type") == "function_call_output"]
    assert outs[-1] == "no such item"


def test_checklist_tools_are_optional():
    for enabled in (False, True):
        client = FakeClient([END])
        loop.run_episode(client, FakeDriver(), "Try", checklist=enabled)
        names = {t["name"] for t in client.bodies[0][0]["tools"]}
        assert ("tick" in names and "set_checklist" in names) is enabled
        assert "escalate" not in names


def test_escalate_tool_is_offered_only_when_asked():
    client = FakeClient([END])
    loop.run_episode(client, FakeDriver(), "Try", escalate=True)
    assert "escalate" in {t["name"] for t in client.bodies[0][0]["tools"]}
    client = FakeClient([END])
    loop.run_episode(client, FakeDriver(), "Try")
    assert "escalate" not in {t["name"] for t in client.bodies[0][0]["tools"]}


def test_escalation_stops_before_later_actions():
    client = FakeClient([act([{"type": "wait"}]), call("escalate", reason="Blocked", question="Which door?") + act([{"type": "wait"}])])
    sink = {}
    result = loop.run_episode(client, FakeDriver(), "Try", sink=sink, escalate=True)
    assert result["stop"] == "escalated" and result["steps"] == 1
    assert result["escalation"] == {"reason": "Blocked", "question": "Which door?", "step": 1}
    assert sink["escalation"] == result["escalation"]
    assert result["log"][-1]["calls"][-1]["name"] == "act"
    assert result["log"][-1]["calls"][-1]["output"] == "not run"


@pytest.fixture
def fake_cli(tmp_path, monkeypatch):
    from pt import adapter, guard
    from trials import common

    class Driver(FakeDriver):
        controls, goal, name = "Keys", "Reach exit", "Test"

        def __init__(self, bugs=""):
            super().__init__()
            self.bugs, self.closed = bugs, False

        def won(self): return False
        def bug_hits(self): return {}
        def close(self): self.closed = True

    drivers, locks = [], []
    def make(game, bugs=""):
        d = Driver(bugs)
        d.game_id = game
        drivers.append(d)
        return d
    monkeypatch.setattr(cli, "ROOT", tmp_path)
    monkeypatch.setattr(adapter, "make", make)
    monkeypatch.setattr(guard, "problems", lambda: [])
    monkeypatch.setattr(guard, "take_lock", lambda: locks.append("take"))
    monkeypatch.setattr(guard, "release_lock", lambda: locks.append("release"))
    monkeypatch.setattr(guard, "free_gb", lambda: 99)
    monkeypatch.setattr(common, "load_client", lambda _: client)
    client = FakeClient([END])
    return tmp_path / "data" / "runs" / "run", client, drivers, locks


def test_hunt_saves_checklist_and_escalation(fake_cli, capsys):
    folder, client, drivers, locks = fake_cli
    client.script = [call("set_checklist", items=["Door"]), rep("Door stuck"), call("escalate", reason="Blocked", question="Which door?")]
    assert cli.main(["hunt", "run", "--checklist", "--escalate"]) == 0
    result = json.loads((folder / "result.json").read_text())
    assert result["checklist"][0]["text"] == "Door"
    assert result["game_id"] == "cave-courier"
    assert json.loads((folder / "needs_human.json").read_text()) == result["escalation"]
    output = capsys.readouterr().out
    assert "UNVERIFIED" in output and "Door stuck" in output and "python -m pt confirm" in output
    assert "NEEDS A PERSON: Which door?" in output
    assert locks == ["take", "release"] and drivers[0].closed


@pytest.mark.parametrize("kind", ["goal", "hunt"])
@pytest.mark.parametrize("enabled", [False, True])
def test_cli_narration_is_used_and_saved(fake_cli, kind, enabled):
    folder, client, _, _ = fake_cli
    assert cli.main([kind, "run"] + (["--narrate"] if enabled else [])) == 0
    result = json.loads((folder / "result.json").read_text())
    assert result["settings"]["narrate"] is enabled
    assert ("Before each action, say one short sentence" in client.bodies[0][0]["instructions"]) is enabled


def test_resume_keeps_narration_setting(fake_cli):
    folder, client, _, _ = fake_cli
    put(folder, "result.json", {"settings": {"narrate": True}})
    assert cli.main(["resume", "run", "--note", "Continue"]) == 0
    result = json.loads((folder / "result.json").read_text())
    assert result["settings"]["narrate"] is True
    assert "Before each action, say one short sentence" in client.bodies[0][0]["instructions"]


def test_resume_restores_and_appends(fake_cli):
    folder, client, drivers, locks = fake_cli
    old = {"goal": "Try the door", "game": "Test", "game_id": "test-config", "kind": "hunt", "bugs_on": "2", "steps": 1,
           "cost_usd": .2, "seconds": 2, "reports": [{"title": "Old", "step": 1}],
           "actions_by_step": [[{"type": "wait"}]], "log": [{"step": 0, "text": "Earlier"}],
           "checklist": [{"text": "Door", "done": False, "evidence": "", "step": 0}],
           "settings": {"checklist": True}, "escalation": {"question": "Which?"}}
    put(folder, "result.json", old)
    put(folder, "needs_human.json", old["escalation"])
    client.script = [act([{"type": "wait"}]), call("tick", index=0, evidence="Opened"), rep("New"), END]
    assert cli.main(["resume", "run", "--note", "Left door", "--max-steps", "4"]) == 0
    text = client.bodies[0][0]["input"][0]["content"][0]["text"]
    assert text == "Try the door\nA person answered your question: Left door"
    result = json.loads((folder / "result.json").read_text())
    assert result["steps"] == 2 and len(result["actions_by_step"]) == 2
    assert [r["title"] for r in result["reports"]] == ["Old", "New"]
    assert result["reports"][-1]["step"] == 2
    assert result["log"][0] == old["log"][0] and result["log"][1]["step"] == 1
    assert result["checklist"][0]["done"] and result["checklist"][0]["step"] == 2
    assert result["cost_usd"] == .26 and result["nudges"] == 2      # a resumed hunt is reminded twice of its steps left
    assert drivers[0].bugs == "2" and drivers[0].n == 2
    assert drivers[0].game_id == "test-config"
    assert not (folder / "needs_human.json").exists()
    assert (folder / "s001.jpg").exists() and locks == ["take", "release"]


def test_resume_keeps_old_checklist_when_setting_new_items():
    old = {"checklist": [{"text": "Door", "done": True, "evidence": "Opened", "step": 1}], "steps": 1}
    client = FakeClient([call("set_checklist", items=["Old plan"]), call("set_checklist", items=["Window"]), END])
    result = loop.run_episode(client, FakeDriver(), "Continue", checklist=True, initial=old)
    assert [item["text"] for item in result["checklist"]] == ["Door", "Window"]
    assert result["checklist"][0] == old["checklist"][0]
    assert "Door" in client.bodies[0][0]["instructions"]


def test_signoff_uses_saved_status(tmp_path):
    put(tmp_path, "result.json", {"reports": [{"title": "A"}, {"title": "B"}]})
    put(tmp_path, "confirm.json", [{"status": "confirmed"}, {"status": "rejected"}])
    assert cli.main(["signoff", str(tmp_path), "--by", "Sam"]) == 0
    assert report._badge({"status": "confirmed"}) == "Confirmed"
    assert report._badge({"status": "rejected"}) == "Not confirmed"


def test_console_without_checklist_or_log(tmp_path):
    from pt import console
    put(tmp_path, "result.json", {"final_text": "Nothing to do"})
    assert "Nothing to do" in console.build(tmp_path)


def test_resume_missing_result(fake_cli, capsys):
    assert cli.main(["resume", "run", "--note", "Left"]) == 1
    assert "result.json" in capsys.readouterr().out
    assert fake_cli[2] == [] and fake_cli[3] == []


def test_signoff_refuses_unverified_then_counts(tmp_path, capsys):
    put(tmp_path, "result.json", {"reports": [{"title": "A"}, {"title": "B"}, {"title": "C"}]})
    put(tmp_path, "confirm.json", [{"confirmed": True, "reproducible": True}, {"confirmed": False, "reproducible": False}])
    assert cli.main(["signoff", str(tmp_path), "--by", "Sam"]) == 1
    assert "unverified" in capsys.readouterr().out.lower()
    assert not (tmp_path / "signoff.json").exists()
    put(tmp_path, "confirm.json", [{"status": "confirmed", "confirmed": True, "reproducible": True},
                                   {"status": "rejected", "confirmed": False}, {"status": "rejected", "confirmed": False}])
    assert cli.main(["signoff", str(tmp_path), "--by", "Sam", "--note", "Reviewed"]) == 0
    saved = json.loads((tmp_path / "signoff.json").read_text())
    assert saved["by"] == "Sam" and saved["note"] == "Reviewed" and saved["time"]
    assert (saved["confirmed_count"], saved["rejected_count"], saved["unverified_count"]) == (1, 2, 0)


def test_report_unverified_signoff_and_console(tmp_path):
    put(tmp_path, "result.json", {"reports": [{"title": "Door"}]})
    page = report.build(tmp_path)
    assert "Unverified" in page and "Not signed off" in page
    put(tmp_path, "signoff.json", {"by": "<Sam>"})
    (tmp_path / "console.html").write_text("console")
    page = report.build(tmp_path)
    assert "Signed off by &lt;Sam&gt;" in page and 'href="console.html"' in page


@pytest.mark.parametrize("checklist", [[], [{"text": "Door", "done": True, "evidence": "Opened", "step": 1}]])
def test_console_steps_are_escaped_and_complete(tmp_path, checklist, capsys):
    from pt import console
    put(tmp_path, "result.json", {"log": [
        {"step": 0, "text": "<script>bad()</script>", "cost": .1, "latency_s": 2,
         "calls": [{"name": "act", "args": {"actions": []}, "output": "done"}]},
        {"step": 1, "text": "Second step", "cost": .2, "latency_s": 3, "calls": []}],
        "reports": [{"title": "Door report", "step": 1}], "checklist": checklist,
        "escalation": {"reason": "Blocked", "question": "Which <door>?", "step": 1}})
    assert cli.main(["console", str(tmp_path)]) == 0
    page = (tmp_path / "console.html").read_text(encoding="utf-8")
    assert str(tmp_path / "console.html") in capsys.readouterr().out
    for value in ("&lt;script&gt;bad()&lt;/script&gt;", "Second step", "s000.jpg", "s001.jpg", "done",
                  "0.30000", "Previous", "Next", "Play to end", "ArrowLeft", "ArrowRight", "<progress",
                  "Door report", "Unverified", "Which &lt;door&gt;?", "Blocked"):
        assert value in page
    assert "<script>bad()" not in page
    assert console.write(tmp_path) == tmp_path / "console.html"


def test_allow_game_window_skips_only_the_game_window_check(fake_cli, monkeypatch, capsys):
    from pt import guard
    seen = []

    def problems(probes=None):
        seen.append(sorted(probes or {}))
        return [] if probes and "games" in probes else ["a game window is open: Marvel"]
    monkeypatch.setattr(guard, "problems", problems)
    assert cli.main(["goal", "g1"]) == 1
    assert "BLOCKED" in capsys.readouterr().out
    assert cli.main(["goal", "g2", "--allow-game-window"]) == 0
    assert seen[-1] == ["games"]

def test_unknown_tool_is_rejected_and_run_continues():
    driver = FakeDriver()
    client = FakeClient([call("run_shell"), act([{"type": "wait"}]), END])

    result = loop.run_episode(client, driver, "Try")

    assert result["log"][0]["calls"][0]["output"] == "unknown tool"
    assert driver.executed == [{"type": "wait"}]
    assert result["steps"] == 1 and result["stop"] == "model"


def test_unoffered_escalate_is_rejected_and_run_continues():
    client = FakeClient([call("escalate", reason="Blocked", question="Help"), END])

    result = loop.run_episode(client, FakeDriver(), "Try", escalate=False)

    assert result["log"][0]["calls"][0]["output"] == "unknown tool"
    assert result["stop"] == "model"
    assert "escalation" not in result


@pytest.mark.parametrize("name,args", [("tick", {"index": 0, "evidence": "done"}),
                                       ("set_checklist", {"items": ["Door"]})])
def test_unoffered_checklist_tools_are_rejected(name, args):
    sink = {}
    client = FakeClient([call(name, **args), END])

    result = loop.run_episode(client, FakeDriver(), "Try", checklist=False, sink=sink)

    assert result["log"][0]["calls"][0]["output"] == "unknown tool"
    assert result["checklist"] == []
    assert sink["checklist"] == []
    assert result["stop"] == "model"
