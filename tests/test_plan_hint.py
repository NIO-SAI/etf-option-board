"""点位缓存：期权链接口复用 analyze 的买卖点/IV-RV 上下文（纯内存，不触网）。"""

import time

from services import strategy


def setup_function(_):
    strategy._PLAN_CACHE.clear()


def test_returns_cached_hint():
    strategy._PLAN_CACHE["510300"] = (
        time.time(), {"levels": {"entry_break": 4.0}, "spot": 4.0, "iv_rv_ratio": 1.2})
    hint = strategy.plan_hint("510300")
    assert hint["spot"] == 4.0 and hint["iv_rv_ratio"] == 1.2
    assert hint["levels"]["entry_break"] == 4.0


def test_expired_hint_is_empty():
    strategy._PLAN_CACHE["510300"] = (time.time() - strategy._PLAN_TTL - 1, {"spot": 4.0})
    assert strategy.plan_hint("510300") == {}


def test_unknown_code_is_empty():
    assert strategy.plan_hint("NOPE") == {}
