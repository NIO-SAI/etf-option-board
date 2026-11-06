"""etf_context 的 TTL + 单飞缓存回归（全部打桩，不触网）。

背景：同一批标的上下文被 monitor / directions / national_team / /api/etf 等
5 条链路重复计算，稳态下 300+ 次/分钟打东财。缓存后同一窗口内共享一次构建。
"""

import asyncio

import pytest

from services import market_service as ms


def _run(coro):
    """项目未装 pytest-asyncio，按 test_monitor_alerts 的惯例手动跑事件循环。"""
    return asyncio.run(coro)


@pytest.fixture()
def stubbed(monkeypatch):
    """打桩 etf_context 的 6 路上游取数，各留调用计数。"""
    calls = {"quote": 0, "kline": 0, "trends": 0, "fflow": 0, "stock_get": 0}

    async def quote(secid):
        calls["quote"] += 1
        return {"price": 2.9, "high": 2.9, "low": 2.9, "open": 2.9}

    async def kline(secid, klt=1, lmt=240):
        calls["kline"] += 1
        return [{"date": "2026-11-06 13:00", "open": 2.9, "close": 2.9,
                 "high": 2.9, "low": 2.9, "volume": 100.0, "amount": 290.0}] * 30

    async def trends(secid, ndays=1):
        calls["trends"] += 1
        return [{"time": "2026-11-06 13:00", "price": 2.9, "avg": 2.9}]

    async def flow_series(secid):
        calls["fflow"] += 1
        return [{"main": 1.0}], "2026-11-06"

    async def stock_get(secid, fields, ttl=None):
        calls["stock_get"] += 1
        return {"f137": 1.0}

    monkeypatch.setattr(ms, "quote", quote)
    monkeypatch.setattr(ms, "kline", kline)
    monkeypatch.setattr(ms, "trends", trends)
    monkeypatch.setattr(ms, "flow_series", flow_series)
    monkeypatch.setattr(ms.em, "stock_get", stock_get)
    return calls


@pytest.fixture(autouse=True)
def _clean_cache():
    ms._CTX_CACHE.clear()  # noqa: SLF001 — 测试间隔离
    yield
    ms._CTX_CACHE.clear()  # noqa: SLF001


def test_concurrent_calls_share_one_build(stubbed):
    """同一窗口内 9 个并发调用（模拟 monitor+directions+national+api 撞车），
    6 路上游各只应发 1 次请求。"""
    async def one():
        return await ms.etf_context("510300", "1.510300")

    async def main():
        return await asyncio.gather(*[one() for _ in range(9)])

    results = _run(main())
    assert all(r["code"] == "510300" for r in results)
    assert stubbed["quote"] == 1
    assert stubbed["kline"] == 2          # 1m + 5m 两档
    assert stubbed["trends"] == 1
    assert stubbed["fflow"] == 1
    assert stubbed["stock_get"] == 1


def test_ttl_expiry_triggers_rebuild(stubbed, monkeypatch):
    """TTL 内命中缓存；过期后重新构建（freshness 不降级）。"""
    _run(ms.etf_context("510300", "1.510300"))
    before = dict(stubbed)
    # 8s 内再取：纯缓存命中
    _run(ms.etf_context("510300", "1.510300"))
    assert stubbed == before
    # 手动把时间推过 TTL：应触发重建
    at, data = ms._CTX_CACHE["510300"]  # noqa: SLF001
    ms._CTX_CACHE["510300"] = (at - ms._CTX_TTL - 1, data)  # noqa: SLF001
    _run(ms.etf_context("510300", "1.510300"))
    assert stubbed["quote"] == before["quote"] + 1
    assert stubbed["fflow"] == before["fflow"] + 1


def test_different_codes_cached_separately(stubbed):
    """不同标互不串缓存。"""
    async def main():
        await asyncio.gather(ms.etf_context("510300", "1.510300"),
                             ms.etf_context("510050", "1.510050"))

    _run(main())
    assert stubbed["quote"] == 2
    assert stubbed["fflow"] == 2
