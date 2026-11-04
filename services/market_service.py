"""市场环境：宽基指数、ETF 分时与资金流、外围市场、国家队护盘识别。"""

from __future__ import annotations

import asyncio
import logging
import time

from services import em
from services.indicators import macd_state, pct_change, support_resistance, volume_stats
from services.universe import (EXTERNAL, INDICES, NATIONAL_TEAM_ETFS, TRACK_INDEX)

log = logging.getLogger("market")

_IDX_FIELDS = "f43,f44,f45,f46,f47,f48,f57,f58,f60,f169,f170,f171"


async def quote(secid: str) -> dict | None:
    q = await em.stock_get(secid, _IDX_FIELDS)
    if not q:
        return None
    return {
        "secid": secid, "code": em.f(q.get("f57")), "name": em.f(q.get("f58")),
        "price": em.num(q.get("f43")), "high": em.num(q.get("f44")), "low": em.num(q.get("f45")),
        "open": em.num(q.get("f46")), "prev_close": em.num(q.get("f60")),
        "volume": em.num(q.get("f47")), "amount": em.num(q.get("f48")),
        "change": em.num(q.get("f169")), "pct": em.num(q.get("f170")),
        "amplitude": em.num(q.get("f171")),
    }


async def indices_snapshot() -> list[dict]:
    res = await asyncio.gather(*[quote(i["secid"]) for i in INDICES])
    out = []
    for meta, q in zip(INDICES, res):
        if q:
            out.append({**q, "short": meta["short"]})
    return out


async def external_snapshot() -> list[dict]:
    res = await asyncio.gather(*[quote(i["secid"]) for i in EXTERNAL], return_exceptions=True)
    out = []
    for meta, q in zip(EXTERNAL, res):
        if isinstance(q, dict) and q:
            out.append({**q, "key": meta["key"], "name_cn": meta["name"]})
    return out


async def kline(secid: str, klt: int = 1, lmt: int = 240) -> list[dict]:
    if klt == 3:
        bars = em.parse_klines(await em.kline(secid, klt=1, lmt=lmt * 3))
        return _agg(bars, 3)
    return em.parse_klines(await em.kline(secid, klt=klt, lmt=lmt))


async def trends(secid: str, ndays: int = 1) -> list[dict]:
    return em.parse_trends(await em.trends(secid, ndays=ndays))


async def flow_series(secid: str) -> tuple[list[dict], str | None]:
    """返回 (分钟点列表, 数据所属日期)。9:15 前等当日无数据时日期为昨日。"""
    raw = await em.fflow(secid)
    return em.parse_fflow(raw), (raw or {}).get("day")


def _agg(bars: list[dict], n: int) -> list[dict]:
    out = []
    for i in range(0, len(bars), n):
        g = bars[i:i + n]
        if not g:
            continue
        out.append({"date": g[-1]["date"], "open": g[0]["open"], "close": g[-1]["close"],
                    "high": max(b["high"] for b in g), "low": min(b["low"] for b in g),
                    "volume": sum(b["volume"] for b in g), "amount": sum(b["amount"] for b in g)})
    return out


def _snap_num(v):
    """资金流快照取数：保留 None（与 em.num 遇空值回 0 不同，避免把"无数据"画成 0）。"""
    if v in (None, "-", ""):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


async def etf_context(code: str, etf_secid: str) -> dict:
    """单只 ETF 的行情 + 分钟K + 分时 + 资金流。"""
    q, k1, k5, tr, flr, fsnap = await asyncio.gather(
        quote(etf_secid),
        kline(etf_secid, klt=1, lmt=240),
        # 5 分钟 K（跨日，供 15 分钟背离监测；15m 由 3 根 5m 聚合，1m×240 不够 MACD 预热）
        kline(etf_secid, klt=5, lmt=120),
        trends(etf_secid),
        flow_series(etf_secid),
        # 当日累计资金流快照（收盘后分钟序列无数据时，前端仍可用此数字展示）
        em.stock_get(etf_secid, "f137,f140,f143,f146,f149", ttl=30.0),
    )
    fl, flow_day = flr
    closes = [b["close"] for b in k1]
    vols = [b["volume"] for b in k1]
    # 15 分钟 K 线（由 5 分钟本地聚合）——MACD 顶/底背离统一按 15 分钟口径监测，
    # 与变盘点引擎（reversal）一致，过滤掉 3 分钟级别的盘中噪声。
    closes15 = [b["close"] for b in _agg(k5, 3)]
    flow_tail = fl[-5:] if fl else []
    flow_delta = (flow_tail[-1]["main"] - flow_tail[0]["main"]) if len(flow_tail) >= 2 else None
    tr_day = (tr[-1]["time"] or "")[:10] if tr else None
    # 日内枢轴支撑/压力（供分时图横线）：只用 1 分钟 K，纯本地计算不额外发请求
    sr = (support_resistance(closes, [b["high"] for b in k1], [b["low"] for b in k1])
          if len(k1) >= 10 else {})
    return {
        "code": code,  # 供综合方向并入「变盘点」加分（reversal.factor）
        "quote": q, "kline_1m": k1, "trends": tr, "trends_day": tr_day,
        "support": sr.get("support") or [],
        "resistance": sr.get("resistance") or [],
        # 盘前 trends 会回退到上一交易日；涨跌幅基准必须用那一日的昨收，而不是今日的
        "trends_prev_close": (em.trend_prev_close(etf_secid)
                              if tr_day and tr_day != time.strftime("%Y-%m-%d") else None),
        "flow": fl, "flow_day": flow_day,
        "macd": macd_state(closes),        # 1 分钟：金叉/死叉
        "macd15": macd_state(closes15),    # 15 分钟：顶/底背离监测（全站统一口径）
        "volume": volume_stats(vols, closes),
        "flow_main_delta5m": flow_delta,
        "flow_main_total": fl[-1]["main"] if fl else 0,
        "flow_snapshot": {
            "main": _snap_num(fsnap.get("f137")),
            "small": _snap_num(fsnap.get("f140")),
            "mid": _snap_num(fsnap.get("f143")),
            "big": _snap_num(fsnap.get("f146")),
            "super": _snap_num(fsnap.get("f149")),
        } if fsnap else None,
        "pct": pct_change(closes, 5),
    }


async def index_support_state(secid: str) -> dict:
    """指数当前位置 vs 日线支撑（MA20/前低）与日内区间位置。"""
    daily_raw, q = await asyncio.gather(
        em.kline(secid, klt=101, lmt=40),
        quote(secid),
    )
    daily = em.parse_klines(daily_raw)
    if not daily or not q:
        return {}
    closes = [b["close"] for b in daily]
    ma5 = sum(closes[-5:]) / min(5, len(closes))
    ma10 = sum(closes[-10:]) / min(10, len(closes))
    ma20 = sum(closes[-20:]) / min(20, len(closes))
    last = q["price"]
    prev_low = daily[-2]["low"] if len(daily) > 1 else q["low"]
    day_pos = 0.0
    if q["high"] and q["low"] and q["high"] > q["low"]:
        day_pos = (last - q["low"]) / (q["high"] - q["low"])
    dist_ma20 = (last / ma20 - 1) * 100 if ma20 else 0
    at_support = dist_ma20 < 1.0 or last <= ma20 * 1.005 or last <= prev_low * 1.01
    return {
        "ma5": round(ma5, 2), "ma10": round(ma10, 2), "ma20": round(ma20, 2),
        "last": last, "prev_low": prev_low, "dist_ma20_pct": round(dist_ma20, 2),
        "day_position": round(day_pos, 3), "at_support": at_support,
    }


async def national_team_signal() -> dict:
    """国家队护盘识别：宽基 ETF 资金流 + 放量 + 指数是否处支撑。

    综合打分：主力净流入合力(近5分钟增量) + 量能放大 + 指数位置。
    """
    # 指数关键位与 7 只 ETF 行情并发（此前串行相加，/api/national 要 1.6s）
    idx_task = asyncio.ensure_future(index_support_state("1.000001"))
    tasks = [etf_context(e["code"], e["secid"]) for e in NATIONAL_TEAM_ETFS]
    ctxs = await asyncio.gather(*tasks, return_exceptions=True)
    idx = await idx_task
    entries = []
    main_sum = 0.0
    surge_cnt = 0
    for meta, ctx in zip(NATIONAL_TEAM_ETFS, ctxs):
        if isinstance(ctx, Exception) or not ctx.get("quote"):
            continue
        d5 = ctx.get("flow_main_delta5m") or 0
        vs = ctx.get("volume") or {}
        main_sum += d5
        if vs.get("is_surge"):
            surge_cnt += 1
        entries.append({
            "code": meta["code"], "name": meta["name"],
            "pct": ctx["quote"]["pct"],
            "main_5m": round(d5 / 1e4, 0),           # 万元
            "main_total": round((ctx.get("flow_main_total") or 0) / 1e8, 2),  # 亿元
            "vol_ratio": vs.get("ratio"),
            "surge": bool(vs.get("is_surge")),
        })
    entries.sort(key=lambda x: -(x["main_5m"] or 0))
    # 护盘评分 0~100
    score = 0.0
    if main_sum > 0:
        score += min(main_sum / 2e8, 1) * 45          # 5分钟主力净流入合力
    score += min(surge_cnt / 3, 1) * 25               # 放量标的数
    if idx.get("at_support"):
        score += 20
    if idx.get("day_position", 1) < 0.35:
        score += 10
    score = round(min(score, 100), 1)
    level = ("强护盘" if score >= 65 else "疑似护盘" if score >= 40
             else "中性" if score >= 20 else "无")
    return {
        "score": score, "level": level,
        "index_state": idx,
        "etfs": entries,
        "main_5m_sum": round(main_sum / 1e4, 0),
        "surge_count": surge_cnt,
    }


async def track_index_state(track: str) -> dict:
    secid = TRACK_INDEX.get(track)
    if not secid:
        return {}
    q, sup, tr, flr, k1 = await asyncio.gather(
        quote(secid), index_support_state(secid), trends(secid), flow_series(secid),
        kline(secid, klt=5, lmt=60))
    fl, flow_day = flr
    closes = [b["close"] for b in k1]
    tr_day = (tr[-1]["time"] or "")[:10] if tr else None
    return {"secid": secid, "quote": q, "support": sup, "trends": tr, "trends_day": tr_day,
            "trends_prev_close": (em.trend_prev_close(secid)
                                  if tr_day and tr_day != time.strftime("%Y-%m-%d") else None),
            "flow": fl, "flow_day": flow_day, "macd": macd_state(closes)}
