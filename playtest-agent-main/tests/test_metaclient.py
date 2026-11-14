"""The Meta Model API client with a shared hard spend cap. No test here touches the network.

Cap: $15 total for BOTH trials together (lead, 26 Oct 2026), one shared ledger file, cost logged per call.
Request shapes come from dev.meta.ai docs read 26 Oct 2026: speech-to-text.md, sam/segmenting.md, video-understanding.md,
file-handling.md, pricing-rate-limits.md.
"""
import base64
import json

import pytest

from metaclient import client as C
from metaclient import ledger as L


@pytest.fixture(autouse=True)
def clear_playtest_cap(monkeypatch):
    monkeypatch.delenv("PLAYTEST_CAP_USD", raising=False)


class FakeHttp:
    def __init__(self, status=200, body=None, headers=None):
        self.calls, self.status, self.body, self.headers = [], status, body if body is not None else {}, headers or {}

    def send(self, method, url, headers, json_body=None, files=None, timeout=300):
        self.calls.append({"method": method, "url": url, "headers": headers, "json": json_body, "files": files})
        return C.Resp(self.status, self.headers, json.dumps(self.body).encode())


def make(tmp_path, http=None, **kw):
    led = L.Ledger(tmp_path / "ledger.jsonl", repo="t")
    return C.MetaClient("KEY-SECRET-123", led, http or FakeHttp(), **kw), led


class FakeStreamHttp:
    status_code = 200

    def __init__(self, events):
        self.events, self.calls = events, []
        self.closed, self.read_count = False, 0

    def send_stream(self, method, url, headers, json_body=None, timeout=300):
        self.calls.append(json_body)
        return self

    def iter_lines(self):
        yield b": heartbeat"
        yield b""
        for event in self.events:
            self.read_count += 1
            yield b"data: " + json.dumps(event).encode()

    def close(self):
        self.closed = True


def test_wonder_stream_joins_text_and_settles_usage(tmp_path):
    http = FakeStreamHttp([
        {"type": "response.output_text.delta", "delta": "hello "},
        {"type": "response.output_text.delta", "delta": "world"},
        {"type": "response.completed", "response": {"status": "completed", "usage": {
            "input_tokens": 100, "output_tokens": 20, "input_tokens_details": {"cached_tokens": 30}}}}])
    c, led = make(tmp_path, http)
    seen = []
    result = c.wonder_stream({"input": []}, label="stream", reserve_usd=.3,
                             stop=lambda text: seen.append(text) or False)
    assert seen == ["hello ", "hello world"]
    assert result["text"] == C.output_text(result) == "hello world"
    assert result["_cost_usd"] == pytest.approx(C.wonder_cost(100, 20, 30))
    row = json.loads(led.path.read_text().splitlines()[-1])
    assert row["cost_estimated"] is False
    assert row["usage"]["output_tokens"] == 20
    assert http.calls == [{"model": C.WONDER, "input": [], "stream": True}]
    assert http.closed


def test_requests_stream_transport_uses_stream_true(monkeypatch):
    import requests
    seen = []
    response = FakeStreamHttp([])
    monkeypatch.setattr(requests, "request", lambda *a, **kw: seen.append((a, kw)) or response)
    assert C.RequestsHttp().send_stream("POST", "fake", {}, json_body={"stream": True}) is response
    assert seen[0][1]["stream"] is True


# ---- ledger ------------------------------------------------------------------

def test_cap_in_code():
    assert L.TOTAL_CAP_USD == 145.00


def test_reserve_refuses_before_the_call_that_would_pass_the_cap(tmp_path):
    led = L.Ledger(tmp_path / "l.jsonl", repo="a")
    led.reserve(L.TOTAL_CAP_USD - 5.03, "x")
    with pytest.raises(L.CapReached):
        led.reserve(5.04, "y")
    led.reserve(5.0, "z")
    with pytest.raises(L.CapReached):
        led.reserve(0.04, "w")


def test_two_repos_share_one_ledger(tmp_path):
    p = tmp_path / "l.jsonl"
    L.Ledger(p, repo="who-said-that").reserve(9.0, "a")
    with pytest.raises(L.CapReached):
        L.Ledger(p, repo="field-count").reserve(L.TOTAL_CAP_USD - 8.9, "b")


def test_settle_gives_back_the_unused_part(tmp_path):
    led = L.Ledger(tmp_path / "l.jsonl", repo="a")
    r = led.reserve(14.0, "x")
    led.settle(r, 0.5, model="m")
    assert led.spent() == pytest.approx(0.5)
    led.reserve(14.0, "y")


def test_env_can_lower_the_cap_never_raise_it(tmp_path, monkeypatch):
    monkeypatch.setenv("PLAYTEST_CAP_USD", "200")
    assert L.effective_cap() == 145.00
    monkeypatch.setenv("PLAYTEST_CAP_USD", "2")
    assert L.effective_cap() == 2.0
    monkeypatch.setenv("PLAYTEST_CAP_USD", "nope")
    assert L.effective_cap() == 145.00


def test_damaged_ledger_fails_closed(tmp_path):
    p = tmp_path / "l.jsonl"
    p.write_text("not json\n")
    with pytest.raises(L.CapReached):
        L.Ledger(p, repo="a").reserve(0.01, "x")


def test_ledger_records_cost_per_call_and_never_the_key(tmp_path):
    c, led = make(tmp_path, FakeHttp(body={"usage": {"input_tokens": 1000, "output_tokens": 200}, "output": []}))
    c.responses([{"role": "user", "content": [{"type": "input_text", "text": "hi"}]}], model="muse-spark-1.3", label="t")
    text = (tmp_path / "ledger.jsonl").read_text()
    assert "KEY-SECRET-123" not in text
    rows = [json.loads(x) for x in text.splitlines()]
    s = [r for r in rows if r["type"] == "settle"][0]
    assert s["model"] == "muse-spark-1.3" and s["status"] == 200
    assert s["cost_usd"] == pytest.approx(1000 * 1.25 / 1e6 + 200 * 4.25 / 1e6)
    assert s["repo"] == "t" and "latency_s" in s


# ---- prices ------------------------------------------------------------------

def test_prices_match_the_pricing_page():
    # src-pricing.md lines 37 to 41, 67 to 69, 77 to 80
    assert C.spark_cost(1_000_000, 0) == pytest.approx(1.25)
    assert C.spark_cost(0, 1_000_000) == pytest.approx(4.25)
    assert C.spark_cost(1_000_000, 0, cached=1_000_000) == pytest.approx(0.15)
    assert C.transcribe_cost(3600) == pytest.approx(0.18)
    assert C.transcribe_cost(600.9) == pytest.approx(600 * 0.18 / 3600)   # whole seconds, rounded down
    assert C.sam_image_cost() == pytest.approx(0.0025)
    assert C.sam_video_cost(900) == pytest.approx(0.18)
    assert C.sam_video_cost(10) == pytest.approx(50 * 0.0002)             # at least 50 frames billed


# ---- request shapes ----------------------------------------------------------

def test_transcribe_request(tmp_path):
    import wave
    wav = tmp_path / "a.wav"
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b"\0\0" * 16000 * 2)   # 2 seconds
    http = FakeHttp(body={"sessionId": "s", "transcript": "hi", "audioDurationMs": 2000, "turns": []})
    c, _ = make(tmp_path, http)
    out = c.transcribe(wav)
    call = http.calls[0]
    assert call["url"] == "https://api.meta.ai/v1/asr/transcribe"
    assert call["headers"]["Authorization"] == "Bearer KEY-SECRET-123"
    req = json.loads(call["files"]["request"][1])
    assert req == {"mode": "DIARIZATION", "model": "muse-voice-transcribe-1.0", "audioEncoding": "WAV"}
    assert call["files"]["request"][2] == "application/json"
    assert call["files"]["audio"][0].endswith(".wav")
    assert out["turns"] == []


def test_transcribe_refuses_audio_over_10_minutes_before_sending(tmp_path):
    import wave
    wav = tmp_path / "long.wav"
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000); w.writeframes(b"\0\0" * 8000 * 601)
    http = FakeHttp()
    c, _ = make(tmp_path, http)
    with pytest.raises(ValueError):
        c.transcribe(wav)
    assert http.calls == []


def test_sam_image_request(tmp_path):
    http = FakeHttp(body={"output_text": "<0f>"})
    c, _ = make(tmp_path, http)
    c.sam_image(b"\xff\xd8jpegbytes", "person")
    j = http.calls[0]["json"]
    assert http.calls[0]["url"] == "https://api.meta.ai/v1/responses"
    assert j["model"] == "sam-3.1"
    parts = j["input"][0]["content"]
    assert parts[0] == {"type": "input_text", "text": "person"}
    assert parts[1]["type"] == "input_image"
    assert parts[1]["image_url"] == "data:image/jpeg;base64," + base64.b64encode(b"\xff\xd8jpegbytes").decode()
    assert j["metadata"]["include_confidence"] == "true"
    assert j["metadata"]["mask_encoding"] == "one_bit"


def test_sam_video_request_with_file_id(tmp_path):
    http = FakeHttp(body={"output_text": "", "usage": {"video_frames_processed": 50}})
    c, _ = make(tmp_path, http)
    c.sam_video_by_file_id("file-abc", "fish", frames=120)
    j = http.calls[0]["json"]
    assert j["model"] == "sam-3.1"
    assert j["input"][0]["content"][1] == {"type": "input_video", "file_id": "file-abc"}
    assert j["metadata"]["propagation_direction"] == "forward"


def test_spark_clip_request_uses_input_video(tmp_path):
    http = FakeHttp(body={"output_text": "2", "usage": {"input_tokens": 100, "output_tokens": 10}})
    c, _ = make(tmp_path, http)
    c.spark_video(b"mp4bytes", "Which numbered person is speaking?")
    j = http.calls[0]["json"]
    assert j["model"] == "muse-spark-1.3"
    parts = j["input"][0]["content"]
    assert {"type": "input_text", "text": "Which numbered person is speaking?"} in parts
    vid = [p for p in parts if p["type"] == "input_video"][0]
    assert vid["video_url"].startswith("data:video/mp4;base64,")
    assert j["max_output_tokens"] >= 4000       # reasoning shares the output budget (video-understanding.md)


def test_files_upload_request(tmp_path):
    f = tmp_path / "c.mp4"
    f.write_bytes(b"x" * 10)
    http = FakeHttp(body={"id": "file-123", "object": "file", "bytes": 10})
    c, _ = make(tmp_path, http)
    assert c.upload_file(f) == "file-123"
    call = http.calls[0]
    assert call["url"] == "https://api.meta.ai/v1/files"
    assert call["files"]["purpose"][1] == "user_data"


def test_cap_stops_a_call_with_no_network(tmp_path):
    http = FakeHttp()
    c, led = make(tmp_path, http)
    led.reserve(L.TOTAL_CAP_USD - 0.04, "earlier")
    with pytest.raises(L.CapReached):
        c.spark_video(b"x" * 10, "q", reserve_usd=0.5)
    assert http.calls == []


def test_http_error_is_recorded_and_not_billed(tmp_path):
    http = FakeHttp(status=401, body={"error": {"code": "invalid_api_key"}})
    c, led = make(tmp_path, http)
    with pytest.raises(C.ApiError) as e:
        c.sam_image(b"x", "person")
    assert e.value.status == 401
    assert led.spent() == 0.0


def test_key_is_never_in_an_error_message(tmp_path):
    http = FakeHttp(status=500, body={"error": "boom"})
    c, _ = make(tmp_path, http)
    with pytest.raises(C.ApiError) as e:
        c.sam_image(b"x", "person")
    assert "KEY-SECRET-123" not in str(e.value)


def test_parse_sam_on_a_real_response_sample():
    """docs/receipts/sam-image-raw-sample.txt is the first 1,500 characters of a real SAM 3.1 answer (26 Oct 2026)."""
    from pathlib import Path
    from metaclient.client import parse_sam
    sample = (Path(__file__).resolve().parents[1] / "docs" / "receipts" / "sam-image-raw-sample.txt")
    if not sample.exists():
        pytest.skip("receipt not present")
    recs = parse_sam(sample.read_text(encoding="utf-8"))
    r = recs[0][0]
    assert (r.obj_id, r.box, r.size) == (0, (191.0, 93.0, 256.0, 223.0), (352.0, 288.0))
    assert 0.9 < r.conf < 1.0


def test_parse_sam_two_frames():
    from metaclient.client import parse_sam
    t = "<0f>0<|box;x1=1;y1=2;x2=3;y2=4;w=10;h=20|><|mask;x=0;y=0;data=1,1,!A|>,3<|box;x1=5;y1=6;x2=7;y2=8;w=10;h=20|><|mask;x=0;y=0;data=1,1,!A|>\n<4f>3<|box;x1=9;y1=9;x2=10;y2=10;w=10;h=20|>"
    r = parse_sam(t)
    assert [x.obj_id for x in r[0]] == [0, 3] and [x.obj_id for x in r[4]] == [3]


def test_a_stale_lock_file_does_not_block_the_ledger(tmp_path):
    import os, time
    led = L.Ledger(tmp_path / "l.jsonl", repo="a")
    lock = tmp_path / "l.jsonl.lock"
    lock.write_text("x")
    old = time.time() - 120
    os.utime(lock, (old, old))
    led.reserve(0.1, "x")                      # the 2 minute old lock is dropped
    assert not lock.exists()


def test_a_fresh_lock_held_by_another_process_makes_reserve_wait_then_fail_closed(tmp_path, monkeypatch):
    led = L.Ledger(tmp_path / "l.jsonl", repo="a")
    (tmp_path / "l.jsonl.lock").write_text("x")
    monkeypatch.setattr(L, "LOCK_WAIT_S", 0.3)
    with pytest.raises(L.CapReached):
        led.reserve(0.1, "x")


def test_two_ledgers_in_threads_never_lose_a_reservation(tmp_path):
    import threading
    p = tmp_path / "l.jsonl"
    def work():
        led = L.Ledger(p, repo="t")
        for _ in range(20):
            led.reserve(0.01, "x")
    ts = [threading.Thread(target=work) for _ in range(4)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert L.Ledger(p).spent() == pytest.approx(0.8)


def test_a_lock_file_being_deleted_counts_as_locked_not_as_an_error(tmp_path, monkeypatch):
    """Windows answers "permission denied" (not "file exists") while another thread's lock file is being deleted.
    That was the one flaky failure: 1 of 5 runs lost a reservation to a PermissionError."""
    real_open, calls = L.os.open, []
    def busy_once(path, flags, *a):
        calls.append(path)
        if len(calls) == 1:
            raise PermissionError(13, "Permission denied", path)
        return real_open(path, flags, *a)
    monkeypatch.setattr(L.os, "open", busy_once)
    led = L.Ledger(tmp_path / "l.jsonl", repo="t")
    led.reserve(0.01, "x")
    assert len(calls) == 2 and led.spent() == pytest.approx(0.01)


class FlakyHttp:
    """Answers each status in order, then 200."""
    def __init__(self, *statuses):
        self.statuses, self.calls = list(statuses), 0

    def send(self, method, url, headers, json_body=None, files=None, timeout=300):
        self.calls += 1
        status = self.statuses.pop(0) if self.statuses else 200
        body = {"error": {"message": "internal server error"}} if status >= 300 else {"output": [], "usage": {}}
        return C.Resp(status, {}, json.dumps(body).encode())


def test_a_server_error_500_is_tried_again(tmp_path, monkeypatch):
    """t-high-old (28 Oct) ended at step 31 on one HTTP 500 "internal server error"; the next call would likely have worked."""
    monkeypatch.setattr(C.time, "sleep", lambda s: None)
    http = FlakyHttp(500)
    c, led = make(tmp_path, http)
    c.responses([{"role": "user", "content": [{"type": "input_text", "text": "hi"}]}], model="muse-spark-1.3", label="t")
    assert http.calls == 2


def test_a_400_is_never_tried_again(tmp_path, monkeypatch):
    monkeypatch.setattr(C.time, "sleep", lambda s: None)
    http = FlakyHttp(400)
    c, led = make(tmp_path, http)
    with pytest.raises(C.ApiError):
        c.responses([{"role": "user", "content": [{"type": "input_text", "text": "hi"}]}], model="muse-spark-1.3", label="t")
    assert http.calls == 1
