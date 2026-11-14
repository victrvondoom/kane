import json

import pytest

from metaclient import local
from pt import cli, confirm, guard
from trials import common
from test_loop import act
from test_workshop import END, fake_cli, put
from test_judge import FakeD, Seq, _frames


@pytest.fixture
def private_cli(fake_cli, monkeypatch):
    folder, client, drivers, locks = fake_cli
    created = []
    def make(**kwargs):
        created.append(kwargs)
        return client
    monkeypatch.setattr(local, "LocalClient", make)
    monkeypatch.setattr(common, "load_client", lambda _: pytest.fail("hosted client called"))
    return folder, client, drivers, locks, created


@pytest.mark.parametrize("kind", ["goal", "hunt"])
def test_local_run(private_cli, kind):
    folder, client, drivers, locks, created = private_cli
    assert cli.main([kind, "run", "--model", "glimmer-local", "--reasoning", "high", "--glimmer-url", "http://localhost:8090/v1"]) == 0
    result = json.loads((folder / "result.json").read_text())
    assert result["settings"]["model"] == "glimmer-local"
    assert client.bodies[0][0]["reasoning"] == {"effort": "high"}
    assert created[0]["base_url"] == "http://localhost:8090/v1" and created[0]["reasoning"] == "high"
    assert locks == ["take", "release"] and drivers[0].closed


def test_local_confirm(private_cli, monkeypatch):
    folder, client, _, locks, created = private_cli
    from pt import adapter
    monkeypatch.setattr(adapter, "make", lambda *a, **kw: FakeD())
    client.responses = lambda *a, **kw: {"output_text": '{"verdict":"YES","evidence":"The value stayed at one"}', "_cost_usd": 0.0}
    put(folder, "result.json", {"settings": {"model": "glimmer-local"}, "reports": [{"title": "Value", "step": 1}], "actions_by_step": [[{}]]})
    assert cli.main(["confirm", str(folder), "--model", "glimmer-local"]) == 0
    assert json.loads((folder / "confirm.json").read_text())[0]["confirmed"]
    assert json.loads((folder / "result.json").read_text())["settings"]["model"] == "glimmer-local"
    assert created and locks == ["take", "release"]


@pytest.mark.parametrize("override", [False, True])
def test_resume_model(private_cli, monkeypatch, override):
    folder, client, _, _, created = private_cli
    put(folder, "result.json", {"settings": {"model": "glimmer-local"}})
    hosted = []
    monkeypatch.setattr(common, "load_client", lambda _: (hosted.append(True), client)[1])
    assert cli.main(["resume", "run", "--note", "Continue"] + (["--model", "wonder"] if override else [])) == 0
    assert bool(hosted) is override and bool(created) is not override
    assert json.loads((folder / "result.json").read_text())["settings"]["model"] == ("wonder" if override else "glimmer-local")


def test_local_guard_blocks(private_cli, monkeypatch):
    _, _, _, locks, created = private_cli
    monkeypatch.setattr(guard, "problems", lambda: ["busy"])
    assert cli.main(["hunt", "run", "--model", "glimmer-local"]) == 1
    assert not locks and not created


def test_local_memory_stop(private_cli, monkeypatch):
    folder, client, _, locks, _ = private_cli
    client.script = [act([{"type": "wait"}]), END]
    monkeypatch.setattr(guard, "must_stop", lambda *_: True)
    assert cli.main(["hunt", "run", "--model", "glimmer-local"]) == 0
    assert json.loads((folder / "result.json").read_text())["stop"] == "memory"
    assert locks == ["take", "release"]


def test_judge_uses_configured_local_reasoning():
    from pt import judge
    client = Seq([("completed", '{"verdict":"NO","evidence":"No change is shown"}')])
    client.reasoning = "high"
    judge.judge(client, {}, _frames(), [])
    assert client.extras[0]["reasoning"] == {"effort": "high"}


def test_model_flag_defaults():
    for kind in ("goal", "hunt", "confirm"):
        a = cli.parse([kind, "run"])
        assert a.model == "wonder" and a.reasoning == "low"
        assert a.glimmer_url == "http://127.0.0.1:8090/v1"
