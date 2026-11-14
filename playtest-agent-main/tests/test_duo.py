"""Duo uses fake clients and drivers only. No browser or model service."""
import copy
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from pt import duo
from pt.adapter import load_config, validate
from pt.cli import parse
from pt.replay import replay_trace

ROOT = Path(__file__).resolve().parents[1]


def call(name="act", **args):
    return {"type": "function_call", "name": name, "call_id": "fake", "arguments": json.dumps(args)}


def act(*keys, message=""):
    return call(actions=[{"type": "keypress", "keys": list(keys)}], message=message)


class Driver:
    name = "Switch Partners"
    goal = "Open the gate together and reach the exit."

    def __init__(self, bugs=""):
        self.cfg = load_config(ROOT / "games/duo.json")
        self.executed = []
        self.closed = False

    def execute(self, actions):
        self.executed.append(copy.deepcopy(actions))

    def screenshot(self):
        return b"fake screenshot"

    def tick(self):
        return len(self.executed) * 19

    def state(self):
        return {"turns": len(self.executed)}

    def won(self):
        return False

    def bug_hits(self):
        return {}

    def close(self):
        self.closed = True


class Client:
    def __init__(self, player, outputs, order=None, cost=0.01):
        self.player, self.outputs, self.cost = player, iter(outputs), cost
        self.order = order if order is not None else []
        self.bodies = []

    def wonder(self, body, **kwargs):
        self.bodies.append(copy.deepcopy(body))
        self.order.append(self.player)
        return {"id": "fake", "output": next(self.outputs), "_cost_usd": self.cost,
                "_latency_s": 0, "usage": {"input_tokens": 100}}


def test_turns_filter_keys_and_keep_merged_replay_order():
    order = []
    clients = [Client(1, [[act("right", "a", "Enter")], [act("ArrowLeft", "q")]], order),
               Client(2, [[act("D", "left", "KeyQ")], [act("w", "Enter")]], order)]
    driver = Driver()
    result = duo.run_duo(clients, driver, driver.goal, max_steps=4)
    assert order == [1, 2, 1, 2]
    assert result["steps"] == 4 and result["stop"] == "steps"
    assert result["dropped_keys"] == 4
    assert result["actions_by_step"] == driver.executed
    assert [a[0]["keys"] for a in driver.executed] == [
        ["ArrowRight", "Enter"], ["d", "q"], ["ArrowLeft"], ["w"]]
    assert result["actions_by_player"]["1"] == driver.executed[::2]
    assert result["actions_by_player"]["2"] == driver.executed[1::2]
    assert [line["player"] for line in result["log"]] == order
    copies = []

    def fresh(bugs=""):
        copies.append(Driver(bugs))
        return copies[-1]

    trace = replay_trace(result["actions_by_step"], result["steps"], "", driver_cls=fresh)
    assert copies[0].executed == driver.executed
    assert copies[0].closed and trace["states"][-1] == driver.state()


def current_text(body):
    return body["input"][-1]["content"][0]["text"]


def test_message_only_reaches_other_players_next_prompt():
    clients = [Client(1, [[act("enter", message="hold the blue switch")], [act("right")], [act("right")]]),
               Client(2, [[act("q")], [act("d")]])]
    result = duo.run_duo(clients, Driver(), "test", max_steps=5)
    assert "hold the blue switch" in current_text(clients[1].bodies[0])
    assert "hold the blue switch" not in json.dumps(clients[1].bodies[1])
    assert "hold the blue switch" not in current_text(clients[0].bodies[1])
    assert result["messages"] == [{"player": 1, "to": 2, "step": 0, "text": "hold the blue switch"}]
    assert "player 1" in clients[0].bodies[0]["instructions"].lower()
    assert "player 2" in clients[1].bodies[0]["instructions"].lower()


def test_shared_dollar_cap_stops_both_and_reserves_next_call():
    clients = [Client(1, [[act("right")]], cost=0.15), Client(2, [[act("d")]], cost=0.15)]
    result = duo.run_duo(clients, Driver(), "test", max_steps=20, max_usd=0.20)
    assert result["stop"] == "cost" and result["cost_usd"] == 0.15
    assert len(clients[0].bodies) == 1 and not clients[1].bodies


@pytest.mark.parametrize("caps,stop", [({"max_steps": 0}, "steps"), ({"max_seconds": 0}, "time"), ({"max_usd": 0}, "cost")])
def test_empty_caps_make_no_call(caps, stop):
    clients = [Client(1, []), Client(2, [])]
    result = duo.run_duo(clients, Driver(), "test", **caps)
    assert result["stop"] == stop and result["steps"] == 0
    assert not any(c.bodies for c in clients)


def test_reports_are_tagged_with_player_and_replay_step():
    report = call("report_bug", title="Gate stuck", expected="Open", actual="Closed")
    clients = [Client(1, [[act("right"), report]]), Client(2, [[act("d"), report]])]
    result = duo.run_duo(clients, Driver(), "test", max_steps=2)
    assert [(r["player"], r["step"]) for r in result["reports"]] == [(1, 1), (2, 2)]


def test_page_config_and_public_manifest():
    cfg = load_config(ROOT / "games/duo.json")
    assert validate(cfg) == [] and len(cfg["players"]) == 2
    assert set(cfg["players"][0]["keys"]).isdisjoint(cfg["players"][1]["keys"])
    assert cfg["frame_lock"] and cfg["hold_frames"] == 15 and cfg["settle_frames"] == 4
    source = (ROOT / "game/duo.html").read_text(encoding="utf-8")
    for text in ("BUGS.has(1)", "BUGS.has(2)", "q.get('bugs') || ''", "window.__state", "window.__ready", "window.__frame", "window.__won", "window.__bugHit"):
        assert text in source
    assert "game/duo.html" in (ROOT / "tools/public_manifest.txt").read_text(encoding="utf-8").splitlines()


def test_cli_defaults_and_report_has_two_columns(tmp_path):
    args = parse(["duo", "fake", "--game", "duo", "--bugs", "1,2"])
    assert args.game == "duo" and args.bugs == "1,2"
    result = duo.run_duo([Client(1, [[act("right", message="<wait>")]]), Client(2, [[act("d")]])], Driver(), "test", max_steps=2)
    result["kind"] = "duo"
    (tmp_path / "result.json").write_text(json.dumps(result), encoding="utf-8")
    from pt.report import build
    page = build(tmp_path)
    assert 'class="duo-lines"' in page and "Player 1" in page and "Player 2" in page
    assert "&lt;wait&gt;" in page and "<wait>" not in page


def test_confirmation_uses_the_merged_trace(tmp_path, monkeypatch):
    from pt import confirm
    report = call("report_bug", title="Gate", expected="Open", actual="Closed")
    clients = [Client(1, [[act("right")]]), Client(2, [[act("d"), report]])]
    result = duo.run_duo(clients, Driver(), "test", max_steps=2)
    (tmp_path / "result.json").write_text(json.dumps(result), encoding="utf-8")
    drivers = []

    def fresh(bugs=""):
        drivers.append(Driver(bugs))
        return drivers[-1]

    def fake_judge(client, report, frames, diff, **kwargs):
        assert report["player"] == 2 and len(frames) == 3
        return {"confirmed": True, "evidence": "fake gate evidence", "raw": "YES fake", "cost_usd": 0, "strip": b"fake strip"}

    monkeypatch.setattr(confirm.J, "judge", fake_judge)
    rows = confirm.confirm_run(tmp_path, object(), driver_cls=fresh)
    assert rows[0]["confirmed"] and rows[0]["reproducible"]
    assert len(drivers) == 2 and all(d.closed and d.executed == result["actions_by_step"] for d in drivers)


@pytest.mark.skipif(shutil.which("node") is None, reason="Node is needed for the fake canvas check")
def test_game_logic_with_node_fake_canvas():
    # Node executes only page JavaScript with fake DOM hooks, never a browser.
    script = r"""
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const source = fs.readFileSync(process.argv[1], 'utf8').split('<script>')[1].split('</script>')[0];
function game(bugs='') {
  const handlers = {}, frames = [];
  const g = new Proxy({}, {get: () => () => {}});
  const c = {URLSearchParams, location: {search: bugs ? '?bugs=' + bugs : ''},
    document: {getElementById: () => ({getContext: () => g})},
    addEventListener: (name, fn) => handlers[name] = fn,
    requestAnimationFrame: fn => frames.push(fn)};
  c.window = c;
  vm.runInNewContext(source, c);
  const step = n => {for(let i=0;i<n;i++) frames.shift()();};
  const key = (code, n=1) => {
    handlers.keydown({code, repeat:false, preventDefault(){}});
    step(n); handlers.keyup({code});
  };
  step(1);
  assert(c.__ready && c.__frame === 1 && !c.__won);
  return {c, step, key, state: () => c.__state()};
}
function holdLeft(g) { g.key('ArrowRight',46); g.key('Enter'); assert(g.state().gateOpen); }
const clean = game();
clean.key('KeyD',100);
assert.equal(clean.state().players[1].x,350); // closed gate blocks the partner
holdLeft(clean);
clean.key('KeyW'); clean.step(40);
assert(clean.state().gateOpen); // a partner's jump must leave the holder alone
clean.key('KeyD',43); clean.key('KeyQ');
assert.equal(clean.state().players[1].holding,1);
clean.key('ArrowRight',160);
assert(!clean.c.__won); // one player at the exit is insufficient
clean.key('KeyD',80);
assert(clean.c.__won);
assert(Object.values(clean.c.__bugHit).every(v => !v));
const one = game('1'); holdLeft(one); one.key('KeyW');
assert(!one.state().gateOpen && one.c.__bugHit[1] && !one.c.__bugHit[2]);
const two = game('2'); holdLeft(two); two.key('KeyD',120);
assert(two.state().gateOpen && two.state().players[1].x === 350 && two.c.__bugHit[2] && !two.c.__bugHit[1]);
const both = game('1,2'); holdLeft(both); both.key('KeyD',120); both.key('KeyW');
assert(both.c.__bugHit[1] && both.c.__bugHit[2]);
console.log('clean win and both planted bug flags checked');
"""
    completed = subprocess.run(["node", "-e", script, str(ROOT / "game/duo.html")], capture_output=True, text=True)
    assert completed.returncode == 0, completed.stderr
    assert "clean win" in completed.stdout


def test_rejects_shared_controls_and_shared_client():
    driver = Driver()
    client = Client(1, [])
    with pytest.raises(ValueError, match="separate client"):
        duo.run_duo([client, client], driver, "test")
    driver.cfg["players"][1]["keys"]["enter"] = "Enter"
    with pytest.raises(ValueError, match="separate"):
        duo.run_duo([client, Client(2, [])], driver, "test")


def test_multiple_tool_calls_form_one_bounded_turn():
    clients = [Client(1, [[act("right"), act("enter"), call(actions=[{"type": "reload"}, {"type": "click", "x": 1, "y": 1}, {"type": "wait", "ms": 999999}])]]),
               Client(2, [[act("d")]])]
    driver = Driver()
    result = duo.run_duo(clients, driver, "test", max_steps=2)
    assert len(driver.executed) == 2 and len(result["actions_by_step"][0]) == 3
    assert result["actions_by_step"][0][-1] == {"type": "wait", "ms": 2000}


@pytest.mark.parametrize("fail_second", [False, True])
def test_cli_with_two_fake_clients_one_driver_and_saved_partial_run(tmp_path, monkeypatch, fail_second):
    from pt import adapter, cli, guard
    from trials import common
    order = []
    clients = [Client(1, [[act("right")]], order), Client(2, [[act("d")]], order)]
    if fail_second:
        def fail(*args, **kwargs):
            raise RuntimeError("fake transport failure")
        clients[1].wonder = fail
    factory_calls = []

    def load_client(repo):
        factory_calls.append(repo)
        return clients[len(factory_calls) - 1]

    drivers = []

    def make(game, bugs=""):
        assert game == "duo" and bugs == "1,2"
        drivers.append(Driver())
        return drivers[-1]

    lock_calls = []
    monkeypatch.setattr(common, "load_client", load_client)
    monkeypatch.setattr(guard, "problems", lambda: [])
    monkeypatch.setattr(guard, "take_lock", lambda: lock_calls.append("take"))
    monkeypatch.setattr(guard, "release_lock", lambda: lock_calls.append("release"))
    monkeypatch.setattr(guard, "free_gb", lambda: 100)
    monkeypatch.setattr(guard, "total_gb", lambda: 100)
    monkeypatch.setattr(guard, "must_stop", lambda *args: False)
    config = ROOT / "games/duo.json"
    monkeypatch.setattr(adapter, "config_path", lambda game: config)
    monkeypatch.setattr(adapter, "ROOT", tmp_path)
    monkeypatch.setattr(adapter, "make", make)
    assert cli.main(["duo", "fake", "--bugs", "1,2", "--max-steps", "2"]) == 0
    folder = tmp_path / "data/runs/fake"
    result = json.loads((folder / "result.json").read_text(encoding="utf-8"))
    assert len(drivers) == 1 and drivers[0].closed
    assert len(factory_calls) == 2 and lock_calls == ["take", "release"]
    assert result["game_id"] == "duo" and result["bugs_on"] == "1,2"
    assert result["steps"] == (1 if fail_second else 2)
    assert result["stop"] == ("error:RuntimeError" if fail_second else "steps")
    assert (folder / "report.html").is_file()
