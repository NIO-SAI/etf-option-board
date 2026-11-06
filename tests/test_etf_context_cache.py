"""etf_context 的 TTL + 单飞缓存回归（全部打桩，不触网）。

背景：同一批标的上下文被 monitor / directions / national_team / /api/etf 等
5 条链路重复计算，稳态下 300+ 次/分钟打东财。缓存后同一窗口内共享一次构建。
"""

import asyncio
from types import SimpleNamespace

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
def clock(monkeypatch):
    """时间全部注入；缓存与绑定事件循环的锁都按用例隔离。"""
    now = [1000.0]
    monkeypatch.setattr(ms, "time", SimpleNamespace(
        time=lambda: now[0], strftime=lambda fmt: "2026-11-06"))
    monkeypatch.setattr(ms, "_CTX_CACHE", {})
    monkeypatch.setattr(ms, "_CTX_LOCKS", {})
    return now


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


def test_ttl_expiry_triggers_rebuild(stubbed, clock):
    """TTL 内命中缓存；过期后重新构建（freshness 不降级）。"""
    _run(ms.etf_context("510300", "1.510300"))
    before = dict(stubbed)
    # 8s 内再取：纯缓存命中
    _run(ms.etf_context("510300", "1.510300"))
    assert stubbed == before
    # 手动把时间推过 TTL：应触发重建
    clock[0] += ms._CTX_TTL + 1
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


def test_failed_build_can_retry(stubbed, monkeypatch):
    """构建失败不缓存异常，下一次调用可重新获取数据。"""
    original = ms._build_etf_context
    attempts = 0

    async def build(code, secid):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("模拟上游失败")
        return await original(code, secid)

    monkeypatch.setattr(ms, "_build_etf_context", build)

    async def main():
        with pytest.raises(RuntimeError, match="模拟上游失败"):
            await ms.etf_context("510300", "1.510300")
        assert not ms._CTX_CACHE
        return await ms.etf_context("510300", "1.510300")

    assert _run(main())["code"] == "510300"
    assert attempts == 2
    assert stubbed["quote"] == 1


def test_cancelled_builder_releases_waiter(stubbed, monkeypatch):
    """构建者取消后，已排队的同标调用可以继续构建，不留下锁死状态。"""
    original = ms._build_etf_context

    async def main():
        entered = asyncio.Event()
        waiting = asyncio.Event()
        attempts = 0

        async def build(code, secid):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                entered.set()
                await asyncio.Event().wait()
            return await original(code, secid)

        async def waiter():
            waiting.set()
            return await ms.etf_context("510300", "1.510300")

        monkeypatch.setattr(ms, "_build_etf_context", build)
        first = asyncio.create_task(ms.etf_context("510300", "1.510300"))
        await entered.wait()
        second = asyncio.create_task(waiter())
        await waiting.wait()
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        return await second

    assert _run(main())["code"] == "510300"
    assert stubbed["quote"] == 1
