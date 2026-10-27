"""沪深两市成交额因子：判断放量/缩量并与大盘涨跌做量价配合。

口径：上证指数 + 深证成指当日累计成交额（腾讯 day/query，两者相加即两市总额）。
盘中按交易进度折算成全天预估，再与前一日全天成交额比较；收盘后直接用全天值。
"""

from __future__ import annotations

import asyncio
import datetime as dt
import time

from services import em, market_service as ms

SECIDS = ("1.000001", "0.399001")   # 上证指数 + 深证成指
_TTL = 30
_CACHE: tuple[float, dict] | None = None

# 连续竞价时段（分钟）：09:30-11:30 / 13:00-15:00，共 240 分钟
_SESSIONS = ((9 * 60 + 30, 11 * 60 + 30), (13 * 60, 15 * 60))
_TOTAL_MIN = sum(e - s for s, e in _SESSIONS)
_MIN_PROGRESS = 0.06      # 开盘不足 15 分钟不做折算（样本太小，预估会失真）
_SURGE, _SHRINK = 1.15, 0.85


def session_progress(now: dt.datetime | None = None) -> float:
    """已完成交易分钟数 / 240，0 表示未开盘、1 表示已收盘。"""
    now = now or dt.datetime.now()
    cur = now.hour * 60 + now.minute + now.second / 60
    done = 0.0
    for start, end in _SESSIONS:
        if cur >= end:
            done += end - start
        elif cur > start:
            done += cur - start
    return max(0.0, min(1.0, done / _TOTAL_MIN))


def _fmt_amt(v: float) -> str:
    return f"{v / 1e12:.2f} 万亿"


async def snapshot(force: bool = False) -> dict:
    global _CACHE
    now = time.time()
    if not force and _CACHE and now - _CACHE[0] < _TTL:
        return _CACHE[1]

    quotes, hist = await asyncio.gather(
        asyncio.gather(*[ms.quote(s) for s in SECIDS], return_exceptions=True),
        asyncio.gather(*[em.day_amounts(s, ndays=6) for s in SECIDS], return_exceptions=True),
    )
    qs = [q for q in quotes if isinstance(q, dict) and q]
    per = [{str(b.get("date") or "")[:10]: float(b.get("amount") or 0) for b in rows}
           for rows in hist if isinstance(rows, list) and rows]

    def result(**kw) -> dict:
        res = {"ok": False, "factor": 0.0, "status": "平量", "ratio": None,
               "amount": 0.0, "amount_projected": 0.0, "prev_amount": 0.0,
               "pct": (qs[0].get("pct") if qs else None),
               "progress": round(session_progress(), 3), "live": False,
               "ts": dt.datetime.now().strftime("%H:%M:%S")}
        res.update(kw)
        _CACHE = (now, res)
        return res

    if len(per) != len(SECIDS):
        return result(note="成交额数据不足")

    dates = sorted(set.intersection(*[set(p) for p in per]))
    if not dates:
        return result(note="成交额数据不足")

    progress = session_progress()
    if progress <= 0:
        return result(note="盘前无成交额")
    if progress < _MIN_PROGRESS:
        return result(note="开盘初期，成交额样本不足")

    today = dt.date.today().isoformat()
    live = dates[-1] == today and progress < 1.0
    if live:
        # 盘中：当日累计成交额按交易进度折算全天；基准取前一交易日
        prev_date = next((d for d in reversed(dates) if d < today), None)
        cur_amt = sum(p.get(today, 0.0) for p in per)
        projected = cur_amt / progress
    else:
        # 收盘后/非交易日：最后一根日线即完整交易日
        prev_date = dates[-2] if len(dates) >= 2 else None
        cur_amt = sum(p.get(dates[-1], 0.0) for p in per)
        projected = cur_amt
        progress = 1.0

    if not prev_date:
        return result(note="缺少前一交易日成交额", amount=cur_amt,
                      amount_projected=projected, live=live)
    prev_amt = sum(p.get(prev_date, 0.0) for p in per)
    if not prev_amt:
        return result(note="缺少前一交易日成交额", amount=cur_amt,
                      amount_projected=projected, live=live)

    ratio = projected / prev_amt
    status = "放量" if ratio >= _SURGE else "缩量" if ratio <= _SHRINK else "平量"
    pct = (qs[0].get("pct") or 0.0) if qs else 0.0

    # 量价配合：放量同向 ±10，缩量同向弱化为 ±3；平量或指数近乎不动不计分
    factor = 0.0
    if abs(pct) > 0.1:
        sign = 1.0 if pct > 0 else -1.0
        if status == "放量":
            factor = 10.0 * sign
        elif status == "缩量":
            factor = 3.0 * sign

    return result(
        ok=True, factor=factor, status=status, ratio=round(ratio, 2),
        amount=cur_amt, amount_projected=projected, prev_amount=prev_amt,
        prev_date=prev_date, pct=pct, progress=round(progress, 3), live=live,
        text=(f"沪深两市成交额 {_fmt_amt(projected)}"
              f"{'（折算全天）' if live else ''}，较前一交易日{status} {ratio:.2f}x"),
    )


def factor_text(t: dict) -> str | None:
    """放量/缩量信号文案；平量不提示。"""
    if not t.get("ok") or t.get("status") == "平量" or t.get("ratio") is None:
        return None
    pct = t.get("pct")
    tail = f"，上证 {pct:+.2f}%" if pct is not None else ""
    return f"{t.get('text') or ''}{tail}"
