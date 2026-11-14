"""Meta Model API client for the two trials. Standard mode only: no model id here ends in -contributor.

Every call reserves its worst case in the shared ledger BEFORE any network call, then settles the real cost.
Shapes: dev.meta.ai/docs speech-to-text.md, sam/segmenting.md, video-understanding.md, file-handling.md (read 26 Oct 2026).
"""
import base64
import json
import re
import time
import wave
from dataclasses import dataclass
from pathlib import Path

from .ledger import Ledger

BASE = "https://api.meta.ai/v1"
SPARK = "muse-spark-1.3"
SAM = "sam-3.1"
VOICE = "muse-voice-transcribe-1.0"
WONDER = "muse-wonder-1.0"
MAX_AUDIO_SECONDS = 600     # "Audio over 10 minutes returns 400"


class ApiError(Exception):
    def __init__(self, status, body):
        self.status = status
        self.body = body[:400]
        super().__init__(f"HTTP {status}: {self.body}")


@dataclass
class Resp:
    status: int
    headers: dict
    body: bytes

    def json(self):
        return json.loads(self.body.decode("utf-8"))


class RequestsHttp:
    def send_stream(self, method, url, headers, json_body=None, timeout=300):
        import requests
        return requests.request(method, url, headers=headers, json=json_body, timeout=timeout, stream=True)

    def send(self, method, url, headers, json_body=None, files=None, timeout=300):
        import requests
        r = requests.request(method, url, headers=headers, json=json_body, files=files, timeout=timeout)
        return Resp(r.status_code, dict(r.headers), r.content)


# ---- prices (src-pricing.md, Standard mode) ----------------------------------

def spark_cost(tokens_in, tokens_out, cached=0):
    return (tokens_in - cached) * 1.25 / 1e6 + cached * 0.15 / 1e6 + tokens_out * 4.25 / 1e6


def wonder_cost(tokens_in, tokens_out, cached=0):
    """Standard mode: $4.00 in, $0.20 cached in, $20.00 out per 1M tokens (pricing-rate-limits.md, 26 Oct 2026)."""
    return (tokens_in - cached) * 4.00 / 1e6 + cached * 0.20 / 1e6 + tokens_out * 20.00 / 1e6


def wonder_reserve(last_input_tokens, max_output_tokens, growth=6000):
    """Worst case for the next call: the last input plus one more screenshot and reply, none of it cached."""
    return wonder_cost(last_input_tokens + growth, max_output_tokens) + 0.005


def transcribe_cost(seconds):
    return int(seconds) * 0.18 / 3600


def sam_image_cost():
    return 2.50 / 1000


def sam_video_cost(frames):
    return max(50, int(frames)) * 0.20 / 1000


# ---- reading outputs ---------------------------------------------------------

def output_text(resp: dict) -> str:
    if isinstance(resp.get("output_text"), str):
        return resp["output_text"]
    parts = []
    for item in resp.get("output") or []:
        for c in item.get("content") or []:
            if c.get("type") in ("output_text", "text") and isinstance(c.get("text"), str):
                parts.append(c["text"])
    if parts:
        return "".join(parts)
    try:
        return resp["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError):
        return ""


@dataclass
class Record:
    obj_id: int
    box: tuple          # x1, y1, x2, y2 in source pixels
    size: tuple         # w, h of the source frame
    conf: float = None


def parse_sam(text: str) -> dict:
    """{frame index: [Record]}. Boxes only: a count needs no mask."""
    out = {}
    for m in re.finditer(r"<(\d+)f>(.*?)(?=<\d+f>|$)", text, re.S):
        frame, body = int(m.group(1)), m.group(2)
        for rec in re.finditer(r"(\d+)\s*,?\s*<\|box;([^|]*)\|>", body):
            kv = dict(p.split("=", 1) for p in rec.group(2).split(";") if "=" in p)
            try:
                out.setdefault(frame, []).append(Record(
                    int(rec.group(1)), tuple(float(kv[k]) for k in ("x1", "y1", "x2", "y2")),
                    (float(kv.get("w", 0)), float(kv.get("h", 0))), float(kv["c"]) if "c" in kv else None))
            except (KeyError, ValueError):
                continue
    return out


# ---- the client --------------------------------------------------------------

class MetaClient:
    def __init__(self, key: str, ledger: Ledger, http=None):
        if not key:
            raise ValueError("no API key")
        self._key = key
        self.ledger = ledger
        self.http = http or RequestsHttp()

    def _headers(self):
        return {"Authorization": f"Bearer {self._key}"}

    def _call(self, url, model, label, reserve_usd, json_body=None, files=None, cost_fn=None, timeout=300):
        rid = self.ledger.reserve(reserve_usd, f"{model}:{label}")        # raises CapReached, nothing is sent
        t0 = time.perf_counter()
        try:
            for attempt in range(4):          # this PC drops about 1 call in 10 and the server sometimes answers 503; the reserve stays, so a retry cannot pass the cap
                try:
                    r = self.http.send("POST", url, self._headers(), json_body=json_body, files=files, timeout=timeout)
                    if r.status in (500, 502, 503, 504) and attempt < 3:      # 500: one "internal server error" ended t-high-old (28 Oct)
                        time.sleep(2.0)
                        continue
                    break
                except Exception as e:
                    if attempt == 3 or type(e).__name__ not in ("ConnectionError", "ChunkedEncodingError"):
                        raise
                    time.sleep(1.5)
        except Exception as e:
            self.ledger.settle(rid, reserve_usd, model=model, label=label, status=0, error=type(e).__name__,
                               latency_s=round(time.perf_counter() - t0, 3))
            raise
        latency = round(time.perf_counter() - t0, 3)
        if r.status >= 300:
            self.ledger.settle(rid, 0.0, model=model, label=label, status=r.status, latency_s=latency)
            raise ApiError(r.status, r.body.decode("utf-8", "replace"))
        data = r.json()
        cost, usage = cost_fn(data) if cost_fn else (None, {})
        cost = reserve_usd if cost is None else cost   # the real cost is logged even when it is above the reserve
        self.ledger.settle(rid, cost, model=model, label=label, status=r.status, latency_s=latency, usage=usage)
        data["_latency_s"] = latency
        data["_cost_usd"] = cost
        return data

    # Spark ------------------------------------------------------------------
    @staticmethod
    def _spark_cost(data):
        u = data.get("usage") or {}
        tin = u.get("input_tokens", u.get("prompt_tokens"))
        tout = u.get("output_tokens", u.get("completion_tokens"))
        if tin is None or tout is None:
            return None, u
        cached = ((u.get("input_tokens_details") or {}).get("cached_tokens")) or 0
        return spark_cost(tin, tout, cached), u

    def responses(self, input, model=SPARK, max_output_tokens=6000, label="", reserve_usd=0.10, extra=None):
        body = {"model": model, "input": input, "max_output_tokens": max_output_tokens, **(extra or {})}
        return self._call(f"{BASE}/responses", model, label, reserve_usd, json_body=body, cost_fn=self._spark_cost)

    def spark_video(self, mp4: bytes, question: str, label="spark_video", reserve_usd=0.15, max_output_tokens=6000):
        part = {"type": "input_video", "video_url": "data:video/mp4;base64," + base64.b64encode(mp4).decode()}
        inp = [{"role": "user", "content": [{"type": "input_text", "text": question}, part]}]
        return self.responses(inp, SPARK, max_output_tokens, label, reserve_usd)

    def spark_video_file(self, file_id: str, question: str, label="spark_video", reserve_usd=0.30, max_output_tokens=6000):
        part = {"type": "input_video", "file_id": file_id}
        inp = [{"role": "user", "content": [{"type": "input_text", "text": question}, part]}]
        return self.responses(inp, SPARK, max_output_tokens, label, reserve_usd)

    @staticmethod
    def _wonder_cost(data):
        u = data.get("usage") or {}
        tin = u.get("input_tokens", u.get("prompt_tokens"))
        tout = u.get("output_tokens", u.get("completion_tokens"))
        if tin is None or tout is None:
            return None, u
        cached = ((u.get("input_tokens_details") or {}).get("cached_tokens")) or 0
        return wonder_cost(tin, tout, cached), u

    def wonder(self, body, label="", reserve_usd=0.30, timeout=300):
        """One Responses call to Muse Wonder. The body carries input, tools, previous_response_id and so on."""
        return self._call(f"{BASE}/responses", WONDER, label, reserve_usd, json_body={"model": WONDER, **body},
                          cost_fn=self._wonder_cost, timeout=timeout)

    def wonder_stream(self, body, label="", reserve_usd=0.30, stop=None, timeout=300):
        """Read deltas with a stop callback; streaming not verified on the real API."""
        from .streaming import wonder_stream
        return wonder_stream(self, body, label, reserve_usd, stop, timeout)

    # Files ------------------------------------------------------------------
    def upload_file(self, path) -> str:
        p = Path(path)
        files = {"purpose": (None, "user_data"), "file": (p.name, p.read_bytes(), "application/octet-stream")}
        data = self._call(f"{BASE}/files", "files", p.name, 0.0, files=files, cost_fn=lambda d: (0.0, {}))
        return data["id"]

    # SAM --------------------------------------------------------------------
    def sam_image(self, image: bytes, phrase: str, mime="image/jpeg", label="sam_image"):
        part = {"type": "input_image", "image_url": f"data:{mime};base64," + base64.b64encode(image).decode()}
        body = {"model": SAM, "input": [{"role": "user", "content": [{"type": "input_text", "text": phrase}, part]}],
                "metadata": {"include_confidence": "true", "mask_encoding": "one_bit"}}
        d = self._call(f"{BASE}/responses", SAM, label, sam_image_cost(), json_body=body,
                       cost_fn=lambda d: (sam_image_cost(), d.get("usage") or {}))
        d["_records"] = parse_sam(output_text(d))
        return d

    def sam_video_by_file_id(self, file_id: str, phrase: str, frames: int, label="sam_video", direction="forward"):
        reserve = sam_video_cost(frames)
        part = {"type": "input_video", "file_id": file_id}
        body = {"model": SAM, "input": [{"role": "user", "content": [{"type": "input_text", "text": phrase}, part]}],
                "metadata": {"include_confidence": "true", "mask_encoding": "one_bit", "propagation_direction": direction}}

        def cost(d):
            u = d.get("usage") or {}
            return sam_video_cost(u.get("video_frames_processed", frames)), u
        d = self._call(f"{BASE}/responses", SAM, label, reserve, json_body=body, cost_fn=cost, timeout=900)
        d["_records"] = parse_sam(output_text(d))
        return d

    # Voice ------------------------------------------------------------------
    def transcribe(self, wav_path, mode="DIARIZATION", label="transcribe"):
        p = Path(wav_path)
        with wave.open(str(p), "rb") as w:
            seconds = w.getnframes() / float(w.getframerate())
        if seconds > MAX_AUDIO_SECONDS:
            raise ValueError(f"audio is {seconds:.0f} s; the API refuses more than {MAX_AUDIO_SECONDS} s")
        req = json.dumps({"mode": mode, "model": VOICE, "audioEncoding": "WAV"})
        files = {"request": (None, req, "application/json"), "audio": (p.name, p.read_bytes(), "audio/wav")}
        return self._call(f"{BASE}/asr/transcribe", VOICE, label, transcribe_cost(seconds) + 1e-6, files=files,
                          cost_fn=lambda d: (transcribe_cost(d.get("audioDurationMs", seconds * 1000) / 1000.0), {"audio_s": seconds}))
