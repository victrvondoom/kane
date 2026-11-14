"""Bounded Wonder streams. Streaming not verified on the real API."""
import json
import time


def wonder_stream(client, body, label, reserve_usd, stop, timeout):
    # streaming not verified on the real API
    from .client import ApiError, BASE, WONDER

    rid = client.ledger.reserve(reserve_usd, f"{WONDER}:{label}")
    started = time.perf_counter()
    response, data, text = None, {}, ""
    cost, usage, status, estimated = reserve_usd, {}, 0, True
    error = None
    try:
        response = client.http.send_stream("POST", f"{BASE}/responses", client._headers(),
                                          json_body={"model": WONDER, **body, "stream": True}, timeout=timeout)
        status = response.status_code
        if status >= 300:
            cost, estimated = 0.0, False
            raise ApiError(status, response.content.decode("utf-8", "replace"))
        for line in response.iter_lines():
            if isinstance(line, bytes):
                line = line.decode("utf-8")
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if not payload or payload == "[DONE]":
                continue
            event = json.loads(payload)
            kind = event.get("type")
            if kind == "response.output_text.delta":
                text += event["delta"]
                if stop is not None and stop(text):
                    data = {"status": "stopped_blank"}
                    break
            elif kind in ("response.completed", "response.incomplete", "response.failed"):
                data = event.get("response") or {}
                data.setdefault("status", kind.split(".")[1])
                actual, usage = client._wonder_cost(data)
                if actual is not None:
                    cost, estimated = actual, False
                break
            elif kind == "error":
                raise ValueError("Stream error")
        else:
            data = {"status": "incomplete"}
    except Exception as exc:
        error = type(exc).__name__
        raise
    finally:
        try:
            if response is not None:
                response.close()
        finally:
            latency = round(time.perf_counter() - started, 3)
            fields = {"error": error} if error else {}
            client.ledger.settle(rid, cost, model=WONDER, label=label, status=status,
                                 latency_s=latency, usage=usage, cost_estimated=estimated, **fields)
    data.update(text=text, output_text=text, _cost_usd=cost, _latency_s=latency,
                cost_estimated=estimated)
    return data
