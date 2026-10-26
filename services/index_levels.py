"""上证指数关键位因子：20 日高低 / 整百关口 / MA5·MA11 排列 + 盘中突破确认。

9 只 ETF 共用同一份结果（30s 缓存），不按关联指数分别计算。仅用上证 000001，
只用 20 日窗口（不含今日未完成日线），不引入 60/120 日阶段位。
"""

from __future__ import annotations

import asyncio
import datetime as dt
import math
import time

from services import em, market_service as ms

SECID = "1.000001"
_TTL = 30
_CACHE: tuple[float, dict] | None = None


def _pct(a: float, b: float) -> float | None:
    """支撑口径：a 相对 b 的距离（%）。"""
    if not b:
        return None
    return round((a / b - 1) * 100, 2)


def _pct_pressure(level: float, last: float) -> float | None:
    """压力口径：位相对现价还有多少空间（%）。"""
    if not last:
        return None
    return round((level / last - 1) * 100, 2)


async def _minute_closes() -> list[float]:
    """最近已收盘的 1 分钟 K 收盘（剔除正在形成的当分钟 K，仅取今日）。"""
    bars = await em.kline(SECID, klt=1, lmt=30, ttl=30)
    today = dt.date.today().isoformat()
    cur_min = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    out: list[float] = []
    for b in em.parse_klines(bars):
        t = str(b.get("date") or "")
        if not t.startswith(today) or t[:16] == cur_min:
            continue
        if b.get("close"):
            out.append(float(b["close"]))
    return out


def evaluate(prev: list[dict], last: float, mins: list[float]) -> dict:
    """纯计算：给定「不含今日」的日线、最新点位与已收盘分钟收盘序列，产出关键位。"""
    window = prev[-20:]
    enough = len(window) >= 5
    hist = [b["close"] for b in prev]
    high20 = max(b["high"] for b in window) if enough else None
    low20 = min(b["low"] for b in window) if enough else None
    ma5 = sum((hist + [last])[-5:]) / 5 if enough else None
    ma11 = sum((hist + [last])[-11:]) / 11 if enough and len(hist) >= 10 else None
    int_lower = math.floor(last / 100) * 100
    int_upper = int_lower + 100

    breakout = breakdown = False
    if enough and len(mins) >= 3 and high20 and low20:
        tail = mins[-3:]
        breakout = all(c >= high20 * 1.002 for c in tail)
        breakdown = all(c <= low20 * 0.998 for c in tail)

    levels: list[dict] = []
    raw = 0.0

    def add(key: str, name: str, value: float | None, side: str, dist: float | None, contrib: float):
        nonlocal raw
        if value is None:
            return
        raw += contrib
        levels.append({"key": key, "name": name, "value": round(value, 2),
                       "side": side, "dist_pct": dist, "contrib": round(contrib, 1)})

    if enough:
        d_low = _pct(last, low20)
        d_high = _pct_pressure(high20, last)
        if breakdown:
            c_low = -10.0
        elif d_low is not None and 0 <= d_low <= 0.3:
            c_low = 8.0
        elif d_low is not None and 0.3 < d_low <= 0.8:
            c_low = 4.0
        else:
            c_low = 0.0
        if breakout:
            c_high = 10.0
        elif d_high is not None and 0 <= d_high <= 0.3:
            c_high = -8.0
        elif d_high is not None and 0.3 < d_high <= 0.8:
            c_high = -4.0
        else:
            c_high = 0.0
        add("low20", "20日低点", low20, "support", d_low, c_low)
        add("high20", "20日高点", high20, "pressure", d_high, c_high)

        d_lower = _pct(last, int_lower)
        d_upper = _pct_pressure(int_upper, last)
        add("int_lower", "下方整百", int_lower, "support", d_lower,
            4.0 if d_lower is not None and d_lower <= 0.5 else 0.0)
        add("int_upper", "上方整百", int_upper, "pressure", d_upper,
            -4.0 if d_upper is not None and d_upper <= 0.5 else 0.0)

        if ma5:
            add("ma5", "MA5", ma5, "ma", _pct(last, ma5),
                (5.0 if ma11 and last > ma5 > ma11
                 else -5.0 if ma11 and last < ma5 < ma11 else 0.0))
        if ma11:
            add("ma11", "MA11", ma11, "ma", _pct(last, ma11), 0.0)

    total = round(max(-15.0, min(15.0, raw)), 1) if enough else 0.0
    note = None
    if not enough:
        note = "历史不足 5 日，关键位不计分"
    elif len(window) < 20:
        note = f"历史不足 20 日（仅 {len(window)} 日）"
    return {"high20": high20, "low20": low20, "ma5": ma5, "ma11": ma11,
            "int_upper": int_upper, "int_lower": int_lower,
            "total": total, "levels": levels, "note": note,
            "insufficient": not enough, "breakout": breakout, "breakdown": breakdown}


async def snapshot(force: bool = False) -> dict:
    global _CACHE
    now = time.time()
    if not force and _CACHE and now - _CACHE[0] < _TTL:
        return _CACHE[1]

    daily, q, mins = await asyncio.gather(
        em.kline(SECID, klt=101, lmt=45, ttl=60),
        ms.quote(SECID),
        _minute_closes(),
    )
    bars = em.parse_klines(daily)
    today = dt.date.today().isoformat()
    prev = [b for b in bars if str(b.get("date") or "")[:10] < today]
    last = (q or {}).get("price") or (prev[-1]["close"] if prev else None)

    if not prev or not last:
        res = {"ok": False, "last": last, "total": 0.0, "levels": [],
               "note": "日线数据不足", "insufficient": True,
               "breakout": False, "breakdown": False,
               "pct": (q or {}).get("pct")}
        _CACHE = (now, res)
        return res

    ev = evaluate(prev, last, mins)
    res = {
        "ok": True, "secid": SECID, "code": "000001", "name": "上证指数",
        "last": last, "pct": (q or {}).get("pct"), "prev_close": (q or {}).get("prev_close"),
        "high20": round(ev["high20"], 2) if ev["high20"] else None,
        "low20": round(ev["low20"], 2) if ev["low20"] else None,
        "ma5": round(ev["ma5"], 2) if ev["ma5"] else None,
        "ma11": round(ev["ma11"], 2) if ev["ma11"] else None,
        "int_upper": ev["int_upper"], "int_lower": ev["int_lower"],
        "total": ev["total"], "levels": ev["levels"], "note": ev["note"],
        "insufficient": ev["insufficient"], "breakout": ev["breakout"],
        "breakdown": ev["breakdown"],
        "ts": dt.datetime.now().strftime("%H:%M:%S"),
    }
    _CACHE = (now, res)
    return res


def factor_text(levels: dict) -> str | None:
    """关键位因子 ≥8 或发生突破时，给出点名具体位的文案。"""
    if not levels.get("ok"):
        return None
    if levels.get("breakout"):
        return f"上证指数突破 20 日高点 {levels['high20']:.1f}（3 根 1 分钟 K 均在位外）"
    if levels.get("breakdown"):
        return f"上证指数跌破 20 日低点 {levels['low20']:.1f}"
    if abs(levels.get("total") or 0) < 8:
        return None
    row = max(levels.get("levels") or [], key=lambda x: abs(x.get("contrib") or 0), default=None)
    if not row or not row.get("contrib"):
        return None
    if row["side"] == "support":
        return f"上证距 {row['name']} {row['dist_pct']:.2f}%，支撑有效"
    if row["side"] == "pressure":
        return f"上证距 {row['name']} {row['dist_pct']:.2f}%，压力临近"
    return None
