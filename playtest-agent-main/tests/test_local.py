import json

import pytest

from metaclient.client import ApiError, output_text
from metaclient.local import LocalClient


def answer(content="Done", calls=None):
    return {"choices": [{"message": {"role": "assistant", "content": content, "tool_calls": calls or []},
                         "finish_reason": "stop"}], "usage": {"prompt_tokens": 12, "completion_tokens": 3}}


def test_screenshot_tools_usage_and_log(tmp_path):
    sent = []
    log = tmp_path / "calls.jsonl"
    client = LocalClient(http=lambda *args: (sent.append(args), answer())[1], log_path=log)
    tool = {"type": "function", "name": "act", "description": "Move", "parameters": {"type": "object"}}
    res = client.wonder({"instructions": "Test", "tools": [tool], "max_output_tokens": 90,
                         "input": [{"role": "user", "content": [{"type": "input_text", "text": "Look"},
                                    {"type": "input_image", "image_url": "data:image/jpeg;base64,eA=="}]}]}, label="turn")
    url, payload, timeout = sent[0]
    assert url == "http://127.0.0.1:8090/v1/chat/completions" and timeout == 600
    assert payload == {"model": "glimmer-local", "max_tokens": 90, "temperature": 0,
                       "chat_template_kwargs": {"reasoning_strength": "low"},
                       "tools": [{"type": "function", "function": {k: tool[k] for k in ("name", "description", "parameters")}}],
                       "messages": [{"role": "system", "content": "Test"}, {"role": "user", "content": [
                           {"type": "text", "text": "Look"}, {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,eA=="}}]}]}
    assert res["id"] == "local-1" and output_text(res) == "Done"
    assert res["usage"] == {"input_tokens": 12, "output_tokens": 3}
    assert res["_cost_usd"] == 0.0 and res["_latency_s"] >= 0
    assert json.loads(log.read_text()) == {"label": "turn", "seconds": res["_latency_s"], "input_tokens": 12, "output_tokens": 3}


def test_tool_round_trip_and_stateless_history():
    sent = []
    call = {"id": "c1", "type": "function", "function": {"name": "act", "arguments": '{"actions": []}'}}
    replies = iter([answer(None, [call]), answer(), answer()])
    client = LocalClient(http=lambda u, p, t: (sent.append(p), next(replies))[1])
    first = {"role": "user", "content": "Go"}
    res = client.wonder({"instructions": "Test", "input": [first]})
    item = {"type": "function_call", "call_id": "c1", "name": "act", "arguments": '{"actions": []}'}
    assert res["output"] == [item]
    out = {"type": "function_call_output", "call_id": "c1", "output": "done"}
    second = client.wonder({"instructions": "Test", "previous_response_id": res["id"], "input": [out]})
    assert second["id"] == "local-2"
    assert sent[1]["messages"] == [{"role": "system", "content": "Test"}, first,
                                   {"role": "assistant", "content": None, "tool_calls": [call]},
                                   {"role": "tool", "tool_call_id": "c1", "content": "done"}]
    client.wonder({"instructions": "Test", "store": False, "previous_response_id": "missing",
                   "input": [first, item, out, {"role": "assistant", "content": [{"type": "output_text", "text": "Fine"}]}]})
    assert sent[2]["messages"][:-1] == sent[1]["messages"]
    assert sent[2]["messages"][-1] == {"role": "assistant", "content": [{"type": "text", "text": "Fine"}]}


def test_unknown_previous_response():
    client = LocalClient(http=lambda *args: pytest.fail("HTTP called"))
    with pytest.raises(ApiError) as exc:
        client.wonder({"previous_response_id": "missing", "input": []})
    assert (exc.value.status, exc.value.body) == (400, "previous response not found")


def test_stateless_text_and_parallel_calls_share_one_assistant_message():
    sent = []
    client = LocalClient(http=lambda u, p, t: (sent.append(p), answer())[1])
    calls = [{"type": "function_call", "call_id": name, "name": name, "arguments": "{}"} for name in ("act", "tick")]
    client.wonder({"store": False, "input": calls + [
        {"role": "assistant", "content": [{"type": "output_text", "text": "Trying both"}]},
        {"type": "function_call_output", "call_id": "act", "output": "done"},
        {"type": "function_call_output", "call_id": "tick", "output": "noted"}]})
    messages = sent[0]["messages"]
    assert len(messages) == 3
    assert messages[0]["role"] == "assistant" and len(messages[0]["tool_calls"]) == 2
    assert messages[0]["content"] == [{"type": "text", "text": "Trying both"}]
    assert [m["role"] for m in messages] == ["assistant", "tool", "tool"]


@pytest.mark.parametrize("url", ["https://example.com/v1", "http://127.0.0.2/v1", "http://localhost.evil/v1", "file:///tmp/v1"])
def test_refuses_remote_hosts(url):
    with pytest.raises(ValueError):
        LocalClient(base_url=url)


@pytest.mark.parametrize("host", ["localhost", "127.0.0.1", "[::1]"])
def test_accepts_loopback(host):
    LocalClient(base_url=f"http://{host}:8090/v1")


def test_default_http_error(monkeypatch):
    import requests
    class Response:
        status_code = 503
        text = "busy"
    monkeypatch.setattr(requests, "post", lambda *a, **kw: Response())
    with pytest.raises(ApiError) as exc:
        LocalClient().wonder({"input": []})
    assert (exc.value.status, exc.value.body) == (503, "busy")


@pytest.mark.parametrize("effort,expected", [("minimal", "low"), ("low", "low"), ("medium", "medium"), ("high", "high")])
def test_responses_reasoning(effort, expected):
    sent = []
    client = LocalClient(reasoning="high", http=lambda u, p, t: (sent.append(p), answer())[1])
    res = client.responses("Check", extra={"reasoning": {"effort": effort}, "temperature": 0})
    assert sent[0]["chat_template_kwargs"] == {"reasoning_strength": expected}
    assert sent[0]["messages"] == [{"role": "user", "content": "Check"}]
    assert output_text(res) == "Done" and res["_cost_usd"] == 0.0


def test_default_http_success_and_incomplete(monkeypatch):
    import requests
    sent = []
    class Response:
        status_code = 200
        def json(self):
            data = answer()
            data["choices"][0]["finish_reason"] = "length"
            return data
    monkeypatch.setattr(requests, "post", lambda *a, **kw: (sent.append((a, kw)), Response())[1])
    res = LocalClient(reasoning="medium").responses("Check")
    assert res["status"] == "incomplete"
    assert sent[0][1]["json"]["chat_template_kwargs"] == {"reasoning_strength": "medium"}
    assert sent[0][1]["allow_redirects"] is False


def _turn(text):
    return {"input": [{"role": "user", "content": [{"type": "input_text", "text": text},
                                                   {"type": "input_image", "image_url": "data:image/jpeg;base64,eA=="}]}]}


def test_only_the_latest_screenshots_are_kept_so_the_context_does_not_fill():
    sent = []
    client = LocalClient(http=lambda *args: (sent.append(args[1]), answer())[1], keep_images=2)
    prev = None
    for i in range(5):
        body = {**_turn(f"turn {i}"), **({"previous_response_id": prev} if prev else {})}
        prev = client.wonder(body)["id"]
    last = sent[-1]["messages"]
    images = [p for m in last if isinstance(m["content"], list) for p in m["content"] if p.get("type") == "image_url"]
    assert len(images) == 2
    texts = json.dumps(last)
    assert "turn 0" in texts and "turn 4" in texts          # the words of every turn stay
    assert "earlier screenshot not kept" in texts
    # the stored history is pruned too, so memory does not grow with images
    stored = client._history[prev]
    assert sum(1 for m in stored if isinstance(m["content"], list) for p in m["content"] if p.get("type") == "image_url") == 2


def test_thought_is_the_last_line_of_the_reasoning_when_there_are_no_words():
    reply = {"choices": [{"message": {"role": "assistant", "content": "", "reasoning_content": "Need to act. Door is ahead.\n\nI'll try move forward. Then look.", "tool_calls": []}, "finish_reason": "stop"}],
             "usage": {"prompt_tokens": 1, "completion_tokens": 1}}
    res = LocalClient(http=lambda *a: reply).wonder({"input": [{"role": "user", "content": [{"type": "input_text", "text": "x"}]}]})
    assert res["_thought"] == "I'll try move forward. Then look."
    spoken = dict(reply, choices=[{"message": {"role": "assistant", "content": "I see a door.", "reasoning_content": "hmm"}, "finish_reason": "stop"}])
    assert LocalClient(http=lambda *a: spoken).wonder({"input": [{"role": "user", "content": [{"type": "input_text", "text": "x"}]}]})["_thought"] == ""
