"""Muse Wonder pricing and the call wrapper. No network. Prices: dev.meta.ai/docs pricing-rate-limits.md, read 26 Oct 2026."""
import json
import pytest
from metaclient import client as C
from metaclient import ledger as L
from test_metaclient import FakeHttp, make  # noqa


def test_wonder_cost_per_million():
    assert C.wonder_cost(1_000_000, 0) == pytest.approx(4.00)
    assert C.wonder_cost(0, 1_000_000) == pytest.approx(20.00)
    assert C.wonder_cost(1_000_000, 0, cached=1_000_000) == pytest.approx(0.20)


def test_wonder_call_settles_real_cost(tmp_path):
    body = {"id": "r1", "output": [], "usage": {"input_tokens": 10000, "output_tokens": 100, "input_tokens_details": {"cached_tokens": 4000}}}
    cl, led = make(tmp_path, FakeHttp(200, body))
    d = cl.wonder({"input": "x"}, label="t", reserve_usd=0.5)
    expect = 6000 * 4 / 1e6 + 4000 * 0.2 / 1e6 + 100 * 20 / 1e6
    assert d["_cost_usd"] == pytest.approx(expect)
    assert led.spent() == pytest.approx(expect)
    sent = cl.http.calls[0]["json"]
    assert sent["model"] == "muse-wonder-1.0"


def test_wonder_refuses_over_cap(tmp_path, monkeypatch):
    monkeypatch.setenv("PLAYTEST_CAP_USD", "0.10")
    cl, led = make(tmp_path, FakeHttp(200, {}))
    with pytest.raises(L.CapReached):
        cl.wonder({"input": "x"}, label="t", reserve_usd=0.5)
    assert cl.http.calls == []


def test_reserve_estimate_grows_with_last_input():
    small = C.wonder_reserve(last_input_tokens=2000, max_output_tokens=1000)
    big = C.wonder_reserve(last_input_tokens=80000, max_output_tokens=1000)
    assert big > small
    assert small >= C.wonder_cost(2000, 1000)   # never under the worst case


def test_no_contributor_model_id():
    assert not C.WONDER.endswith("-contributor")
