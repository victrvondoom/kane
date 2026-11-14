import base64
import json

import pytest

from metaclient import fireworks as F
from metaclient.ledger import CapReached
from pt import judge as J, replay
from trials import fireworks_judge as C
from test_judge import jpg


KEY = "fake-secret-fireworks"
YES = '{"verdict":"YES","evidence":"The value stayed at one"}'


def reply(content=YES, finish="stop", usage=None):
    return 200, json.dumps({"choices": [{"message": {"content": content}, "finish_reason": finish}],
                            "usage": usage if usage is not None else {"prompt_tokens": 100, "completion_tokens": 20}})


class Http:
    def __init__(self, *replies):
        self.replies = list(replies) or [reply()]
        self.calls = []

    def __call__(self, url, payload, headers, timeout):
        self.calls.append((url, payload, headers, timeout))
        result = self.replies.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


def client(tmp_path, *replies):
    http, sleeps = Http(*replies), []
    ledger = F.FireworksLedger(tmp_path / "fw.jsonl")
    return F.FireworksClient(KEY, ledger, http=http, sleep=sleeps.append), http, sleeps


def case():
    return {"set": "true8", "id": "secret-file:0", "title": "Saved symptom",
            "report": {"title": "Saved symptom", "expected": "Change", "actual": "Same"},
            "diff": ["coins: 1 -> 1"], "strip": b"saved jpeg bytes", "truth": True, "spark": False}


def test_cost_and_payload(tmp_path):
    usage = {"prompt_tokens": 1000, "completion_tokens": 200,
             "prompt_tokens_details": {"cached_tokens": 400}, "completion_tokens_details": {"reasoning_tokens": 100}}
    assert F.fireworks_cost(usage) == pytest.approx((600 * 1.25 + 400 * .15 + 200 * 4.25) / 1e6)
    c, http, _ = client(tmp_path, reply(usage=usage), reply())
    c.reasoning = "high"
    result = C.ask(c, case())
    url, payload, headers, timeout = http.calls[0]
    assert url == F.BASE_URL and headers == {"Authorization": "Bearer " + KEY} and timeout == 300
    assert payload["model"] == F.MODEL and payload["max_tokens"] == 6000
    assert payload["reasoning_effort"] == "high" and payload["temperature"] == 0
    parts = payload["messages"][0]["content"]
    assert parts == [{"type": "text", "text": J.build_prompt(case()["report"], case()["diff"])},
                     {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(case()["strip"]).decode()}}]
    assert result["confirmed"] and result["prompt_tokens"] == 1000
    reserve = json.loads(c.ledger.path.read_text().splitlines()[0])["usd"]
    expected = (6000 * 4.25 + (len(J.build_prompt(case()["report"], case()["diff"])) / 2 + 8000) * 1.25) / 1e6
    assert reserve == pytest.approx(expected, abs=1e-6)
    assert c.responses("hello")["_cost_usd"] == pytest.approx(.00021)


def test_incomplete_retry_and_null(tmp_path):
    c, http, _ = client(tmp_path, reply(None, "length"), reply(YES))
    assert C.ask(c, case())["confirmed"]
    assert [p[1]["max_tokens"] for p in http.calls] == [6000, 15000]
    c, _, _ = client(tmp_path / "other", reply(None), reply(YES, "length"), reply(YES, "length"))
    assert c.responses("x")["output"][0]["content"][0]["text"] == ""
    result = C.ask(c, case())
    assert result["incomplete"] and not result["confirmed"]


def test_cap_is_separate_and_fixed(tmp_path, monkeypatch):
    muse = tmp_path / "muse.jsonl"
    monkeypatch.setenv("PLAYTEST_LEDGER", str(muse))
    monkeypatch.setenv("PLAYTEST_CAP_USD", "1000")
    assert F.FireworksLedger().path == F.Path(F.__file__).resolve().parents[1] / "data/fireworks-ledger.jsonl"
    c, http, _ = client(tmp_path)
    c.ledger.reserve(9.99)
    with pytest.raises(CapReached):
        c.responses("x")
    assert not http.calls and not muse.exists() and c.ledger.cap() == 10


@pytest.mark.parametrize("status,body", [(402, "No credit available"), (429, "credit denied"), (400, "bad request")])
def test_immediate_stop(tmp_path, status, body):
    c, http, sleeps = client(tmp_path, (status, body))
    with pytest.raises(F.FireworksStop) as exc:
        c.responses("x")
    assert exc.value.status == status and exc.value.body == body and body in str(exc.value)
    assert len(http.calls) == 1 and not sleeps and c.ledger.spent() == 0


def test_transient_retries(tmp_path):
    c, http, sleeps = client(tmp_path, (429, "busy"), reply())
    c.responses("x")
    assert len(http.calls) == 2 and sleeps == [5]
    c, http, sleeps = client(tmp_path / "three", *[(503, "busy")] * 3)
    with pytest.raises(F.FireworksStop):
        c.responses("x")
    assert len(http.calls) == 3 and sleeps == [5, 20] and c.ledger.spent() == 0


@pytest.mark.parametrize("response", [TimeoutError("timeout"), (200, "not json"), (200, '{"choices":[]}')])
def test_uncertain_charge_keeps_reserve(tmp_path, response):
    c, http, _ = client(tmp_path, response)
    with pytest.raises(F.FireworksStop) as exc:
        c.responses("abcd", max_output_tokens=6000, reserve_usd=99)
    assert exc.value.status == (0 if isinstance(response, Exception) else 200)
    assert c.ledger.spent() == pytest.approx((6000 * 4.25 + 2 * 1.25) / 1e6, abs=1e-6)


def test_key_redacted(tmp_path, capsys):
    c, _, _ = client(tmp_path, (402, "echo " + KEY))
    with pytest.raises(F.FireworksStop) as exc:
        c.responses("x", label=KEY)
    print(exc.value)
    assert exc.value.body == "echo <key>"
    assert KEY not in str(exc.value) + c.ledger.path.read_text() + capsys.readouterr().out
    c, _, _ = client(tmp_path / "timeout", TimeoutError(KEY))
    with pytest.raises(F.FireworksStop) as exc:
        c.responses("x")
    assert KEY not in str(exc.value)
    with pytest.raises(ValueError):
        path = tmp_path / "empty.txt"
        path.write_text("\n")
        F.read_key(path)
    path.write_text(" fake-only \nsecond")
    assert F.read_key(path) == "fake-only"
    stop = F.FireworksStop(402, KEY + "x" * 2100, KEY)
    assert stop.body.startswith("<key>") and len(stop.body) == 2000 and KEY not in str(stop)


def test_default_transport_has_no_redirects(tmp_path, monkeypatch):
    import requests

    calls = []

    class Response:
        status_code, text = reply()

    def post(url, **kwargs):
        calls.append((url, kwargs))
        return Response()

    monkeypatch.setattr(requests, "post", post)
    c = F.FireworksClient(KEY, F.FireworksLedger(tmp_path / "ledger.jsonl"))
    c.responses("text")
    assert calls[0][0] == F.BASE_URL
    assert calls[0][1]["allow_redirects"] is False and calls[0][1]["timeout"] == 300


def write(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj))


@pytest.fixture
def sources(tmp_path):
    report = case()["report"]
    rows = []
    write(tmp_path / "data/runs/sample/result.json", {"reports": [report]})
    write(tmp_path / "docs/false-claims.json", {"claims": [{**report, "run": "sample", "step": 0}]})
    for group in ("true8", "neg8", "false6"):
        rows.append({"set": group, "id": "sample:0", "judge_yes": True})
        replay.save_trace({"frames": [jpg((0, 0, 0))], "states": [{"x": 1}, {"x": 2}]},
                          tmp_path / f"data/judge_traces/{group}_sample_0")
    write(tmp_path / "docs/receipts/judge-eval.json", {"rows": rows})
    chess = tmp_path / "data/runs/pc2-react-chess/replay-check"
    write(chess / "summary.json", {"reports": [{"index": i, "report": report, "tries": [{"try": 1, "verdict": "YES"}]} for i in (0, 8)]})
    for i in (0, 8):
        folder = chess / f"report-{i}/try-1"
        write(folder / "meta.json", {"states": [{"x": 1}, {"x": 2}]})
        (folder / "strip.jpg").write_bytes(b"chess picture")
    for run, count in (("sts2-room-g-3", 1), ("sts2-room-g-decoy-1b", 1), ("sts2-room-g-decoy2-1", 1), ("ho1", 5), ("ho1-clean", 1)):
        folder = tmp_path / "data/runs" / run
        write(folder / "confirm.json", [{**report, "confirmed": True, "state_change": ["saved diff"]} for _ in range(count)])
        for i in range(count):
            (folder / f"strip_{i}.jpg").write_bytes(b"original picture")
    return tmp_path


def test_load_cases(sources):
    rows = C.load_cases(sources)
    assert len(rows) == 14
    assert [r["truth"] for r in rows] == [True, False, False, True, False, True, False, False, True, True, False, True, True, False]
    assert all(set(r["report"]) == {"title", "expected", "actual"} for r in rows)
    assert rows[3]["id"] == "r0:t1" and rows[3]["strip"] == b"chess picture"
    assert rows[5]["diff"] == ["saved diff"] and rows[5]["strip"] == b"original picture"
    (sources / "data/runs/ho1-clean/strip_0.jpg").unlink()
    with pytest.raises(FileNotFoundError):
        C.load_cases(sources)


def test_main_resume_and_stop(sources, monkeypatch):
    monkeypatch.setenv("FIREWORKS_API_KEY", KEY)
    monkeypatch.setattr(C, "ROOT", sources)
    monkeypatch.setattr(C, "read_key", lambda: KEY)
    c, http, _ = client(sources, reply(), (402, "credit exhausted"))
    monkeypatch.setattr(C, "FireworksLedger", lambda: c.ledger)
    monkeypatch.setattr(C, "FireworksClient", lambda *a, **kw: c)
    assert C.main(["--tag", "test", "--sets", "true8", "--limit", "1"]) == 0
    assert C.main(["--tag", "test", "--sets", "true8"]) == 0
    assert len(http.calls) == 1
    path = sources / "docs/receipts/spark-open-judge-test.json"
    receipt = json.loads(path.read_text())
    assert receipt["summary"]["all"]["open_right"] == 1
    assert receipt["summary"]["all"]["total"] == 1
    assert receipt["ledger_total_usd"] == c.ledger.spent()
    assert C.main(["--tag", "test", "--sets", "neg8"]) == 3
    receipt = json.loads(path.read_text())
    assert receipt["stop"] == {"status": 402, "text": "Fireworks status 402: credit exhausted"}
    assert len(receipt["rows"]) == 1 and len(http.calls) == 2


def test_main_cap_and_incomplete_summary(sources, monkeypatch, capsys):
    monkeypatch.setenv("FIREWORKS_API_KEY", KEY)
    monkeypatch.setattr(C, "ROOT", sources)
    monkeypatch.setattr(C, "read_key", lambda: KEY)
    c, http, _ = client(sources, reply(YES, "length"), reply(YES, "length"))
    monkeypatch.setattr(C, "FireworksLedger", lambda: c.ledger)
    monkeypatch.setattr(C, "FireworksClient", lambda *a, **kw: c)
    assert C.main(["--tag", "incomplete", "--sets", "true8"]) == 0
    path = sources / "docs/receipts/spark-open-judge-incomplete.json"
    receipt = json.loads(path.read_text())
    summary = receipt["summary"]["all"]
    assert summary["incomplete"] == summary["misses"] == summary["spark_right"] == 1
    assert summary["agree"] == summary["open_right"] == summary["false_alarms"] == 0
    assert summary["cost_usd"] == pytest.approx(.00042)
    c.ledger.reserve(9.99)
    assert C.main(["--tag", "capped", "--sets", "neg8"]) == 3
    receipt = json.loads((sources / "docs/receipts/spark-open-judge-capped.json").read_text())
    assert receipt["stop"]["status"] == 0 and "cap $10.00 reached" in receipt["stop"]["text"]
    assert len(http.calls) == 2 and KEY not in capsys.readouterr().out


def test_main_missing_file_before_key(sources, monkeypatch, capsys):
    monkeypatch.setenv("FIREWORKS_API_KEY", KEY)
    monkeypatch.setattr(C, "ROOT", sources)
    monkeypatch.setattr(C, "read_key", lambda: pytest.fail("read key before checking files"))
    (sources / "data/runs/ho1/strip_0.jpg").unlink()
    assert C.main(["--tag", "missing"]) == 2
    lines = capsys.readouterr()
    lines = (lines.out + lines.err).splitlines()
    assert len(lines) == 1 and "strip_0.jpg" in lines[0]
    assert "unzip" in lines[0] and "data/runs/" in lines[0]


@pytest.fixture
def no_fireworks_key(monkeypatch):
    monkeypatch.delenv("FIREWORKS_API_KEY", raising=False)
    monkeypatch.delenv("FIREWORKS_KEY_FILE", raising=False)
    monkeypatch.setattr("pt.env.load_local_env", lambda: None)


def test_main_no_key_writes_nothing(sources, monkeypatch, capsys, no_fireworks_key):
    monkeypatch.setattr(C, "ROOT", sources)
    monkeypatch.setattr(C, "FireworksClient", lambda *a, **kw: pytest.fail("model call"))
    monkeypatch.setattr(C, "FireworksLedger", lambda: pytest.fail("ledger created"))
    before = set(sources.rglob("*"))
    assert C.main(["--tag", "x", "--sets", "chess"]) == 2
    captured = capsys.readouterr()
    assert (captured.out + captured.err).splitlines() == ["Muse Spark Open needs your own Fireworks key. Set FIREWORKS_API_KEY. Nothing was spent."]
    assert set(sources.rglob("*")) == before


def test_limit_zero_needs_no_key(sources, monkeypatch, no_fireworks_key):
    monkeypatch.setattr(C, "ROOT", sources)
    monkeypatch.setattr(C, "read_key", lambda: pytest.fail("read key"))
    monkeypatch.setattr(C, "FireworksClient", lambda *a, **kw: pytest.fail("model call"))
    assert C.main(["--tag", "x", "--sets", "chess", "--limit", "0"]) == 0


def test_chess_without_private_traces(sources):
    (sources / "docs/receipts/judge-eval.json").unlink()
    rows = C.load_cases(sources, {"chess"})
    assert rows and {r["set"] for r in rows} == {"chess"}


def test_no_drive_path():
    assert "C:" not in F.Path(F.__file__).read_text(encoding="utf-8")
