"""Responses interface for a model on this machine."""
import copy
import json
import time
from pathlib import Path
from urllib.parse import urlsplit

from metaclient.client import ApiError

REASONING_FIELD = "chat_template_kwargs"


def _http(url, payload, timeout):
    import requests
    response = requests.post(url, json=payload, timeout=timeout, allow_redirects=False)
    if response.status_code != 200:
        raise ApiError(response.status_code, response.text)
    return response.json()


def _messages(items):
    if isinstance(items, str):
        return [{"role": "user", "content": items}]
    messages = []
    for item in items:
        kind = item.get("type")
        if kind == "function_call":
            call = {"id": item["call_id"], "type": "function", "function": {
                "name": item["name"], "arguments": item["arguments"]}}
            if messages and messages[-1]["role"] == "assistant":
                messages[-1].setdefault("tool_calls", []).append(call)
            else:
                messages.append({"role": "assistant", "content": None, "tool_calls": [call]})
        elif kind == "function_call_output":
            messages.append({"role": "tool", "tool_call_id": item["call_id"], "content": item["output"]})
        else:
            content = item.get("content", "")
            if isinstance(content, list):
                parts = []
                for part in content:
                    if part["type"] == "input_image":
                        parts.append({"type": "image_url", "image_url": {"url": part["image_url"]}})
                    elif part["type"] in ("input_text", "output_text", "text"):
                        parts.append({"type": "text", "text": part["text"]})
                content = parts
            role = item.get("role", "assistant")
            if role == "assistant" and messages and messages[-1].get("tool_calls"):
                messages[-1]["content"] = content
            else:
                messages.append({"role": role, "content": content})
    return messages


def _last_thought(reasoning):
    """The last paragraph of the model's reasoning, as one short line, for a model that writes no words next to its tool call."""
    parts = [p.strip() for p in reasoning.strip().splitlines() if p.strip()]
    return parts[-1][:200] if parts else ""


def _prune_images(messages, keep):
    """Keep only the latest `keep` screenshots; older ones become a short note so the context window does not fill."""
    seen = 0
    for m in reversed(messages):
        if not isinstance(m.get("content"), list):
            continue
        parts = []
        for p in reversed(m["content"]):
            if p.get("type") == "image_url":
                seen += 1
                if seen > keep:
                    p = {"type": "text", "text": "(earlier screenshot not kept)"}
            parts.append(p)
        m["content"] = parts[::-1]
    return messages


class LocalClient:
    def __init__(self, base_url="http://127.0.0.1:8090/v1", model="glimmer-local", reasoning="low", http=None, log_path=None, keep_images=2):
        url = urlsplit(base_url)
        if url.scheme not in ("http", "https") or url.hostname not in ("localhost", "127.0.0.1", "::1"):
            raise ValueError("local server required")
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.reasoning = reasoning
        self.http = http or _http
        self.log_path = Path(log_path) if log_path is not None else None
        self.keep_images = keep_images
        self._history = {}
        self._next_id = 0

    def wonder(self, body, label="", reserve_usd=0.0, timeout=600):
        start = time.perf_counter()
        usage = {"input_tokens": 0, "output_tokens": 0}
        try:
            previous = body.get("previous_response_id") if body.get("store") is not False else None
            if previous and previous not in self._history:
                raise ApiError(400, "previous response not found")
            messages = copy.deepcopy(self._history[previous]) if previous else []
            if "instructions" in body:
                messages = [m for m in messages if m["role"] != "system"]
                messages.insert(0, {"role": "system", "content": body["instructions"]})
            messages.extend(_messages(body.get("input", [])))
            _prune_images(messages, self.keep_images)
            effort = (body.get("reasoning") or {}).get("effort", self.reasoning)
            payload = {"model": self.model, "messages": messages, "max_tokens": body.get("max_output_tokens", 6000),
                       "temperature": body.get("temperature", 0),
                       REASONING_FIELD: {"reasoning_strength": "low" if effort == "minimal" else effort}}
            if body.get("tools"):
                payload["tools"] = [{"type": "function", "function": {
                    k: tool[k] for k in ("name", "description", "parameters") if k in tool}} for tool in body["tools"]]
            data = self.http(self.base_url + "/chat/completions", payload, timeout)
            choice = data["choices"][0]
            message = choice["message"]
            output = []
            for call in message.get("tool_calls") or []:
                function = call["function"]
                arguments = function["arguments"]
                output.append({"type": "function_call", "call_id": call["id"], "name": function["name"],
                               "arguments": arguments if isinstance(arguments, str) else json.dumps(arguments)})
            if message.get("content"):
                output.append({"type": "message", "content": [{"type": "output_text", "text": message["content"]}]})
            raw_usage = data.get("usage") or {}
            usage = {"input_tokens": raw_usage.get("prompt_tokens", 0), "output_tokens": raw_usage.get("completion_tokens", 0)}
            self._next_id += 1
            response_id = f"local-{self._next_id}"
            self._history[response_id] = copy.deepcopy(messages + [{k: message[k] for k in ("role", "content", "tool_calls") if k in message}])
            seconds = time.perf_counter() - start
            thought = "" if message.get("content") else _last_thought(message.get("reasoning_content") or "")
            return {"id": response_id, "output": output, "usage": usage, "_thought": thought, "_cost_usd": 0.0, "_latency_s": seconds,
                    "status": "incomplete" if choice.get("finish_reason") == "length" else "completed"}
        finally:
            if self.log_path is not None:
                self.log_path.parent.mkdir(parents=True, exist_ok=True)
                with self.log_path.open("a", encoding="utf-8") as log:
                    log.write(json.dumps({"label": label, "seconds": locals().get("seconds", time.perf_counter() - start), **usage}) + "\n")

    def responses(self, input, model=None, max_output_tokens=6000, label="", reserve_usd=0.0, extra=None):
        return self.wonder({"input": input, "max_output_tokens": max_output_tokens, **(extra or {})},
                           label=label, reserve_usd=reserve_usd)
