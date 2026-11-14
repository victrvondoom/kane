"""The live demo's money guards, with a fake model ($0) behind the real client and the real ledger. No network, no browser."""
import json
import threading
import urllib.error
import urllib.request

import pytest

from metaclient import client as C
from metaclient.ledger import CapReached
from pt import demo as D

CODE = "open-sesame"


@pytest.fixture(autouse=True)
def no_cap_env(monkeypatch):
    monkeypatch.delenv("PLAYTEST_CAP_USD", raising=False)
    monkeypatch.delenv("DEMO_TRUST_CF", raising=False)


def act(cid="c"):
    return [{"type": "function_call", "name": "act", "call_id": cid,
             "arguments": json.dumps({"look": "a cave", "plan": "walk", "actions": [{"type": "wait"}]})}]


class FakeHttp:
    """Answers every model call with one act call. tokens_in and tokens_out set the real cost the client works out."""

    def __init__(self, tokens_in=3000, tokens_out=100, on_call=None):
        self.calls, self.tokens_in, self.tokens_out, self.on_call = 0, tokens_in, tokens_out, on_call

    def send(self, method, url, headers, json_body=None, files=None, timeout=300):
        self.calls += 1
        if self.on_call:
            self.on_call(self.calls)
        body = {"id": f"r{self.calls}", "output": act(f"c{self.calls}"),
                "usage": {"input_tokens": self.tokens_in, "output_tokens": self.tokens_out}}
        return C.Resp(200, {}, json.dumps(body).encode())


class FakeDriver:
    name, goal, controls = "Fake Cave", "g", "arrows"

    def __init__(self, won_after=None):
        self.n, self.won_after, self.closed = 0, won_after, False

    def screenshot(self):
        return b"\xff\xd8fake"

    def execute(self, actions):
        self.n += 1

    def state(self):
        return {"n": self.n}

    def won(self):
        return self.won_after is not None and self.n >= self.won_after

    def bug_hits(self):
        return []

    def close(self):
        self.closed = True


def rows_for(repo, usd):
    return [{"type": "reserve", "id": repo + "1", "usd": usd, "repo": repo, "label": "x", "ts": 0},
            {"type": "settle", "id": repo + "1", "cost_usd": usd, "repo": repo, "ts": 0}]


def make(tmp_path, passcode=CODE, http=None, rows=(), won_after=1, **kw):
    ledger = tmp_path / "ledger.jsonl"
    ledger.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    http = http or FakeHttp()
    d = D.Demo(ledger, passcode, lambda led: C.MetaClient("KEY", led, http), lambda bugs="": FakeDriver(won_after),
               data=tmp_path / "demo", replay_root=tmp_path / "runs", **kw)
    return d, http, ledger


def finish(d):
    d.thread.join(30)
    assert not d.thread.is_alive()


# ---- 1. kill switch ------------------------------------------------------------

def test_kill_switch_refuses(tmp_path):
    d, http, _ = make(tmp_path)
    d.kill_file.parent.mkdir(parents=True)
    d.kill_file.write_text("")
    assert d.admit(CODE, "1.1.1.1") == (False, D.OFF)
    assert http.calls == 0


def test_kill_switch_stops_a_running_run(tmp_path):
    holder = {}
    http = FakeHttp(on_call=lambda n: n == 2 and holder["d"].kill_file.write_text(""))
    d, _, _ = make(tmp_path, http=http, won_after=None)
    holder["d"] = d
    d.kill_file.parent.mkdir(parents=True, exist_ok=True)
    ok, name = d.admit(CODE, "1.1.1.1")
    assert ok
    finish(d)
    res = json.loads((d.runs_dir / name / "result.json").read_text(encoding="utf-8"))
    assert res["stop"] == "kill switch" and http.calls == 2


# ---- 2 to 4. passcode ----------------------------------------------------------

def test_no_passcode_set_refuses(tmp_path):
    d, http, _ = make(tmp_path, passcode="")
    assert d.admit("", "1.1.1.1") == (False, D.NO_CODE)
    assert d.admit("anything", "1.1.1.1") == (False, D.NO_CODE)
    assert http.calls == 0


def test_wrong_passcode_refuses(tmp_path):
    d, http, _ = make(tmp_path)
    assert d.admit("open-sesam", "1.1.1.1") == (False, D.WRONG)
    assert d.admit(None, "1.1.1.1") == (False, D.WRONG)
    assert http.calls == 0
    ok, _ = d.admit(CODE, "1.1.1.1")
    assert ok
    finish(d)


def test_passcode_guessing_is_locked_out(tmp_path):
    d, http, _ = make(tmp_path)
    for _ in range(D.BAD_CODES_PER_IP):
        assert d.admit("guess", "6.6.6.6") == (False, D.WRONG)
    assert d.admit(CODE, "6.6.6.6") == (False, D.GUESSING)     # even the right code, from that address, for an hour
    ok, _ = d.admit(CODE, "7.7.7.7")
    assert ok
    finish(d)


def test_lockout_ends_after_an_hour(tmp_path):
    now = [1000.0]
    d, _, _ = make(tmp_path, clock=lambda: now[0])
    for _ in range(D.BAD_CODES_PER_IP):
        d.admit("guess", "6.6.6.6")
    now[0] += D.HOUR + 1
    ok, _ = d.admit(CODE, "6.6.6.6")
    assert ok
    finish(d)


# ---- 5 and 6. one at a time, runs per address ---------------------------------

def test_one_run_at_a_time(tmp_path):
    gate = threading.Event()
    http = FakeHttp(on_call=lambda n: gate.wait(10))
    d, _, _ = make(tmp_path, http=http)
    ok, _ = d.admit(CODE, "1.1.1.1")
    assert ok
    assert d.admit(CODE, "2.2.2.2") == (False, D.BUSY)
    gate.set()
    finish(d)
    ok, _ = d.admit(CODE, "2.2.2.2")
    assert ok
    finish(d)


def test_runs_per_address(tmp_path):
    d, _, _ = make(tmp_path)
    for _ in range(D.RUNS_PER_IP):
        ok, _ = d.admit(CODE, "1.1.1.1")
        assert ok
        finish(d)
    assert d.admit(CODE, "1.1.1.1") == (False, D.USED)
    ok, _ = d.admit(CODE, "2.2.2.2")
    assert ok
    finish(d)


def test_address_book_keeps_no_plain_address(tmp_path):
    d, _, _ = make(tmp_path)
    d.admit(CODE, "203.0.113.9")
    finish(d)
    assert "203.0.113.9" not in d.book_file.read_text(encoding="utf-8")


def test_damaged_address_book_refuses(tmp_path):
    d, http, _ = make(tmp_path)
    d.book_file.parent.mkdir(parents=True)
    d.book_file.write_text("{not json", encoding="utf-8")
    assert d.admit(CODE, "1.1.1.1") == (False, D.NO_BOOK)
    assert http.calls == 0


# ---- 7 to 10. the ledger and the caps ------------------------------------------

def test_missing_ledger_refuses(tmp_path):
    d, http, ledger = make(tmp_path)
    ledger.unlink()
    assert d.admit(CODE, "1.1.1.1") == (False, D.NO_LEDGER)
    assert http.calls == 0


def test_damaged_ledger_refuses(tmp_path):
    d, http, ledger = make(tmp_path)
    ledger.write_text("this is not json\n", encoding="utf-8")
    assert d.admit(CODE, "1.1.1.1") == (False, D.NO_LEDGER)
    assert http.calls == 0


def test_demo_cap_refuses(tmp_path):
    d, http, _ = make(tmp_path, rows=rows_for(D.DEMO_REPO, D.DEMO_CAP_USD - 0.5))
    assert d.admit(CODE, "1.1.1.1") == (False, D.SPENT)
    assert http.calls == 0


def two_rows(*pairs):
    """rows_for with a unique id per pair, so two repos' rows never share an id."""
    out = []
    for i, (repo, usd) in enumerate(pairs):
        out += [{**r, "id": f"{repo}{i}"} for r in rows_for(repo, usd)]
    return out


def test_demo_has_its_own_room(tmp_path):
    """The ledger on 28 Oct, after the proof run: other spend $45.42, demo $0.42015. The demo must still get its own $20, less its spend."""
    d, http, ledger = make(tmp_path, rows=two_rows(("playtest-agent", 45.42), (D.DEMO_REPO, 0.42015)))
    assert D.room(ledger) == pytest.approx(D.DEMO_CAP_USD - 0.42015)
    ok, _ = d.admit(CODE, "1.1.1.1")
    assert ok
    finish(d)
    assert http.calls >= 1


def test_other_spend_at_its_cap_does_not_block_the_demo(tmp_path):
    from metaclient.ledger import TOTAL_CAP_USD
    d, _, _ = make(tmp_path, rows=two_rows(("other-repo", TOTAL_CAP_USD)))
    ok, _ = d.admit(CODE, "1.1.1.1")
    assert ok
    finish(d)


def test_other_runs_still_stop_at_their_cap_and_never_count_demo_spend(tmp_path):
    from metaclient.ledger import TOTAL_CAP_USD, Ledger
    path = tmp_path / "l.jsonl"
    path.write_text("".join(json.dumps(r) + "\n" for r in two_rows(("playtest-agent", TOTAL_CAP_USD - 0.5), (D.DEMO_REPO, 15.0))), encoding="utf-8")
    led = Ledger(path, repo="playtest-agent")
    led.reserve(0.4, "fits under $50 although the demo spent $15")
    with pytest.raises(CapReached):
        led.reserve(0.2, "would pass $50")


def test_worst_case_is_165_dollars(tmp_path):
    from metaclient.ledger import TOTAL_CAP_USD, Ledger
    path = tmp_path / "l.jsonl"
    path.write_text("".join(json.dumps(r) + "\n" for r in two_rows(("playtest-agent", TOTAL_CAP_USD), (D.DEMO_REPO, D.DEMO_CAP_USD))), encoding="utf-8")
    with pytest.raises(CapReached):
        Ledger(path, repo="playtest-agent").reserve(0.01)
    with pytest.raises(CapReached):
        D.DemoLedger(path).reserve(0.01)
    assert TOTAL_CAP_USD + D.DEMO_CAP_USD == 165.00


def test_run_cap_in_the_ledger(tmp_path):
    led = D.DemoLedger(tmp_path / "l.jsonl")
    rid = led.reserve(0.6, "a")
    led.settle(rid, 0.6)
    with pytest.raises(CapReached, match="run cap"):
        led.reserve(0.6, "b")
    assert led.run_spent() == pytest.approx(0.6)


def test_demo_cap_in_the_ledger(tmp_path):
    path = tmp_path / "l.jsonl"
    path.write_text("".join(json.dumps(r) + "\n" for r in rows_for(D.DEMO_REPO, D.DEMO_CAP_USD - 0.1)), encoding="utf-8")
    with pytest.raises(CapReached, match="demo cap"):
        D.DemoLedger(path).reserve(0.2, "a")


def test_run_cap_is_hard(tmp_path):
    """Calls that cost $0.28 each: the ledger refuses the call that could take the run past $1.00, before it is sent."""
    http = FakeHttp(tokens_in=60000, tokens_out=2000)
    d, _, ledger = make(tmp_path, http=http, won_after=None)
    ok, name = d.admit(CODE, "1.1.1.1")
    assert ok
    finish(d)
    res = json.loads((d.runs_dir / name / "result.json").read_text(encoding="utf-8"))
    assert res["stop"] == "run cap", res["stop"]
    assert http.calls == 3
    assert D.DEMO_CAP_USD - D.room(ledger) <= D.RUN_CAP_USD + 1e-9
    assert d.status()["cost_usd"] <= D.RUN_CAP_USD


def test_demo_spend_goes_in_the_same_ledger(tmp_path):
    d, http, ledger = make(tmp_path, rows=rows_for("playtest-agent", 10.0))
    ok, _ = d.admit(CODE, "1.1.1.1")
    finish(d)
    rows = [json.loads(x) for x in ledger.read_text(encoding="utf-8").splitlines()]
    demo = [r for r in rows if r.get("repo") == D.DEMO_REPO]
    assert http.calls >= 1 and len(demo) == 2 * http.calls
    assert rows[0]["repo"] == "playtest-agent"


# ---- 11 and 12. the host and the address ---------------------------------------

def test_host_busy_refuses(tmp_path):
    d, http, _ = make(tmp_path, host_problems=lambda: ["GPU is 90% used (limit 40%)"])
    assert d.admit(CODE, "1.1.1.1") == (False, "The host is busy: GPU is 90% used (limit 40%)")
    assert http.calls == 0


class Req:
    def __init__(self, headers, addr="10.0.0.5"):
        self.headers, self.client_address = headers, (addr, 5555)


def test_header_not_trusted_by_default():
    assert D.client_ip(Req({"CF-Connecting-IP": "9.9.9.9"})) == "10.0.0.5"


def test_header_trusted_behind_our_tunnel(monkeypatch):
    monkeypatch.setenv("DEMO_TRUST_CF", "1")
    assert D.client_ip(Req({"CF-Connecting-IP": "9.9.9.9"})) == "9.9.9.9"


# ---- replay and files ----------------------------------------------------------

def recorded(tmp_path, name="cl21"):
    folder = tmp_path / "runs" / name
    folder.mkdir(parents=True)
    (folder / "s000.jpg").write_bytes(b"\xff\xd8a")
    (folder / "s001.jpg").write_bytes(b"\xff\xd8b")
    log = [{"step": 0, "calls": [{"name": "act", "args": {"look": "the first screen"}}]}]
    (folder / "result.json").write_text(json.dumps({"game": "Cave Courier", "steps": 1, "cost_usd": 0.01, "reports": [], "log": log}), encoding="utf-8")


def test_replay_shows_a_recorded_run(tmp_path):
    recorded(tmp_path)
    d, _, _ = make(tmp_path)
    r = d.replay("cl21")
    assert [f["file"] for f in r["frames"]] == ["s000.jpg", "s001.jpg"]
    assert r["frames"][0]["look"] == "the first screen"
    assert d.status()["replays"] == ["cl21"]


def test_replay_is_offered_when_refused(tmp_path):
    recorded(tmp_path)
    d, _, _ = make(tmp_path, rows=rows_for(D.DEMO_REPO, D.DEMO_CAP_USD))
    assert d.admit(CODE, "1.1.1.1") == (False, D.SPENT)
    assert d.status()["replays"] == ["cl21"]


def test_files_cannot_leave_their_folders(tmp_path):
    recorded(tmp_path)
    (tmp_path / "private.jpg").write_bytes(b"\xff\xd8private")      # a picture outside the run folders
    d, _, _ = make(tmp_path)
    assert d.file("replay", "cl21", "s000.jpg") is not None
    for bad in ("../../private.jpg", "..\\..\\private.jpg", "../ledger.jsonl", "..", "result.json", "s000.jpg/../x"):
        assert d.file("replay", "cl21", bad) is None
    assert d.file("replay", "..", "s000.jpg") is None
    assert d.file("run", "anything", "s000.jpg") is None


# ---- the HTTP layer ------------------------------------------------------------

def test_server_never_shares_a_port(tmp_path):
    """28 Oct: another program bound 127.0.0.1:8765 while the demo held it, because the server allowed address reuse. Now it refuses."""
    import socket
    other = socket.socket()
    other.bind(("127.0.0.1", 0))
    other.listen()
    try:
        d, _, _ = make(tmp_path)
        with pytest.raises(OSError):
            D.serve(d, other.getsockname()[1]).server_close()
    finally:
        other.close()


def test_nothing_can_share_the_demo_port(tmp_path):
    import socket
    d, _, _ = make(tmp_path)
    server = D.serve(d, 0)
    try:
        other = socket.socket()
        other.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        with pytest.raises(OSError):
            other.bind(("127.0.0.1", server.server_address[1]))
        other.close()
    finally:
        server.server_close()


def test_http_says_why(tmp_path):
    d, http, _ = make(tmp_path)
    server = D.serve(d, 0)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        req = urllib.request.Request(base + "/run", data=json.dumps({"code": "nope"}).encode(), headers={"Content-Type": "application/json"})
        with pytest.raises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(req, timeout=10)
        assert e.value.code == 403 and json.loads(e.value.read())["reason"] == D.WRONG
        with urllib.request.urlopen(base + "/status", timeout=10) as r:
            assert json.loads(r.read())["state"] == "idle"
        with urllib.request.urlopen(base + "/", timeout=10) as r:
            assert b"Playtest Agent" in r.read()
        with pytest.raises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(base + "/replay-file/cl21/..%2Fledger.jsonl", timeout=10)
        assert e.value.code == 404
        assert http.calls == 0
    finally:
        server.shutdown()
        server.server_close()


# ---- the art build -------------------------------------------------------------

def test_demo_starts_the_art_build(tmp_path, monkeypatch):
    """His pick, 28 Oct: the live demo plays the art build (h12 found 5 of 5 planted bugs on it)."""
    import pt.adapter
    made = []
    monkeypatch.setattr(pt.adapter, "make", lambda name, bugs="", **kw: made.append((name, bugs)) or FakeDriver())
    demo = D.build({"DEMO_PASSCODE": CODE, "PLAYTEST_LEDGER": str(tmp_path / "l.jsonl")}, key="KEY")
    demo.driver_factory("1,2")
    assert made == [("cave-courier-art", "1,2")]


def test_a_run_records_the_art_build(tmp_path):
    d, _, _ = make(tmp_path)
    ok, name = d.admit(CODE, "1.1.1.1")
    finish(d)
    res = json.loads((d.runs_dir / name / "result.json").read_text(encoding="utf-8"))
    assert res["game_id"] == "cave-courier-art"


def test_first_replay_is_an_art_build_run():
    assert D.REPLAYS[0] == "h12"
    result = D.ROOT / "data" / "runs" / "h12" / "result.json"
    if not result.is_file():
        pytest.skip("the recorded runs are not in this copy")
    assert json.loads(result.read_text(encoding="utf-8"))["game_id"] == "cave-courier-art"


def test_replay_captions_without_look_lines(tmp_path):
    """h12 ran without LOOK lines: a frame shows its bug report, else the keys pressed."""
    folder = tmp_path / "runs" / "h12"
    folder.mkdir(parents=True)
    for i in range(3):
        (folder / f"s{i:03d}.jpg").write_bytes(b"\xff\xd8")
    log = [{"step": 0, "calls": [{"name": "act", "args": {"actions": [{"type": "keypress", "keys": ["right"]}, {"type": "keypress", "keys": ["space"]}]}}]},
           {"step": 1, "calls": [{"name": "act", "args": {"actions": [{"type": "wait"}]}}]}]
    result = {"game": "Cave Courier", "game_id": "cave-courier-art", "steps": 2, "cost_usd": 0.1, "log": log,
              "reports": [{"title": "Door stays shut", "step": 1}]}
    (folder / "result.json").write_text(json.dumps(result), encoding="utf-8")
    (folder / "confirm.json").write_text(json.dumps([{"title": "Door stays shut", "confirmed": True}]), encoding="utf-8")
    d, _, _ = make(tmp_path, replays=("h12",))
    r = d.replay("h12")
    assert r["frames"][0]["look"] == "Keys: right space"
    assert r["frames"][1]["look"] == "Bug report: Door stays shut"
    assert r["confirmed"] == 1 and r["reports"] == 1


# ---- behind Caddy on the droplet ------------------------------------------------

def test_proxy_header_trusted_only_from_this_machine(monkeypatch):
    monkeypatch.setenv("DEMO_TRUST_PROXY", "1")
    assert D.client_ip(Req({"X-Forwarded-For": "6.6.6.6, 5.5.5.5"}, addr="127.0.0.1")) == "5.5.5.5"
    assert D.client_ip(Req({"X-Forwarded-For": "6.6.6.6"}, addr="10.0.0.5")) == "10.0.0.5"


def test_proxy_header_not_trusted_by_default():
    assert D.client_ip(Req({"X-Forwarded-For": "5.5.5.5"}, addr="127.0.0.1")) == "127.0.0.1"


def test_droplet_guard_reads_free_memory(tmp_path, monkeypatch):
    meminfo = tmp_path / "meminfo"
    monkeypatch.setattr(D, "MEMINFO", meminfo)
    meminfo.write_text("MemTotal: 2000000 kB\nMemAvailable: 300000 kB\n", encoding="utf-8")
    assert D.droplet_problems() and "free memory" in D.droplet_problems()[0]
    meminfo.write_text("MemTotal: 2000000 kB\nMemAvailable: 1500000 kB\n", encoding="utf-8")
    assert D.droplet_problems() == []
    meminfo.unlink()
    assert D.droplet_problems() == ["could not read free memory"]


def test_droplet_uses_the_droplet_guard(tmp_path):
    from pt import guard
    pc = D.build({"DEMO_PASSCODE": CODE, "PLAYTEST_LEDGER": str(tmp_path / "l.jsonl")}, key="KEY")
    droplet = D.build({"DEMO_PASSCODE": CODE, "PLAYTEST_LEDGER": str(tmp_path / "l.jsonl"), "DEMO_PC_GUARDS": "0"}, key="KEY")
    assert pc.host_problems is guard.problems
    assert droplet.host_problems is D.droplet_problems


# ---- moving the demo's ledger rows between this PC and the droplet --------------

def test_export_takes_only_demo_rows(tmp_path):
    src = tmp_path / "l.jsonl"
    src.write_text("".join(json.dumps(r) + "\n" for r in two_rows(("playtest-agent", 5.0), (D.DEMO_REPO, 0.42))), encoding="utf-8")
    rows = D.export_rows(src)
    assert len(rows) == 2 and {r["repo"] for r in rows} == {D.DEMO_REPO}


def test_import_adds_missing_rows_once_and_refuses_other_repos(tmp_path):
    dst = tmp_path / "d.jsonl"
    rows = two_rows((D.DEMO_REPO, 0.42))
    assert D.import_rows(dst, rows) == 2
    assert D.import_rows(dst, rows) == 0
    assert D.room(dst) == pytest.approx(D.DEMO_CAP_USD - 0.42)
    with pytest.raises(ValueError):
        D.import_rows(dst, two_rows(("playtest-agent", 1.0)))
    assert D.room(dst) == pytest.approx(D.DEMO_CAP_USD - 0.42)
