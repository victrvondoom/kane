import base64
import io
import json
import shutil

import pytest
from PIL import Image

from pt import judge as J, confirm, replay
from pt.cli import parse


def frames(n=3):
    result = []
    for i in range(n):
        buf = io.BytesIO()
        Image.new("RGB", (65, 37), (i * 20, 0, 0)).save(buf, "JPEG")
        result.append(buf.getvalue())
    return result


class Client:
    def __init__(self, evidence="Coins stayed at one", statuses=("completed",)):
        self.evidence, self.statuses, self.calls = evidence, iter(statuses), []

    def responses(self, inp, **kwargs):
        self.calls.append((inp, kwargs))
        return {"status": next(self.statuses), "_cost_usd": .01,
                "output_text": json.dumps({"verdict": "YES", "evidence": self.evidence})}


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="requires ffmpeg on PATH")
def test_video_sends_real_mp4_and_uses_same_parser(monkeypatch):
    client, seen = Client(), []
    original = J.parse_verdict
    def parse_spy(text):
        seen.append(text)
        return original(text)
    monkeypatch.setattr(J, "parse_verdict", parse_spy)
    value = J.judge(client, {"title": "Missing coin"}, frames(), ["coins: 1 -> 1"], judge_input="video")
    content = client.calls[0][0][0]["content"]
    assert content[1]["type"] == "input_video"
    mp4 = base64.b64decode(content[1]["video_url"].split(",", 1)[1])
    assert mp4[4:8] == b"ftyp"
    assert value["video"] == mp4 and value["strip"][:2] == b"\xff\xd8"
    assert value["confirmed"] and len(seen) == 1
    assert "Missing coin" in content[0]["text"] and "coins: 1 -> 1" in content[0]["text"]
    assert "If you cannot quote evidence, answer NO." in content[0]["text"]
    assert "video" in content[0]["text"] and "Read left to right" not in content[0]["text"]


def test_video_without_quote_is_no(monkeypatch):
    from pt import judge_video as V
    monkeypatch.setattr(V, "encode", lambda f: b"\x00\x00\x00\x18ftypisom")
    assert not J.judge(Client(evidence=""), {}, frames(), [], judge_input="video")["confirmed"]


def test_video_retries_incomplete_with_same_clip(monkeypatch):
    encoded = []
    from pt import judge_video as V
    monkeypatch.setattr(V, "encode", lambda f: encoded.append(f) or b"\x00\x00\x00\x18ftypisom")
    client = Client(statuses=("incomplete", "completed"))
    value = J.judge(client, {}, frames(15), [], judge_input="video")
    assert value["confirmed"] and value["cost_usd"] == .02
    assert len(encoded) == 1 and len(encoded[0]) == 12
    assert client.calls[0][0] == client.calls[1][0]


def test_missing_ffmpeg_is_clear(monkeypatch):
    from pt import judge_video as V
    monkeypatch.setattr(shutil, "which", lambda name: None)
    with pytest.raises(RuntimeError, match="ffmpeg.*PATH"):
        V.encode(frames())


def test_cli_defaults_and_video_flag():
    assert parse(["confirm", "run"]).judge_input == "strip"
    assert parse(["confirm", "run", "--judge-input", "video"]).judge_input == "video"


def test_confirm_saves_video_with_fake_replay(tmp_path, monkeypatch):
    (tmp_path / "result.json").write_text(json.dumps({"reports": [{"title": "t", "step": 1}], "actions_by_step": [[]]}))
    monkeypatch.setattr(replay, "reproducible", lambda *a, **kw: {
        "reproducible": True, "comparison": {"compared": True, "method": "state", "same": True},
        "trace": {"frames": frames(), "states": [{"coins": 1}, {"coins": 1}]}})
    from pt import judge_video as V
    monkeypatch.setattr(V, "encode", lambda f: b"\x00\x00\x00\x18ftypisom")
    rows = confirm.confirm_run(tmp_path, Client(), judge_input="video")
    assert rows[0]["confirmed"] and rows[0]["judge_input"] == "video"
    assert (tmp_path / "video_0.mp4").read_bytes()[4:8] == b"ftyp"


def test_compare_missing_trace_refuses_before_client(tmp_path, monkeypatch):
    from trials import judge_video_compare as C
    monkeypatch.setattr(C, "ROOT", tmp_path)
    monkeypatch.setattr(C, "load_client", lambda *a: pytest.fail("client loaded"))
    docs = tmp_path / "docs"
    (docs / "receipts").mkdir(parents=True)
    (docs / "false-claims.json").write_text('{"claims": []}')
    run = tmp_path / "data/runs/hunt1"
    run.mkdir(parents=True)
    (run / "result.json").write_text('{"reports": [{"title": "t"}]}')
    rows = [{"set": "true8", "id": f"hunt1:{i}", "title": "t"} for i in range(8)]
    rows += [{"set": "neg8", "id": f"hunt1:{i}", "title": "t"} for i in range(8)]
    rows += [{"set": "false6", "id": f"hunt1:{i}", "title": "t"} for i in range(6)]
    (docs / "receipts/judge-eval.json").write_text(json.dumps({"rows": rows}))
    with pytest.raises(FileNotFoundError, match="missing trace"):
        C.main([])


def test_paired_verdicts_reserve_through_ledger_with_fake_http(tmp_path):
    from metaclient.client import MetaClient, Resp
    from metaclient.ledger import Ledger
    from trials import judge_video_compare as C
    ledger = Ledger(tmp_path / "ledger.jsonl")
    calls = []
    class Http:
        def send(self, *a, **kw):
            body = kw["json_body"]
            assert ledger._rows()[-1]["type"] == "reserve"
            calls.append(body)
            # Make the first pair disagree and the rest agree, independently of saved verdicts.
            yes = len(calls) != 2
            return Resp(200, {}, json.dumps({"status": "completed",
                "output_text": json.dumps({"verdict": "YES" if yes else "NO", "evidence": "Coins stayed at one"}),
                "usage": {"input_tokens": 100, "output_tokens": 20}}).encode())
    trace = {"frames": frames(), "states": [{"coins": 1}, {"coins": 1}], "reproducible": True}
    items = [({"set": "true8", "id": str(i), "judge_yes": False}, {"title": "Coin"}, trace) for i in range(22)]
    result = list(C.judge_pairs(MetaClient("fake", ledger, http=Http()), items, [b"\x00\x00\x00\x18ftypisom"] * 22))
    assert len(result) == 22 and sum(row["agree"] for row in result) == 21
    assert all(row["strip"] for row in result)
    assert len(calls) == 44 and len(ledger._rows()) == 88
    for strip, video in zip(calls[::2], calls[1::2]):
        a, b = strip["input"][0]["content"], video["input"][0]["content"]
        assert a[1]["type"] == "input_image" and b[1]["type"] == "input_video"
        assert "If you cannot quote evidence, answer NO." in a[0]["text"]
        assert "If you cannot quote evidence, answer NO." in b[0]["text"]


def test_preencoded_video_rejects_bad_mp4_before_client():
    client = Client()
    with pytest.raises(ValueError, match="MP4"):
        J.judge(client, {}, frames(), [], judge_input="video", video_bytes=b"not a video")
    assert not client.calls


def test_strip_default_still_sends_image():
    client = Client()
    value = J.judge(client, {}, frames(), [])
    assert "video" not in value
    assert client.calls[0][0][0]["content"][1]["type"] == "input_image"
    assert client.calls[0][1]["reserve_usd"] == .05


def test_incomplete_video_cannot_confirm(monkeypatch):
    from pt import judge_video as V
    monkeypatch.setattr(V, "encode", lambda f: b"\x00\x00\x00\x18ftypisom")
    client = Client(statuses=("incomplete", "incomplete"))
    value = J.judge(client, {}, frames(), [], judge_input="video")
    assert value["incomplete"] and not value["confirmed"]
    assert [kwargs["reserve_usd"] for _, kwargs in client.calls] == [.15, .30]
