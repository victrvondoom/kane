"""Fireworks responses with a separate hard spending cap."""
import json
import os
import time
from pathlib import Path

from metaclient.ledger import Ledger
from metaclient.local import _messages

BASE_URL = "https://api.fireworks.ai/inference/v1/chat/completions"
MODEL = "accounts/fireworks/models/muse-spark-open"
# fireworks.ai/models/fireworks/muse-spark-open, read 31 Oct 2026: "$1.25 / $0.15 / $4.25"
INPUT_PER_M, CACHED_PER_M, OUTPUT_PER_M = 1.25, 0.15, 4.25
FIREWORKS_CAP_USD = 10.00


def read_key(path=None):
    if path is None:
        key = os.environ.get("FIREWORKS_API_KEY", "").strip()
        if key:
            return key
        path = os.environ.get("FIREWORKS_KEY_FILE", "").strip()
        if not path:
            raise ValueError("Fireworks key is empty")
    lines = Path(path).read_text(encoding="utf-8").splitlines()
    key = lines[0].strip() if lines else ""
    if not key:
        raise ValueError("Fireworks key is empty")
    return key


def key_available():
    try:
        return bool(read_key())
    except (OSError, ValueError):
        return False


class FireworksLedger(Ledger):
    def __init__(self, path=None):
        super().__init__(path if path is not None else Path(__file__).resolve().parents[1] / "data/fireworks-ledger.jsonl",
                         repo="fireworks")

    def cap(self):
        return FIREWORKS_CAP_USD


class FireworksStop(Exception):
    def __init__(self, status, body, key=""):
        self.status = status
        self.body = (body.replace(key, "<key>") if key else body)[:2000]
        super().__init__(f"Fireworks status {status}: {self.body}")


def fireworks_cost(usage):
    cached = (usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0)
    return ((usage.get("prompt_tokens", 0) - cached) * INPUT_PER_M + cached * CACHED_PER_M
            + usage.get("completion_tokens", 0) * OUTPUT_PER_M) / 1_000_000


def _http(url, payload, headers, timeout):
    import requests
    response = requests.post(url, json=payload, headers=headers, timeout=timeout, allow_redirects=False)
    return response.status_code, response.text


class FireworksClient:
    reasoning = "low"

    def __init__(self, key, ledger, http=None, sleep=time.sleep):
        if not key:
            raise ValueError("Fireworks key is empty")
        self.key, self.ledger = key, ledger
        self.http, self.sleep = http or _http, sleep

    def responses(self, input, model=None, max_output_tokens=6000, label="", reserve_usd=0.0, extra=None):
        extra = extra or {}
        messages = _messages(input)
        payload = {"model": model or MODEL, "messages": messages, "max_tokens": max_output_tokens,
                   "temperature": extra.get("temperature", 0),
                   "reasoning_effort": (extra.get("reasoning") or {}).get("effort", self.reasoning)}
        chars, images = 0, 0
        for message in messages:
            content = message.get("content") or ""
            if isinstance(content, str):
                chars += len(content)
            else:
                for part in content:
                    if part["type"] == "image_url":
                        images += 1
                    elif part["type"] == "text":
                        chars += len(part["text"])
        reserve = (max_output_tokens * OUTPUT_PER_M + (chars / 2 + 8000 * images) * INPUT_PER_M) / 1_000_000
        for attempt in range(3):
            rid = self.ledger.reserve(reserve, label.replace(self.key, "<key>"))
            error = None
            try:
                status, body = self.http(BASE_URL, payload, {"Authorization": "Bearer " + self.key}, 300)
            except Exception as exc:
                error = FireworksStop(0, str(exc), self.key)
            if error is not None:
                raise error
            if status == 200:
                try:
                    data = json.loads(body)
                    if not isinstance(data.get("usage"), dict):
                        raise ValueError("missing usage")
                    choice = data["choices"][0]
                    content = choice["message"]["content"] or ""
                    cost = fireworks_cost(data["usage"])
                except (ValueError, TypeError, KeyError, IndexError, AttributeError):
                    error = FireworksStop(status, body, self.key)
                if error is not None:
                    raise error
                self.ledger.settle(rid, cost)
                return {"output": [{"type": "message", "content": [{"type": "output_text", "text": content.replace(self.key, "<key>")}]}],
                        "usage": data["usage"], "_cost_usd": cost,
                        "status": "incomplete" if choice.get("finish_reason") == "length" else "completed"}
            self.ledger.settle(rid, 0)
            billing = any(word in body.lower() for word in ("credit", "balance", "billing", "payment", "suspend", "quota"))
            if billing or not (status == 429 or 500 <= status < 600) or attempt == 2:
                raise FireworksStop(status, body, self.key)
            self.sleep((5, 20)[attempt])
